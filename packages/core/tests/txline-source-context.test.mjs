import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTxlineMatchPulseSourceContext, parseTxlineScoreEvents } from '../src/txline.ts';

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

test('buildTxlineMatchPulseSourceContext preserves snapshot-owned match state and source counts', () => {
  const snapshotScores = [
    {
      Id: 'snapshot-3',
      Seq: 3,
      Ts: Date.parse('2026-07-06T03:00:00.000Z'),
      Action: 'shot',
      Clock: { Seconds: 5400 },
      Confirmed: true,
      Participant: 2,
      Stats: { 1: 2, 2: 3 },
      StatusId: 5,
    },
  ];
  const historyScores = [
    {
      Id: 'history-1',
      Seq: 1,
      Ts: Date.parse('2026-07-06T02:00:00.000Z'),
      Action: 'corner',
      Clock: { Seconds: 3600 },
      Confirmed: true,
      Participant: 1,
      Stats: { 1: 2, 2: 2 },
      StatusId: 4,
    },
  ];

  const context = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    snapshotScores,
    historyScores,
    nowMs: Date.parse('2026-07-06T03:00:10.000Z'),
  });

  assert.deepEqual(context.score, { home: 2, away: 3 });
  assert.equal(context.clock.phase, 'replay_ready');
  assert.equal(context.snapshotScoreId, 'snapshot-3');
  assert.deepEqual(context.sourceCounts, { snapshot: 1, history: 1, update: 0 });
  assert.equal(context.freshness.status, 'fresh');
  assert.equal(context.sourceEvents.length, 2);
  assert.equal(context.sourceEvents[0].sourceRef.kind, 'txline_history');
  assert.equal(context.sourceEvents[1].sourceRef.kind, 'txline_snapshot');
});

test('source context sorts by sequence, timestamp, then clock seconds', () => {
  const context = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    historyScores: [
      {
        Id: 'later-clock',
        Seq: 10,
        Ts: 2000,
        Action: 'shot',
        Clock: { Seconds: 120 },
      },
      {
        Id: 'earlier-seq',
        Seq: 9,
        Ts: 9999,
        Action: 'corner',
        Clock: { Seconds: 500 },
      },
      {
        Id: 'earlier-clock',
        Seq: 10,
        Ts: 2000,
        Action: 'free_kick',
        Clock: { Seconds: 60 },
      },
    ],
  });

  assert.deepEqual(context.sourceEvents.map((event) => event.sourceRef.id), [
    'earlier-seq',
    'earlier-clock',
    'later-clock',
  ]);
});

test('source context keeps missing participant data auditable without assigning a team', () => {
  const context = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    updateScores: [
      {
        Id: 'system-1',
        Seq: 1,
        Ts: Date.parse('2026-07-06T01:00:00.000Z'),
        Action: 'coverage_update',
      },
    ],
  });

  assert.equal(context.sourceEvents[0].participant, undefined);
  assert.equal(context.sourceEvents[0].team, undefined);
  assert.equal(context.sourceEvents[0].sourceRef.teamId, undefined);
  assert.equal(context.sourceEvents[0].rawAction, 'coverage_update');
});

test('source context marks empty and stale freshness states', () => {
  const emptyContext = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    nowMs: Date.parse('2026-07-06T03:00:00.000Z'),
  });
  assert.equal(emptyContext.freshness.status, 'empty');

  const staleContext = buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    updateScores: [
      {
        Id: 'old-update',
        Seq: 1,
        Ts: Date.parse('2026-07-06T01:00:00.000Z'),
        Action: 'throw_in',
      },
    ],
    nowMs: Date.parse('2026-07-06T03:00:00.000Z'),
    staleAfterMs: 30_000,
  });
  assert.equal(staleContext.freshness.status, 'stale');
});

test('fixture-aware ownership swaps home and away when participant one is not home', () => {
  const context = buildTxlineMatchPulseSourceContext({
    fixture: {
      ...baseFixture,
      Participant1IsHome: false,
    },
    snapshotScores: [
      {
        Id: 'snapshot-away-p1',
        Seq: 1,
        Ts: Date.parse('2026-07-06T03:00:00.000Z'),
        Action: 'goal',
        Participant: 1,
        Stats: { 1: 4, 2: 2 },
      },
    ],
  });

  assert.equal(context.homeTeam.name, 'England');
  assert.equal(context.awayTeam.name, 'Mexico');
  assert.deepEqual(context.score, { home: 2, away: 4 });
  assert.equal(context.sourceEvents[0].team?.side, 'away');
});

test('parseTxlineScoreEvents reads server-sent event data blocks', () => {
  const events = parseTxlineScoreEvents([
    'event: score',
    'data: {"Seq":1,"Action":"corner"}',
    '',
    'event: score',
    'data: [{"Seq":2,"Action":"shot"}]',
    '',
  ].join('\n'));

  assert.deepEqual(events.map((event) => event.Action), ['corner', 'shot']);
});
