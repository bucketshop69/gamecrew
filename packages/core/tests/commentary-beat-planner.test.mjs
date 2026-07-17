import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMENTARY_PLAN_VERSION,
  planCommentaryBeats,
} from '../src/match-engine/index.ts';

const fixtureId = 18179759;

function fact(id, seq, overrides = {}) {
  return {
    id,
    kind: 'incident',
    lifecycle: 'confirmed',
    basis: 'direct',
    revision: 1,
    value: {},
    sourceSeqs: [seq],
    provenance: { fixtureId, action: 'test', sourceId: id, seq },
    ...overrides,
  };
}

function cue(id, kind, seq, overrides = {}) {
  return {
    id,
    kind,
    updateMode: 'incident_upsert',
    lifecycle: 'confirmed',
    basis: 'direct',
    revision: 1,
    value: {},
    sourceSeqs: [seq],
    factIds: [`fact:${id}`],
    ...overrides,
  };
}

function frame(seq, clock, cues, facts = cues.map((item) => fact(item.factIds[0], seq))) {
  return {
    id: `${fixtureId}:${seq}`,
    fixtureId,
    seq,
    stateRevision: seq,
    matchClockSeconds: clock,
    facts,
    simulationCues: cues,
  };
}

const teams = [
  { participant: 1, teamId: 'mexico', name: 'Mexico' },
  { participant: 2, teamId: 'ecuador', name: 'Ecuador' },
];

test('emits corner and shot immediately with stable versioned ids and no overlapping summary', () => {
  const corner = cue('corner:1', 'set_piece', 10, {
    participant: 1,
    teamId: 'mexico',
    value: { action: 'corner' },
  });
  const shot = cue('shot:2', 'shot_outcome', 11, {
    participant: 1,
    teamId: 'mexico',
    value: { action: 'shot' },
  });

  const beats = planCommentaryBeats([
    frame(11, 660, [shot]),
    frame(10, 620, [corner]),
  ], { projectionGeneration: 4, teams });

  assert.equal(COMMENTARY_PLAN_VERSION, 3);
  assert.equal(beats.length, 2);
  assert.deepEqual(beats.map((beat) => beat.kind), ['routine', 'routine']);
  assert.deepEqual(beats.map((beat) => beat.id), [
    '18179759:commentary:0:routine:10:10:corner%3A1',
    '18179759:commentary:0:routine:11:11:shot%3A2',
  ]);
  assert.deepEqual(beats.map((beat) => beat.plannerVersion), [3, 3]);
  assert.deepEqual(beats.map((beat) => beat.sourceFrameIds), [
    ['18179759:10'],
    ['18179759:11'],
  ]);
  assert.equal(beats[0].fallbackCommentary, 'Mexico win a corner.');
  assert.equal(beats[1].fallbackCommentary, 'Mexico have an effort.');
});

test('splits same-frame card and corner cues into distinct immediate beats', () => {
  const yellowCard = cue('card:same-frame', 'card', 12, {
    participant: 2,
    teamId: 'ecuador',
    value: { action: 'yellow_card' },
  });
  const corner = cue('corner:same-frame', 'set_piece', 12, {
    participant: 1,
    teamId: 'mexico',
    value: { action: 'corner' },
  });

  const beats = planCommentaryBeats([
    frame(12, 680, [yellowCard, corner]),
  ], { projectionGeneration: 4, teams });

  assert.equal(beats.length, 2);
  assert.deepEqual(beats.map((beat) => beat.id), [
    '18179759:commentary:0:routine:12:12:card%3Asame-frame',
    '18179759:commentary:0:routine:12:12:corner%3Asame-frame',
  ]);
  assert.deepEqual(beats.map((beat) => beat.cueIds), [
    ['card:same-frame'],
    ['corner:same-frame'],
  ]);
  assert.deepEqual(beats.map((beat) => beat.fallbackCommentary), [
    'Ecuador receive a yellow card.',
    'Mexico win a corner.',
  ]);
});

