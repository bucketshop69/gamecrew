import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  COMMENTARY_PLAN_VERSION,
  type MatchEngineTeam,
  type TxlineMatchEngineRecord,
} from '@gamecrew/core';
import { CommentaryProjectionConsumer } from './ingestion/commentary-projection-consumer.js';
import { SemanticFrameHub } from './ingestion/semantic-frame-hub.js';
import { SqliteIngestionStore } from './ingestion/sqlite-ingestion-store.js';
import { SqliteMatchPulseCommentaryStore } from './match-pulse-commentary-store.js';

const args = process.argv.slice(2).filter((argument) => argument !== '--');
const fixtureId = args[0] ?? '18179759';
const databasePath = args[1]
  ?? resolve(process.cwd(), `.data/match-ingestion-${fixtureId}.sqlite`);
const commentaryDatabasePath = resolve(process.cwd(), `.data/match-commentary-acceptance-${fixtureId}.sqlite`);
const store = new SqliteIngestionStore(databasePath);
await rm(commentaryDatabasePath, { force: true });
const commentaryStore = new SqliteMatchPulseCommentaryStore(commentaryDatabasePath);
const consumer = new CommentaryProjectionConsumer(store, new SemanticFrameHub(store), commentaryStore);

try {
  const checkpoint = await store.getCheckpoint(fixtureId);
  if (!checkpoint) throw new Error(`No engine checkpoint for fixture ${fixtureId}. Run ingestion:smoke first.`);
  const [storedFrames, raw] = await Promise.all([
    store.listFramesAfter(fixtureId, 0, checkpoint.engineVersion),
    store.listRawCandidates(fixtureId),
  ]);
  const records = raw.flatMap(({ payloadJson }) => {
    try { return [JSON.parse(payloadJson) as TxlineMatchEngineRecord]; } catch { return []; }
  });
  const teams = (await store.getFixtureContext(fixtureId))?.participants ?? inferTeams(records);
  await consumer.ensureFixture(fixtureId, teams);
  const entries = await commentaryStore.listEntries(fixtureId);
  const cursor = await commentaryStore.getProjectionCursor(fixtureId);
  const counts = Object.fromEntries(['routine', 'pressure', 'major'].map((kind) => [
    kind,
    entries.filter((entry) => entry.commentaryBeatKind === kind).length,
  ]));
  if (fixtureId === '18179759') assertFixture18179759(entries, storedFrames.length, checkpoint.state);
  const samples = [
    ...entries.slice(-3),
    ...entries.filter(hasRestartContext).slice(0, 4),
    ...entries.filter((entry) => entry.commentaryBeatKind === 'pressure').slice(0, 2),
    ...entries.filter((entry) => entry.commentaryBeatKind === 'major').slice(0, 4),
  ].filter((entry, index, all) => all.findIndex(({ id }) => id === entry.id) === index)
    .map((entry) => ({
      kind: entry.commentaryBeatKind,
      fromSeq: entry.fromSeq,
      toSeq: entry.toSeq,
      sourceFrames: entry.sourceFrameIds?.length ?? 0,
      fallbackCommentary: entry.fallbackCommentary,
    }));

  console.log(JSON.stringify({
    fixtureId,
    projectionGeneration: cursor?.projectionGeneration,
    semanticFrames: storedFrames.length,
    commentaryBeats: entries.length,
    counts,
    grounded: entries.every(hasCompleteFrameProvenance),
    samples,
  }, null, 2));
} finally {
  await consumer.close();
  commentaryStore.close();
  store.close();
  await rm(commentaryDatabasePath, { force: true });
}

function assertFixture18179759(
  entries: readonly import('@gamecrew/core').MatchPulseCommentaryEntry[],
  semanticFrameCount: number,
  state: import('@gamecrew/core').CanonicalMatchState,
): void {
  assert.equal(semanticFrameCount, 886, 'commentary acceptance requires 886 semantic frames');
  assert.equal(entries.length, 708, 'commentary acceptance requires 708 immediate durable beats');
  assert.ok(entries.every((entry) => entry.commentaryPlanVersion === COMMENTARY_PLAN_VERSION),
    `every commentary beat must use planner v${COMMENTARY_PLAN_VERSION}`);
  assert.equal(entries.filter((entry) => entry.commentaryBeatKind === 'pressure').length, 0,
    'immediate commentary must not reintroduce delayed pressure summaries');
  assert.equal(state.phase, 'finalised');
  assert.deepEqual(state.finalScore, { participant1: 2, participant2: 0 });
  assert.deepEqual(state.integrityWarnings, []);
  const goals = entries.filter((entry) => entry.kind === 'goal');
  assert.equal(goals.length, 2, 'both confirmed goals must be durable commentary beats');
  assert.ok(goals.every((entry) => (entry.sourceFrameIds?.length ?? 0) >= 2),
    'goal beats must preserve their later scorer-enrichment frames');
  assert.equal(entries.filter((entry) => restartContext(entry) === 'after_goal').length, 2,
    'both goals must be followed by a grounded restart');
  assert.ok(entries.some((entry) => entry.groundedFacts?.some((fact) => fact.value.phase === 'half_time')),
    'halftime must be present');
  assert.ok(entries.some((entry) => restartContext(entry) === 'second_half'),
    'second-half kickoff must be present');
  assert.ok(entries.some((entry) => entry.groundedFacts?.some((fact) => fact.action === 'red_card')),
    'red card must be present');
  assert.ok(entries.every(hasCompleteFrameProvenance),
    'every commentary beat must retain exact source-frame coverage');
}

function hasCompleteFrameProvenance(entry: import('@gamecrew/core').MatchPulseCommentaryEntry): boolean {
  const expected = new Set(entry.sourceFrameIds ?? []);
  const actual = new Set(entry.sourceEvents.map((event) => event.id).filter((id): id is string => Boolean(id)));
  return expected.size > 0
    && (entry.cueIds?.length ?? 0) > 0
    && [...expected].every((frameId) => actual.has(frameId))
    && [...actual].every((frameId) => expected.has(frameId))
    && entry.sourceEvents.every((event) => Number.isSafeInteger(event.seq));
}

function hasRestartContext(entry: import('@gamecrew/core').MatchPulseCommentaryEntry): boolean {
  return restartContext(entry) !== undefined;
}

function restartContext(entry: import('@gamecrew/core').MatchPulseCommentaryEntry): string | undefined {
  const restart = entry.groundedFacts?.find((fact) => fact.kind === 'restart');
  return typeof restart?.value.context === 'string' ? restart.value.context : undefined;
}

function inferTeams(records: readonly TxlineMatchEngineRecord[]): readonly MatchEngineTeam[] {
  const named = records.find((record) =>
    record.Participant1Id !== undefined && record.Participant2Id !== undefined);
  const participant1Id = named?.Participant1Id as number | string | undefined;
  const participant2Id = named?.Participant2Id as number | string | undefined;
  return [
    {
      participant: 1,
      teamId: participant1Id ?? 1,
      name: typeof named?.Participant1 === 'string' ? named.Participant1 : `Participant ${participant1Id ?? 1}`,
      isHome: named?.Participant1IsHome !== false,
    },
    {
      participant: 2,
      teamId: participant2Id ?? 2,
      name: typeof named?.Participant2 === 'string' ? named.Participant2 : `Participant ${participant2Id ?? 2}`,
      isHome: named?.Participant1IsHome === false,
    },
  ];
}
