import assert from 'node:assert/strict';
import test from 'node:test';

import { computeBeatNarrative } from '../src/match-engine/index.ts';

const fixtureId = 18179759;

const teams = {
  mexico: { participant: 1, teamId: 'mexico' },
  ecuador: { participant: 2, teamId: 'ecuador' },
};

function cue(id, kind, overrides = {}) {
  return {
    id,
    kind,
    updateMode: 'incident_upsert',
    lifecycle: 'confirmed',
    basis: 'direct',
    revision: 1,
    value: {},
    sourceSeqs: [1],
    factIds: [],
    ...overrides,
  };
}

function scoreCue(id, participant1, participant2, seq) {
  return cue(id, 'score_commit', {
    updateMode: 'state_replace',
    value: { participant1, participant2 },
    sourceSeqs: [seq],
  });
}

function goalCue(id, participant, teamKey, seq, player) {
  return cue(id, 'goal_confirmed', {
    participant,
    teamId: teams[teamKey].teamId,
    value: { action: 'goal' },
    sourceSeqs: [seq],
    ...(player ? { player } : {}),
  });
}

function cardCue(id, participant, teamKey, seq, action, player) {
  return cue(id, 'card', {
    participant,
    teamId: teams[teamKey].teamId,
    value: { action },
    sourceSeqs: [seq],
    ...(player ? { player } : {}),
  });
}

function setPieceCue(id, participant, teamKey, seq, action = 'corner') {
  return cue(id, 'set_piece', {
    participant,
    teamId: teams[teamKey].teamId,
    value: { action },
    sourceSeqs: [seq],
  });
}

function beat(id, kind, cues, overrides = {}) {
  return {
    id,
    fixtureId,
    projectionGeneration: 0,
    kind,
    mustCover: kind === 'major',
    fromSeq: cues[0]?.sourceSeqs[0] ?? 0,
    toSeq: cues[cues.length - 1]?.sourceSeqs[0] ?? 0,
    participant: cues[0]?.participant,
    teamId: cues[0]?.teamId,
    sourceFrameIds: [],
    sources: [],
    factIds: [],
    cueIds: cues.map((c) => c.id),
    facts: [],
    simulationCues: cues,
    fallbackCommentary: '',
    ...overrides,
  };
}

function player(normativeId, teamKey, name) {
  return {
    normativeId,
    participant: teams[teamKey].participant,
    teamId: teams[teamKey].teamId,
    sourcePreferredName: name,
  };
}

const baseState = {
  fixtureId,
  lastAppliedSeq: 0,
  stateRevision: 0,
  phase: 'first_half',
  confirmedScore: { participant1: 0, participant2: 0 },
  possibleEvents: {},
  activePlayerIdsByParticipant: { '1': [1, 2, 3], '2': [4, 5, 6] },
  disciplineByPlayerId: {},
  incidents: {},
  supportedFacts: {},
  simulationCues: {},
  integrityWarnings: [],
};

test('opener: first goal of the match classifies as opener', () => {
  const scorer = player(101, 'mexico', 'Scorer One');
  const beats = [
    beat('b0', 'major', [
      goalCue('goal:1', 1, 'mexico', 10, scorer),
      scoreCue('score:1', 1, 0, 10),
    ], { matchClockSeconds: 600 }),
  ];
  const result = computeBeatNarrative({ beat: beats[0], beatIndex: 0, beats, state: baseState });

  assert.ok(result);
  assert.deepEqual(result.scoreStory.events, ['opener']);
  assert.deepEqual(result.scoreStory.before, { participant1: 0, participant2: 0 });
  assert.deepEqual(result.scoreStory.after, { participant1: 1, participant2: 0 });
  assert.equal(result.scoreStory.leadChangeCount, 1);
  assert.equal(result.playerMemory.scorerGoalsThisMatch, 1);
  assert.ok(result.scoreStory.derivedFrom.includes('goal:1'));
});

