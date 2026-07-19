import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceDropInQueue,
  buildPinnedChallengeStrip,
  buildReactionSendPayload,
  countUnseenOpenChallenges,
  EMPTY_DROP_IN_QUEUE_STATE,
  hasUnreadSignal,
  reconcileDropInQueue,
  REACTION_CHIPS,
  REACTION_EMOJI_CHIPS,
  REACTION_PHRASE_CHIPS,
  shortenChallengeCopy,
} from '../src/screens/match-chat-sheet-logic.ts';

function prompt(id, overrides) {
  return {
    id,
    fixtureId: 'fx-1',
    trigger: '',
    predicate: 'goal_in_first_half',
    sourceFrameId: `frame-${id}`,
    copy: `Make your call: ${id}?`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// reconcileDropInQueue / advanceDropInQueue
// ---------------------------------------------------------------------------

test('reconcileDropInQueue shows the first newly-arrived prompt when idle and sheet closed', () => {
  const next = reconcileDropInQueue(EMPTY_DROP_IN_QUEUE_STATE, [prompt('a')], new Set(), false);
  assert.equal(next.visible?.id, 'a');
  assert.deepEqual(next.queued, []);
});

test('reconcileDropInQueue queues a second newly-arrived prompt behind the currently visible one', () => {
  const afterFirst = reconcileDropInQueue(EMPTY_DROP_IN_QUEUE_STATE, [prompt('a')], new Set(), false);
  const afterSecond = reconcileDropInQueue(afterFirst, [prompt('a'), prompt('b')], new Set(['a']), false);
  assert.equal(afterSecond.visible?.id, 'a');
  assert.deepEqual(afterSecond.queued.map((p) => p.id), ['b']);
});

test('reconcileDropInQueue queues multiple newly-arrived prompts in arrival order', () => {
  const afterFirst = reconcileDropInQueue(EMPTY_DROP_IN_QUEUE_STATE, [prompt('a')], new Set(), false);
  const afterMore = reconcileDropInQueue(
    afterFirst,
    [prompt('a'), prompt('b'), prompt('c')],
    new Set(['a']),
    false,
  );
  assert.equal(afterMore.visible?.id, 'a');
  assert.deepEqual(afterMore.queued.map((p) => p.id), ['b', 'c']);
});

test('reconcileDropInQueue does not re-show a prompt already known from a previous call', () => {
  // "a" was already known (in previousPromptIds) -- it should not be treated
  // as newly arrived even though nothing is currently visible.
  const next = reconcileDropInQueue(EMPTY_DROP_IN_QUEUE_STATE, [prompt('a')], new Set(['a']), false);
  assert.equal(next.visible, undefined);
  assert.deepEqual(next.queued, []);
});

test('reconcileDropInQueue suppresses entirely while the sheet is open', () => {
  const next = reconcileDropInQueue(EMPTY_DROP_IN_QUEUE_STATE, [prompt('a')], new Set(), true);
  assert.equal(next.visible, undefined);
  assert.deepEqual(next.queued, []);
});

test('reconcileDropInQueue clears an existing visible/queued state when the sheet opens', () => {
  const withState = { visible: prompt('a'), queued: [prompt('b')] };
  const next = reconcileDropInQueue(withState, [prompt('a'), prompt('b')], new Set(['a', 'b']), true);
  assert.deepEqual(next, EMPTY_DROP_IN_QUEUE_STATE);
});

test('reconcileDropInQueue drops a visible prompt that is no longer open (answered/expired)', () => {
  const withState = { visible: prompt('a'), queued: [] };
  const next = reconcileDropInQueue(withState, [], new Set(['a']), false);
  assert.equal(next.visible, undefined);
  assert.deepEqual(next.queued, []);
});

test('reconcileDropInQueue drops a queued prompt that closes before it is ever shown', () => {
  const withState = { visible: prompt('a'), queued: [prompt('b'), prompt('c')] };
  const next = reconcileDropInQueue(withState, [prompt('a'), prompt('c')], new Set(['a', 'b', 'c']), false);
  assert.equal(next.visible?.id, 'a');
  assert.deepEqual(next.queued.map((p) => p.id), ['c']);
});

test('advanceDropInQueue promotes the next queued prompt to visible', () => {
  const state = { visible: prompt('a'), queued: [prompt('b'), prompt('c')] };
  const next = advanceDropInQueue(state);
  assert.equal(next.visible?.id, 'b');
  assert.deepEqual(next.queued.map((p) => p.id), ['c']);
});

test('advanceDropInQueue clears visible when the queue is empty', () => {
  const state = { visible: prompt('a'), queued: [] };
  const next = advanceDropInQueue(state);
  assert.equal(next.visible, undefined);
  assert.deepEqual(next.queued, []);
});

// ---------------------------------------------------------------------------
// hasUnreadSignal
// ---------------------------------------------------------------------------

test('hasUnreadSignal is false when there are no signal-kind rows', () => {
  const rows = [{ id: '1', kind: 'chatter' }, { id: '2', kind: 'social_proof' }];
  assert.equal(hasUnreadSignal(rows, new Set()), false);
});

test('hasUnreadSignal is true when a prompt row is not in seenRowIds', () => {
  const rows = [{ id: '1', kind: 'chatter' }, { id: '2', kind: 'prompt' }];
  assert.equal(hasUnreadSignal(rows, new Set()), true);
});

test('hasUnreadSignal is true when a gift_reveal row is not in seenRowIds', () => {
  const rows = [{ id: '1', kind: 'gift_reveal' }];
  assert.equal(hasUnreadSignal(rows, new Set()), true);
});

test('hasUnreadSignal is false once every signal row id is in seenRowIds', () => {
  const rows = [{ id: '1', kind: 'prompt' }, { id: '2', kind: 'gift_reveal' }];
  assert.equal(hasUnreadSignal(rows, new Set(['1', '2'])), false);
});

test('hasUnreadSignal ignores non-signal kinds even when unseen', () => {
  const rows = [{ id: '1', kind: 'settlement_win' }, { id: '2', kind: 'user_chat' }];
  assert.equal(hasUnreadSignal(rows, new Set()), false);
});

// ---------------------------------------------------------------------------
// countUnseenOpenChallenges (item 1/4: floating chat button count badge)
// ---------------------------------------------------------------------------

test('countUnseenOpenChallenges is 0 with no prompt rows', () => {
  const rows = [{ id: '1', kind: 'chatter' }, { id: '2', kind: 'gift_reveal' }];
  assert.equal(countUnseenOpenChallenges(rows, new Set()), 0);
});

test('countUnseenOpenChallenges counts only open, unseen prompt rows', () => {
  const rows = [
    { id: '1', kind: 'prompt', state: 'open' },
    { id: '2', kind: 'prompt', state: 'open' },
    { id: '3', kind: 'prompt', state: 'taken' },
    { id: '4', kind: 'prompt', state: 'closed' },
    { id: '5', kind: 'gift_reveal' },
  ];
  assert.equal(countUnseenOpenChallenges(rows, new Set()), 2);
});

test('countUnseenOpenChallenges excludes ids already in seenRowIds', () => {
  const rows = [
    { id: '1', kind: 'prompt', state: 'open' },
    { id: '2', kind: 'prompt', state: 'open' },
  ];
  assert.equal(countUnseenOpenChallenges(rows, new Set(['1'])), 1);
});

test('countUnseenOpenChallenges is 0 once every open prompt has been seen', () => {
  const rows = [
    { id: '1', kind: 'prompt', state: 'open' },
    { id: '2', kind: 'prompt', state: 'open' },
  ];
  assert.equal(countUnseenOpenChallenges(rows, new Set(['1', '2'])), 0);
});

// ---------------------------------------------------------------------------
// buildPinnedChallengeStrip
// ---------------------------------------------------------------------------

test('buildPinnedChallengeStrip includes open and taken prompt rows', () => {
  const rows = [
    { id: 'r1', kind: 'prompt', promptId: 'p1', copy: 'Goal before half time?', state: 'open' },
    { id: 'r2', kind: 'prompt', promptId: 'p2', copy: 'Who scores next?', state: 'taken', takenItemId: 'dust', takenParticipant: 1 },
  ];
  const chips = buildPinnedChallengeStrip(rows);
  assert.equal(chips.length, 2);
  assert.equal(chips[0].status, 'open');
  assert.equal(chips[1].status, 'taken');
  assert.equal(chips[1].takenItemId, 'dust');
  assert.equal(chips[1].takenParticipant, 1);
});

test('buildPinnedChallengeStrip drops closed/expired prompt rows', () => {
  const rows = [
    { id: 'r1', kind: 'prompt', promptId: 'p1', copy: 'Card in the next 10?', state: 'closed' },
  ];
  assert.deepEqual(buildPinnedChallengeStrip(rows), []);
});

test('buildPinnedChallengeStrip ignores non-prompt rows', () => {
  const rows = [
    { id: 'r1', kind: 'chatter' },
    { id: 'r2', kind: 'prompt', promptId: 'p1', copy: 'Goal?', state: 'open' },
  ];
  const chips = buildPinnedChallengeStrip(rows);
  assert.equal(chips.length, 1);
  assert.equal(chips[0].promptId, 'p1');
});

test('buildPinnedChallengeStrip preserves feed order', () => {
  const rows = [
    { id: 'r1', kind: 'prompt', promptId: 'p1', copy: 'First?', state: 'open' },
    { id: 'r2', kind: 'prompt', promptId: 'p2', copy: 'Second?', state: 'open' },
  ];
  const chips = buildPinnedChallengeStrip(rows);
  assert.deepEqual(chips.map((c) => c.promptId), ['p1', 'p2']);
});

// ---------------------------------------------------------------------------
// shortenChallengeCopy
// ---------------------------------------------------------------------------

test('shortenChallengeCopy leaves short copy unchanged', () => {
  assert.equal(shortenChallengeCopy('Goal in the first half?'), 'Goal in the first half?');
});

test('shortenChallengeCopy truncates long copy at a word boundary with an ellipsis', () => {
  const long = 'Make your call: will there be a goal scored by either team before half time today?';
  const short = shortenChallengeCopy(long);
  assert.ok(short.length <= 41, `expected truncated length <= 41, got ${short.length}`);
  assert.ok(short.endsWith('…'));
  assert.ok(!short.includes('  '));
});

test('shortenChallengeCopy trims surrounding whitespace', () => {
  assert.equal(shortenChallengeCopy('   Goal?   '), 'Goal?');
});

// Item 11 (fix round): drop the "Make your call:" prefix -- the question
// itself is the chip label.
test('shortenChallengeCopy drops the "Make your call:" prefix, leaving the question as the label', () => {
  assert.equal(shortenChallengeCopy('Make your call: a goal in the next 5 minutes?'), 'a goal in the next 5 minutes?');
});

test('shortenChallengeCopy strips the prefix case-insensitively', () => {
  assert.equal(shortenChallengeCopy('MAKE YOUR CALL: who scores next?'), 'who scores next?');
});

test('shortenChallengeCopy leaves copy with no "Make your call:" prefix unaffected', () => {
  assert.equal(shortenChallengeCopy('Goal in the first half?'), 'Goal in the first half?');
});

// ---------------------------------------------------------------------------
// reaction chip payloads
// ---------------------------------------------------------------------------

test('REACTION_CHIPS is the concatenation of phrase and emoji chips', () => {
  assert.deepEqual(REACTION_CHIPS, [...REACTION_PHRASE_CHIPS, ...REACTION_EMOJI_CHIPS]);
});

test('REACTION_PHRASE_CHIPS covers the spec phrases', () => {
  const labels = REACTION_PHRASE_CHIPS.map((chip) => chip.label);
  assert.deepEqual(labels, ['What a goal!', 'VAR again?!', 'Cook them!', 'No way!', 'Scenes!']);
});

test('REACTION_EMOJI_CHIPS covers the spec emoji', () => {
  const labels = REACTION_EMOJI_CHIPS.map((chip) => chip.label);
  assert.deepEqual(labels, ['🔥', '⚽', '😱', '🤯', '👏', '💀']);
});

test('buildReactionSendPayload resolves a known chip id to its exact label text', () => {
  assert.equal(buildReactionSendPayload('goal'), 'What a goal!');
  assert.equal(buildReactionSendPayload('fire'), '🔥');
});

test('buildReactionSendPayload returns undefined for an unknown chip id', () => {
  assert.equal(buildReactionSendPayload('not-a-real-chip'), undefined);
});

test('every REACTION_CHIPS id is unique', () => {
  const ids = REACTION_CHIPS.map((chip) => chip.id);
  assert.equal(new Set(ids).size, ids.length);
});
