import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGameViewTimeline } from '../src/match-engine/index.ts';

const FIXTURE_ID = 999001;

let seqCounter = 0;
let revisionCounter = 0;

function nextSeq() {
  seqCounter += 1;
  return seqCounter;
}

/** Builds a minimal-but-valid SimulationCue carrying only the fields game-view.ts reads. */
function cue(overrides) {
  revisionCounter += 1;
  return {
    id: overrides.id ?? `cue:${FIXTURE_ID}:${overrides.kind}:${revisionCounter}`,
    kind: overrides.kind,
    updateMode: overrides.updateMode ?? 'incident_upsert',
    lifecycle: overrides.lifecycle ?? 'observed',
    basis: overrides.basis ?? 'direct',
    revision: overrides.revision ?? 1,
    participant: overrides.participant,
    teamId: overrides.teamId,
    player: overrides.player,
    pressure: overrides.pressure,
    probableZone: overrides.probableZone,
    value: overrides.value ?? {},
    occurrenceSeconds: overrides.occurrenceSeconds,
    sourceSeqs: overrides.sourceSeqs ?? [nextSeq()],
    factIds: overrides.factIds ?? [],
  };
}

/** Builds a minimal-but-valid SemanticFrame with a single seq and the given cues. */
function frame(overrides) {
  const seq = overrides.seq ?? nextSeq();
  return {
    id: overrides.id ?? `frame:${FIXTURE_ID}:${seq}`,
    fixtureId: FIXTURE_ID,
    seq,
    stateRevision: overrides.stateRevision ?? seq,
    sourceTimestamp: overrides.sourceTimestamp,
    matchClockSeconds: overrides.matchClockSeconds,
    facts: overrides.facts ?? [],
    simulationCues: overrides.cues ?? [],
  };
}

function player(overrides) {
  return {
    normativeId: overrides.normativeId,
    participant: overrides.participant,
    teamId: overrides.teamId ?? 'team-a',
    sourcePreferredName: overrides.sourcePreferredName ?? 'Player',
    displayName: overrides.displayName ?? overrides.sourcePreferredName ?? 'Player',
  };
}

test.beforeEach(() => {
  seqCounter = 0;
  revisionCounter = 0;
});

test('extends the same ambient scene across possession cues in the same zone/team, and opens a new one on zone change', () => {
  const frames = [
    frame({ cues: [cue({ kind: 'possession_change', participant: 1, teamId: 'team-a', pressure: 'safe', probableZone: 'safe' })] }),
    frame({ cues: [cue({ kind: 'possession_pressure', participant: 1, teamId: 'team-a', pressure: 'safe', probableZone: 'safe' })] }),
    frame({ cues: [cue({ kind: 'possession_pressure', participant: 1, teamId: 'team-a', pressure: 'attack', probableZone: 'attack' })] }),
  ];

  const scenes = buildGameViewTimeline(frames);

  assert.equal(scenes.length, 2, 'first two same-zone cues stay in one ambient scene, third opens a new one');
  assert.equal(scenes[0].kind, 'ambient');
  assert.equal(scenes[0].zone, 'safe');
  assert.deepEqual(scenes[0].sourceFrameIds, [frames[0].id, frames[1].id]);
  assert.equal(scenes[1].kind, 'ambient');
  assert.equal(scenes[1].zone, 'attack');
  assert.deepEqual(scenes[1].sourceFrameIds, [frames[2].id]);
});

test('opens a new ambient scene on possession flip to the other team even when the zone label is unchanged', () => {
  const frames = [
    frame({ cues: [cue({ kind: 'possession_change', participant: 1, teamId: 'team-a', pressure: 'neutral', probableZone: 'neutral' })] }),
    frame({ cues: [cue({ kind: 'possession_change', participant: 2, teamId: 'team-b', pressure: 'neutral', probableZone: 'neutral' })] }),
  ];

  const scenes = buildGameViewTimeline(frames);

  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].teamId, 'team-a');
  assert.equal(scenes[1].teamId, 'team-b');
});

