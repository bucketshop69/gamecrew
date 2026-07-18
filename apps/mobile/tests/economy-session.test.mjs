import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireEconomySession,
  __resetEconomySessionRegistryForTests,
} from '../src/state/economy-session.ts';

/** Minimal fake MatchSessionHandle: no network, snapshot pushed manually by the test. */
function createFakeMatchSession(initialSnapshot) {
  let snapshot = initialSnapshot;
  const listeners = new Set();
  let released = false;

  return {
    handle: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => snapshot,
      syncLiveStatus: () => {},
      release: () => {
        released = true;
      },
    },
    isReleased: () => released,
    push(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener(snapshot);
    },
    listenerCount: () => listeners.size,
  };
}

function baseMatchSnapshot(overrides = {}) {
  return {
    fixtureId: 'fx-1',
    frames: [],
    headRevision: 0,
    projectionGeneration: 1,
    status: 'loading',
    ...overrides,
  };
}

function frame(id, stateRevision, seq = stateRevision) {
  return { id, fixtureId: 'fx-1', seq, stateRevision, facts: [], simulationCues: [] };
}

/** Fake, deterministic director: returns one event per frame, tagged with the current action count. */
function countingDirector() {
  let calls = 0;
  return {
    director: (frames, options) => {
      calls += 1;
      const actions = options.actions ?? [];
      return frames.map((f) => ({
        id: `${f.id}:${options.userId}:${actions.length}`,
        kind: 'match_moment',
        fixtureId: f.fixtureId,
        userId: options.userId,
        seq: f.seq,
        sourceFrameId: f.id,
        stateRevision: f.stateRevision,
        coolnessDelta: 0,
        itemDeltas: [],
        text: `actions=${actions.length}`,
      }));
    },
    callCount: () => calls,
  };
}

test.beforeEach(() => {
  __resetEconomySessionRegistryForTests();
});

// -- ENG-004/005 state-side: pickedParticipant flows from the local action
// through EconomySession into the director's options.actions, which is what
// the real engine (packages/core) reads to settle a who_scores_next call
// win/loss. This is not re-testing the engine's own settlement logic
// (covered in packages/core) -- it proves the mobile chain (UserPileStore ->
// EconomySession -> buildEconomyTimeline's options.actions) actually carries
// the team pick through, which is exactly the gap the coordinator flagged:
// takeBet had no parameter for it at all.

/** A director standing in for the real engine's who_scores_next settlement: settles win if the taken action's pickedParticipant matches the frame's simulated scoringParticipant fact, loss otherwise. */
function whoScoresNextDirector(frames, options) {
  const actions = options.actions ?? [];
  const take = actions.find((a) => a.kind === 'bet_taken' && a.promptId === 'prompt-wsn');
  if (!take) return [];
  const scoringFrame = frames.find((f) => f.scoringParticipant !== undefined);
  if (!scoringFrame) return [];
  const outcome = take.pickedParticipant === scoringFrame.scoringParticipant ? 'bet_settled_win' : 'bet_settled_loss';
  return [{
    id: `${options.userId}:${outcome}`,
    kind: outcome,
    fixtureId: scoringFrame.fixtureId,
    userId: options.userId,
    seq: scoringFrame.seq,
    sourceFrameId: scoringFrame.id,
    stateRevision: scoringFrame.stateRevision,
    coolnessDelta: outcome === 'bet_settled_win' ? 15 : -5,
    itemDeltas: [],
    promptId: 'prompt-wsn',
    pickedParticipant: take.pickedParticipant,
    scoringParticipant: scoringFrame.scoringParticipant,
  }];
}

test('ENG-004/005: a who-scores-next take with pickedParticipant flows through to the engine action and settles WIN when the pick matches who scored', () => {
  const { handle } = createFakeMatchSession(
    baseMatchSnapshot({
      frames: [{ ...frame('f1', 1), scoringParticipant: 2 }],
      headRevision: 1,
      status: 'live',
    }),
  );

  const session = acquireEconomySession('fx-1', {
    acquireSession: () => handle,
    director: whoScoresNextDirector,
    userId: 'user-1',
    // The picked team (2) matches the frame's scoringParticipant (2): should settle win.
    getActions: () => [{ kind: 'bet_taken', promptId: 'prompt-wsn', itemId: 'bananas', pickedParticipant: 2 }],
  });

  const [event] = session.getSnapshot().events;
  assert.equal(event.kind, 'bet_settled_win');
  assert.equal(event.pickedParticipant, 2);
  assert.equal(event.scoringParticipant, 2);
  assert.equal(event.coolnessDelta, 15);

  session.release();
});

