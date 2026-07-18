import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireEconomySession,
  __resetEconomySessionRegistryForTests,
} from '../src/state/economy-session.ts';
import { UserPileStore } from '../src/state/user-pile-store.ts';

/**
 * These tests model `use-economy.ts`'s own orchestration of `UserPileStore` +
 * `EconomySession` directly (the hook itself is React-only and can't be
 * imported by the plain-Node test runner -- same constraint as the existing
 * PERS-007 tests in economy-session.test.mjs). They prove the exact
 * cross-fixture popup-gating sequence the hook performs:
 *
 * 1. First-ever fixture for a device: hasSeenWelcomePopup() is false, so the
 *    hook leaves pendingGift true and waits for the UI's claimGift()/
 *    markWelcomePopupSeen() call (modeled here directly).
 * 2. A later, second fixture: hasSeenWelcomePopup() is now true, so the hook
 *    auto-claims the gift silently (recordGiftClaimed + notifyActionsChanged)
 *    as soon as welcome_gift_offered appears, and pendingGift never becomes
 *    true -- the gift still lands (gift_granted still fires), just without a
 *    popup.
 * 3. The seen-flag and the second fixture's silent grant both survive a
 *    simulated restart (fresh UserPileStore instance over the same storage).
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

function createFakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    storage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => {
        map.set(key, value);
      },
    },
    map,
  };
}

/** Minimal fake MatchSessionHandle: no network, single static snapshot (frame count/status don't matter for these tests). */
function createFakeMatchSession(fixtureId) {
  const snapshot = { fixtureId, frames: [{ id: 'f1', fixtureId, seq: 1, stateRevision: 1, facts: [], simulationCues: [] }], headRevision: 1, projectionGeneration: 1, status: 'live' };
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    syncLiveStatus: () => {},
    release: () => {},
  };
}

/** Director standing in for the real engine's gift semantics: welcome_gift_offered on the first frame, gift_granted only once a gift_claimed action is present -- same shape as the PERS-007 tests' giftAwareDirector. */
function giftAwareDirector(frames, options) {
  const actions = options.actions ?? [];
  const events = [];
  if (frames.length > 0) {
    events.push({
      id: `${options.userId}:${frames[0].fixtureId}:welcome_gift_offered`,
      kind: 'welcome_gift_offered',
      fixtureId: frames[0].fixtureId,
      userId: options.userId,
      seq: frames[0].seq,
      sourceFrameId: frames[0].id,
      stateRevision: frames[0].stateRevision,
      coolnessDelta: 0,
      itemDeltas: [],
    });
  }
  if (actions.some((a) => a.kind === 'gift_claimed')) {
    events.push({
      id: `${options.userId}:${frames[0].fixtureId}:gift_granted`,
      kind: 'gift_granted',
      fixtureId: frames[0].fixtureId,
      userId: options.userId,
      seq: frames[0].seq,
      sourceFrameId: frames[0].id,
      stateRevision: frames[0].stateRevision,
      coolnessDelta: 20,
      itemDeltas: [{ item: 'bananas', delta: 12 }],
    });
  }
  return events;
}

function isGiftUnclaimed(events) {
  return events.some((e) => e.kind === 'welcome_gift_offered') && !events.some((e) => e.kind === 'gift_granted');
}

/** Models use-economy.ts's effect body: acquire the session (actions already hydrated), decide pendingGift, and silently auto-claim if the popup has already been seen on this device. */
function mountEconomyForFixture(store, fixtureId) {
  const session = acquireEconomySession(fixtureId, {
    acquireSession: () => createFakeMatchSession(fixtureId),
    director: giftAwareDirector,
    userId: store.getUserId(),
    getActions: () => store.getActionsForFixture(fixtureId),
  });

  const shouldAutoClaimSilently = store.hasSeenWelcomePopup();
  const events = session.getSnapshot().events;

  if (shouldAutoClaimSilently && isGiftUnclaimed(events)) {
    const anchorFrameId = events.find((e) => e.kind === 'welcome_gift_offered').sourceFrameId;
    store.recordGiftClaimed(fixtureId, anchorFrameId, Date.now());
    session.notifyActionsChanged();
  }

  const pendingGift = !shouldAutoClaimSilently && isGiftUnclaimed(session.getSnapshot().events);
  return { session, pendingGift };
}

test.beforeEach(() => {
  __resetEconomySessionRegistryForTests();
});

