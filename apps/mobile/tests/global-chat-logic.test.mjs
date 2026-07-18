import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGlobalChatRows,
  buildGlobalChatStreamRows,
  buildPileRows,
  itemClaimStatus,
  latestGiftRevealItems,
  pickAutoStakeItem,
  poolChipText,
  promptTakenPillText,
  rarityPresentationTier,
} from '../src/screens/global-chat-logic.ts';

// Fake catalogue mirroring packages/core/src/match-engine/economy.ts's
// ECONOMY_ITEM_CATALOGUE shape, injected instead of imported so this test
// file has zero runtime dependency on @gamecrew/core (see global-chat-logic.ts's
// EconomyItemLookup doc comment for why).
const FAKE_CATALOGUE = {
  dust: { label: 'Dust', emoji: '✨', rarityTier: 1 },
  bananas: { label: 'Bananas', emoji: '🍌', rarityTier: 2 },
  rubber_duck: { label: 'Rubber Duck', emoji: '🦆', rarityTier: 3 },
  traffic_cone: { label: 'Traffic Cone', emoji: '🚧', rarityTier: 4 },
  pizza: { label: 'Pizza', emoji: '🍕', rarityTier: 5 },
  boombox: { label: 'Boombox', emoji: '📻', rarityTier: 6 },
  jetski: { label: 'Jetski', emoji: '🚤', rarityTier: 7 },
  lambo: { label: 'Lambo', emoji: '🏎️', rarityTier: 8 },
};

function lookupItem(itemId) {
  const def = FAKE_CATALOGUE[itemId];
  if (!def) throw new Error(`Unknown fake item id: ${itemId}`);
  return def;
}

function baseEvent(overrides) {
  return {
    id: 'evt-1',
    kind: 'room_chatter',
    fixtureId: 'fx-1',
    userId: 'user-1',
    seq: 1,
    sourceFrameId: 'f1',
    stateRevision: 1,
    coolnessDelta: 0,
    itemDeltas: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// pickAutoStakeItem
// ---------------------------------------------------------------------------

test('pickAutoStakeItem picks the most plentiful item in the pile', () => {
  const pile = [
    { itemId: 'dust', quantity: 3 },
    { itemId: 'bananas', quantity: 12 },
    { itemId: 'lambo', quantity: 1 },
  ];
  assert.equal(pickAutoStakeItem(pile), 'bananas');
});

test('pickAutoStakeItem falls back to dust when the pile is empty', () => {
  assert.equal(pickAutoStakeItem([]), 'dust');
});

test('pickAutoStakeItem ignores zero-quantity entries', () => {
  const pile = [
    { itemId: 'lambo', quantity: 0 },
    { itemId: 'dust', quantity: 5 },
  ];
  assert.equal(pickAutoStakeItem(pile), 'dust');
});

// ---------------------------------------------------------------------------
// buildGlobalChatRows
// ---------------------------------------------------------------------------

test('buildGlobalChatRows renders room_chatter and match_moment as plain lines', () => {
  const events = [
    baseEvent({ id: 'e1', kind: 'room_chatter', text: 'the room is buzzing' }),
    baseEvent({ id: 'e2', kind: 'match_moment', text: 'GOAL! the room erupts' }),
  ];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  assert.deepEqual(rows, [
    { id: 'e1', kind: 'chatter', text: 'the room is buzzing' },
    { id: 'e2', kind: 'match_moment', text: 'GOAL! the room erupts' },
  ]);
});

test('buildGlobalChatRows skips welcome_gift_offered (handled by the gift popup, not chat)', () => {
  const events = [baseEvent({ id: 'e1', kind: 'welcome_gift_offered', text: 'gifts!' })];
  assert.deepEqual(buildGlobalChatRows(events, [], [], lookupItem), []);
});

test('buildGlobalChatRows renders gift_granted/drop_granted with item deltas and readable text', () => {
  const events = [
    baseEvent({
      id: 'e1',
      kind: 'gift_granted',
      itemDeltas: [{ item: 'bananas', delta: 12 }, { item: 'rubber_duck', delta: 1 }],
    }),
  ];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'gift_reveal');
  assert.deepEqual(rows[0].itemDeltas, [
    { itemId: 'bananas', quantity: 12 },
    { itemId: 'rubber_duck', quantity: 1 },
  ]);
  assert.match(rows[0].text, /12 bananas/);
  assert.match(rows[0].text, /1 rubber duck/);
});

test('buildGlobalChatRows marks a prompt row isOpen true when still in openPrompts', () => {
  const events = [baseEvent({ id: 'e1', kind: 'prompt_offered', promptId: 'p1', text: 'Goal in 2 min?' })];
  const openPrompts = [{ id: 'p1', fixtureId: 'fx-1', trigger: 'corner_won', predicate: 'goal_within_window', sourceFrameId: 'f1', copy: 'Goal in 2 min?' }];
  const rows = buildGlobalChatRows(events, openPrompts, [{ itemId: 'bananas', quantity: 5 }], lookupItem);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'prompt');
  assert.equal(rows[0].isOpen, true);
  assert.equal(rows[0].stakeItemId, 'bananas');
  assert.equal(rows[0].copy, 'Goal in 2 min?');
});

