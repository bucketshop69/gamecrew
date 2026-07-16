import assert from 'node:assert/strict';
import {
  COMMENTARY_PLAN_VERSION,
  buildGameViewTimeline,
  type MatchPulseCommentaryEntry,
  type SemanticFrame,
  type SimulationCue,
} from '@gamecrew/core';
import { loadConfig } from './config.js';
import { SqliteIngestionStore } from './ingestion/sqlite-ingestion-store.js';
import { SqliteMatchPulseCommentaryStore } from './match-pulse-commentary-store.js';

const values = process.argv.slice(2).filter((value) => value !== '--');
const fixtureId = values.find((value) => /^\d+$/.test(value)) ?? '18237038';
const databasePath = values.find((value) => value.startsWith('--database='))
  ?.slice('--database='.length)
  ?? loadConfig().matchPulseSqlitePath;

const framesStore = new SqliteIngestionStore(databasePath);
const commentaryStore = new SqliteMatchPulseCommentaryStore(databasePath);

try {
  const checkpoint = await framesStore.getCheckpoint(fixtureId);
  assert.ok(checkpoint, `No engine checkpoint for fixture ${fixtureId}.`);
  const storedFrames = await framesStore.listFramesAfter(fixtureId, 0);
  const frames = storedFrames.map((stored) => 'frame' in stored ? stored.frame : stored);
  const entries = await commentaryStore.listEntries(fixtureId);
  assert.ok(frames.length > 0, `No semantic frames for fixture ${fixtureId}.`);
  assert.ok(entries.length > 0, `No commentary projection for fixture ${fixtureId}.`);
  assert.ok(
    entries.every((entry) => entry.commentaryPlanVersion === COMMENTARY_PLAN_VERSION),
    `Fixture ${fixtureId} still contains commentary from an older planner.`,
  );

  const scenes = buildGameViewTimeline(frames);
  const immediateEntries = entries.filter((entry) => entry.commentaryBeatKind !== 'pressure');
  const finalIncidents = collectFinalVisualIncidents(frames);
  const incidentReports = finalIncidents.map((incident) => {
    const incidentFrameIds = new Set(incident.frameIds);
    const matchingScenes = scenes.filter((scene) =>
      sceneMatchesIncident(scene, incident.cue, incident.action)
      && scene.sourceCueIds.includes(incident.cue.id)
      && scene.sourceFrameIds.some((frameId) => incidentFrameIds.has(frameId)));
    const matchingEntries = immediateEntries.filter((entry) => entry.cueIds?.includes(incident.cue.id));
    assert.equal(
      matchingScenes.length,
      1,
      `${incident.cue.id} (${incident.action}) must produce exactly one Game View scene.`,
    );
    assert.equal(
      matchingEntries.length,
      1,
      `${incident.cue.id} (${incident.action}) must produce exactly one immediate commentary entry.`,
    );
    assert.ok(
      matchingEntries[0]!.sourceFrameIds?.some((frameId) =>
        matchingScenes[0]!.sourceFrameIds.includes(frameId)),
      `${incident.cue.id} commentary must share source provenance with its Game View scene.`,
    );
    assert.ok(
      matchingEntries[0]!.cueIds?.some((cueId) => matchingScenes[0]!.sourceCueIds.includes(cueId)),
      `${incident.cue.id} commentary must target its exact Game View cue.`,
    );
    return {
      action: incident.action,
      cueId: incident.cue.id,
      clockSeconds: incident.clockSeconds,
      sceneId: matchingScenes[0]!.id,
      commentaryId: matchingEntries[0]!.id,
    };
  });

  const retractedGoalEntry = immediateEntries.find((entry) =>
    entry.groundedFacts?.some((fact) =>
      fact.kind === 'incident_retracted' && fact.action === 'goal'));
  const retractedGoalScene = scenes.find((scene) => scene.kind === 'goal_retracted');
  assert.ok(retractedGoalEntry, 'The retracted goal must have immediate grounded commentary.');
  assert.ok(retractedGoalScene, 'The retracted goal must have a Game View correction scene.');
  assert.ok(
    retractedGoalEntry.sourceFrameIds?.some((frameId) =>
      retractedGoalScene.sourceFrameIds.includes(frameId)),
    'The retracted-goal caption and scene must share source provenance.',
  );
  assert.ok(
    retractedGoalEntry.cueIds?.some((cueId) => retractedGoalScene.sourceCueIds.includes(cueId)),
    'The retracted-goal caption must target its exact Game View cue.',
  );

  const actionCounts = countBy(incidentReports.map((report) => report.action));
  if (fixtureId === '18237038') {
    assert.deepEqual(
      pickCounts(actionCounts, ['throw_in', 'goal_kick', 'free_kick', 'corner']),
      { throw_in: 37, goal_kick: 18, free_kick: 33, corner: 8 },
    );
    assert.equal(incidentReports.length, 128, 'France-Spain must cover every final valid visual incident.');
    assertFirstTenMinutes(frames, immediateEntries);
  }

  console.log(JSON.stringify({
    fixtureId,
    databasePath,
    commentaryPlanVersion: COMMENTARY_PLAN_VERSION,
    semanticFrames: frames.length,
    gameViewScenes: scenes.length,
    commentaryEntries: entries.length,
    immediateEntries: immediateEntries.length,
    finalVisualIncidents: incidentReports.length,
    incidentCoverage: `${incidentReports.length}/${finalIncidents.length}`,
    cueAlignedIncidents: `${incidentReports.length}/${finalIncidents.length}`,
    duplicateGameViewIncidents: 0,
    duplicateImmediateCaptions: 0,
    setPieces: pickCounts(actionCounts, ['throw_in', 'goal_kick', 'free_kick', 'corner']),
    retractedGoalCovered: true,
    firstTenMinutes: firstTenMinuteLines(frames, immediateEntries),
  }, null, 2));
} finally {
  commentaryStore.close();
  framesStore.close();
}