test('admits throw-ins and observed goal kicks as immediate beats', () => {
  const throwIn = cue('throw:1', 'set_piece', 20, {
    participant: 2,
    teamId: 'ecuador',
    value: { action: 'throw_in' },
  });
  const goalKick = cue('goal-kick:1', 'set_piece', 21, {
    lifecycle: 'observed',
    participant: 1,
    teamId: 'mexico',
    value: { action: 'goal_kick' },
  });

  const beats = planCommentaryBeats([
    frame(20, 700, [throwIn]),
    frame(21, 710, [goalKick]),
  ], { projectionGeneration: 0, teams });

  assert.deepEqual(beats.map((beat) => beat.fallbackCommentary), [
    'Throw-in to Ecuador.',
    'Mexico take the goal kick.',
  ]);
  assert.deepEqual(beats.map((beat) => beat.cueIds), [['throw:1'], ['goal-kick:1']]);
});

test('admits possession changes and all pressure zones while collapsing repeated identical pressure', () => {
  const possession = cue('possession', 'possession_change', 30, {
    updateMode: 'state_replace',
    lifecycle: 'observed',
    participant: 1,
    teamId: 'mexico',
  });
  const safePressure = (seq, teamId = 'mexico', participant = 1) => cue('pressure', 'possession_pressure', seq, {
    updateMode: 'state_replace',
    lifecycle: 'observed',
    basis: 'derived_probable',
    participant,
    teamId,
    pressure: 'safe',
    probableZone: 'safe',
  });
  const neutralPressure = cue('pressure', 'possession_pressure', 34, {
    updateMode: 'state_replace',
    lifecycle: 'observed',
    basis: 'derived_probable',
    participant: 2,
    teamId: 'ecuador',
    pressure: 'neutral',
    probableZone: 'neutral',
  });
  const advancedPressure = (seq, pressure) => cue('pressure', 'possession_pressure', seq, {
    updateMode: 'state_replace',
    lifecycle: 'observed',
    basis: 'derived_probable',
    participant: 2,
    teamId: 'ecuador',
    pressure,
    probableZone: pressure,
  });

  const beats = planCommentaryBeats([
    frame(30, 800, [possession]),
    frame(31, 810, [safePressure(31)]),
    frame(32, 820, [safePressure(32)]),
    frame(33, 830, [safePressure(33, 'ecuador', 2)]),
    frame(34, 840, [neutralPressure]),
    frame(35, 850, [advancedPressure(35, 'attack')]),
    frame(36, 860, [advancedPressure(36, 'danger')]),
    frame(37, 870, [advancedPressure(37, 'high_danger')]),
  ], { projectionGeneration: 0, teams });

  assert.deepEqual(beats.map((beat) => beat.sourceFrameIds), [
    ['18179759:30'],
    ['18179759:31'],
    ['18179759:33'],
    ['18179759:34'],
    ['18179759:35'],
    ['18179759:36'],
    ['18179759:37'],
  ]);
  assert.deepEqual(beats.map((beat) => beat.fallbackCommentary), [
    'Mexico take possession.',
    'Mexico keep the ball in a safe area.',
    'Ecuador keep the ball in a safe area.',
    'Ecuador retain possession.',
    'Ecuador move onto the attack.',
    'Ecuador advance into a dangerous area.',
    'Ecuador threaten the goal.',
  ]);
});

test('collapses provisional and confirmed routine revisions at the first confirmed anchor', () => {
  const provisional = cue('corner:revised', 'set_piece', 40, {
    lifecycle: 'provisional',
    revision: 1,
    participant: 1,
    teamId: 'mexico',
    value: { action: 'corner' },
  });
  const confirmed = { ...provisional, lifecycle: 'confirmed', revision: 2, sourceSeqs: [40, 41] };
  const enriched = {
    ...confirmed,
    revision: 3,
    sourceSeqs: [40, 41, 43],
    player: {
      normativeId: 99,
      participant: 1,
      teamId: 'mexico',
      sourcePreferredName: 'Quinones, Julian',
      displayName: 'Julián Quiñones',
    },
  };

  const beats = planCommentaryBeats([
    frame(40, 900, [provisional]),
    frame(41, 900, [confirmed]),
    frame(43, 900, [enriched]),
  ], { projectionGeneration: 1, teams });

  assert.equal(beats.length, 1);
  assert.equal(beats[0].fromSeq, 41);
  assert.equal(beats[0].toSeq, 41);
  assert.deepEqual(beats[0].sourceFrameIds, ['18179759:41']);
  assert.equal(beats[0].simulationCues[0].revision, 3);
  assert.equal(beats[0].simulationCues[0].player.displayName, 'Julián Quiñones');
});