test('equaliser: goal levels the score after trailing', () => {
  const beats = [
    beat('b0', 'major', [goalCue('goal:1', 1, 'mexico', 10, player(101, 'mexico', 'A')), scoreCue('score:1', 1, 0, 10)], { matchClockSeconds: 600 }),
    beat('b1', 'major', [goalCue('goal:2', 2, 'ecuador', 20, player(201, 'ecuador', 'B')), scoreCue('score:2', 1, 1, 20)], { matchClockSeconds: 1200 }),
  ];
  const result = computeBeatNarrative({ beat: beats[1], beatIndex: 1, beats, state: baseState });

  assert.ok(result);
  assert.deepEqual(result.scoreStory.events, ['equaliser']);
  assert.deepEqual(result.scoreStory.before, { participant1: 1, participant2: 0 });
  assert.deepEqual(result.scoreStory.after, { participant1: 1, participant2: 1 });
});

test('comeback: team down 0-2 reaches 2-2', () => {
  const beats = [
    beat('b0', 'major', [goalCue('goal:1', 2, 'ecuador', 10, player(201, 'ecuador', 'B')), scoreCue('score:1', 0, 1, 10)], { matchClockSeconds: 300 }),
    beat('b1', 'major', [goalCue('goal:2', 2, 'ecuador', 20, player(202, 'ecuador', 'C')), scoreCue('score:2', 0, 2, 20)], { matchClockSeconds: 900 }),
    beat('b2', 'major', [goalCue('goal:3', 1, 'mexico', 30, player(101, 'mexico', 'A')), scoreCue('score:3', 1, 2, 30)], { matchClockSeconds: 1500 }),
    beat('b3', 'major', [goalCue('goal:4', 1, 'mexico', 40, player(102, 'mexico', 'D')), scoreCue('score:4', 2, 2, 40)], { matchClockSeconds: 2100 }),
  ];
  const result = computeBeatNarrative({ beat: beats[3], beatIndex: 3, beats, state: baseState });

  assert.ok(result);
  assert.ok(result.scoreStory.events.includes('comeback'));
  assert.ok(result.scoreStory.events.includes('equaliser'));
  // comeback is narratively strongest, ordered first
  assert.equal(result.scoreStory.events[0], 'comeback');
});

test('lead_change: scoring team goes from trailing to leading', () => {
  const beats = [
    beat('b0', 'major', [goalCue('goal:1', 2, 'ecuador', 10, player(201, 'ecuador', 'B')), scoreCue('score:1', 0, 1, 10)], { matchClockSeconds: 300 }),
    beat('b1', 'major', [goalCue('goal:2', 1, 'mexico', 20, player(101, 'mexico', 'A')), scoreCue('score:2', 1, 1, 20)], { matchClockSeconds: 900 }),
    beat('b2', 'major', [goalCue('goal:3', 1, 'mexico', 30, player(102, 'mexico', 'D')), scoreCue('score:3', 2, 1, 30)], { matchClockSeconds: 1500 }),
  ];
  const result = computeBeatNarrative({ beat: beats[2], beatIndex: 2, beats, state: baseState });

  assert.ok(result);
  assert.deepEqual(result.scoreStory.events, ['lead_change']);
  assert.equal(result.scoreStory.leadChangeCount, 2);
});

test('late_winner: stoppage-time goal creates a decisive lead from level', () => {
  const beats = [
    beat('b0', 'major', [goalCue('goal:1', 1, 'mexico', 10, player(101, 'mexico', 'A')), scoreCue('score:1', 1, 0, 10)], { matchClockSeconds: 600 }),
    beat('b1', 'major', [goalCue('goal:2', 2, 'ecuador', 20, player(201, 'ecuador', 'B')), scoreCue('score:2', 1, 1, 20)], { matchClockSeconds: 1200 }),
    // second half stoppage: 45*60 (first half) + 45*60 (second half reg) + 60s = 5460
    beat('b2', 'major', [goalCue('goal:3', 1, 'mexico', 30, player(102, 'mexico', 'D')), scoreCue('score:3', 2, 1, 30)], { matchClockSeconds: 5460 }),
  ];
  const stateSecondHalf = { ...baseState, phase: 'second_half' };
  const result = computeBeatNarrative({ beat: beats[2], beatIndex: 2, beats, state: stateSecondHalf });

  assert.ok(result);
  assert.ok(result.scoreStory.events.includes('late_winner'));
  assert.equal(result.scoreStory.events[0], 'late_winner');
  assert.equal(result.timeContext, 'stoppage');
});