test('runs the full goal choreography: provisional tension never celebrates, confirmation adds the celebration beat and score, and score_commit rides along without its own scene', () => {
  const scorer = player({ normativeId: 1, participant: 1, sourcePreferredName: 'Striker' });
  const goalKey = `${FIXTURE_ID}:goal:501`;
  const goalCueId = `cue:${goalKey}`;

  const pendingFrame = frame({
    cues: [cue({ id: goalCueId, kind: 'goal_pending', lifecycle: 'provisional', participant: 1, teamId: 'team-a', player: scorer })],
  });
  const confirmFrame = frame({
    cues: [
      cue({ id: goalCueId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1, teamId: 'team-a', player: scorer }),
      cue({ kind: 'score_commit', lifecycle: 'confirmed', value: { participant1: 1, participant2: 0 } }),
    ],
  });

  const scenes = buildGameViewTimeline([pendingFrame, confirmFrame]);

  assert.equal(scenes.length, 1, 'goal_pending and goal_confirmed collapse into a single goal_sequence scene');
  const goal = scenes[0];
  assert.equal(goal.kind, 'goal_sequence');
  assert.equal(goal.lifecycle, 'confirmed');
  assert.deepEqual(goal.scoreAtMoment, { participant1: 1, participant2: 0 });
  assert.deepEqual(goal.sourceFrameIds, [pendingFrame.id, confirmFrame.id]);

  assert.equal(goal.beats.length, 2, 'exactly tension then celebration, no third beat for score_commit');
  assert.equal(goal.beats[0].kind, 'tension');
  assert.equal(goal.beats[0].lifecycle, 'provisional');
  assert.equal(goal.beats[0].scoreAtMoment, undefined, 'a provisional/tension beat must never carry a settled score');
  assert.equal(goal.beats[1].kind, 'celebration');
  assert.equal(goal.beats[1].lifecycle, 'confirmed');
  assert.deepEqual(goal.beats[1].scoreAtMoment, { participant1: 1, participant2: 0 });

  assert.ok(goal.scoreEvents.includes('opener'), 'first goal of the match from 0-0 should be classified as opener');
});

test('a goal confirmed with no prior goal_pending still produces a takeover with only a celebration beat', () => {
  const scorer = player({ normativeId: 2, participant: 2, sourcePreferredName: 'Poacher' });
  const goalKey = `${FIXTURE_ID}:goal:777`;
  const confirmFrame = frame({
    cues: [
      cue({ id: `cue:${goalKey}`, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 2, teamId: 'team-b', player: scorer }),
      cue({ kind: 'score_commit', lifecycle: 'confirmed', value: { participant1: 0, participant2: 1 } }),
    ],
  });

  const scenes = buildGameViewTimeline([confirmFrame]);

  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].kind, 'goal_sequence');
  assert.equal(scenes[0].beats.length, 1);
  assert.equal(scenes[0].beats[0].kind, 'celebration');
});

