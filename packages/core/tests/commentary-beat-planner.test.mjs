import assert from 'node:assert/strict';
import test from 'node:test';

import { planCommentaryBeats } from '../src/match-engine/index.ts';

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

test('groups same-team pressure frames and preserves generation and source coverage', () => {
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

  assert.equal(beats.length, 1);
  assert.equal(beats[0].id, '18179759:commentary:4:10:11');
  assert.equal(beats[0].projectionGeneration, 4);
  assert.equal(beats[0].mustCover, false);
  assert.equal(beats[0].kind, 'pressure');
  assert.deepEqual(beats[0].sourceFrameIds, ['18179759:10', '18179759:11']);
  assert.deepEqual(beats[0].cueIds, ['corner:1', 'shot:2']);
  assert.match(beats[0].fallbackCommentary, /^Mexico keep the pressure on/);
  assert.match(beats[0].fallbackCommentary, /1 corner and 1 effort/);
  assert.doesNotMatch(beats[0].fallbackCommentary, /coordinate|left|right|penalty area/i);
});

test('keeps major beats isolated and collapses later confirmed enrichment', () => {
  const corner = cue('corner:1', 'set_piece', 20, {
    participant: 1,
    teamId: 'mexico',
    value: { action: 'corner' },
  });
  const goal = cue('goal:7', 'goal_confirmed', 21, {
    participant: 1,
    teamId: 'mexico',
    value: { action: 'goal', sourceId: 7 },
  });
  const score = cue('score', 'score_commit', 21, {
    updateMode: 'state_replace',
    participant: 1,
    teamId: 'mexico',
    value: { participant1: 1, participant2: 0 },
  });
  const enrichedGoal = {
    ...goal,
    revision: 2,
    player: {
      normativeId: 99,
      participant: 1,
      teamId: 'mexico',
      sourcePreferredName: 'J. Quiñones',
      displayName: 'Julián Quiñones',
    },
    sourceSeqs: [21, 23],
  };

  const beats = planCommentaryBeats([
    frame(20, 800, [corner]),
    frame(21, 810, [goal, score]),
    frame(23, 810, [enrichedGoal]),
  ], { projectionGeneration: 0, teams });

  assert.equal(beats.length, 2);
  assert.equal(beats[0].kind, 'routine');
  assert.equal(beats[1].kind, 'major');
  assert.equal(beats[1].mustCover, true);
  assert.deepEqual(beats[1].sourceFrameIds, ['18179759:21', '18179759:23']);
  assert.deepEqual(beats[1].sources, [
    {
      frameId: '18179759:21',
      seq: 21,
      cueIds: ['goal:7', 'score'],
      cues: [
        { cueId: 'goal:7', action: 'goal' },
        { cueId: 'score', action: 'score_commit' },
      ],
      factIds: ['fact:goal:7', 'fact:score'],
    },
    {
      frameId: '18179759:23', seq: 23, cueIds: ['goal:7'],
      cues: [{ cueId: 'goal:7', action: 'goal' }], factIds: ['fact:goal:7'],
    },
  ]);
  assert.equal(beats[1].id, '18179759:commentary:0:21:21');
  assert.match(beats[1].fallbackCommentary, /Julián Quiñones/);
  assert.match(beats[1].fallbackCommentary, /1-0/);
});

test('maps non-contiguous pressure cues to their actual source seqs', () => {
  const corner = cue('corner:non-contiguous', 'set_piece', 40, {
    participant: 1, teamId: 'mexico', value: { action: 'corner' },
  });
  const shot = cue('shot:non-contiguous', 'shot_outcome', 47, {
    participant: 1, teamId: 'mexico', value: { action: 'shot' },
  });
  const beat = planCommentaryBeats([
    frame(40, 1000, [corner]),
    frame(47, 1040, [shot]),
  ], { projectionGeneration: 3, teams })[0];

  assert.deepEqual(beat.sources, [
    {
      frameId: '18179759:40', seq: 40, cueIds: ['corner:non-contiguous'],
      cues: [{ cueId: 'corner:non-contiguous', action: 'corner' }],
      factIds: ['fact:corner:non-contiguous'],
    },
    {
      frameId: '18179759:47', seq: 47, cueIds: ['shot:non-contiguous'],
      cues: [{ cueId: 'shot:non-contiguous', action: 'shot' }],
      factIds: ['fact:shot:non-contiguous'],
    },
  ]);
});

test('does not merge pressure across teams and omits non-narrative state changes', () => {
  const mexicoAttack = cue('pressure:1', 'possession_pressure', 30, {
    updateMode: 'state_replace',
    lifecycle: 'observed',
    basis: 'derived_probable',
    participant: 1,
    teamId: 'mexico',
    pressure: 'danger',
  });
  const ecuadorAttack = cue('pressure:2', 'possession_pressure', 31, {
    updateMode: 'state_replace',
    lifecycle: 'observed',
    basis: 'derived_probable',
    participant: 2,
    teamId: 'ecuador',
    pressure: 'attack',
  });
  const possession = cue('possession', 'possession_change', 32, {
    updateMode: 'state_replace',
    lifecycle: 'observed',
    participant: 2,
    teamId: 'ecuador',
  });

  const beats = planCommentaryBeats([
    frame(30, 900, [mexicoAttack]),
    frame(31, 910, [ecuadorAttack]),
    frame(32, 920, [possession]),
  ], { projectionGeneration: 2, teams });

  assert.equal(beats.length, 2);
  assert.deepEqual(beats.map((beat) => beat.kind), ['routine', 'routine']);
  assert.deepEqual(beats.map((beat) => beat.teamId), ['mexico', 'ecuador']);
});