test('buildGlobalChatRows marks a prompt row isOpen false once no longer in openPrompts (expired)', () => {
  const events = [baseEvent({ id: 'e1', kind: 'prompt_offered', promptId: 'p1', text: 'Goal in 2 min?' })];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  assert.equal(rows[0].isOpen, false);
});

test('buildGlobalChatRows produces no row for prompt_expired itself', () => {
  const events = [baseEvent({ id: 'e1', kind: 'prompt_expired', promptId: 'p1' })];
  assert.deepEqual(buildGlobalChatRows(events, [], [], lookupItem), []);
});

test('buildGlobalChatRows renders bet_taken as a social-proof line, deterministic per prompt id', () => {
  const events = [baseEvent({ id: 'e1', kind: 'bet_taken', promptId: 'p1' })];
  const rowsA = buildGlobalChatRows(events, [], [], lookupItem);
  const rowsB = buildGlobalChatRows(events, [], [], lookupItem);
  assert.equal(rowsA[0].kind, 'social_proof');
  assert.equal(rowsA[0].text, rowsB[0].text);
  assert.match(rowsA[0].text, /others/);
});

test('buildGlobalChatRows renders bet_settled_win loud with payout item deltas and spec-exact copy', () => {
  const events = [
    baseEvent({
      id: 'e1',
      kind: 'bet_settled_win',
      coolnessDelta: 15,
      itemDeltas: [{ item: 'bananas', delta: 16 }],
    }),
  ];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  assert.equal(rows[0].kind, 'settlement_win');
  assert.deepEqual(rows[0].itemDeltas, [{ itemId: 'bananas', quantity: 16 }]);
  // UX spec section 2: "You called it right -- coolness +{n}" (always "You" -- V1 has no other display names surfaced here).
  assert.equal(rows[0].text, 'You called it right -- coolness +15');
});

test('buildGlobalChatRows renders bet_settled_loss quiet with no item deltas exposed and spec-exact copy', () => {
  const events = [baseEvent({ id: 'e1', kind: 'bet_settled_loss', coolnessDelta: -5 })];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  assert.equal(rows[0].kind, 'settlement_loss');
  // UX spec section 2: always second-person, never the player's name -- only the loser ever sees this row.
  assert.equal(rows[0].text, 'You called it wrong -- coolness -5.');
});

test('buildGlobalChatRows renders bet_voided as a correction row', () => {
  const events = [baseEvent({ id: 'e1', kind: 'bet_voided', text: 'Settlement corrected.' })];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  assert.equal(rows[0].kind, 'settlement_voided');
});

test('buildGlobalChatRows preserves event order across mixed kinds', () => {
  const events = [
    baseEvent({ id: 'e1', kind: 'room_chatter', text: 'chatter' }),
    baseEvent({ id: 'e2', kind: 'prompt_offered', promptId: 'p1', text: 'prompt' }),
    baseEvent({ id: 'e3', kind: 'bet_taken', promptId: 'p1' }),
    baseEvent({ id: 'e4', kind: 'bet_settled_win', text: 'won', itemDeltas: [{ item: 'bananas', delta: 4 }] }),
  ];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  assert.deepEqual(rows.map((row) => row.id), ['e1', 'e2', 'e3', 'e4']);
});

