import assert from 'node:assert/strict';
import test from 'node:test';

import { replayMatchEngine } from '../src/match-engine/index.ts';

const context = {
  fixtureId: 99,
  participants: [
    { participant: 1, teamId: 10, name: 'Home' },
    { participant: 2, teamId: 20, name: 'Away' },
  ],
  confirmedScore: { participant1: 0, participant2: 0 },
  phase: 'first_half',
};

function record(seq, id, action, extra = {}) {
  return { FixtureId: 99, Seq: seq, Id: id, Action: action, ...extra };
}

function score(home, away) {
  return {
    Participant1: { Total: { Goals: home } },
    Participant2: { Total: { Goals: away } },
  };
}

test('sparse goal confirmation commits the score retained by the merged incident', () => {
  const result = replayMatchEngine([
    record(1, 7, 'goal', { Confirmed: false, Participant: 1, Score: score(1, 0) }),
    record(2, 7, 'goal', { Confirmed: true, Participant: 1 }),
  ], context);

  assert.deepEqual(result.state.confirmedScore, { participant1: 1, participant2: 0 });
  assert.equal(result.frames[1].simulationCues.some((cue) => cue.kind === 'score_commit'), true);
});

test('late score snapshots enrich a confirmed goal without rolling score backward', () => {
  const result = replayMatchEngine([
    record(1, 7, 'goal', { Confirmed: true, Participant: 1, Score: score(1, 0) }),
    record(2, 8, 'goal', { Confirmed: true, Participant: 1, Score: score(2, 0) }),
    record(3, 7, 'goal', {
      Confirmed: true,
      Participant: 1,
      Data: { PlayerId: 101 },
      Score: score(1, 0),
    }),
  ], {
    ...context,
    players: {
      '101': { normativeId: 101, participant: 1, teamId: 10, sourcePreferredName: 'First scorer' },
    },
  });

  const scoreCommits = result.frames.flatMap((frame) => frame.simulationCues.filter(
    (cue) => cue.kind === 'score_commit',
  ));
  assert.equal(scoreCommits.length, 2);
  assert.deepEqual(result.state.confirmedScore, { participant1: 2, participant2: 0 });
  assert.deepEqual(result.frames[2].simulationCues.map((cue) => cue.kind), [
    'goal_confirmed', 'player_highlight',
  ]);
});

test('scored penalty outcomes use goal choreography and commit the score once', () => {
  const result = replayMatchEngine([
    record(214, 46, 'penalty', { Confirmed: false, Participant: 2 }),
    record(217, 46, 'penalty', { Confirmed: true, Participant: 2 }),
    record(220, 48, 'penalty_outcome', {
      Confirmed: false,
      Participant: 2,
      Data: { Outcome: 'Scored' },
      Score: score(0, 1),
    }),
    record(221, 48, 'penalty_outcome', {
      Confirmed: true,
      Participant: 2,
      Data: { Outcome: 'Scored' },
      Score: score(0, 1),
    }),
    record(222, 48, 'penalty_outcome', {
      Confirmed: true,
      Participant: 2,
      Data: { Outcome: 'Scored', PlayerId: 201 },
      Score: score(0, 1),
    }),
    record(617, 92, 'goal', { Confirmed: false, Participant: 2, Score: score(0, 2) }),
    record(618, 92, 'goal', { Confirmed: true, Participant: 2, Score: score(0, 2) }),
  ], {
    ...context,
    players: {
      '201': { normativeId: 201, participant: 2, teamId: 20, sourcePreferredName: 'Penalty scorer' },
    },
  });

  const scoreCommits = result.frames.flatMap((frame) => frame.simulationCues.filter(
    (cue) => cue.kind === 'score_commit',
  ));
  assert.deepEqual(scoreCommits.map((cue) => cue.value), [
    { participant1: 0, participant2: 1 },
    { participant1: 0, participant2: 2 },
  ]);
  const penaltyFrames = result.frames.filter((frame) => frame.seq === 214 || frame.seq === 217);
  assert.deepEqual(penaltyFrames.flatMap((frame) => frame.simulationCues.map((cue) => cue.kind)), [
    'set_piece', 'set_piece',
  ]);
  assert.equal(penaltyFrames[0].simulationCues[0].value.action, 'penalty');
  const pendingPenalty = result.frames.find((frame) => frame.seq === 220);
  const confirmedPenalty = result.frames.find((frame) => frame.seq === 221);
  const duplicatePenalty = result.frames.find((frame) => frame.seq === 222);
  const confirmedGoal = result.frames.find((frame) => frame.seq === 618);
  assert.deepEqual(pendingPenalty?.simulationCues.map((cue) => cue.kind), ['goal_pending']);
  assert.deepEqual(confirmedPenalty?.simulationCues.map((cue) => cue.kind), ['goal_confirmed', 'score_commit']);
  assert.equal(confirmedPenalty?.simulationCues[0].value.action, 'penalty_outcome');
  assert.deepEqual(duplicatePenalty?.simulationCues.map((cue) => cue.kind), [
    'goal_confirmed', 'player_highlight',
  ]);
  assert.equal(confirmedGoal?.simulationCues.filter((cue) => cue.kind === 'score_commit').length, 1);
  assert.deepEqual(result.state.confirmedScore, { participant1: 0, participant2: 2 });
});