test('rejects an invalid projection generation', () => {
  assert.throws(
    () => planCommentaryBeats([], { projectionGeneration: -1 }),
    /non-negative integer/,
  );
});

test('narrates kickoff but does not merge unknown-owner pressure into one spell', () => {
  const provisionalKickoff = cue('restart', 'restart', 0, {
    updateMode: 'state_replace',
    lifecycle: 'provisional',
    participant: 1,
    teamId: 'mexico',
    value: { kind: 'kickoff' },
  });
  const kickoff = cue('restart', 'restart', 1, {
    updateMode: 'state_replace',
    participant: 1,
    teamId: 'mexico',
    value: { kind: 'kickoff' },
  });
  const firstUnknownShot = cue('shot:unknown:1', 'shot_attempt', 2, { value: { action: 'shot' } });
  const secondUnknownShot = cue('shot:unknown:2', 'shot_attempt', 3, { value: { action: 'shot' } });
  const beats = planCommentaryBeats([
    frame(0, 0, [provisionalKickoff]),
    frame(1, 0, [kickoff]),
    frame(2, 30, [firstUnknownShot]),
    frame(3, 40, [secondUnknownShot]),
  ], { projectionGeneration: 0, teams });

  assert.equal(beats[0].fallbackCommentary, 'Mexico get the match underway.');
  assert.deepEqual(beats.map((beat) => beat.kind), ['routine', 'routine', 'routine']);
});

test('labels initial, post-goal, and second-half restarts distinctly', () => {
  const restart = (id, seq, participant, phase) => frame(seq, seq * 10, [cue(id, 'restart', seq, {
    updateMode: 'state_replace',
    participant,
    teamId: participant === 1 ? 'mexico' : 'ecuador',
    value: { kind: 'kickoff' },
  })], [fact(`fact:${id}`, seq, { kind: 'phase', value: { phase } })]);
  const goal = cue('goal:restart', 'goal_confirmed', 2, {
    participant: 1,
    teamId: 'mexico',
    value: { action: 'goal' },
  });
  const beats = planCommentaryBeats([
    restart('initial', 1, 1, 'first_half'),
    frame(2, 20, [goal]),
    restart('after-goal', 3, 2, 'first_half'),
    restart('second-half', 4, 1, 'second_half'),
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

test('caps a pressure spell from its first frame instead of chaining indefinitely', () => {
  const pressure = (id, seq, clock) => frame(seq, clock, [cue(id, 'possession_pressure', seq, {
    updateMode: 'state_replace',
    lifecycle: 'observed',
    basis: 'derived_probable',
    participant: 1,
    teamId: 'mexico',
    pressure: 'danger',
  })]);
  const beats = planCommentaryBeats([
    pressure('pressure:anchor', 1, 0),
    pressure('pressure:middle', 2, 80),
    pressure('pressure:late', 3, 160),
  ], { projectionGeneration: 0, teams, pressureWindowSeconds: 90 });

  assert.equal(beats.length, 2);
  assert.deepEqual(beats.map((beat) => beat.sourceFrameIds), [
    ['18179759:1', '18179759:2'],
    ['18179759:3'],
  ]);
});

test('omits a late-confirmed routine incident that occurred before an already narrated goal', () => {
  const goal = cue('goal:chronology', 'goal_confirmed', 10, {
    participant: 1,
    teamId: 'mexico',
    occurrenceSeconds: 100,
    value: { action: 'goal' },
  });
  const oldShot = cue('shot:chronology', 'shot_outcome', 11, {
    participant: 1,
    teamId: 'mexico',
    occurrenceSeconds: 90,
    value: { action: 'shot' },
  });
  const restart = cue('restart:chronology', 'restart', 12, {
    updateMode: 'state_replace',
    participant: 2,
    teamId: 'ecuador',
    occurrenceSeconds: 110,
    value: { kind: 'kickoff' },
  });
  const beats = planCommentaryBeats([
    frame(10, 100, [goal]),
    frame(11, 90, [oldShot]),
    frame(12, 110, [restart]),
  ], { projectionGeneration: 0, teams });

  assert.deepEqual(beats.flatMap((beat) => beat.cueIds), ['goal:chronology', 'restart:chronology']);
});

test('keeps halftime activity when the second-half playing clock resets', () => {
  const lateFirstHalfGoal = cue('goal:first-half', 'goal_confirmed', 20, {
    participant: 1, teamId: 'mexico', occurrenceSeconds: 3000, value: { action: 'goal' },
  });
  const halfTime = cue('phase:half-time', 'phase_change', 21, {
    updateMode: 'state_replace', value: { phase: 'half_time' },
  });
  const substitution = cue('sub:half-time', 'substitution', 22, {
    participant: 1, teamId: 'mexico', occurrenceSeconds: 2700, value: { action: 'substitution' },
  });
  const secondHalf = cue('restart:second-half', 'restart', 23, {
    updateMode: 'state_replace', participant: 2, teamId: 'ecuador',
    occurrenceSeconds: 2700, value: { kind: 'kickoff' },
  });
  const beats = planCommentaryBeats([
    frame(20, 3000, [lateFirstHalfGoal]),
    frame(21, 3001, [halfTime]),
    frame(22, 2700, [substitution], [fact('fact:sub:half-time', 22, { kind: 'phase', value: { phase: 'half_time' } })]),
    frame(23, 2700, [secondHalf], [fact('fact:restart:second-half', 23, { kind: 'phase', value: { phase: 'second_half' } })]),
  ], { projectionGeneration: 0, teams });

  assert.ok(beats.some((beat) => beat.cueIds.includes('sub:half-time')));
  assert.equal(
    beats.find((beat) => beat.cueIds.includes('restart:second-half'))?.fallbackCommentary,
    'Ecuador get the second half underway.',
  );
});
