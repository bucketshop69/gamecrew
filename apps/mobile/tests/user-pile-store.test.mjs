import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UserPileStore,
  createInMemoryUserPileStorage,
} from '../src/state/user-pile-store.ts';

/**
 * Local re-implementation of `foldEconomyBalances`, standing in for the real
 * `@gamecrew/core` export (which UserPileStore takes injected -- see its
 * module header comment on why this file must not import it directly).
 */
function foldBalances(events) {
  let coolness = 0;
  const pile = {};
  for (const event of events) {
    coolness += event.coolnessDelta;
    for (const delta of event.itemDeltas) {
      pile[delta.item] = (pile[delta.item] ?? 0) + delta.delta;
    }
  }
  return { coolness, pile };
}

/** Fake storage backed by a plain object, so round-trips go through real JSON (de)serialization like a real AsyncStorage would. */
function createFakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  const calls = { getItem: 0, setItem: 0 };
  return {
    storage: {
      getItem: (key) => {
        calls.getItem += 1;
        return map.has(key) ? map.get(key) : null;
      },
      setItem: (key, value) => {
        calls.setItem += 1;
        map.set(key, value);
      },
    },
    map,
    calls,
  };
}

function event(overrides) {
  return {
    id: 'e1',
    kind: 'gift_granted',
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

test('generates and persists a device-local user id on first load', async () => {
  const { storage, map } = createFakeStorage();
  const store = new UserPileStore({ storage, generateUserId: () => 'user-fixed', foldBalances });

  await store.load();

  assert.equal(store.getUserId(), 'user-fixed');
  assert.equal(map.get('gamecrew:economy:device-user-id'), 'user-fixed');
});

test('reuses a previously persisted user id rather than generating a new one', async () => {
  const { storage } = createFakeStorage({ 'gamecrew:economy:device-user-id': 'user-existing' });
  const store = new UserPileStore({ storage, generateUserId: () => 'should-not-be-used', foldBalances });

  await store.load();

  assert.equal(store.getUserId(), 'user-existing');
});

test('recordGiftClaimed appends a gift_claimed action once and is idempotent on repeat calls', () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  store.recordGiftClaimed('fx-1', 'f1', 1000);
  store.recordGiftClaimed('fx-1', 'f1', 2000);

  const actions = store.getActionsForFixture('fx-1');
  assert.equal(actions.length, 1, 'a second claim for the same fixture is a no-op');
  assert.equal(actions[0].kind, 'gift_claimed');
  assert.equal(actions[0].anchorFrameId, 'f1');
});

test('recordBetTaken appends a bet_taken action once per promptId', () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  store.recordBetTaken('fx-1', 'prompt-1', 'bananas');
  store.recordBetTaken('fx-1', 'prompt-1', 'lambo'); // duplicate take on the same prompt: ignored
  store.recordBetTaken('fx-1', 'prompt-2', 'dust');

  const actions = store.getActionsForFixture('fx-1');
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map((a) => `${a.promptId}:${a.itemId}`), ['prompt-1:bananas', 'prompt-2:dust']);
});

test('ENG-005: recordBetTaken records pickedParticipant onto the bet_taken action when a who-scores-next team pick is provided', () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  store.recordBetTaken('fx-1', 'prompt-who-scores', 'bananas', 2);

  const [action] = store.getActionsForFixture('fx-1');
  assert.equal(action.pickedParticipant, 2);
});

test('recordBetTaken omits pickedParticipant for ordinary (non-who-scores-next) takes, preserving backward compatibility', () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  store.recordBetTaken('fx-1', 'prompt-1', 'bananas');

  const [action] = store.getActionsForFixture('fx-1');
  assert.equal(action.pickedParticipant, undefined);
});

test('recordBetTaken with pickedParticipant persists across a fresh store instance over the same storage', async () => {
  const { storage } = createFakeStorage();
  const storeA = new UserPileStore({ storage, foldBalances });
  storeA.recordBetTaken('fx-1', 'prompt-who-scores', 'lambo', 1);

  const storeB = new UserPileStore({ storage, foldBalances });
  await storeB.hydrateFixture('fx-1');

  const [action] = storeB.getActionsForFixture('fx-1');
  assert.equal(action.pickedParticipant, 1);
});