test('a confirmed missed penalty outcome clears its provisional scored state', () => {
  const result = replayMatchEngine([
    record(1, 48, 'penalty_outcome', {
      Confirmed: false,
      Participant: 2,
      Data: { Outcome: 'Scored' },
      Score: score(0, 1),
    }),
    record(2, 48, 'penalty_outcome', {
      Confirmed: true,
      Participant: 2,
      Data: { Outcome: 'Missed' },
      Score: score(0, 1),
    }),
  ], context);

  assert.deepEqual(result.state.confirmedScore, { participant1: 0, participant2: 0 });
  assert.equal(result.state.provisionalScore, undefined);
  assert.equal(result.frames.flatMap((frame) => frame.simulationCues).some(
    (cue) => cue.kind === 'score_commit' || cue.kind === 'goal_confirmed',
  ), false);
});

test('an overturned VAR score snapshot cannot commit a provisional goal', () => {
  const result = replayMatchEngine([
    record(220, 48, 'penalty_outcome', {
      Confirmed: true,
      Participant: 2,
      Data: { Outcome: 'Scored' },
      Score: score(0, 1),
    }),
    record(617, 92, 'goal', { Confirmed: false, Participant: 2, Score: score(0, 2) }),
    record(618, 92, 'goal', { Confirmed: true, Participant: 2, Score: score(0, 2) }),
    record(638, 95, 'goal', { Confirmed: false, Participant: 2, Score: score(0, 3) }),
    record(641, 96, 'var_end', {
      Confirmed: true,
      Data: { Outcome: 'Overturned' },
      Score: score(0, 3),
    }),
    record(642, 95, 'action_discarded', { Score: score(0, 2) }),
  ], context);

  const scoreCommitFrames = result.frames.filter((frame) => frame.simulationCues.some(
    (cue) => cue.kind === 'score_commit',
  ));
  assert.deepEqual(scoreCommitFrames.map((frame) => frame.seq), [220, 618]);
  assert.equal(result.frames[4].simulationCues.some((cue) => cue.kind === 'score_commit'), false);
  assert.deepEqual(result.state.confirmedScore, { participant1: 0, participant2: 2 });
  assert.equal(result.state.provisionalScore, undefined);
});

test('late incident enrichment keeps confirmed simulation lifecycle and cue kind', () => {
  const result = replayMatchEngine([
    record(1, 7, 'goal', { Confirmed: true, Participant: 1, Score: score(1, 0) }),
    record(2, 7, 'goal', { Participant: 1, Data: { PlayerId: 101 } }),
  ], {
    ...context,
    players: {
      '101': { normativeId: 101, participant: 1, teamId: 10, sourcePreferredName: 'Player 101' },
    },
  });

  const cue = result.frames[1].simulationCues.find((candidate) => candidate.id === 'cue:99:goal:7');
  assert.equal(cue?.kind, 'goal_confirmed');
  assert.equal(cue?.lifecycle, 'confirmed');
});

test('lineup reconciliation orders substitutions by first occurrence, not late enrichment', () => {
  const players = Object.fromEntries([101, 102, 103].map((id) => [String(id), {
    normativeId: id,
    participant: 1,
    teamId: 10,
    sourcePreferredName: `Player ${id}`,
    starter: id === 101,
  }]));
  const result = replayMatchEngine([
    record(1, 11, 'substitution', { Confirmed: false, Participant: 1 }),
    record(2, 12, 'substitution', {
      Confirmed: true,
      Participant: 1,
      Data: { PlayerOutId: 102, PlayerInId: 103 },
    }),
    record(3, 11, 'substitution', {
      Confirmed: true,
      Participant: 1,
      Data: { PlayerOutId: 101, PlayerInId: 102 },
    }),
  ], { ...context, players });

  assert.deepEqual(result.state.activePlayerIdsByParticipant['1'], [103]);
});

test('discarding a confirmed incident warns and leaves canonical state unchanged', () => {
  const result = replayMatchEngine([
    record(1, 7, 'goal', { Confirmed: true, Participant: 1, Score: score(1, 0) }),
    record(2, 7, 'action_discarded'),
  ], context);

  assert.equal(result.state.incidents['99:goal:7'].lifecycle, 'confirmed');
  assert.deepEqual(result.state.confirmedScore, { participant1: 1, participant2: 0 });
  assert.equal(result.frames[1].facts.length, 0);
  assert.match(result.state.integrityWarnings.at(-1), /ignored for confirmed incident/);
});

test('final reconciliation preserves independently confirmed score evidence', () => {
  const result = replayMatchEngine([
    record(1, 7, 'goal', { Confirmed: true, Participant: 1, Score: score(1, 0) }),
    record(2, 9, 'game_finalised', { Score: score(2, 0) }),
  ], context);

  assert.deepEqual(result.state.confirmedScore, { participant1: 1, participant2: 0 });
  assert.deepEqual(result.state.finalScore, { participant1: 2, participant2: 0 });
  assert.match(result.state.integrityWarnings.at(-1), /differs from confirmed score/);
});
