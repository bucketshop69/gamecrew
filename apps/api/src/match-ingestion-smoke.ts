import { resolve } from 'node:path';
import { TxlineApiClient, type TxlineFixture, type TxlineScore } from '@gamecrew/core';
import { loadConfig } from './config.js';
import { FixtureIngestionSession } from './ingestion/fixture-ingestion-session.js';
import { buildMatchEngineContext } from './ingestion/match-engine-context.js';
import { MatchEngineProjector } from './ingestion/match-engine-projector.js';
import { SemanticFrameHub } from './ingestion/semantic-frame-hub.js';
import { SqliteIngestionStore } from './ingestion/sqlite-ingestion-store.js';
import { TxlineAuthSession } from './ingestion/txline-auth-session.js';
import { TxlineFeedSource } from './ingestion/txline-feed-source.js';

const fixtureId = process.argv.find((value) => /^\d+$/.test(value)) ?? '18179759';
const config = loadConfig();
const databasePath = resolve(process.cwd(), `.data/match-ingestion-${fixtureId}.sqlite`);
const store = new SqliteIngestionStore(databasePath);
const client = new TxlineApiClient({ baseUrl: config.txlineBaseUrl, apiToken: config.txlineApiToken });
const auth = new TxlineAuthSession(client);
const feed = new TxlineFeedSource(client, auth);
let session: FixtureIngestionSession | undefined;

try {
  let history: readonly TxlineScore[] = [];
  let fixture: TxlineFixture | undefined;
  let upstreamFailure: string | undefined;
  try {
    history = await feed.fetchHistorical(fixtureId);
    const startTime = history.find((score) => typeof score.StartTime === 'number')?.StartTime;
    const fixtures = await feed.fetchFixtures({
      ...(typeof startTime === 'number' ? { startEpochDay: Math.floor(startTime / 86_400_000) } : {}),
    });
    fixture = fixtures.find((candidate) => String(candidate.FixtureId) === fixtureId) ?? buildFixture(history);
  } catch (error) {
    upstreamFailure = error instanceof Error ? error.message : String(error);
  }

  let source: 'txline' | 'durable' = 'durable';
  if (fixture) {
    const context = buildMatchEngineContext(fixture, history);
    const hub = new SemanticFrameHub(store);
    const projector = new MatchEngineProjector(store, { publisher: hub });
    session = new FixtureIngestionSession({ fixtureId, context, feed, store, projector });
    await store.saveFixtureContext({
      fixtureId,
      participants: context.participants,
      updatedAt: new Date().toISOString(),
    });
    await session.start();
    source = 'txline';
  }

  const checkpoint = await store.getCheckpoint(fixtureId);
  const cursor = await store.getCursor(fixtureId);
  const raw = await store.listRawCandidates(fixtureId);
  if (!checkpoint) {
    const reason = upstreamFailure
      ? ` TxLINE failed with: ${upstreamFailure}`
      : '';
    throw new Error(`Fixture ${fixtureId} could not be reconstructed and has no durable checkpoint.${reason}`);
  }
  if (fixtureId === '18179759') {
    const failures = [
      raw.length === 886 ? undefined : `expected 886 raw candidates, received ${raw.length}`,
      cursor?.lastSeenSeq === 885 ? undefined : `expected last contiguous Seq 885, received ${cursor?.lastSeenSeq ?? 'none'}`,
      checkpoint.state.phase === 'finalised' ? undefined : `expected finalised phase, received ${checkpoint.state.phase}`,
      checkpoint.state.confirmedScore.participant1 === 2 && checkpoint.state.confirmedScore.participant2 === 0
        ? undefined
        : `expected confirmed score 2-0, received ${checkpoint.state.confirmedScore.participant1}-${checkpoint.state.confirmedScore.participant2}`,
      checkpoint.state.finalScore?.participant1 === 2 && checkpoint.state.finalScore?.participant2 === 0
        ? undefined
        : 'expected final score 2-0',
      checkpoint.state.integrityWarnings.length === 0
        ? undefined
        : `expected zero integrity warnings, received ${checkpoint.state.integrityWarnings.length}`,
    ].filter((failure): failure is string => failure !== undefined);
    if (failures.length > 0) {
      throw new Error(`Fixture 18179759 ingestion acceptance failed: ${failures.join('; ')}.`);
    }
  }
  console.log(JSON.stringify({
    fixtureId,
    databasePath,
    source,
    ...(source === 'durable'
      ? { upstreamStatus: upstreamFailure ? `unavailable: ${upstreamFailure}` : 'historical fixture unavailable' }
      : {}),
    rawCandidates: raw.length,
    lastContiguousSeq: cursor?.lastSeenSeq,
    lastEventId: cursor?.lastEventId,
    phase: checkpoint.state.phase,
    confirmedScore: checkpoint.state.confirmedScore,
    finalScore: checkpoint.state.finalScore,
    stateRevision: checkpoint.stateRevision,
    integrityWarnings: checkpoint.state.integrityWarnings,
  }, null, 2));
} finally {
  await session?.stop();
  store.close();
}

function buildFixture(scores: readonly TxlineScore[]): TxlineFixture | undefined {
  const score = scores.find((candidate) => candidate.Participant1Id && candidate.Participant2Id);
  if (!score) return undefined;
  const participant1Id = score.Participant1Id!;
  const participant2Id = score.Participant2Id!;
  return {
    Ts: score.Ts ?? 0,
    StartTime: score.StartTime ?? 0,
    Competition: `Competition ${score.CompetitionId ?? 'unknown'}`,
    CompetitionId: score.CompetitionId ?? 0,
    FixtureGroupId: score.FixtureGroupId ?? 0,
    Participant1Id: participant1Id,
    Participant1: score.Participant1 ?? `Participant ${participant1Id}`,
    Participant2Id: participant2Id,
    Participant2: score.Participant2 ?? `Participant ${participant2Id}`,
    FixtureId: Number(fixtureId),
    Participant1IsHome: score.Participant1IsHome ?? true,
  };
}