test('second yellow becomes a red card and sets secondYellowRed', () => {
  const carded = player(101, 'mexico', 'Carded Player');
  const beats = [
    beat('b0', 'routine', [cardCue('card:1', 1, 'mexico', 10, 'yellow_card', carded)], { matchClockSeconds: 600 }),
    beat('b1', 'major', [cardCue('card:2', 1, 'mexico', 20, 'red_card', carded)], { matchClockSeconds: 1200 }),
  ];
  const state = {
    ...baseState,
    activePlayerIdsByParticipant: { '1': [102, 103], '2': [4, 5, 6] },
  };
  const result = computeBeatNarrative({ beat: beats[1], beatIndex: 1, beats, state });

  assert.ok(result);
  assert.equal(result.discipline.secondYellowRed, true);
  assert.equal(result.discipline.playerPriorYellows, 1);
  assert.equal(result.discipline.menRemainingReduced, true);
});

test('team fourth yellow count is tallied across different players', () => {
  const beats = [
    beat('b0', 'routine', [cardCue('card:1', 1, 'mexico', 10, 'yellow_card', player(101, 'mexico', 'A'))], { matchClockSeconds: 300 }),
    beat('b1', 'routine', [cardCue('card:2', 1, 'mexico', 20, 'yellow_card', player(102, 'mexico', 'B'))], { matchClockSeconds: 900 }),
    beat('b2', 'routine', [cardCue('card:3', 1, 'mexico', 30, 'yellow_card', player(103, 'mexico', 'C'))], { matchClockSeconds: 1500 }),
    beat('b3', 'routine', [cardCue('card:4', 1, 'mexico', 40, 'yellow_card', player(104, 'mexico', 'D'))], { matchClockSeconds: 2100 }),
  ];
  const result = computeBeatNarrative({ beat: beats[3], beatIndex: 3, beats, state: baseState });

  assert.ok(result);
  assert.equal(result.discipline.teamYellowCount, 4);
  assert.equal(result.discipline.secondYellowRed, false);
});

test('brace detection: second goal by same scorer counts scorerGoalsThisMatch as 2', () => {
  const scorer = player(101, 'mexico', 'Scorer One');
  const beats = [
    beat('b0', 'major', [goalCue('goal:1', 1, 'mexico', 10, scorer), scoreCue('score:1', 1, 0, 10)], { matchClockSeconds: 300 }),
    beat('b1', 'major', [goalCue('goal:2', 1, 'mexico', 20, scorer), scoreCue('score:2', 2, 0, 20)], { matchClockSeconds: 900 }),
  ];
  const result = computeBeatNarrative({ beat: beats[1], beatIndex: 1, beats, state: baseState });

  assert.ok(result);
  assert.equal(result.playerMemory.scorerGoalsThisMatch, 2);
});

test('pressure spell counting accumulates consecutive same-team pressure beats', () => {
  const beats = [
    beat('b0', 'pressure', [setPieceCue('corner:1', 1, 'mexico', 10)], { matchClockSeconds: 100 }),
    beat('b1', 'pressure', [setPieceCue('corner:2', 1, 'mexico', 20)], { matchClockSeconds: 200 }),
    beat('b2', 'pressure', [setPieceCue('corner:3', 1, 'mexico', 30)], { matchClockSeconds: 300 }),
  ];
  const result = computeBeatNarrative({ beat: beats[2], beatIndex: 2, beats, state: baseState });

  assert.ok(result);
  assert.equal(result.momentum.pressureSpellBeats, 3);
  assert.equal(result.momentum.setPieceCountRecentWindow, 3);
});