test('keeps a goal major isolated and retains full lifecycle evidence for enrichment', () => {
  const pendingGoal = cue('goal:7', 'goal_pending', 50, {
    lifecycle: 'provisional',
    participant: 1,
    teamId: 'mexico',
    value: { action: 'goal', sourceId: 7 },
  });
  const goal = cue('goal:7', 'goal_confirmed', 51, {
    revision: 2,
    participant: 1,
    teamId: 'mexico',
    value: { action: 'goal', sourceId: 7 },
  });
  const score = cue('score', 'score_commit', 51, {
    updateMode: 'state_replace',
    participant: 1,
    teamId: 'mexico',
    value: { participant1: 1, participant2: 0 },
  });
  const enrichedGoal = {
    ...goal,
    revision: 3,
    sourceSeqs: [50, 51, 53],
    player: {
      normativeId: 99,
      participant: 1,
      teamId: 'mexico',
      sourcePreferredName: 'Quinones Quinones, Julian Andres',
      displayName: 'Julián Quiñones',
    },
  };

  const inputFrames = [
    frame(50, 1000, [pendingGoal]),
    frame(51, 1000, [goal, score]),
    frame(53, 1000, [enrichedGoal]),
  ];
  const beats = planCommentaryBeats(inputFrames, { projectionGeneration: 0, teams });
  const rebuilt = planCommentaryBeats(inputFrames, { projectionGeneration: 1, teams });

  assert.equal(beats.length, 1);
  assert.equal(beats[0].kind, 'major');
  assert.equal(beats[0].mustCover, true);
  assert.equal(beats[0].id, '18179759:commentary:0:major:51:51:goal%3A7+score');
  assert.equal(rebuilt[0].id, beats[0].id, 'projection rebuilds retain source-grounded beat identity');
  assert.equal(rebuilt[0].projectionGeneration, 1);
  assert.deepEqual(beats[0].sourceFrameIds, [
    '18179759:50',
    '18179759:51',
    '18179759:53',
  ]);
  assert.match(beats[0].fallbackCommentary, /Julián Quiñones/);
  assert.match(beats[0].fallbackCommentary, /1-0/);
});

test('narrates only goal retractions and ignores minor incident corrections', () => {
  const goalRetraction = cue('goal:retracted', 'incident_retracted', 60, {
    lifecycle: 'retracted',
    participant: 1,
    teamId: 'mexico',
    value: { action: 'goal' },
  });
  const cornerRetraction = cue('corner:retracted', 'incident_retracted', 61, {
    lifecycle: 'retracted',
    participant: 1,
    teamId: 'mexico',
    value: { action: 'corner' },
  });

  const beats = planCommentaryBeats([
    frame(60, 1100, [goalRetraction]),
    frame(61, 1110, [cornerRetraction]),
  ], { projectionGeneration: 0, teams });

  assert.equal(beats.length, 1);
  assert.equal(beats[0].kind, 'major');
  assert.equal(beats[0].fallbackCommentary, 'The goal is ruled out.');
});

test('isolates red cards, half-time, and full-time as major beats', () => {
  const redCard = cue('card:red', 'card', 65, {
    participant: 2,
    teamId: 'ecuador',
    value: { action: 'red_card' },
  });
  const halfTime = cue('phase', 'phase_change', 66, {
    updateMode: 'state_replace',
    lifecycle: 'observed',
    value: { phase: 'half_time' },
  });
  const fullTime = cue('phase', 'phase_change', 67, {
    updateMode: 'state_replace',
    lifecycle: 'observed',
    value: { phase: 'finalised' },
  });

  const beats = planCommentaryBeats([
    frame(65, 1150, [redCard]),
    frame(66, 2700, [halfTime]),
    frame(67, 5400, [fullTime]),
  ], { projectionGeneration: 0, teams });

  assert.deepEqual(beats.map((beat) => beat.kind), ['major', 'major', 'major']);
  assert.deepEqual(beats.map((beat) => beat.mustCover), [true, true, true]);
  assert.deepEqual(beats.map((beat) => beat.fallbackCommentary), [
    'Ecuador receive a red card.',
    'The first half comes to an end.',
    'The match is over.',
  ]);
});

