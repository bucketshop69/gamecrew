import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitTxlineMatchPulseMoments,
  buildTxlineMatchPulseSourceContext,
} from '../src/txline.ts';

const baseFixture = {
  Ts: Date.parse('2026-07-06T00:00:00.000Z'),
  StartTime: Date.parse('2026-07-06T01:00:00.000Z'),
  Competition: 'World Cup',
  CompetitionId: 72,
  FixtureGroupId: 10115574,
  Participant1Id: 1,
  Participant1: 'Mexico',
  Participant2Id: 2,
  Participant2: 'England',
  FixtureId: 18192996,
  Participant1IsHome: true,
};

test('admission resolves duplicate provisional and confirmed events to the confirmed version', () => {
  const context = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    updateScores: [
      txScore({
        id: 'shot-1',
        seq: 10,
        action: 'shot',
        seconds: 6066,
        participant: 1,
        confirmed: false,
      }),
      txScore({
        id: 'shot-1',
        seq: 11,
        action: 'shot',
        seconds: 6066,
        participant: 1,
        confirmed: true,
      }),
    ],
  });

  const moments = admitTxlineMatchPulseMoments(context, { pressureMinimumEvents: 1 });

  assert.equal(moments.length, 1);
  assert.equal(moments[0].sourceEvents.length, 1);
  assert.equal(moments[0].sourceEvents[0].confirmed, true);
  assert.equal(moments[0].sourceEvents[0].seq, 11);
});

test('admission ignores unconfirmed source events before moment generation', () => {
  const context = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    updateScores: [
      txScore({ id: 'shot-1', seq: 12, action: 'shot', seconds: 6066, participant: 1, confirmed: false }),
    ],
  });

  const moments = admitTxlineMatchPulseMoments(context, { pressureMinimumEvents: 1 });

  assert.equal(moments.length, 0);
});

test('admission collapses repeated corners and danger into one pressure moment', () => {
  const context = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    updateScores: [
      txScore({ id: 'danger-1', seq: 20, action: 'high_danger_possession', seconds: 6060, participant: 1, confirmed: true }),
      txScore({ id: 'corner-1', seq: 21, action: 'corner', seconds: 6070, participant: 1, confirmed: true }),
      txScore({ id: 'corner-2', seq: 22, action: 'corner', seconds: 6080, participant: 1, confirmed: true }),
      txScore({ id: 'corner-3', seq: 23, action: 'corner', seconds: 6090, participant: 1, confirmed: true }),
    ],
  });

  const moments = admitTxlineMatchPulseMoments(context);

  assert.equal(moments.length, 1);
  assert.equal(moments[0].type, 'pressure');
  assert.equal(moments[0].team?.name, 'Mexico');
  assert.equal(moments[0].intensity, 'danger');
  assert.equal(moments[0].sourceEvents.length, 4);
  assert.match(moments[0].body, /3 corners/);
});

test('admission hides isolated throw-ins and system noise', () => {
  const context = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    updateScores: [
      txScore({ id: 'throw-1', seq: 30, action: 'throw_in', seconds: 3000, participant: 2, confirmed: true }),
      txScore({ id: 'status-1', seq: 31, action: 'status', seconds: 3010, confirmed: true }),
      txScore({ id: 'disconnect-1', seq: 32, action: 'disconnected', seconds: 3020, confirmed: true }),
    ],
  });

  const moments = admitTxlineMatchPulseMoments(context);

  assert.equal(moments.length, 0);
});

test('admission keeps must-show goals even near a generated pressure sequence', () => {
  const context = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    updateScores: [
      txScore({ id: 'danger-1', seq: 40, action: 'high_danger_possession', seconds: 5000, participant: 1, confirmed: true }),
      txScore({ id: 'shot-1', seq: 41, action: 'shot', seconds: 5010, participant: 1, confirmed: true }),
      txScore({ id: 'goal-1', seq: 42, action: 'goal', seconds: 5020, participant: 1, confirmed: true, home: 3, away: 3 }),
      txScore({ id: 'corner-1', seq: 43, action: 'corner', seconds: 5030, participant: 1, confirmed: true, home: 3, away: 3 }),
    ],
  });

  const moments = admitTxlineMatchPulseMoments(context, { pressureMinimumEvents: 2 });

  assert.equal(moments.some((moment) => moment.type === 'goal'), true);
  assert.equal(moments.some((moment) => moment.type === 'pressure'), true);
  assert.equal(moments.find((moment) => moment.type === 'goal')?.sourceEvents[0].action, 'goal');
});

test('admission bounds pressure clusters from the first event in the window', () => {
  const context = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    updateScores: [
      txScore({ id: 'danger-1', seq: 50, action: 'danger_possession', seconds: 6000, participant: 1, confirmed: true }),
      txScore({ id: 'shot-1', seq: 51, action: 'shot', seconds: 6040, participant: 1, confirmed: true }),
      txScore({ id: 'corner-1', seq: 52, action: 'corner', seconds: 6080, participant: 1, confirmed: true }),
      txScore({ id: 'danger-2', seq: 53, action: 'danger_possession', seconds: 6120, participant: 1, confirmed: true }),
      txScore({ id: 'shot-2', seq: 54, action: 'shot', seconds: 6160, participant: 1, confirmed: true }),
      txScore({ id: 'corner-2', seq: 55, action: 'corner', seconds: 6200, participant: 1, confirmed: true }),
    ],
  });

  const moments = admitTxlineMatchPulseMoments(context, {
    pressureMinimumEvents: 3,
    pressureWindowSeconds: 90,
  });

  assert.equal(moments.length, 2);
  assert.deepEqual(moments.map((moment) => moment.sourceEvents.length), [3, 3]);
});

function txScore({
  id,
  seq,
  action,
  seconds,
  participant,
  confirmed,
  home = 2,
  away = 3,
}) {
  return {
    Id: id,
    Seq: seq,
    Ts: Date.parse('2026-07-06T03:00:00.000Z') + seq * 1000,
    Action: action,
    Clock: { Seconds: seconds },
    Participant: participant,
    Confirmed: confirmed,
    Stats: { 1: home, 2: away },
  };
}