test('relevance gating: a routine beat with nothing notable returns undefined', () => {
  const beats = [
    beat('b0', 'routine', [cue('possession:1', 'possession_change', {
      updateMode: 'state_replace',
      participant: 1,
      teamId: teams.mexico.teamId,
    })], { matchClockSeconds: 100 }),
  ];
  const result = computeBeatNarrative({ beat: beats[0], beatIndex: 0, beats, state: baseState });

  assert.equal(result, undefined);
});

test('relevance gating: a goal beat has no discipline slice', () => {
  const beats = [
    beat('b0', 'major', [goalCue('goal:1', 1, 'mexico', 10, player(101, 'mexico', 'A')), scoreCue('score:1', 1, 0, 10)], { matchClockSeconds: 300 }),
  ];
  const result = computeBeatNarrative({ beat: beats[0], beatIndex: 0, beats, state: baseState });

  assert.ok(result);
  assert.equal(result.discipline, undefined);
  assert.equal(result.momentum, undefined);
});

test('relevance gating: a card beat has no scoreStory or momentum slice', () => {
  const beats = [
    beat('b0', 'routine', [cardCue('card:1', 1, 'mexico', 10, 'yellow_card', player(101, 'mexico', 'A'))], { matchClockSeconds: 300 }),
  ];
  const result = computeBeatNarrative({ beat: beats[0], beatIndex: 0, beats, state: baseState });

  assert.ok(result);
  assert.equal(result.scoreStory, undefined);
  assert.equal(result.playerMemory, undefined);
  assert.equal(result.momentum, undefined);
});

test('missing player id is handled gracefully: goal without player omits playerMemory but keeps scoreStory', () => {
  const beats = [
    beat('b0', 'major', [goalCue('goal:1', 1, 'mexico', 10), scoreCue('score:1', 1, 0, 10)], { matchClockSeconds: 300 }),
  ];
  const result = computeBeatNarrative({ beat: beats[0], beatIndex: 0, beats, state: baseState });

  assert.ok(result);
  assert.ok(result.scoreStory);
  assert.equal(result.playerMemory, undefined);
});

test('missing clock data omits timeContext but keeps other slices', () => {
  const beats = [
    beat('b0', 'major', [goalCue('goal:1', 1, 'mexico', 10, player(101, 'mexico', 'A')), scoreCue('score:1', 1, 0, 10)]),
  ];
  const result = computeBeatNarrative({ beat: beats[0], beatIndex: 0, beats, state: baseState });

  assert.ok(result);
  assert.equal(result.timeContext, undefined);
  assert.ok(result.scoreStory);
});

test('timeContext: closing stages attaches on a late card beat', () => {
  const beats = [
    beat('b0', 'routine', [cardCue('card:1', 1, 'mexico', 10, 'yellow_card', player(101, 'mexico', 'A'))], {
      matchClockSeconds: 4900,
    }),
  ];
  const state = { ...baseState, phase: 'second_half' };
  const result = computeBeatNarrative({ beat: beats[0], beatIndex: 0, beats, state });

  assert.ok(result);
  assert.equal(result.timeContext, 'closing_stages');
});

test('timeContext: pre_halftime attaches near the end of the first half', () => {
  const beats = [
    beat('b0', 'routine', [cardCue('card:1', 1, 'mexico', 10, 'yellow_card', player(101, 'mexico', 'A'))], {
      matchClockSeconds: 2500,
    }),
  ];
  const result = computeBeatNarrative({ beat: beats[0], beatIndex: 0, beats, state: baseState });

  assert.ok(result);
  assert.equal(result.timeContext, 'pre_halftime');
});
