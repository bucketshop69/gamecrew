import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveTxlineMatchAdapter } from '../src/txline/adapters.ts';

const NOW = Date.parse('2026-07-13T12:00:00.000Z');
const DAY_MS = 86_400_000;

test('live adapter lists the complete TxLINE lookback and reuses only archival scores', async () => {
  const originalDateNow = Date.now;
  Date.now = () => NOW;

  const fixtureRequests = [];
  const scoreRequests = [];
  const fixtures = [
    fixture({
      FixtureId: 18218149,
      StartTime: NOW - 3 * DAY_MS,
      Participant1: 'Spain',
      Participant2: 'Belgium',
    }),
    fixture({
      FixtureId: 18222446,
      StartTime: NOW - DAY_MS,
      Participant1: 'Argentina',
      Participant2: 'Switzerland',
      Participant1IsHome: false,
    }),
    fixture({
      FixtureId: 18230000,
      StartTime: NOW - 151 * 60 * 1000,
      Participant1: 'Recent',
      Participant2: 'Correction window',
    }),
    fixture({
      FixtureId: 18237038,
      StartTime: NOW + DAY_MS,
      Participant1: 'France',
      Participant2: 'Spain',
    }),
  ];
  const client = {
    async startGuestSession() {
      return { jwt: 'guest-jwt' };
    },
    async listFixtures(jwt, options) {
      fixtureRequests.push({ jwt, options });
      return fixtures;
    },
    async listScoreSnapshot(fixtureId, jwt) {
      scoreRequests.push({ fixtureId, jwt });
      if (fixtureId === 18218149) {
        // TxLINE can retain an in-play status on an old clock row.
        return [score({
          FixtureId: fixtureId,
          StatusId: 4,
          Ts: NOW - 3 * DAY_MS,
          home: 2,
          away: 1,
        })];
      }
      if (fixtureId === 18230000) {
        const requestCount = scoreRequests.filter(({ fixtureId: id }) => id === fixtureId).length;
        return [score({
          FixtureId: fixtureId,
          StatusId: requestCount === 1 ? 4 : 5,
          home: 3,
          away: 1,
        })];
      }
      return [score({ FixtureId: fixtureId, StatusId: 5, home: 3, away: 1 })];
    },
  };

  try {
    const adapter = new LiveTxlineMatchAdapter(client);
    const first = await adapter.listMatches();
    const second = await adapter.listMatches({ filter: 'replay' });

    assert.deepEqual(fixtureRequests, [
      {
        jwt: 'guest-jwt',
        options: { startEpochDay: Math.floor(NOW / DAY_MS) - 30 },
      },
      {
        jwt: 'guest-jwt',
        options: { startEpochDay: Math.floor(NOW / DAY_MS) - 30 },
      },
    ]);
    assert.deepEqual(scoreRequests, [
      { fixtureId: 18218149, jwt: 'guest-jwt' },
      { fixtureId: 18222446, jwt: 'guest-jwt' },
      { fixtureId: 18230000, jwt: 'guest-jwt' },
      { fixtureId: 18230000, jwt: 'guest-jwt' },
    ]);
    assert.deepEqual(first.map(({ txline }) => txline.fixtureId), [
      '18218149',
      '18222446',
      '18230000',
      '18237038',
    ]);
    assert.deepEqual(second.map(({ txline }) => txline.fixtureId), [
      '18218149',
      '18222446',
      '18230000',
    ]);
    assert.equal(first[0].status, 'replayable');
    assert.deepEqual(first[0].score, { home: 2, away: 1 });
    assert.deepEqual(first[1].score, { home: 1, away: 3 });
    assert.equal(first[2].status, 'live');
    assert.equal(second[2].status, 'replayable');
  } finally {
    Date.now = originalDateNow;
  }
});

test('incomplete and failed historical score requests do not hide fixtures or poison the cache', async () => {
  const originalDateNow = Date.now;
  Date.now = () => NOW;
  const scoreRequests = [];
  const fixtures = [
    fixture({ FixtureId: 1, StartTime: NOW - DAY_MS }),
    fixture({ FixtureId: 2, StartTime: NOW - DAY_MS }),
    fixture({ FixtureId: 3, StartTime: NOW - DAY_MS }),
  ];
  const client = {
    async startGuestSession() {
      return { jwt: 'guest-jwt' };
    },
    async listFixtures() {
      return fixtures;
    },
    async listScoreSnapshot(fixtureId) {
      scoreRequests.push(fixtureId);
      if (fixtureId === 1 && scoreRequests.filter((id) => id === 1).length === 1) {
        return [{ FixtureId: fixtureId, Ts: NOW, StatusId: 5 }];
      }
      if (fixtureId === 3) throw new Error('temporary score failure');
      return [score({ FixtureId: fixtureId, StatusId: 5, home: 1, away: 0 })];
    },
  };

  try {
    const adapter = new LiveTxlineMatchAdapter(client);
    const first = await adapter.listMatches();
    const second = await adapter.listMatches();

    assert.equal(first.length, 3);
    assert.equal(first[0].status, 'replayable');
    assert.equal(first[0].score, undefined);
    assert.deepEqual(first[1].score, { home: 1, away: 0 });
    assert.equal(first[2].score, undefined);
    assert.deepEqual(second[0].score, { home: 1, away: 0 });
    assert.deepEqual(scoreRequests, [1, 2, 3, 1, 3]);
  } finally {
    Date.now = originalDateNow;
  }
});

test('concurrent lists coalesce the same archival score request', async () => {
  const originalDateNow = Date.now;
  Date.now = () => NOW;
  let scoreRequestCount = 0;
  const client = {
    async startGuestSession() {
      return { jwt: 'guest-jwt' };
    },
    async listFixtures() {
      return [fixture({ FixtureId: 10, StartTime: NOW - 2 * DAY_MS })];
    },
    async listScoreSnapshot(fixtureId) {
      scoreRequestCount += 1;
      await Promise.resolve();
      return [score({ FixtureId: fixtureId, StatusId: 5, home: 2, away: 0 })];
    },
  };

  try {
    const adapter = new LiveTxlineMatchAdapter(client);
    const [first, second] = await Promise.all([adapter.listMatches(), adapter.listMatches()]);

    assert.equal(scoreRequestCount, 1);
    assert.deepEqual(first[0].score, { home: 2, away: 0 });
    assert.deepEqual(second[0].score, { home: 2, away: 0 });
  } finally {
    Date.now = originalDateNow;
  }
});

function fixture(overrides) {
  return {
    Ts: NOW,
    StartTime: NOW,
    Competition: 'World Cup',
    CompetitionId: 72,
    FixtureGroupId: 10115677,
    Participant1Id: 1,
    Participant1: 'Home',
    Participant2Id: 2,
    Participant2: 'Away',
    FixtureId: 1,
    Participant1IsHome: true,
    ...overrides,
  };
}

function score({ FixtureId, StatusId, Ts = NOW, home, away }) {
  return {
    FixtureId,
    Ts,
    Seq: 1,
    StatusId,
    Clock: { Running: StatusId !== 5, Seconds: 90 * 60 },
    Stats: { 1: home, 2: away },
  };
}
