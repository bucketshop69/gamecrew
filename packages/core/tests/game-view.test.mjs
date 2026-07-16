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

function withoutPlayback(scene) {
  const { playback: _playback, ...truth } = scene;
  return truth;
}

function replayContractFrames() {
  const goalCueId = `cue:${FIXTURE_ID}:goal:replay-contract`;
  return [
    frame({ matchClockSeconds: 0, cues: [cue({ kind: 'phase_change', value: { phase: 'first_half' } })] }),
    frame({ matchClockSeconds: 10, cues: [cue({ kind: 'possession_change', participant: 1, teamId: 'team-a', pressure: 'safe', probableZone: 'safe' })] }),
    frame({ matchClockSeconds: 30, cues: [cue({ kind: 'possession_change', participant: 2, teamId: 'team-b', pressure: 'attack', probableZone: 'attack' })] }),
    frame({ matchClockSeconds: 119, cues: [cue({ kind: 'possession_pressure', participant: 1, teamId: 'team-a', pressure: 'danger', probableZone: 'danger' })] }),
    frame({ matchClockSeconds: 121, cues: [cue({ kind: 'possession_pressure', participant: 1, teamId: 'team-a', pressure: 'high_danger', probableZone: 'high_danger' })] }),
    frame({ matchClockSeconds: 130, cues: [cue({ kind: 'set_piece', participant: 1, teamId: 'team-a', probableZone: 'safe', value: { action: 'throw_in' } })] }),
    frame({ matchClockSeconds: 140, cues: [cue({ kind: 'set_piece', participant: 2, teamId: 'team-b', probableZone: 'attack', value: { action: 'throw_in' } })] }),
    frame({ matchClockSeconds: 150, cues: [cue({ kind: 'shot_attempt', participant: 1, teamId: 'team-a' })] }),
    frame({ matchClockSeconds: 160, cues: [
      cue({ id: goalCueId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1, teamId: 'team-a' }),
      cue({ kind: 'score_commit', lifecycle: 'confirmed', value: { participant1: 1, participant2: 0 } }),
    ] }),
    frame({ matchClockSeconds: 170, cues: [cue({ id: goalCueId, kind: 'incident_retracted', lifecycle: 'retracted', participant: 1, teamId: 'team-a', value: { action: 'goal' } })] }),
    frame({ matchClockSeconds: 180, cues: [cue({ kind: 'card', participant: 2, teamId: 'team-b', value: { action: 'yellow_card' } })] }),
    frame({ matchClockSeconds: 190, cues: [cue({ kind: 'substitution', participant: 2, teamId: 'team-b' })] }),
    frame({ matchClockSeconds: 200, cues: [cue({ kind: 'var', participant: 2, teamId: 'team-b' })] }),
    frame({ matchClockSeconds: 210, cues: [cue({ kind: 'restart', participant: 1, teamId: 'team-a' })] }),
    frame({ matchClockSeconds: 2700, cues: [cue({ kind: 'phase_change', value: { phase: 'second_half' } })] }),
    frame({ matchClockSeconds: 2710, cues: [cue({ kind: 'set_piece', participant: 1, teamId: 'team-a', probableZone: 'safe', value: { action: 'throw_in' } })] }),
    frame({ matchClockSeconds: 2720, cues: [cue({ kind: 'set_piece', participant: 2, teamId: 'team-b', probableZone: 'safe', value: { action: 'throw_in' } })] }),
  ];
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
  assert.deepEqual(goal.beats[0].scoreAtMoment, { participant1: 0, participant2: 0 }, 'tension carries the source-grounded pre-goal score, never the settled score');
  assert.equal(goal.beats[1].kind, 'celebration');
  assert.equal(goal.beats[1].lifecycle, 'confirmed');
  assert.deepEqual(goal.beats[1].scoreAtMoment, { participant1: 1, participant2: 0 });

  assert.ok(goal.scoreEvents.includes('opener'), 'first goal of the match from 0-0 should be classified as opener');
});