test('retracts a confirmed goal after the fact, restoring the score to its value immediately before that goal', () => {
  const firstScorer = player({ normativeId: 5, participant: 1, sourcePreferredName: 'First Scorer' });
  const secondScorer = player({ normativeId: 3, participant: 1, sourcePreferredName: 'VAR Victim' });
  const firstGoalCueId = `cue:${FIXTURE_ID}:goal:800`;
  const secondGoalCueId = `cue:${FIXTURE_ID}:goal:900`;

  // First goal makes it 1-0; this is the score the retraction below must restore to.
  const firstGoalFrame = frame({
    cues: [
      cue({ id: firstGoalCueId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1, teamId: 'team-a', player: firstScorer }),
      cue({ kind: 'score_commit', lifecycle: 'confirmed', value: { participant1: 1, participant2: 0 } }),
    ],
  });
  // Second goal (the one that gets retracted) takes it from 1-0 to 2-1.
  const pendingFrame = frame({
    cues: [cue({ id: secondGoalCueId, kind: 'goal_pending', lifecycle: 'provisional', participant: 1, teamId: 'team-a', player: secondScorer })],
  });
  const confirmFrame = frame({
    cues: [
      cue({ id: secondGoalCueId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1, teamId: 'team-a', player: secondScorer }),
      cue({ kind: 'score_commit', lifecycle: 'confirmed', value: { participant1: 2, participant2: 1 } }),
    ],
  });
  const retractFrame = frame({
    cues: [cue({ id: secondGoalCueId, kind: 'incident_retracted', lifecycle: 'retracted', participant: 1, teamId: 'team-a' })],
  });

  const scenes = buildGameViewTimeline([firstGoalFrame, pendingFrame, confirmFrame, retractFrame]);

  assert.equal(scenes.length, 3, 'both confirmed goal_sequence scenes stay, plus one goal_retracted scene');
  const [firstGoalScene, secondGoalScene, retractedScene] = scenes;
  assert.equal(firstGoalScene.kind, 'goal_sequence');
  assert.deepEqual(firstGoalScene.scoreAtMoment, { participant1: 1, participant2: 0 });
  assert.equal(secondGoalScene.kind, 'goal_sequence');
  assert.deepEqual(secondGoalScene.scoreAtMoment, { participant1: 2, participant2: 1 }, 'the retracted scene keeps its own recorded score');
  assert.equal(retractedScene.kind, 'goal_retracted');
  assert.deepEqual(retractedScene.scoreAtMoment, { participant1: 1, participant2: 0 }, 'restores to the score immediately before the retracted goal, i.e. after the first goal');
});

test('within one frame, a red card outranks a simultaneous set piece and both are still emitted in priority order', () => {
  const cardCue = cue({ kind: 'card', participant: 1, teamId: 'team-a', value: { action: 'red_card' } });
  const setPieceCue = cue({ kind: 'set_piece', participant: 2, teamId: 'team-b' });
  const collisionFrame = frame({ cues: [setPieceCue, cardCue] }); // deliberately out of priority order in the input

  const scenes = buildGameViewTimeline([collisionFrame]);

  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].kind, 'card', 'red card is processed first (higher takeover priority)');
  assert.equal(scenes[1].kind, 'set_piece');
});

test('a yellow card still outranks a set piece, but ranks below a red card tier', () => {
  const yellowCue = cue({ kind: 'card', participant: 1, teamId: 'team-a', value: { action: 'yellow_card' } });
  const setPieceCue = cue({ kind: 'set_piece', participant: 2, teamId: 'team-b' });
  const collisionFrame = frame({ cues: [setPieceCue, yellowCue] });

  const scenes = buildGameViewTimeline([collisionFrame]);

  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].kind, 'card');
  assert.equal(scenes[1].kind, 'set_piece');
});

test('phase_change cues close ambient and produce a phase_break scene, tracking the new phase for later scenes', () => {
  const ambientFrame = frame({
    cues: [cue({ kind: 'possession_change', participant: 1, teamId: 'team-a', pressure: 'neutral', probableZone: 'neutral' })],
  });
  const phaseFrame = frame({ cues: [cue({ kind: 'phase_change', value: { phase: 'half_time' } })] });
  const shotFrame = frame({ cues: [cue({ kind: 'shot_attempt', participant: 1, teamId: 'team-a' })] });

  const scenes = buildGameViewTimeline([ambientFrame, phaseFrame, shotFrame]);

  assert.equal(scenes.length, 3);
  assert.equal(scenes[0].kind, 'ambient');
  assert.equal(scenes[1].kind, 'phase_break');
  assert.equal(scenes[2].kind, 'shot');
  assert.equal(scenes[2].phase, 'half_time', 'the phase captured by phase_change persists onto subsequent scenes');
});

