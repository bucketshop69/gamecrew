import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMatchRecapModel } from '../src/screens/match-recap-logic.ts';

function event(kind, overrides = {}) {
  return {
    id: `e:${kind}:${Math.random()}`,
    kind,
    fixtureId: 'f1',
    userId: 'u1',
    seq: 1,
    sourceFrameId: 'frame:1',
    stateRevision: 1,
    coolnessDelta: 0,
    itemDeltas: [],
    ...overrides,
  };
}

test('a user who did nothing gets a fully-zero recap, not an error/undefined', () => {
  const recap = buildMatchRecapModel({
    claims: [],
    coolnessEarned: 0,
    pile: [],
    poolSplit: undefined,
    streamEvents: [],
  });

  assert.deepEqual(recap, {
    hasActivity: false,
    coolnessEarned: 0,
    callsWon: 0,
    callsLost: 0,
    poolShare: undefined,
    hasUnclaimedItem: false,
  });
});

test('an active user with calls taken counts wins and losses independently', () => {
  const recap = buildMatchRecapModel({
    claims: [],
    coolnessEarned: 40,
    pile: [],
    poolSplit: undefined,
    streamEvents: [
      event('bet_taken'),
      event('bet_settled_win'),
      event('bet_taken'),
      event('bet_settled_loss'),
      event('bet_settled_win'),
    ],
  });

  assert.equal(recap.hasActivity, true);
  assert.equal(recap.coolnessEarned, 40);
  assert.equal(recap.callsWon, 2);
  assert.equal(recap.callsLost, 1);
});

test('bet_voided and prompt events do not count as a win or a loss', () => {
  const recap = buildMatchRecapModel({
    claims: [],
    coolnessEarned: 0,
    pile: [],
    poolSplit: undefined,
    streamEvents: [event('bet_taken'), event('bet_voided'), event('prompt_offered'), event('prompt_expired')],
  });

  assert.equal(recap.callsWon, 0);
  assert.equal(recap.callsLost, 0);
  // Voided/prompt-only activity alone doesn't count as "activity" for the
  // recap row's purposes -- only coolness, resolved calls, or a pool split do.
  assert.equal(recap.hasActivity, false);
});

test('a match with no split at all leaves poolShare undefined (not an empty array)', () => {
  const recap = buildMatchRecapModel({
    claims: [],
    coolnessEarned: 10,
    pile: [],
    poolSplit: undefined,
    streamEvents: [],
  });
  assert.equal(recap.poolShare, undefined);
});

test('a split that resolved with nothing for this user is a real empty array, distinct from unsettled', () => {
  const recap = buildMatchRecapModel({
    claims: [],
    coolnessEarned: 0,
    pile: [],
    poolSplit: [],
    streamEvents: [],
  });
  assert.deepEqual(recap.poolShare, []);
  // An empty settled split alone doesn't flip hasActivity -- nothing was
  // actually won.
  assert.equal(recap.hasActivity, false);
});

test('a real pool share the user won is surfaced verbatim and counts as activity', () => {
  const share = [{ itemId: 'banana', quantity: 12 }];
  const recap = buildMatchRecapModel({
    claims: [],
    coolnessEarned: 0,
    pile: [],
    poolSplit: share,
    streamEvents: [],
  });
  assert.deepEqual(recap.poolShare, share);
  assert.equal(recap.hasActivity, true);
});

test('an item held in the pile with no claim at all is unclaimed', () => {
  const recap = buildMatchRecapModel({
    claims: [],
    coolnessEarned: 0,
    pile: [{ itemId: 'banana', quantity: 1 }],
    poolSplit: undefined,
    streamEvents: [],
  });
  assert.equal(recap.hasUnclaimedItem, true);
});

test('a minted claim for the held item means nothing is unclaimed', () => {
  const recap = buildMatchRecapModel({
    claims: [{ itemId: 'banana', status: 'minted' }],
    coolnessEarned: 0,
    pile: [{ itemId: 'banana', quantity: 1 }],
    poolSplit: undefined,
    streamEvents: [],
  });
  assert.equal(recap.hasUnclaimedItem, false);
});

test('a pending/sending claim for the held item is treated as already in flight, not unclaimed', () => {
  const pending = buildMatchRecapModel({
    claims: [{ itemId: 'banana', status: 'pending' }],
    coolnessEarned: 0,
    pile: [{ itemId: 'banana', quantity: 1 }],
    poolSplit: undefined,
    streamEvents: [],
  });
  assert.equal(pending.hasUnclaimedItem, false);

  const sending = buildMatchRecapModel({
    claims: [{ itemId: 'banana', status: 'sending' }],
    coolnessEarned: 0,
    pile: [{ itemId: 'banana', quantity: 1 }],
    poolSplit: undefined,
    streamEvents: [],
  });
  assert.equal(sending.hasUnclaimedItem, false);
});

test('a failed claim keeps the item unclaimed so the affordance can retry', () => {
  const recap = buildMatchRecapModel({
    claims: [{ itemId: 'banana', status: 'failed' }],
    coolnessEarned: 0,
    pile: [{ itemId: 'banana', quantity: 1 }],
    poolSplit: undefined,
    streamEvents: [],
  });
  assert.equal(recap.hasUnclaimedItem, true);
});

test('the most recent claim for an item wins over an earlier one (retry appended a new record)', () => {
  const recap = buildMatchRecapModel({
    claims: [
      { itemId: 'banana', status: 'failed' },
      { itemId: 'banana', status: 'minted' },
    ],
    coolnessEarned: 0,
    pile: [{ itemId: 'banana', quantity: 1 }],
    poolSplit: undefined,
    streamEvents: [],
  });
  assert.equal(recap.hasUnclaimedItem, false);
});

test('a zero-quantity pile entry is never flagged as unclaimed', () => {
  const recap = buildMatchRecapModel({
    claims: [],
    coolnessEarned: 0,
    pile: [{ itemId: 'banana', quantity: 0 }],
    poolSplit: undefined,
    streamEvents: [],
  });
  assert.equal(recap.hasUnclaimedItem, false);
});

test('an empty pile is never flagged as unclaimed', () => {
  const recap = buildMatchRecapModel({
    claims: [{ itemId: 'banana', status: 'failed' }],
    coolnessEarned: 0,
    pile: [],
    poolSplit: undefined,
    streamEvents: [],
  });
  assert.equal(recap.hasUnclaimedItem, false);
});

test('multiple distinct held items: only the genuinely unclaimed one is flagged', () => {
  const recap = buildMatchRecapModel({
    claims: [{ itemId: 'banana', status: 'minted' }],
    coolnessEarned: 0,
    pile: [
      { itemId: 'banana', quantity: 2 },
      { itemId: 'lambo', quantity: 1 },
    ],
    poolSplit: undefined,
    streamEvents: [],
  });
  assert.equal(recap.hasUnclaimedItem, true);
});