// ---------------------------------------------------------------------------
// rarityPresentationTier / buildPileRows
// ---------------------------------------------------------------------------

test('rarityPresentationTier maps catalogue tiers into four coarse buckets', () => {
  assert.equal(rarityPresentationTier(1), 'common');
  assert.equal(rarityPresentationTier(2), 'common');
  assert.equal(rarityPresentationTier(3), 'uncommon');
  assert.equal(rarityPresentationTier(5), 'uncommon');
  assert.equal(rarityPresentationTier(6), 'rare');
  assert.equal(rarityPresentationTier(7), 'rare');
  assert.equal(rarityPresentationTier(8), 'legendary');
});

test('buildPileRows omits zero-quantity items and sorts rarest-first, then by quantity', () => {
  const pile = [
    { itemId: 'dust', quantity: 40 },
    { itemId: 'lambo', quantity: 1 },
    { itemId: 'rubber_duck', quantity: 0 },
    { itemId: 'bananas', quantity: 12 },
  ];
  const rows = buildPileRows(pile, lookupItem);
  assert.deepEqual(rows.map((row) => row.itemId), ['lambo', 'dust', 'bananas']);
  assert.equal(rows[0].rarityTier, 'legendary');
  assert.equal(rows[0].emoji, '🏎️');
});

// ---------------------------------------------------------------------------
// latestGiftRevealItems
// ---------------------------------------------------------------------------

test('latestGiftRevealItems returns empty before any gift_granted event', () => {
  const events = [baseEvent({ id: 'e1', kind: 'welcome_gift_offered' })];
  assert.deepEqual(latestGiftRevealItems(events, lookupItem), []);
});

test('latestGiftRevealItems resolves the most recent gift_granted event\'s item deltas', () => {
  const events = [
    baseEvent({
      id: 'e1',
      kind: 'gift_granted',
      itemDeltas: [{ item: 'bananas', delta: 12 }, { item: 'rubber_duck', delta: 1 }],
    }),
  ];
  const rows = latestGiftRevealItems(events, lookupItem);
  assert.deepEqual(rows, [
    { itemId: 'bananas', emoji: '🍌', label: 'Bananas', quantity: 12 },
    { itemId: 'rubber_duck', emoji: '🦆', label: 'Rubber Duck', quantity: 1 },
  ]);
});

test('latestGiftRevealItems ignores drop_granted events (only gift_granted counts)', () => {
  const events = [
    baseEvent({ id: 'e1', kind: 'gift_granted', itemDeltas: [{ item: 'dust', delta: 5 }] }),
    baseEvent({ id: 'e2', kind: 'drop_granted', itemDeltas: [{ item: 'lambo', delta: 1 }] }),
  ];
  const rows = latestGiftRevealItems(events, lookupItem);
  assert.deepEqual(rows.map((row) => row.itemId), ['dust']);
});

// ---------------------------------------------------------------------------
// V1: prompt row state machine (open -> taken -> settled), UX spec section 2
// ---------------------------------------------------------------------------

test('buildGlobalChatRows: a prompt row starts open with state "open"', () => {
  const events = [baseEvent({ id: 'e1', kind: 'prompt_offered', promptId: 'p1', text: 'Make your call: a goal in the next 5 minutes?' })];
  const openPrompts = [{ id: 'p1', fixtureId: 'fx-1', trigger: 'big_moment', predicate: 'goal_within_window', sourceFrameId: 'f1', copy: 'Make your call: a goal in the next 5 minutes?' }];
  const rows = buildGlobalChatRows(events, openPrompts, [], lookupItem);
  assert.equal(rows[0].state, 'open');
  assert.equal(rows[0].isOpen, true);
});