test('ENG-004/005: a who-scores-next take with a non-matching pickedParticipant settles LOSS', () => {
  const { handle } = createFakeMatchSession(
    baseMatchSnapshot({
      frames: [{ ...frame('f1', 1), scoringParticipant: 2 }],
      headRevision: 1,
      status: 'live',
    }),
  );

  const session = acquireEconomySession('fx-1', {
    acquireSession: () => handle,
    director: whoScoresNextDirector,
    userId: 'user-1',
    // Picked team 1, but team 2 actually scored: should settle loss.
    getActions: () => [{ kind: 'bet_taken', promptId: 'prompt-wsn', itemId: 'bananas', pickedParticipant: 1 }],
  });

  const [event] = session.getSnapshot().events;
  assert.equal(event.kind, 'bet_settled_loss');
  assert.equal(event.coolnessDelta, -5);

  session.release();
});

test('ENG-004/005: omitting pickedParticipant (a non-who-scores-next take) is unaffected -- backward compatible', () => {
  const { director } = countingDirector();
  const { handle } = createFakeMatchSession(
    baseMatchSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'live' }),
  );

  const session = acquireEconomySession('fx-1', {
    acquireSession: () => handle,
    director,
    userId: 'user-1',
    getActions: () => [{ kind: 'bet_taken', promptId: 'prompt-1', itemId: 'dust' }],
  });

  // countingDirector doesn't touch pickedParticipant at all; this just
  // proves an action without it still flows through without throwing/
  // breaking the existing (three-arg-less) call shape.
  assert.equal(session.getSnapshot().events.length, 1);
  session.release();
});

test('derives events from the match session frame log via the injected director', () => {
  const { director } = countingDirector();
  const { handle } = createFakeMatchSession(
    baseMatchSnapshot({ frames: [frame('f1', 1), frame('f2', 2)], headRevision: 2, status: 'live' }),
  );

  const session = acquireEconomySession('fx-1', {
    acquireSession: () => handle,
    director,
    userId: 'user-1',
    getActions: () => [],
  });

  const snapshot = session.getSnapshot();
  assert.equal(snapshot.events.length, 2);
  assert.deepEqual(snapshot.events.map((e) => e.sourceFrameId), ['f1', 'f2']);
  assert.equal(snapshot.sessionStatus, 'live');

  session.release();
});

test('two acquisitions of the same fixture share one underlying EconomySession', () => {
  const { director, callCount } = countingDirector();
  const { handle } = createFakeMatchSession(
    baseMatchSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'live' }),
  );

  const deps = {
    acquireSession: () => handle,
    director,
    userId: 'user-1',
    getActions: () => [],
  };

  const sessionA = acquireEconomySession('fx-1', deps);
  const sessionB = acquireEconomySession('fx-1', deps);

  assert.equal(callCount(), 1, 'director ran once for two acquisitions of the same fixture');
  assert.equal(sessionA.getSnapshot().events.length, 1);
  assert.equal(sessionB.getSnapshot().events.length, 1);

  sessionA.release();
  sessionB.release();
});

test('rebuild is memoized on head revision/generation/frame count/actions length', () => {
  const { director, callCount } = countingDirector();
  const { handle, push } = createFakeMatchSession(
    baseMatchSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'live' }),
  );

  const session = acquireEconomySession('fx-1', {
    acquireSession: () => handle,
    director,
    userId: 'user-1',
    getActions: () => [],
  });
  const callsAfterConstruction = callCount();

  // Status-only change (no head/generation/frame-count/actions change): no re-run.
  push(baseMatchSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'stale' }));
  assert.equal(callCount(), callsAfterConstruction, 'director not re-run for a status-only update');
  assert.equal(session.getSnapshot().sessionStatus, 'stale', 'status still propagates');

  // Genuine frame-log change: re-run.
  push(baseMatchSnapshot({ frames: [frame('f1', 1), frame('f2', 2)], headRevision: 2, status: 'live' }));
  assert.equal(callCount(), callsAfterConstruction + 1, 'director re-ran once frames advanced');

  session.release();
});

test('notifyActionsChanged forces a recompute even when the frame log is unchanged', () => {
  const { director, callCount } = countingDirector();
  const { handle } = createFakeMatchSession(
    baseMatchSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'live' }),
  );

  let actions = [];
  const session = acquireEconomySession('fx-1', {
    acquireSession: () => handle,
    director,
    userId: 'user-1',
    getActions: () => actions,
  });
  const callsAfterConstruction = callCount();
  assert.equal(session.getSnapshot().events[0].text, 'actions=0');

  actions = [{ kind: 'gift_claimed', anchorFrameId: 'f1', claimedAt: 0 }];
  session.notifyActionsChanged();

  assert.equal(callCount(), callsAfterConstruction + 1, 'director re-ran after notifyActionsChanged');
  assert.equal(session.getSnapshot().events[0].text, 'actions=1');

  session.release();
});