test('POPUP: first-ever fixture for a device shows the popup (pendingGift true), gift not yet granted', async () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, generateUserId: () => 'user-1', foldBalances });
  await store.load();

  const { session, pendingGift } = mountEconomyForFixture(store, 'fx-match-1');

  assert.equal(pendingGift, true, 'never-seen device: the modal should show');
  assert.equal(isGiftUnclaimed(session.getSnapshot().events), true, 'gift not silently granted -- waiting on the popup');

  session.release();
});

test('POPUP: after the popup is claimed (marking the device-wide flag), a second, different fixture shows no popup but still grants the gift', async () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, generateUserId: () => 'user-1', foldBalances });
  await store.load();

  // First match: popup shown, user taps Claim -- the UI's claimGift() does
  // both of these in use-economy.ts's real claimGift.
  const first = mountEconomyForFixture(store, 'fx-match-1');
  assert.equal(first.pendingGift, true);
  const anchorFrameId = first.session.getSnapshot().events.find((e) => e.kind === 'welcome_gift_offered').sourceFrameId;
  store.recordGiftClaimed('fx-match-1', anchorFrameId, Date.now());
  store.markWelcomePopupSeen();
  first.session.notifyActionsChanged();
  first.session.release();

  // Second, different match: popup must NOT show, but the gift must still land silently.
  const second = mountEconomyForFixture(store, 'fx-match-2');

  assert.equal(second.pendingGift, false, 'popup already seen on this device: no modal for a later match');
  assert.equal(
    second.session.getSnapshot().events.some((e) => e.kind === 'gift_granted'),
    true,
    'the welcome gift for the new fixture is still granted -- silently, as an in-stream reveal row',
  );

  second.session.release();
});

test('POPUP: the seen-flag and the silently-granted second fixture both survive a simulated restart', async () => {
  const { storage } = createFakeStorage();

  const storeA = new UserPileStore({ storage, generateUserId: () => 'user-1', foldBalances });
  await storeA.load();
  const first = mountEconomyForFixture(storeA, 'fx-match-1');
  const anchorFrameId = first.session.getSnapshot().events.find((e) => e.kind === 'welcome_gift_offered').sourceFrameId;
  storeA.recordGiftClaimed('fx-match-1', anchorFrameId, Date.now());
  storeA.markWelcomePopupSeen();
  first.session.notifyActionsChanged();
  first.session.release();
  __resetEconomySessionRegistryForTests();

  // Fresh device state (simulated app restart): a new UserPileStore instance
  // over the same backing storage, and the registry cleared so a fresh
  // EconomySession is constructed exactly as it would be after a relaunch.
  const storeB = new UserPileStore({ storage, foldBalances });
  await storeB.load();
  await storeB.hydrateFixture('fx-match-2');

  assert.equal(storeB.hasSeenWelcomePopup(), true, 'seen-flag survived the restart');

  const second = mountEconomyForFixture(storeB, 'fx-match-2');
  assert.equal(second.pendingGift, false, 'still no popup after restart, for a fixture never opened before');
  assert.equal(second.session.getSnapshot().events.some((e) => e.kind === 'gift_granted'), true, 'gift still silently granted after restart');

  second.session.release();
});

test('POPUP: re-opening the ALREADY-claimed first fixture after seeing the popup never re-shows it or re-grants a second gift', async () => {
  const { storage } = createFakeStorage();
  const store = new UserPileStore({ storage, generateUserId: () => 'user-1', foldBalances });
  await store.load();

  const first = mountEconomyForFixture(store, 'fx-match-1');
  const anchorFrameId = first.session.getSnapshot().events.find((e) => e.kind === 'welcome_gift_offered').sourceFrameId;
  store.recordGiftClaimed('fx-match-1', anchorFrameId, Date.now());
  store.markWelcomePopupSeen();
  first.session.notifyActionsChanged();
  const grantedEventsFirstPass = first.session.getSnapshot().events.filter((e) => e.kind === 'gift_granted');
  first.session.release();
  __resetEconomySessionRegistryForTests();

  // Re-mount the SAME fixture (e.g. navigating back into it) after the popup has already been seen and claimed.
  const reopened = mountEconomyForFixture(store, 'fx-match-1');
  assert.equal(reopened.pendingGift, false);
  const grantedEventsSecondPass = reopened.session.getSnapshot().events.filter((e) => e.kind === 'gift_granted');
  assert.equal(grantedEventsSecondPass.length, 1, 'still exactly one gift_granted event -- idempotent, not re-granted');
  assert.equal(grantedEventsSecondPass[0].id, grantedEventsFirstPass[0].id, 'the same event, not a duplicate');

  reopened.session.release();
});
