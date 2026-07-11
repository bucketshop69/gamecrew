import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTxlineMatchPulseCommentaryEntries,
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

test('commentary batching covers a single meaningful source event', () => {
  const context = buildContext([
    txScore({ id: 'shot-1', seq: 10, action: 'shot', seconds: 6066, participant: 1, confirmed: true }),
  ]);

  const entries = buildTxlineMatchPulseCommentaryEntries(context);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'shot');
  assert.equal(entries[0].team?.name, 'Mexico');
  assert.equal(entries[0].fromSeq, 10);
  assert.equal(entries[0].toSeq, 10);
  assert.equal(entries[0].generation, 'rule_based');
  assert.equal(entries[0].enrichmentStatus, 'pending');
  assert.match(entries[0].commentary, /Mexico have a shot/);
  assert.equal(entries[0].sourceEvents[0].id, 'shot-1');
});

test('commentary batching ignores an unconfirmed source event', () => {
  const context = buildContext([
    txScore({ id: 'shot-1', seq: 11, action: 'shot', seconds: 6066, participant: 1, confirmed: false }),
  ]);

  const entries = buildTxlineMatchPulseCommentaryEntries(context);

  assert.equal(entries.length, 0);
});

test('commentary batching ignores kickoff team setup metadata before live kickoff', () => {
  const context = buildContext([
    txScore({ id: 'kickoff-team-1', seq: 12, action: 'kickoff_team', seconds: 0, participant: 1, confirmed: true }),
    txScore({ id: 'kickoff-1', seq: 13, action: 'kickoff', seconds: 0, confirmed: true }),
  ]);

  const entries = buildTxlineMatchPulseCommentaryEntries(context);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].sourceEvents.map((sourceEvent) => sourceEvent.action), ['kickoff']);
  assert.equal(entries[0].sourceEvents[0].confirmed, true);
});

test('commentary batching groups pressure source facts into one commentary batch', () => {
  const context = buildContext([
    txScore({ id: 'danger-1', seq: 20, action: 'high_danger_possession', seconds: 6060, participant: 1, confirmed: true }),
    txScore({ id: 'corner-1', seq: 21, action: 'corner', seconds: 6070, participant: 1, confirmed: true }),
    txScore({ id: 'shot-1', seq: 22, action: 'shot', seconds: 6080, participant: 1, confirmed: true }),
  ]);

  const entries = buildTxlineMatchPulseCommentaryEntries(context);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'pressure');
  assert.equal(entries[0].fromSeq, 20);
  assert.equal(entries[0].toSeq, 22);
  assert.equal(entries[0].sourceEvents.length, 3);
  assert.deepEqual(entries[0].sourceEvents.map((sourceEvent) => sourceEvent.confirmed), [true, true, true]);
  assert.equal(entries[0].intensity, 'danger');
  assert.match(entries[0].fallbackCommentary, /building pressure/);
});

test('commentary batching keeps must-cover goals separate and clear', () => {
  const context = buildContext([
    txScore({ id: 'danger-1', seq: 30, action: 'danger_possession', seconds: 5000, participant: 1, confirmed: true }),
    txScore({ id: 'shot-1', seq: 31, action: 'shot', seconds: 5010, participant: 1, confirmed: true }),
    txScore({ id: 'goal-1', seq: 32, action: 'goal', seconds: 5020, participant: 1, confirmed: true, home: 3, away: 3 }),
    txScore({ id: 'corner-1', seq: 33, action: 'corner', seconds: 5030, participant: 1, confirmed: true, home: 3, away: 3 }),
  ]);

  const entries = buildTxlineMatchPulseCommentaryEntries(context);

  assert.equal(entries.some((entry) => entry.kind === 'goal'), true);
  assert.equal(entries.find((entry) => entry.kind === 'goal')?.sourceEvents[0].id, 'goal-1');
  assert.equal(entries.find((entry) => entry.kind === 'goal')?.sourceEvents[0].confirmed, true);
  assert.equal(entries.find((entry) => entry.kind === 'goal')?.intensity, 'major');
  assert.equal(entries.some((entry) => entry.kind === 'pressure'), true);
});

test('commentary batching dedupes provisional and confirmed source facts', () => {
  const context = buildContext([
    txScore({ id: 'shot-1', seq: 40, action: 'shot', seconds: 6066, participant: 1, confirmed: false }),
    txScore({ id: 'shot-1', seq: 41, action: 'shot', seconds: 6066, participant: 1, confirmed: true }),
  ]);

  const entries = buildTxlineMatchPulseCommentaryEntries(context);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].sourceEvents.length, 1);
  assert.equal(entries[0].sourceEvents[0].confirmed, true);
  assert.equal(entries[0].sourceEvents[0].seq, 41);
});

test('commentary batching skips isolated throw-ins and system noise', () => {
  const context = buildContext([
    txScore({ id: 'throw-1', seq: 50, action: 'throw_in', seconds: 3000, participant: 2, confirmed: true }),
    txScore({ id: 'status-1', seq: 51, action: 'status', seconds: 3010, confirmed: true }),
    txScore({ id: 'disconnect-1', seq: 52, action: 'disconnected', seconds: 3020, confirmed: true }),
  ]);

  const entries = buildTxlineMatchPulseCommentaryEntries(context);

  assert.equal(entries.length, 0);
});

function buildContext(updateScores) {
  return buildTxlineMatchPulseSourceContext({
    fixture: baseFixture,
    updateScores,
  });
}

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