test('a later goal tension beat preserves the pre-goal score before and after confirmation', () => {
  const firstGoalFrame = frame({
    cues: [
      cue({ id: `cue:${FIXTURE_ID}:goal:601`, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1, teamId: 'team-a' }),
      cue({ kind: 'score_commit', lifecycle: 'confirmed', value: { participant1: 1, participant2: 0 } }),
    ],
  });
  const secondGoalCueId = `cue:${FIXTURE_ID}:goal:602`;
  const secondPendingFrame = frame({
    cues: [cue({ id: secondGoalCueId, kind: 'goal_pending', lifecycle: 'provisional', participant: 1, teamId: 'team-a' })],
  });
  const secondConfirmFrame = frame({
    cues: [
      cue({ id: secondGoalCueId, kind: 'goal_confirmed', lifecycle: 'confirmed', participant: 1, teamId: 'team-a' }),
      cue({ kind: 'score_commit', lifecycle: 'confirmed', value: { participant1: 2, participant2: 0 } }),
    ],
  });

  const pendingScenes = buildGameViewTimeline([firstGoalFrame, secondPendingFrame]);
  const pendingGoal = pendingScenes.find((scene) => scene.sourceFrameIds.includes(secondPendingFrame.id));
  assert.deepEqual(pendingGoal.beats[0].scoreAtMoment, { participant1: 1, participant2: 0 });

  const confirmedScenes = buildGameViewTimeline([firstGoalFrame, secondPendingFrame, secondConfirmFrame]);
  const confirmedGoal = confirmedScenes.find((scene) => scene.sourceFrameIds.includes(secondPendingFrame.id));
  assert.deepEqual(confirmedGoal.scoreAtMoment, { participant1: 2, participant2: 0 });
  assert.deepEqual(confirmedGoal.beats[0].scoreAtMoment, { participant1: 1, participant2: 0 });
  assert.deepEqual(confirmedGoal.beats[1].scoreAtMoment, { participant1: 2, participant2: 0 });
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

test('set_piece scenes carry the cue zone, falling back to the last known possession zone', () => {
  // A throw-in cue with its own zone keeps it.
  const zonedThrowIn = frame({ cues: [cue({ kind: 'set_piece', participant: 1, teamId: 'team-a', probableZone: 'danger', value: { action: 'throw_in' } })] });
  const [zonedScene] = buildGameViewTimeline([zonedThrowIn]).filter((scene) => scene.kind === 'set_piece');
  assert.equal(zonedScene.zone, 'danger');

  // Real feeds routinely omit the zone on throw-ins: the scene inherits the
  // last zone possession placed the play in, so the renderer can stage the
  // dead ball where play actually was.
  const possession = frame({ cues: [cue({ kind: 'possession_pressure', participant: 1, teamId: 'team-a', probableZone: 'attack', pressure: 'attack' })] });
  const zonelessThrowIn = frame({ cues: [cue({ kind: 'set_piece', participant: 2, teamId: 'team-b', value: { action: 'throw_in' } })] });
  const scenes = buildGameViewTimeline([possession, zonelessThrowIn]);
  const setPiece = scenes.find((scene) => scene.kind === 'set_piece');
  assert.equal(setPiece.zone, 'attack');
});

test('ordinary provisional and confirmed incident revisions upgrade one scene in place', () => {
  const incidentId = `cue:${FIXTURE_ID}:corner:one-real-event`;
  const provisional = frame({
    matchClockSeconds: 120,
    cues: [cue({
      id: incidentId,
      kind: 'set_piece',
      lifecycle: 'provisional',
      participant: 2,
      teamId: 'team-b',
      probableZone: 'danger',
      value: { action: 'corner' },
    })],
  });
  const confirmed = frame({
    matchClockSeconds: 120,
    cues: [cue({
      id: incidentId,
      kind: 'set_piece',
      lifecycle: 'confirmed',
      participant: 2,
      teamId: 'team-b',
      probableZone: 'high_danger',
      value: { action: 'corner' },
    })],
  });

  const corners = buildGameViewTimeline([provisional, confirmed])
    .filter((scene) => scene.kind === 'set_piece' && scene.sourceAction === 'corner');

  assert.equal(corners.length, 1, 'one source incident must never play as two corners');
  assert.equal(corners[0].lifecycle, 'confirmed');
  assert.equal(corners[0].zone, 'high_danger');
  assert.deepEqual(corners[0].sourceFrameIds, [provisional.id, confirmed.id]);
});

test('a retracted minor incident is omitted from the finalized scene timeline', () => {
  const incidentId = `cue:${FIXTURE_ID}:corner:retracted`;
  const provisional = frame({
    matchClockSeconds: 240,
    cues: [cue({
      id: incidentId,
      kind: 'set_piece',
      lifecycle: 'provisional',
      participant: 1,
      teamId: 'team-a',
      value: { action: 'corner' },
    })],
  });
  const retracted = frame({
    matchClockSeconds: 241,
    cues: [cue({
      id: incidentId,
      kind: 'incident_retracted',
      lifecycle: 'retracted',
      participant: 1,
      teamId: 'team-a',
      value: { action: 'corner' },
    })],
  });

  const scenes = buildGameViewTimeline([provisional, retracted]);

  assert.equal(
    scenes.some((scene) => scene.kind === 'set_piece' && scene.sourceAction === 'corner'),
    false,
  );
  assert.equal(scenes.some((scene) => scene.kind === 'goal_retracted'), false);
});

test('within one frame, a red card outranks a simultaneous set piece and both are still emitted in priority order', () => {
  const cardCue = cue({ kind: 'card', participant: 1, teamId: 'team-a', value: { action: 'red_card' } });
  const setPieceCue = cue({ kind: 'set_piece', participant: 2, teamId: 'team-b' });
  const collisionFrame = frame({ cues: [setPieceCue, cardCue] }); // deliberately out of priority order in the input

  const scenes = buildGameViewTimeline([collisionFrame]);

  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].kind, 'card', 'red card is processed first (higher takeover priority)');
  assert.equal(scenes[1].kind, 'set_piece');
  assert.deepEqual(scenes[0].sourceCueIds, [cardCue.id]);
  assert.deepEqual(scenes[1].sourceCueIds, [setPieceCue.id]);
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

test('same-kind scenes from one frame have distinct cue-grounded ids', () => {
  const firstCard = cue({
    id: `cue:${FIXTURE_ID}:card:first`,
    kind: 'card',
    participant: 1,
    teamId: 'team-a',
    value: { action: 'yellow_card' },
  });
  const secondCard = cue({
    id: `cue:${FIXTURE_ID}:card:second`,
    kind: 'card',
    participant: 2,
    teamId: 'team-b',
    value: { action: 'yellow_card' },
  });

  const scenes = buildGameViewTimeline([frame({ cues: [firstCard, secondCard] })]);

  assert.equal(scenes.length, 2);
  assert.notEqual(scenes[0].id, scenes[1].id);
  assert.deepEqual(scenes.map((scene) => scene.sourceCueIds), [
    [firstCard.id],
    [secondCard.id],
  ]);
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

test('replay summary keeps the last real ambient scene in each 120-second match-clock bucket', () => {
  const first = frame({ matchClockSeconds: 10, cues: [cue({ kind: 'possession_change', participant: 1, teamId: 'team-a', pressure: 'safe', probableZone: 'safe' })] });
  const second = frame({ matchClockSeconds: 30, cues: [cue({ kind: 'possession_change', participant: 2, teamId: 'team-b', pressure: 'attack', probableZone: 'attack' })] });
  const bucketZeroLast = frame({ matchClockSeconds: 119, cues: [cue({ kind: 'possession_pressure', participant: 1, teamId: 'team-a', pressure: 'danger', probableZone: 'danger' })] });
  const bucketOneLast = frame({ matchClockSeconds: 121, cues: [cue({ kind: 'possession_pressure', participant: 1, teamId: 'team-a', pressure: 'high_danger', probableZone: 'high_danger' })] });

  const complete = buildGameViewTimeline([first, second, bucketZeroLast, bucketOneLast]);
  const summary = buildGameViewTimeline(
    [first, second, bucketZeroLast, bucketOneLast],
    { pacing: { mode: 'replay' } },
  );

  assert.equal(complete.filter((scene) => scene.kind === 'ambient').length, 4, 'unpaced/live remains complete');
  assert.deepEqual(
    summary.filter((scene) => scene.kind === 'ambient').map((scene) => scene.sourceFrameIds),
    [[bucketZeroLast.id], [bucketOneLast.id]],
  );
});

test('replay summary samples routine set pieces once per source action per half and retains every attacking set piece', () => {
  const frames = [];
  const addPhase = (phase, clock) => frames.push(frame({ matchClockSeconds: clock, cues: [cue({ kind: 'phase_change', value: { phase } })] }));
  const addSetPiece = (action, zone, clock) => frames.push(frame({
    matchClockSeconds: clock,
    cues: [cue({ kind: 'set_piece', participant: 1, teamId: 'team-a', probableZone: zone, value: { action } })],
  }));

  addPhase('first_half', 0);
  addSetPiece('throw_in', 'safe', 10);
  addSetPiece('throw_in', 'attack', 20);
  addSetPiece('goal_kick', 'safe', 30);
  addSetPiece('goal_kick', 'safe', 40);
  addSetPiece('free_kick', 'safe', 50);
  addSetPiece('free_kick', 'attack', 60);
  addSetPiece('free_kick', 'danger', 70);
  addSetPiece('free_kick', 'danger', 80);
  addSetPiece('corner', 'danger', 90);
  addSetPiece('corner', 'high_danger', 100);
  addSetPiece('penalty', 'high_danger', 110);
  addPhase('second_half', 2700);
  addSetPiece('throw_in', 'safe', 2710);
  addSetPiece('throw_in', 'attack', 2720);
  addSetPiece('goal_kick', 'safe', 2730);
  addSetPiece('goal_kick', 'safe', 2740);
  addSetPiece('free_kick', 'safe', 2750);
  addSetPiece('free_kick', 'attack', 2760);
  addSetPiece('free_kick', 'high_danger', 2770);
  addSetPiece('free_kick', 'high_danger', 2780);
  addSetPiece('corner', 'danger', 2790);
  addSetPiece('corner', 'high_danger', 2800);
  addSetPiece('penalty', 'high_danger', 2810);

  const summarySetPieces = buildGameViewTimeline(frames, { pacing: { mode: 'replay' } })
    .filter((scene) => scene.kind === 'set_piece');
  const count = (action, zone) => summarySetPieces.filter((scene) => (
    scene.sourceAction === action && (zone === undefined || scene.zone === zone)
  )).length;

  assert.equal(count('throw_in'), 2, 'one routine throw-in per half');
  assert.equal(count('goal_kick'), 2, 'one routine goal kick per half');
  assert.equal(count('free_kick', 'safe') + count('free_kick', 'attack'), 2, 'one routine free kick per half');
  assert.equal(count('free_kick', 'danger'), 2, 'every danger free kick survives');
  assert.equal(count('free_kick', 'high_danger'), 2, 'every high-danger free kick survives');
  assert.equal(count('corner'), 4, 'every corner survives');
  assert.equal(count('penalty'), 2, 'every penalty survives');
});

test('replay selection is a deterministic truth-preserving subsequence and complete mode retains every scene', () => {
  const frames = replayContractFrames();
  const complete = buildGameViewTimeline(frames);
  const completeReplay = buildGameViewTimeline(frames, {
    pacing: { mode: 'replay', sceneSelection: 'complete', targetDurationMs: 1 },
  });
  const summary = buildGameViewTimeline(frames, { pacing: { mode: 'replay', targetDurationMs: 1 } });
  const shuffledSummary = buildGameViewTimeline([...frames].reverse(), {
    pacing: { mode: 'replay', targetDurationMs: 1 },
  });

  assert.deepEqual(completeReplay.map((scene) => scene.id), complete.map((scene) => scene.id));
  completeReplay.forEach((scene, index) => {
    assert.deepEqual(withoutPlayback(scene), complete[index], 'complete replay only adds pacing metadata');
  });

  let previousIndex = -1;
  for (const scene of summary) {
    const completeIndex = complete.findIndex((candidate) => candidate.id === scene.id);
    assert.ok(completeIndex > previousIndex, 'summary is a strict chronological subsequence');
    assert.deepEqual(withoutPlayback(scene), complete[completeIndex], 'selection preserves all scene truth and source ids');
    previousIndex = completeIndex;
  }
  assert.deepEqual(shuffledSummary, summary, 'input order cannot change replay selection or pacing');

  const protectedKinds = new Set([
    'goal_sequence', 'goal_retracted', 'card', 'var_review', 'substitution',
    'phase_break', 'shot', 'restart',
  ]);
  const summaryIds = new Set(summary.map((scene) => scene.id));
  for (const scene of complete.filter((candidate) => protectedKinds.has(candidate.kind))) {
    assert.ok(summaryIds.has(scene.id), `protected scene ${scene.id} (${scene.kind}) was dropped`);
  }
});

test('complete replay playbackRate accelerates every scene without changing truth, count, or order', () => {
  const frames = replayContractFrames();
  const normal = buildGameViewTimeline(frames, {
    pacing: { mode: 'replay', sceneSelection: 'complete', targetDurationMs: null },
  });
  const fast = buildGameViewTimeline(frames, {
    pacing: {
      mode: 'replay',
      sceneSelection: 'complete',
      targetDurationMs: null,
      playbackRate: 2,
    },
  });

  assert.equal(fast.length, normal.length);
  let runningOffset = 0;
  fast.forEach((scene, index) => {
    const normalScene = normal[index];
    assert.deepEqual(withoutPlayback(scene), withoutPlayback(normalScene));
    assert.equal(scene.playback.playbackOffsetMs, runningOffset);
    assert.equal(
      scene.playback.playbackDurationMs,
      Math.max(1, Math.round(normalScene.playback.playbackDurationMs / 2)),
    );
    runningOffset += scene.playback.playbackDurationMs;
  });
});

test('replay target never compresses retained choreography below its scene minimum or ambient below 900ms', () => {
  const scenes = buildGameViewTimeline(replayContractFrames(), {
    pacing: { mode: 'replay', targetDurationMs: 1 },
  });

  let runningOffset = 0;
  for (const scene of scenes) {
    assert.equal(scene.playback.playbackOffsetMs, runningOffset, 'playback windows tile without gaps');
    if (scene.kind === 'ambient') {
      assert.ok(scene.playback.playbackDurationMs >= 900, 'ambient transition keeps its readability floor');
    } else {
      assert.equal(
        scene.playback.playbackDurationMs,
        scene.durationHint.minMs,
        `${scene.kind} keeps its full staged choreography window`,
      );
    }
    runningOffset += scene.playback.playbackDurationMs;
  }
  assert.ok(runningOffset > 1, 'the target is best-effort when protected/floored time already exceeds it');
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