test('cacheEventsForFixture + getBalances folds coolness and pile across all cached fixtures', () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  store.cacheEventsForFixture('fx-1', [
    event({ coolnessDelta: 20, itemDeltas: [{ item: 'bananas', delta: 12 }] }),
  ]);
  store.cacheEventsForFixture('fx-2', [
    event({ id: 'e2', fixtureId: 'fx-2', coolnessDelta: 15, itemDeltas: [{ item: 'bananas', delta: 32 }, { item: 'lambo', delta: 1 }] }),
  ]);

  const balances = store.getBalances();
  assert.equal(balances.coolness, 35, 'coolness sums across fixtures');
  assert.equal(balances.pile.bananas, 44, 'same-item deltas sum across fixtures');
  assert.equal(balances.pile.lambo, 1);
});

test('persistence round-trip: actions and events survive through a fresh store over the same storage', async () => {
  const { storage } = createFakeStorage();

  const storeA = new UserPileStore({ storage, generateUserId: () => 'user-fixed', foldBalances });
  await storeA.load();
  storeA.recordGiftClaimed('fx-1', 'f1', 1000);
  storeA.recordBetTaken('fx-1', 'prompt-1', 'bananas');
  storeA.cacheEventsForFixture('fx-1', [
    event({ coolnessDelta: 20, itemDeltas: [{ item: 'bananas', delta: 12 }] }),
  ]);

  // A fresh store instance (e.g. after an app relaunch) over the *same* backing storage.
  const storeB = new UserPileStore({ storage, generateUserId: () => 'should-not-be-used', foldBalances });
  await storeB.load();
  await storeB.hydrateFixture('fx-1');

  assert.equal(storeB.getUserId(), 'user-fixed', 'device id persisted across store instances');

  const actions = storeB.getActionsForFixture('fx-1');
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map((a) => a.kind), ['gift_claimed', 'bet_taken']);

  const balances = storeB.getBalances();
  assert.equal(balances.coolness, 20);
  assert.equal(balances.pile.bananas, 12);
});

test('hydrateFixture tolerates corrupt/malformed persisted JSON without throwing', async () => {
  const { storage, map } = createFakeStorage();
  map.set('gamecrew:economy:actions:fx-1', '{not valid json');
  map.set('gamecrew:economy:events:fx-1', '{not valid json either');

  const store = new UserPileStore({ storage, foldBalances });
  await assert.doesNotReject(() => store.hydrateFixture('fx-1'));

  assert.deepEqual(store.getActionsForFixture('fx-1'), []);
  assert.equal(store.getBalances().coolness, 0);
});

test('in-memory default storage works standalone (no native dependency required)', async () => {
  const store = new UserPileStore({ storage: createInMemoryUserPileStorage(), generateUserId: () => 'user-x', foldBalances });
  await store.load();
  store.recordGiftClaimed('fx-1', 'f1', 0);
  assert.equal(store.getActionsForFixture('fx-1').length, 1);
});

test('subscribers are notified when actions or cached events change', () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  store.recordGiftClaimed('fx-1', 'f1', 0);
  store.cacheEventsForFixture('fx-1', [event({})]);

  assert.equal(notifications, 2);
  unsubscribe();
});

// ---------------------------------------------------------------------------
// User chat messages (CHAT-002/003/004/009/011)
// ---------------------------------------------------------------------------

test('CHAT-002: recordChatMessage rejects an empty string, no row added', () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  const result = store.recordChatMessage('fx-1', '', 0, 1000);

  assert.equal(result, undefined);
  assert.deepEqual(store.getChatMessagesForFixture('fx-1'), []);
});

test('CHAT-003: recordChatMessage rejects whitespace-only input (spaces and newlines)', () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  assert.equal(store.recordChatMessage('fx-1', '   ', 0, 1000), undefined);
  assert.equal(store.recordChatMessage('fx-1', '\n\n\t  \n', 0, 1000), undefined);
  assert.deepEqual(store.getChatMessagesForFixture('fx-1'), []);
});

test('CHAT-003: recordChatMessage trims meaningful surrounding whitespace before storing', () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  const result = store.recordChatMessage('fx-1', '  hello there  ', 0, 1000);

  assert.equal(result.text, 'hello there');
});