test('produces the same scene sequence regardless of input frame order (sorted deterministically by seq)', () => {
  const frames = [
    frame({ seq: 10, cues: [cue({ kind: 'possession_change', participant: 1, teamId: 'team-a', pressure: 'safe', probableZone: 'safe' })] }),
    frame({ seq: 20, cues: [cue({ kind: 'set_piece', participant: 1, teamId: 'team-a' })] }),
    frame({ seq: 30, cues: [cue({ kind: 'shot_attempt', participant: 1, teamId: 'team-a' })] }),
    frame({ seq: 40, cues: [cue({ kind: 'card', participant: 2, teamId: 'team-b', value: { action: 'yellow_card' } })] }),
  ];

  const inOrder = buildGameViewTimeline(frames);
  const shuffled = buildGameViewTimeline([frames[2], frames[0], frames[3], frames[1]]);

  assert.deepEqual(shuffled, inOrder);
  assert.deepEqual(inOrder.map((scene) => scene.kind), ['ambient', 'set_piece', 'shot', 'card']);
});

test('every emitted scene carries at least one sourceFrameId', () => {
  const scorer = player({ normativeId: 4, participant: 1, sourcePreferredName: 'Someone' });
  const goalKey = `${FIXTURE_ID}:goal:321`;
  const goalCueId = `cue:${goalKey}`;

  const frames = [
    frame({ cues: [cue({ kind: 'possession_change', participant: 1, teamId: 'team-a', pressure: 'safe', probableZone: 'safe' })] }),
    frame({ cues: [cue({ kind: 'set_piece', participant: 1, teamId: 'team-a' })] }),
    frame({ cues: [cue({ kind: 'shot_outcome', participant: 1, teamId: 'team-a' })] }),
    frame({ cues: [cue({ id: goalCueId, kind: 'goal_pending', lifecycle: 'provisional', participant: 1, teamId: 'team-a', player: scorer })] }),
    frame({ cues: [
      cue({ id: goalCueId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1, teamId: 'team-a', player: scorer }),
      cue({ kind: 'score_commit', lifecycle: 'confirmed', value: { participant1: 1, participant2: 0 } }),
    ] }),
    frame({ cues: [cue({ id: goalCueId, kind: 'incident_retracted', lifecycle: 'retracted', participant: 1, teamId: 'team-a' })] }),
    frame({ cues: [cue({ kind: 'card', participant: 2, teamId: 'team-b', value: { action: 'red_card' } })] }),
    frame({ cues: [cue({ kind: 'substitution', participant: 2, teamId: 'team-b' })] }),
    frame({ cues: [cue({ kind: 'var', participant: 2, teamId: 'team-b' })] }),
    frame({ cues: [cue({ kind: 'restart', participant: 1, teamId: 'team-a' })] }),
    frame({ cues: [cue({ kind: 'phase_change', value: { phase: 'second_half' } })] }),
  ];

  const scenes = buildGameViewTimeline(frames);

  assert.ok(scenes.length > 0);
  for (const scene of scenes) {
    assert.ok(Array.isArray(scene.sourceFrameIds) && scene.sourceFrameIds.length > 0, `scene ${scene.id} (${scene.kind}) must carry sourceFrameIds`);
  }
});

test('ignores cue kinds outside the director taxonomy without throwing or emitting a scene for them', () => {
  const frames = [
    frame({ cues: [cue({ kind: 'player_highlight', participant: 1, teamId: 'team-a' })] }),
    frame({ cues: [cue({ kind: 'injury', participant: 1, teamId: 'team-a' })] }),
    frame({ cues: [cue({ kind: 'additional_time', value: { seconds: 120 } })] }),
    frame({ cues: [cue({ kind: 'possible_event', participant: 1, teamId: 'team-a' })] }),
    frame({ cues: [cue({ kind: 'incident', participant: 1, teamId: 'team-a' })] }),
    frame({ cues: [cue({ kind: 'shot_attempt', participant: 1, teamId: 'team-a' })] }),
  ];

  const scenes = buildGameViewTimeline(frames);

  assert.equal(scenes.length, 1, 'only the shot_attempt cue produces a scene; everything else is ignored gracefully');
  assert.equal(scenes[0].kind, 'shot');
});

test('returns an empty timeline for no frames and for frames with no relevant cues', () => {
  assert.deepEqual(buildGameViewTimeline([]), []);
  const noise = frame({ cues: [cue({ kind: 'injury', participant: 1, teamId: 'team-a' })] });
  assert.deepEqual(buildGameViewTimeline([noise]), []);
});