test('subscribers receive snapshot updates when the underlying match session advances', () => {
  const { director } = countingDirector();
  const { handle, push } = createFakeMatchSession(
    baseMatchSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'live' }),
  );

  const session = acquireEconomySession('fx-1', {
    acquireSession: () => handle,
    director,
    userId: 'user-1',
    getActions: () => [],
  });

  const seen = [];
  const unsubscribe = session.subscribe((snapshot) => seen.push(snapshot.events.length));

  push(baseMatchSnapshot({ frames: [frame('f1', 1), frame('f2', 2)], headRevision: 2, status: 'live' }));

  assert.deepEqual(seen, [2]);

  unsubscribe();
  session.release();
});

// -- PERS-007 regression guard --------------------------------------------
// pendingGift (computed by the hook layer as
// "welcome_gift_offered present, gift_granted absent") must never be true
// for a returning user whose gift_claimed action is already persisted. The
// bug this guards against: acquiring an EconomySession (which synchronously
// builds the timeline once in its constructor) *before* the local actions
// have been restored from storage would run the director with an empty
// actions array, so a returning user's already-claimed gift would look
// unclaimed on the very first build. use-economy.ts now awaits
// UserPileStore.hydrateFixture() before calling acquireEconomySession(); this
// test proves that ordering is what makes the fix correct, using a director
// shaped like the real engine's gift semantics (welcome_gift_offered always
// on frame one, gift_granted only once a gift_claimed action is present).

function giftAwareDirector(frames, options) {
  const actions = options.actions ?? [];
  const events = [];
  if (frames.length > 0) {
    events.push({
      id: `${options.userId}:welcome_gift_offered`,
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
      id: `${options.userId}:gift_granted`,
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

function pendingGiftFrom(events) {
  return events.some((e) => e.kind === 'welcome_gift_offered') && !events.some((e) => e.kind === 'gift_granted');
}

test('PERS-007: acquiring the session only after actions are restored never shows pendingGift for a returning user', () => {
  const { handle } = createFakeMatchSession(
    baseMatchSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'live' }),
  );

  // Simulates a returning user: hydrateFixture already restored their
  // gift_claimed action into the store *before* acquireEconomySession is
  // called (the fixed ordering in use-economy.ts).
  const restoredActions = [{ kind: 'gift_claimed', anchorFrameId: 'f1', claimedAt: 500 }];

  const session = acquireEconomySession('fx-1', {
    acquireSession: () => handle,
    director: giftAwareDirector,
    userId: 'user-1',
    getActions: () => restoredActions,
  });

  const snapshot = session.getSnapshot();
  assert.equal(pendingGiftFrom(snapshot.events), false, 'a returning user with a persisted claim never sees pendingGift=true, even on the very first build');

  session.release();
});

test('PERS-007 (contrast): acquiring the session BEFORE actions are restored incorrectly shows pendingGift on the first build', () => {
  const { handle } = createFakeMatchSession(
    baseMatchSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'live' }),
  );

  // Simulates the old, buggy ordering: getActions reads an empty array
  // because hydration hasn't resolved yet at the moment the session is
  // constructed (its constructor runs the director synchronously).
  let restoredActions = [];

  const session = acquireEconomySession('fx-1', {
    acquireSession: () => handle,
    director: giftAwareDirector,
    userId: 'user-1',
    getActions: () => restoredActions,
  });

  assert.equal(pendingGiftFrom(session.getSnapshot().events), true, 'demonstrates the bug this ordering fix prevents: the first build sees no actions yet');

  // Even after actions arrive, nothing re-triggers a rebuild without an
  // explicit notifyActionsChanged() -- which is exactly why the fix must be
  // "hydrate before acquiring", not "hydrate, then hope a later frame fixes it".
  restoredActions = [{ kind: 'gift_claimed', anchorFrameId: 'f1', claimedAt: 500 }];
  assert.equal(pendingGiftFrom(session.getSnapshot().events), true, 'stale until an explicit recompute -- proving hydration must complete before acquisition, not after');

  session.notifyActionsChanged();
  assert.equal(pendingGiftFrom(session.getSnapshot().events), false, 'notifyActionsChanged recovers it, but relying on that after the fact is the bug the fix avoids');

  session.release();
});

test('release disposes the underlying match session handle once refcount hits zero', () => {
  const { director } = countingDirector();
  const { handle, isReleased } = createFakeMatchSession(baseMatchSnapshot({ status: 'loading' }));

  const deps = {
    acquireSession: () => handle,
    director,
    userId: 'user-1',
    getActions: () => [],
  };

  const sessionA = acquireEconomySession('fx-1', deps);
  const sessionB = acquireEconomySession('fx-1', deps);

  sessionA.release();
  assert.equal(isReleased(), false, 'still held by sessionB');

  sessionB.release();
  assert.equal(isReleased(), true, 'released once the last handle releases');
});