test('buildGlobalChatRows: bet_taken flips the existing prompt row in place to "taken" rather than adding a second prompt row', () => {
  const events = [
    baseEvent({ id: 'e1', kind: 'prompt_offered', promptId: 'p1', text: 'Make your call: who scores next?' }),
    baseEvent({ id: 'e2', kind: 'bet_taken', promptId: 'p1', stakedItem: 'bananas' }),
  ];
  // p1 no longer open by the time bet_taken lands (taken, not still offerable).
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  const promptRows = rows.filter((row) => row.kind === 'prompt');
  assert.equal(promptRows.length, 1);
  assert.equal(promptRows[0].state, 'taken');
  assert.equal(promptRows[0].takenItemId, 'bananas');
  assert.equal(promptRows[0].isOpen, false);
  // The social-proof line is still its own separate row.
  assert.equal(rows.filter((row) => row.kind === 'social_proof').length, 1);
});

test('buildGlobalChatRows: prompt_expired with no take flips the row to "closed"', () => {
  const events = [
    baseEvent({ id: 'e1', kind: 'prompt_offered', promptId: 'p1', text: 'Make your call: a card in the next 10 minutes?' }),
    baseEvent({ id: 'e2', kind: 'prompt_expired', promptId: 'p1' }),
  ];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  const promptRows = rows.filter((row) => row.kind === 'prompt');
  assert.equal(promptRows.length, 1);
  assert.equal(promptRows[0].state, 'closed');
});

test('promptTakenPillText renders the spec-exact "You called it · {emoji} staked" copy', () => {
  assert.equal(promptTakenPillText('lambo', lookupItem), 'You called it · 🏎️ staked');
});

test('promptTakenPillText includes the picked team name when supplied (who-scores-next taken pill)', () => {
  assert.equal(promptTakenPillText('bananas', lookupItem, 'Home United'), 'You called it · Home United · 🍌 staked');
});

// ---------------------------------------------------------------------------
// V1 fix: who-scores-next team-pick UI (QA HIGH, ENG-002..005 UI-side)
// ---------------------------------------------------------------------------

test('ENG-002/003: a who_scores_next prompt row carries predicate "who_scores_next" from the open prompt', () => {
  const events = [baseEvent({ id: 'e1', kind: 'prompt_offered', promptId: 'p1', text: 'Make your call: who scores next?' })];
  const openPrompts = [{ id: 'p1', fixtureId: 'fx-1', trigger: 'kickoff', predicate: 'who_scores_next', sourceFrameId: 'f1', copy: 'Make your call: who scores next?' }];
  const rows = buildGlobalChatRows(events, openPrompts, [], lookupItem);
  assert.equal(rows[0].kind, 'prompt');
  assert.equal(rows[0].predicate, 'who_scores_next');
});

test('a non-team-pick prompt (e.g. goal_in_first_half) carries its own predicate, distinct from who_scores_next', () => {
  const events = [baseEvent({ id: 'e1', kind: 'prompt_offered', promptId: 'p1', text: 'Make your call: a goal in the first half?' })];
  const openPrompts = [{ id: 'p1', fixtureId: 'fx-1', trigger: 'kickoff', predicate: 'goal_in_first_half', sourceFrameId: 'f1', copy: 'Make your call: a goal in the first half?' }];
  const rows = buildGlobalChatRows(events, openPrompts, [], lookupItem);
  assert.equal(rows[0].predicate, 'goal_in_first_half');
});

test('ENG-005: bet_taken on a who_scores_next prompt carries the picked participant onto the taken row', () => {
  const events = [
    baseEvent({ id: 'e1', kind: 'prompt_offered', promptId: 'p1', text: 'Make your call: who scores next?', betPredicate: 'who_scores_next' }),
    baseEvent({ id: 'e2', kind: 'bet_taken', promptId: 'p1', stakedItem: 'dust', pickedParticipant: 2 }),
  ];
  const openPrompts = [{ id: 'p1', fixtureId: 'fx-1', trigger: 'kickoff', predicate: 'who_scores_next', sourceFrameId: 'f1', copy: 'Make your call: who scores next?' }];
  const rows = buildGlobalChatRows(events, openPrompts, [], lookupItem);
  const promptRow = rows.find((row) => row.kind === 'prompt');
  assert.equal(promptRow.state, 'taken');
  assert.equal(promptRow.takenParticipant, 2);
  assert.equal(promptRow.takenItemId, 'dust');
});