test('CHAT-004: a message at or under the length cap sends; a message over the cap is rejected', async () => {
  const { CHAT_MESSAGE_MAX_LENGTH } = await import('../src/state/user-pile-store.ts');
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  const atCap = 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH);
  const overCap = 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1);

  assert.notEqual(store.recordChatMessage('fx-1', atCap, 0, 1000), undefined, 'exactly at the cap is accepted');
  assert.equal(store.recordChatMessage('fx-1', overCap, 0, 1001), undefined, 'over the cap is rejected');
  assert.equal(store.getChatMessagesForFixture('fx-1').length, 1);
});

test('CHAT-009: five rapid sends all appear exactly once, in order', () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  for (let i = 0; i < 5; i += 1) {
    store.recordChatMessage('fx-1', `message ${i}`, 0, 1000 + i);
  }

  const messages = store.getChatMessagesForFixture('fx-1');
  assert.equal(messages.length, 5);
  assert.deepEqual(messages.map((m) => m.text), ['message 0', 'message 1', 'message 2', 'message 3', 'message 4']);
});

test('CHAT-011/PERS: chat messages persist across a fresh store instance over the same storage', async () => {
  const { storage } = createFakeStorage();

  const storeA = new UserPileStore({ storage, generateUserId: () => 'user-fixed', generateChatMessageId: () => 'chat-fixed-1', foldBalances });
  await storeA.load();
  storeA.recordChatMessage('fx-1', 'hello room', 0, 1000);

  const storeB = new UserPileStore({ storage, foldBalances });
  await storeB.hydrateFixture('fx-1');

  const messages = storeB.getChatMessagesForFixture('fx-1');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'hello room');
  assert.equal(messages[0].releasedEventCountAtSend, 0);
});

// ---------------------------------------------------------------------------
// Item 14 (fix round) root cause: a hydrateFixture read racing a concurrent
// local write must never clobber the write. Reproduces the exact shape of
// the bug -- a returning fixture (already has SOME persisted chat history,
// so hydrateFixture's own restore isn't just a no-op on empty storage) whose
// hydrateFixture() call is still in flight when a message is sent.
// ---------------------------------------------------------------------------

/** Storage whose getItem only resolves once `release()` is called -- lets a test hold hydrateFixture's reads open while it performs a concurrent local write, deterministically reproducing the race window a real async AsyncStorage read leaves open. */
function createDeferredStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    storage: {
      getItem: async (key) => {
        await gate;
        return map.has(key) ? map.get(key) : null;
      },
      setItem: (key, value) => {
        map.set(key, value);
      },
    },
    release: () => release(),
  };
}

test('item 14: a chat message sent while hydrateFixture is still in flight survives, not clobbered once hydration resolves', async () => {
  const { storage, release } = createDeferredStorage({
    'gamecrew:economy:chat:fx-1': JSON.stringify([
      { id: 'chat-old', fixtureId: 'fx-1', text: 'earlier in the match', sentAtMs: 500, releasedEventCountAtSend: 0 },
    ]),
  });
  const store = new UserPileStore({ storage, generateChatMessageId: () => 'chat-reaction-1', foldBalances });

  // Mirrors use-economy.ts's mount effect: hydrateFixture() is called and
  // NOT yet awaited when the user's tap lands.
  const hydratePromise = store.hydrateFixture('fx-1');

  // The tapped reaction chip's send lands while the read above is still
  // in flight (storage hasn't resolved yet).
  const sent = store.recordChatMessage('fx-1', 'What a goal!', 1, 1000);
  assert.notEqual(sent, undefined, 'the send itself succeeds synchronously, in memory');

  // Now let hydrateFixture's storage read resolve.
  release();
  await hydratePromise;

  const messages = store.getChatMessagesForFixture('fx-1');
  assert.ok(
    messages.some((m) => m.text === 'What a goal!'),
    'the reaction sent mid-hydration must still be present after hydration resolves -- this is the exact bug: it used to be wiped by hydrateFixture\'s stale read',
  );
});

test('item 14: hydrateFixture still restores normally when no concurrent write races it (baseline, unaffected by the fix)', async () => {
  const { storage } = createFakeStorage({
    'gamecrew:economy:chat:fx-1': JSON.stringify([
      { id: 'chat-old', fixtureId: 'fx-1', text: 'earlier in the match', sentAtMs: 500, releasedEventCountAtSend: 0 },
    ]),
  });
  const store = new UserPileStore({ storage, foldBalances });

  await store.hydrateFixture('fx-1');

  const messages = store.getChatMessagesForFixture('fx-1');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'earlier in the match');
});