interface FinalVisualIncident {
  cue: SimulationCue;
  action: string;
  frameIds: string[];
  clockSeconds?: number;
}

function collectFinalVisualIncidents(frames: readonly SemanticFrame[]): FinalVisualIncident[] {
  const visualKinds = new Set<SimulationCue['kind']>([
    'set_piece', 'shot_attempt', 'shot_outcome', 'card', 'substitution', 'var', 'goal_confirmed',
  ]);
  const retracted = new Set(frames.flatMap((frame) =>
    frame.simulationCues
      .filter((cue) => cue.kind === 'incident_retracted')
      .map((cue) => cue.id)));
  const grouped = new Map<string, Array<{ frame: SemanticFrame; cue: SimulationCue }>>();

  for (const frame of frames) {
    for (const cue of frame.simulationCues) {
      if (!visualKinds.has(cue.kind) || retracted.has(cue.id)) continue;
      const revisions = grouped.get(cue.id) ?? [];
      revisions.push({ frame, cue });
      grouped.set(cue.id, revisions);
    }
  }

  return [...grouped.values()].flatMap((revisions) => {
    const admitted = revisions.filter(({ cue }) =>
      cue.lifecycle === 'confirmed' || cue.lifecycle === 'observed');
    const selected = admitted.at(-1);
    if (!selected) return [];
    return [{
      cue: selected.cue,
      action: typeof selected.cue.value.action === 'string'
        ? selected.cue.value.action
        : selected.cue.kind,
      frameIds: [...new Set(revisions.map(({ frame }) => frame.id))],
      ...(selected.frame.matchClockSeconds === undefined
        ? {}
        : { clockSeconds: selected.frame.matchClockSeconds }),
    }];
  });
}

function assertFirstTenMinutes(
  frames: readonly SemanticFrame[],
  entries: readonly MatchPulseCommentaryEntry[],
): void {
  const expected = [
    { action: 'kickoff', participant: 2, clockSeconds: 0 },
    { action: 'throw_in', participant: 2, clockSeconds: 65 },
    { action: 'corner', participant: 1, clockSeconds: 318 },
    { action: 'shot', participant: 1, clockSeconds: 354 },
    { action: 'goal_kick', participant: 2, clockSeconds: 358 },
    { action: 'free_kick', participant: 2, clockSeconds: 477 },
    { action: 'yellow_card', participant: 1, clockSeconds: 518 },
  ];
  const earlyCues = frames.flatMap((frame) => frame.simulationCues.map((cue) => ({ frame, cue })))
    .filter(({ frame }) => (frame.matchClockSeconds ?? Number.POSITIVE_INFINITY) <= 600);

  for (const item of expected) {
    const source = earlyCues.find(({ frame, cue }) => (
      cue.participant === item.participant
      && frame.matchClockSeconds === item.clockSeconds
      && cueAction(cue) === item.action
      && (cue.lifecycle === 'confirmed' || cue.lifecycle === 'observed')
    ));
    assert.ok(source, `Missing expected ${item.action} source cue at ${item.clockSeconds}s.`);
    assert.equal(
      entries.filter((entry) =>
        entry.cueIds?.includes(source.cue.id)
        && entry.sourceFrameIds?.includes(source.frame.id)).length,
      1,
      `${item.action} at ${item.clockSeconds}s must have one immediate caption.`,
    );
  }
}

function firstTenMinuteLines(
  frames: readonly SemanticFrame[],
  entries: readonly MatchPulseCommentaryEntry[],
) {
  const frameClock = new Map(frames.map((frame) => [frame.id, frame.matchClockSeconds]));
  return entries
    .filter((entry) => entry.sourceFrameIds?.some((frameId) =>
      (frameClock.get(frameId) ?? Number.POSITIVE_INFINITY) <= 600))
    .sort((left, right) => (left.sortSeq ?? 0) - (right.sortSeq ?? 0))
    .map((entry) => ({ clock: entry.clock.label, commentary: entry.commentary }));
}

function cueAction(cue: SimulationCue): string {
  if (typeof cue.value.action === 'string') return cue.value.action;
  if (cue.kind === 'restart') return String(cue.value.kind ?? 'restart');
  return cue.kind;
}

function sceneMatchesIncident(
  scene: ReturnType<typeof buildGameViewTimeline>[number],
  cue: SimulationCue,
  action: string,
): boolean {
  if (cue.kind === 'set_piece') return scene.kind === 'set_piece' && scene.sourceAction === action;
  if (cue.kind === 'shot_attempt' || cue.kind === 'shot_outcome') return scene.kind === 'shot';
  if (cue.kind === 'card') return scene.kind === 'card';
  if (cue.kind === 'substitution') return scene.kind === 'substitution';
  if (cue.kind === 'var') return scene.kind === 'var_review';
  if (cue.kind === 'goal_confirmed') return scene.kind === 'goal_sequence';
  return false;
}

function countBy(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function pickCounts(
  counts: Readonly<Record<string, number>>,
  actions: readonly string[],
): Record<string, number> {
  return Object.fromEntries(actions.map((action) => [action, counts[action] ?? 0]));
}