test('provides deterministic fallbacks for free kicks, penalties, and shot attempts', () => {
  const actions = [
    cue('free-kick', 'set_piece', 70, {
      participant: 1, teamId: 'mexico', value: { action: 'free_kick' },
    }),
    cue('penalty', 'set_piece', 71, {
      participant: 2, teamId: 'ecuador', value: { action: 'penalty' },
    }),
    cue('shot-attempt', 'shot_attempt', 72, {
      updateMode: 'state_replace',
      lifecycle: 'observed',
      participant: 1,
      teamId: 'mexico',
      value: { action: 'shot' },
    }),
  ];

  const beats = planCommentaryBeats(
    actions.map((item, index) => frame(70 + index, 1200 + index * 10, [item])),
    { projectionGeneration: 0, teams },
  );

  assert.deepEqual(beats.map((beat) => beat.fallbackCommentary), [
    'Mexico win a free kick.',
    'Ecuador are awarded a penalty.',
    'Mexico have a shot.',
  ]);
});

test('labels initial, post-goal, and second-half restarts distinctly', () => {
  const restart = (id, seq, participant, phase) => frame(seq, seq * 10, [cue(id, 'restart', seq, {
    updateMode: 'state_replace',
    participant,
    teamId: participant === 1 ? 'mexico' : 'ecuador',
    value: { kind: 'kickoff' },
  })], [fact(`fact:${id}`, seq, { kind: 'phase', value: { phase } })]);
  const goal = cue('goal:restart', 'goal_confirmed', 81, {
    participant: 1,
    teamId: 'mexico',
    value: { action: 'goal' },
  });
  const beats = planCommentaryBeats([
    restart('initial', 80, 1, 'first_half'),
    frame(81, 810, [goal]),
    restart('after-goal', 82, 2, 'first_half'),
    restart('second-half', 83, 1, 'second_half'),
  ], { projectionGeneration: 0, teams });

  assert.deepEqual(beats.filter((beat) => beat.restartContext).map((beat) => beat.restartContext), [
    'initial', 'after_goal', 'second_half',
  ]);
  assert.deepEqual(beats.filter((beat) => beat.restartContext).map((beat) => beat.fallbackCommentary), [
    'Mexico get the match underway.',
    'Ecuador restart play after the goal.',
    'Mexico get the second half underway.',
  ]);
});

test('retains delayed confirmed incidents instead of silently dropping source truth', () => {
  const goal = cue('goal:chronology', 'goal_confirmed', 90, {
    participant: 1,
    teamId: 'mexico',
    occurrenceSeconds: 100,
    value: { action: 'goal' },
  });
  const oldShot = cue('shot:chronology', 'shot_outcome', 91, {
    participant: 1,
    teamId: 'mexico',
    occurrenceSeconds: 90,
    value: { action: 'shot' },
  });

  const beats = planCommentaryBeats([
    frame(90, 100, [goal]),
    frame(91, 90, [oldShot]),
  ], { projectionGeneration: 0, teams });

  assert.deepEqual(beats.flatMap((beat) => beat.cueIds), [
    'goal:chronology',
    'shot:chronology',
  ]);
});

test('ignores technical possible-event noise and rejects invalid generations', () => {
  const possible = cue('possible', 'possible_event', 100, {
    updateMode: 'state_replace',
    lifecycle: 'observed',
    value: { goal: true },
  });

  assert.deepEqual(
    planCommentaryBeats([frame(100, 1300, [possible])], { projectionGeneration: 0, teams }),
    [],
  );
  assert.throws(
    () => planCommentaryBeats([], { projectionGeneration: -1 }),
    /non-negative integer/,
  );
});