test('hydrateFixture tolerates corrupt persisted chat JSON without throwing (PERS-003 extended to chat)', async () => {
  const { storage, map } = createFakeStorage();
  map.set('gamecrew:economy:chat:fx-1', '{not valid json');

  const store = new UserPileStore({ storage, foldBalances });
  await assert.doesNotReject(() => store.hydrateFixture('fx-1'));
  assert.deepEqual(store.getChatMessagesForFixture('fx-1'), []);
});

test('PERS-009: chat messages, actions, and events for one fixture do not leak into another', async () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  store.recordChatMessage('fx-a', 'hello from A', 0, 1000);
  store.recordGiftClaimed('fx-a', 'f1', 1000);
  store.recordChatMessage('fx-b', 'hello from B', 0, 2000);

  assert.equal(store.getChatMessagesForFixture('fx-a').length, 1);
  assert.equal(store.getChatMessagesForFixture('fx-a')[0].text, 'hello from A');
  assert.equal(store.getChatMessagesForFixture('fx-b').length, 1);
  assert.equal(store.getChatMessagesForFixture('fx-b')[0].text, 'hello from B');
  assert.equal(store.getActionsForFixture('fx-b').length, 0, 'fx-a\'s gift claim does not leak into fx-b');

  // Restore into a fresh store and confirm isolation still holds after hydration.
  const storeB = new UserPileStore({ storage, foldBalances });
  await Promise.all([storeB.hydrateFixture('fx-a'), storeB.hydrateFixture('fx-b')]);
  assert.equal(storeB.getChatMessagesForFixture('fx-a')[0].text, 'hello from A');
  assert.equal(storeB.getChatMessagesForFixture('fx-b')[0].text, 'hello from B');
  assert.equal(storeB.getActionsForFixture('fx-b').length, 0);
});

// ---------------------------------------------------------------------------
// Cross-fixture welcome-popup-seen flag (POPUP-, PERS-007-adjacent)
// ---------------------------------------------------------------------------

test('POPUP: hasSeenWelcomePopup defaults to false before load() resolves and after a fresh install', async () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });

  assert.equal(store.hasSeenWelcomePopup(), false, 'never seen before load() resolves is the safe default (never shows a false positive)');

  await store.load();
  assert.equal(store.hasSeenWelcomePopup(), false, 'a brand-new device has never seen the popup');
});

test('POPUP: markWelcomePopupSeen flips the flag and persists it', async () => {
  const { storage, map } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });
  await store.load();

  store.markWelcomePopupSeen();

  assert.equal(store.hasSeenWelcomePopup(), true);
  assert.equal(map.get('gamecrew:economy:welcome-popup-seen'), '1');
});

test('POPUP: markWelcomePopupSeen is idempotent (no duplicate writes/notifications on repeat calls)', async () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });
  await store.load();

  let notifications = 0;
  store.subscribe(() => { notifications += 1; });

  store.markWelcomePopupSeen();
  store.markWelcomePopupSeen();
  store.markWelcomePopupSeen();

  assert.equal(notifications, 1, 'only the first call actually changes state and notifies');
});

test('POPUP: the welcome-popup-seen flag persists across a fresh store instance over the same storage (restart)', async () => {
  const { storage } = createFakeStorage();

  const storeA = new UserPileStore({ storage, foldBalances });
  await storeA.load();
  storeA.markWelcomePopupSeen();

  // Fresh instance, e.g. after an app relaunch, over the same backing storage.
  const storeB = new UserPileStore({ storage, foldBalances });
  await storeB.load();

  assert.equal(storeB.hasSeenWelcomePopup(), true, 'the flag survives a restart, not reset to false');
});

test('POPUP: the welcome-popup-seen flag is cross-fixture -- unaffected by per-fixture action/event isolation', async () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, foldBalances });
  await store.load();

  store.recordGiftClaimed('fx-a', 'f1', 1000);
  store.markWelcomePopupSeen();

  // Unlike per-fixture actions, this flag has nothing to do with fixtureId at all.
  assert.equal(store.hasSeenWelcomePopup(), true);
  assert.equal(store.getActionsForFixture('fx-b').some((a) => a.kind === 'gift_claimed'), false, 'per-fixture isolation is untouched by this device-wide flag');
});
