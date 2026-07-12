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