test('a non-team-pick call taken via bet_taken has no takenParticipant set', () => {
  const events = [
    baseEvent({ id: 'e1', kind: 'prompt_offered', promptId: 'p1', text: 'Make your call: a card in the next 10 minutes?', betPredicate: 'card_within_window' }),
    baseEvent({ id: 'e2', kind: 'bet_taken', promptId: 'p1', stakedItem: 'pizza' }),
  ];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  const promptRow = rows.find((row) => row.kind === 'prompt');
  assert.equal(promptRow.takenParticipant, undefined);
});

// ---------------------------------------------------------------------------
// V1: Gift Pool rows (pool_seeded / pool_split), UX spec section 3, POOL-011/012
// ---------------------------------------------------------------------------

test('POOL-011: buildGlobalChatRows renders pool_seeded as the once-per-match announcement', () => {
  const events = [
    baseEvent({
      id: 'e1',
      kind: 'pool_seeded',
      poolItemDeltas: [{ item: 'bananas', delta: 500 }, { item: 'lambo', delta: 2 }],
      text: "Tonight's Gift Pool: 500 bananas, 2 lambos.",
    }),
  ];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  assert.equal(rows[0].kind, 'pool_seeded');
  assert.match(rows[0].text, /Tonight's Gift Pool/);
  assert.match(rows[0].text, /500 🍌/);
  assert.match(rows[0].text, /2 🏎️/);
});

test('POOL-012: buildGlobalChatRows renders a winning pool_split with item deltas and no noWinners flag', () => {
  const events = [
    baseEvent({
      id: 'e1',
      kind: 'pool_split',
      poolOutcome: 'split',
      itemDeltas: [{ item: 'bananas', delta: 250 }],
      poolItemDeltas: [{ item: 'bananas', delta: 250 }],
      text: 'Gift Pool split among 2 winners: you get 250 bananas.',
    }),
  ];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  assert.equal(rows[0].kind, 'pool_split');
  assert.equal(rows[0].noWinners, false);
  assert.deepEqual(rows[0].itemDeltas, [{ itemId: 'bananas', quantity: 250 }]);
  assert.match(rows[0].text, /Gift Pool split!/);
});

test('POOL-012: buildGlobalChatRows renders the deterministic no-winner pool_split plainly, with noWinners true, and copy matching the engine\'s actual house-return behavior', () => {
  const events = [
    baseEvent({
      id: 'e1',
      kind: 'pool_split',
      poolOutcome: 'no_winners',
      itemDeltas: [],
      poolItemDeltas: [],
      text: 'No winning calls tonight -- the Gift Pool returns to the house.',
    }),
  ];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  assert.equal(rows[0].kind, 'pool_split');
  assert.equal(rows[0].noWinners, true);
  assert.deepEqual(rows[0].itemDeltas, []);
  // UX review must-fix 1: copy must say house-return, never "rolls to the next match" (that never happens).
  assert.equal(rows[0].text, 'No winning calls tonight -- the Gift Pool goes back to GameCrew.');
});

test('POOL-012: noWinners derivation reads the structural poolOutcome field, not engine text prose', () => {
  // Same no-winner semantics, deliberately different/absent engine text --
  // proves the UI branch no longer depends on a specific English string
  // (QA/UX-flagged coupling defect, now fixed).
  const events = [
    baseEvent({ id: 'e1', kind: 'pool_split', poolOutcome: 'no_winners', itemDeltas: [], poolItemDeltas: [], text: 'Some future reworded copy entirely.' }),
  ];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  assert.equal(rows[0].noWinners, true);
});

test('POOL-012: a room-had-winners-but-not-this-user pool_split is distinct from the true no-winner case', () => {
  const events = [
    baseEvent({
      id: 'e1',
      kind: 'pool_split',
      poolOutcome: 'split',
      itemDeltas: [],
      poolItemDeltas: [],
      text: "Gift Pool split among 3 winners -- you didn't have a winning call this time.",
    }),
  ];
  const rows = buildGlobalChatRows(events, [], [], lookupItem);
  assert.equal(rows[0].noWinners, false);
});

// ---------------------------------------------------------------------------
// V1: poolChipText (economy strip Pool chip)
// ---------------------------------------------------------------------------

test('poolChipText renders "Pool: —" when the pool has not seeded yet', () => {
  assert.equal(poolChipText(undefined, lookupItem), 'Pool: —');
  assert.equal(poolChipText([], lookupItem), 'Pool: —');
});

test('poolChipText shows the top 2 items rarest-first, then by descending quantity within a tier', () => {
  const poolSeed = [
    { itemId: 'bananas', quantity: 500 },
    { itemId: 'lambo', quantity: 2 },
    { itemId: 'rubber_duck', quantity: 40 },
  ];
  // lambo (rarest) leads; rubber_duck (uncommon) outranks bananas (common) for the second slot.
  assert.equal(poolChipText(poolSeed, lookupItem), 'Pool: 2 🏎️ · 40 🦆');
});

// ---------------------------------------------------------------------------
// V1: buildGlobalChatStreamRows (engine events + user chat merge), CHAT-001/006/007/008
// ---------------------------------------------------------------------------

function chatStreamRow(id, text) {
  return { kind: 'chat', message: { id, fixtureId: 'fx-1', text, sentAtMs: 0, releasedEventCountAtSend: 0 } };
}

function eventStreamRow(event) {
  return { kind: 'event', event };
}

test('CHAT-001: buildGlobalChatStreamRows interleaves a user chat row in position order alongside engine events', () => {
  const streamRows = [
    eventStreamRow(baseEvent({ id: 'e1', kind: 'room_chatter', text: 'chatter' })),
    chatStreamRow('m1', 'hey room'),
    eventStreamRow(baseEvent({ id: 'e2', kind: 'match_moment', text: 'GOAL!' })),
  ];
  const rows = buildGlobalChatStreamRows(streamRows, [], [], lookupItem);
  assert.deepEqual(rows.map((row) => row.kind), ['chatter', 'user_chat', 'match_moment']);
  assert.equal(rows[1].text, 'hey room');
});

test('CHAT-008: buildGlobalChatStreamRows applies identical per-event logic as buildGlobalChatRows (prompt state, settlement copy) for the event rows within the merged stream', () => {
  const events = [
    baseEvent({ id: 'e1', kind: 'prompt_offered', promptId: 'p1', text: 'Make your call: who scores next?' }),
    baseEvent({ id: 'e2', kind: 'bet_taken', promptId: 'p1', stakedItem: 'dust' }),
  ];
  const streamRows = events.map(eventStreamRow);
  const rows = buildGlobalChatStreamRows(streamRows, [], [], lookupItem);
  const promptRow = rows.find((row) => row.kind === 'prompt');
  assert.equal(promptRow.state, 'taken');
  assert.equal(promptRow.takenItemId, 'dust');
});

test('buildGlobalChatStreamRows renders an empty stream as an empty row list', () => {
  assert.deepEqual(buildGlobalChatStreamRows([], [], [], lookupItem), []);
});

// ---------------------------------------------------------------------------
// V1: itemClaimStatus's not_sent handling (claim login-required flow)
// ---------------------------------------------------------------------------

test('itemClaimStatus treats a not_sent claim as unclaimed (login-required row still shows the plain claim affordance state)', () => {
  const claims = [{ itemId: 'bananas', quantity: 3, status: 'not_sent' }];
  assert.deepEqual(itemClaimStatus('bananas', claims), { kind: 'unclaimed' });
});

test('itemClaimStatus still resolves minted/failed/pending correctly alongside a not_sent claim for a different item', () => {
  const claims = [
    { itemId: 'bananas', quantity: 3, status: 'not_sent' },
    { itemId: 'lambo', quantity: 1, status: 'minted', explorerUrl: 'https://explorer.example/tx/abc' },
  ];
  assert.deepEqual(itemClaimStatus('lambo', claims), { kind: 'minted', explorerUrl: 'https://explorer.example/tx/abc' });
  assert.deepEqual(itemClaimStatus('bananas', claims), { kind: 'unclaimed' });
});
