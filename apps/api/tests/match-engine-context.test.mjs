import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMatchEngineContext } from '../src/ingestion/match-engine-context.ts';

const fixture = {
  Ts: 1, StartTime: 1, Competition: 'Cup', CompetitionId: 1, FixtureGroupId: 1,
  Participant1Id: 10, Participant1: 'Home', Participant2Id: 20, Participant2: 'Away',
  FixtureId: 99, Participant1IsHome: true,
};

test('derives a safe mid-match score/phase baseline and lineup player index from snapshot state', () => {
  const context = buildMatchEngineContext(fixture, [
    {
      FixtureId: 99, Seq: 600, Id: 1, Action: 'status', StatusId: 4,
      Data: { StatusId: 4 }, Clock: { Running: true, Seconds: 4200 },
    },
    {
      FixtureId: 99, Seq: 599, Id: 2, Action: 'goal',
      Score: {
        Participant1: { Total: { Goals: 2 } },
        Participant2: { Total: { Goals: 1 } },
      },
    },
    {
      FixtureId: 99, Seq: 3, Id: 3, Action: 'lineups',
      Lineups: [{
        normativeId: 10,
        lineups: [{
          starter: true,
          player: { normativeId: 123, preferredName: 'Player One' },
        }],
      }],
    },
  ], { mode: 'snapshot' });
  assert.equal(context.phase, 'second_half');
  assert.deepEqual(context.confirmedScore, { participant1: 2, participant2: 1 });
  assert.equal(context.players['123'].starter, true);
  assert.equal(context.players['123'].participant, 1);
});
