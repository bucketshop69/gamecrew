import assert from 'node:assert/strict';
import test from 'node:test';

import { WalletStore, createInMemoryWalletStorage, __resetWalletStoreForTests } from '../src/state/wallet-store.ts';

/** Fake storage backed by a plain object, so round-trips go through real JSON (de)serialization like a real AsyncStorage would. */
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

/** Fake clock matching the WalletStoreDeps setTimer/clearTimer contract, mirroring match-session.test.mjs/economy-stream.test.mjs. */
function createFakeClock(startMs = 0) {
  let now = startMs;
  const pending = new Map();
  let nextHandle = 1;

  return {
    now: () => now,
    setTimer: (callback, delayMs) => {
      const handle = nextHandle++;
      pending.set(handle, { callback, dueAt: now + delayMs });
      return handle;
    },
    clearTimer: (handle) => {
      pending.delete(handle);
    },
    async flush(advanceMs = 0) {
      now += advanceMs;
      const due = [...pending.entries()]
        .filter(([, entry]) => entry.dueAt <= now)
        .sort((a, b) => a[1].dueAt - b[1].dueAt);
      for (const [handle, entry] of due) {
        pending.delete(handle);
        entry.callback();
      }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    pendingCount: () => pending.size,
  };
}

function isAbortError(error) {
  return typeof error === 'object' && error !== null && error.name === 'AbortError';
}

function baseDeps(overrides = {}) {
  const { storage } = overrides.storage ? { storage: overrides.storage } : createFakeStorage();
  return {
    storage,
    createClaim: async () => ({ claimId: 'claim-1', status: 'pending' }),
    fetchClaim: async () => ({ claimId: 'claim-1', status: 'pending' }),
    isAbortError,
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h),
    pollIntervalMs: 1000,
    ...overrides,
  };
}

test.beforeEach(() => {
  __resetWalletStoreForTests();
});

// -- CLAIM-012: no wallet concept before the user ever taps claim -----------

test('a fresh store starts as no_wallet with no address, before any claim is attempted', () => {
  const store = new WalletStore(baseDeps());
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.status, 'no_wallet');
  assert.equal(snapshot.walletAddress, null);
  assert.deepEqual(snapshot.claims, []);
  store.dispose();
});

// -- setWalletAddress (Privy hands the address to this store) ---------------

test('setWalletAddress flips status to ready and persists the address', () => {
  const { storage, map } = createFakeStorage();
  const store = new WalletStore(baseDeps({ storage }));

  store.setWalletAddress('Wallet111');

  assert.equal(store.getSnapshot().status, 'ready');
  assert.equal(store.getSnapshot().walletAddress, 'Wallet111');
  assert.equal(map.get('gamecrew:economy:wallet-address'), 'Wallet111');
  store.dispose();
});

// -- CLAIM-013: claiming never blocks the core loop (claimItem before a wallet exists queues, doesn't throw) --

test('claiming before a wallet address exists queues the claim as not_sent rather than throwing', () => {
  const store = new WalletStore(baseDeps());
  const localId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 3, sourceEventId: 'evt-1' });
  const claim = store.getSnapshot().claims.find((c) => c.localId === localId);
  assert.equal(claim.status, 'not_sent');
  store.dispose();
});

test('setWalletAddress flushes any not_sent claims automatically once the address arrives (CLAIM-002-equivalent at the state layer)', async () => {
  let createCalls = 0;
  const store = new WalletStore(
    baseDeps({
      createClaim: async () => {
        createCalls += 1;
        return { claimId: 'claim-1', status: 'pending' };
      },
    }),
  );

  const localId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'evt-1' });
  assert.equal(store.getSnapshot().claims.find((c) => c.localId === localId).status, 'not_sent');

  store.setWalletAddress('Wallet111');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(createCalls, 1);
  const claim = store.getSnapshot().claims.find((c) => c.localId === localId);
  assert.equal(claim.status, 'pending');
  store.dispose();
});

// -- CLAIM-004: login cancelled mid-claim ------------------------------------

test('cancelPendingLogin removes not_sent claims, returning the item to unclaimed/retryable', () => {
  const store = new WalletStore(baseDeps());
  const localId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'evt-1' });
  assert.equal(store.getSnapshot().claims.length, 1);

  store.cancelPendingLogin();

  assert.equal(store.getSnapshot().claims.length, 0, 'cancelled login leaves no stuck sending/pending claim');

  // Retryable: claiming again for the same sourceEventId creates a fresh attempt.
  const retryId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'evt-1' });
  assert.notEqual(retryId, localId);
  store.dispose();
});

test('cancelPendingLogin never touches claims that are sending/pending/minted/failed', async () => {
  const store = new WalletStore(baseDeps());
  store.setWalletAddress('Wallet111');
  const localId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'evt-1' });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const beforeStatus = store.getSnapshot().claims.find((c) => c.localId === localId).status;
  assert.notEqual(beforeStatus, 'not_sent');

  store.cancelPendingLogin();
  assert.equal(store.getSnapshot().claims.length, 1, 'an already-sent claim is untouched by cancelPendingLogin');
  store.dispose();
});

// -- Claim lifecycle: sending -> pending -> minted (CLAIM-003 equivalent) ---

test('claim lifecycle: sending -> pending -> minted via polling', async () => {
  const clock = createFakeClock();
  let pollCall = 0;
  const store = new WalletStore(
    baseDeps({
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      pollIntervalMs: 1000,
      createClaim: async () => ({ claimId: 'claim-1', status: 'pending' }),
      fetchClaim: async () => {
        pollCall += 1;
        if (pollCall < 2) return { claimId: 'claim-1', status: 'pending' };
        return {
          claimId: 'claim-1',
          status: 'minted',
          mintAddress: 'Mint111',
          txSignature: 'Tx111',
          explorerUrl: 'https://explorer.solana.com/tx/Tx111',
        };
      },
    }),
  );
  store.setWalletAddress('Wallet111');

  const localId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 3, sourceEventId: 'evt-1' });

  // Immediately after claimItem: optimistic 'sending' status.
  assert.equal(store.getSnapshot().claims.find((c) => c.localId === localId).status, 'sending');

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  let claim = store.getSnapshot().claims.find((c) => c.localId === localId);
  assert.equal(claim.status, 'pending');
  assert.equal(claim.claimId, 'claim-1');

  await clock.flush(1000);
  claim = store.getSnapshot().claims.find((c) => c.localId === localId);
  assert.equal(claim.status, 'pending', 'first poll still pending');

  await clock.flush(2000);
  claim = store.getSnapshot().claims.find((c) => c.localId === localId);
  assert.equal(claim.status, 'minted');
  assert.equal(claim.mintAddress, 'Mint111');
  assert.equal(claim.txSignature, 'Tx111');
  assert.equal(claim.explorerUrl, 'https://explorer.solana.com/tx/Tx111');
  assert.equal(clock.pendingCount(), 0, 'polling stops once minted');

  store.dispose();
});

// -- CLAIM-005/006: failure paths --------------------------------------------

test('CLAIM-005/006: create fails outright -> status failed, wallet flips offline, no polling', async () => {
  const clock = createFakeClock();
  const store = new WalletStore(
    baseDeps({
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      createClaim: async () => {
        throw new Error('boom');
      },
    }),
  );
  store.setWalletAddress('Wallet111');

  const localId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'evt-1' });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const claim = store.getSnapshot().claims.find((c) => c.localId === localId);
  assert.equal(claim.status, 'failed');
  assert.equal(store.getSnapshot().status, 'offline', 'unreachable API flips wallet status to offline (CLAIM-005)');
  assert.equal(clock.pendingCount(), 0);

  store.dispose();
});

test('claim resolves to failed after createClaim succeeds but a poll reports failed', async () => {
  const clock = createFakeClock();
  const store = new WalletStore(
    baseDeps({
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      pollIntervalMs: 500,
      createClaim: async () => ({ claimId: 'claim-1', status: 'pending' }),
      fetchClaim: async () => ({ claimId: 'claim-1', status: 'failed' }),
    }),
  );
  store.setWalletAddress('Wallet111');

  const localId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'evt-1' });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  await clock.flush(500);

  const claim = store.getSnapshot().claims.find((c) => c.localId === localId);
  assert.equal(claim.status, 'failed');
  assert.equal(clock.pendingCount(), 0, 'terminal status stops polling');

  store.dispose();
});

// -- CLAIM-007: retry re-attempts the same item, appending not mutating -----

test('CLAIM-007: retrying a failed claim appends a new record for the same sourceEventId rather than mutating the old one', async () => {
  let createCalls = 0;
  const store = new WalletStore(
    baseDeps({
      createClaim: async () => {
        createCalls += 1;
        if (createCalls === 1) throw new Error('boom');
        return { claimId: 'claim-2', status: 'pending' };
      },
    }),
  );
  store.setWalletAddress('Wallet111');

  const firstId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'pile:bananas' });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.getSnapshot().claims.find((c) => c.localId === firstId).status, 'failed');

  // Retry: same sourceEventId, per the pile sheet's "tap claim again" affordance.
  const secondId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'pile:bananas' });
  assert.notEqual(secondId, firstId, 'retry appends a new record');

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.claims.length, 2, 'both the failed attempt and the retry are kept');
  const latest = snapshot.claims.find((c) => c.localId === secondId);
  assert.equal(latest.status, 'pending');
  assert.equal(latest.claimId, 'claim-2');

  store.dispose();
});

// -- CLAIM-008/009: idempotency, the QA catalogue's top risk -----------------

test('CLAIM-008: double-tapping claimItem for the same sourceEventId before it resolves does not create a second record or a second network call', async () => {
  let createCalls = 0;
  const store = new WalletStore(
    baseDeps({
      createClaim: async () => {
        createCalls += 1;
        return { claimId: 'claim-1', status: 'pending' };
      },
    }),
  );
  store.setWalletAddress('Wallet111');

  const firstId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'pile:bananas' });
  const secondId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'pile:bananas' });

  assert.equal(firstId, secondId, 'the second tap returns the same localId, not a new one');
  assert.equal(store.getSnapshot().claims.length, 1, 'only one claim record exists');

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(createCalls, 1, 'only one createClaim network call fired despite two taps');

  store.dispose();
});

test('CLAIM-009: claiming an already-minted item again shows minted, does not re-mint', async () => {
  const store = new WalletStore(
    baseDeps({
      createClaim: async () => ({
        claimId: 'claim-1',
        status: 'minted',
        mintAddress: 'Mint111',
        explorerUrl: 'https://explorer.solana.com/tx/Tx111',
      }),
    }),
  );
  store.setWalletAddress('Wallet111');

  const firstId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'pile:bananas' });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.getSnapshot().claims.find((c) => c.localId === firstId).status, 'minted');

  const secondId = store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'pile:bananas' });
  assert.equal(secondId, firstId, 'tapping claim again on an already-minted item returns the same minted record');
  assert.equal(store.getSnapshot().claims.length, 1, 'no duplicate/second mint record created');

  store.dispose();
});

// -- CLAIM-010/011: restart persistence + resume polling ---------------------

test('CLAIM-010: claim state (minted) survives a fresh store instance over the same storage', async () => {
  const { storage } = createFakeStorage();
  const storeA = new WalletStore(
    baseDeps({
      storage,
      createClaim: async () => ({ claimId: 'claim-1', status: 'minted', mintAddress: 'Mint111', explorerUrl: 'https://x' }),
    }),
  );
  storeA.setWalletAddress('Wallet111');
  storeA.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'pile:bananas' });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  storeA.dispose();

  const storeB = new WalletStore(baseDeps({ storage }));
  await storeB.load();

  assert.equal(storeB.getSnapshot().walletAddress, 'Wallet111', 'wallet address persisted across restart');
  const restored = storeB.getSnapshot().claims.find((c) => c.sourceEventId === 'pile:bananas');
  assert.equal(restored.status, 'minted');
  assert.equal(restored.mintAddress, 'Mint111');
  storeB.dispose();
});

test('CLAIM-011: a claim still pending when the app closed resumes polling after restart, rather than staying stuck', async () => {
  const { storage } = createFakeStorage();
  const clock = createFakeClock();
  const storeA = new WalletStore(
    baseDeps({
      storage,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      createClaim: async () => ({ claimId: 'claim-1', status: 'pending' }),
    }),
  );
  storeA.setWalletAddress('Wallet111');
  storeA.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'pile:bananas' });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(storeA.getSnapshot().claims[0].status, 'pending');
  storeA.dispose();

  const clockB = createFakeClock();
  let pollCalls = 0;
  const storeB = new WalletStore(
    baseDeps({
      storage,
      setTimer: clockB.setTimer,
      clearTimer: clockB.clearTimer,
      pollIntervalMs: 1000,
      fetchClaim: async () => {
        pollCalls += 1;
        return { claimId: 'claim-1', status: 'minted', mintAddress: 'Mint111' };
      },
    }),
  );
  await storeB.load();

  assert.equal(storeB.getSnapshot().claims[0].status, 'pending', 'restored as pending, not reset to unclaimed');
  await clockB.flush(1000);
  assert.equal(pollCalls, 1, 'polling resumed automatically after restart for a still-pending claim');
  assert.equal(storeB.getSnapshot().claims[0].status, 'minted');

  storeB.dispose();
});

// -- CLAIM-015: unclaimed drops never touch the network ----------------------

test('CLAIM-015: no createClaim call fires until claimItem is explicitly invoked', () => {
  let createCalls = 0;
  const store = new WalletStore(baseDeps({ createClaim: async () => { createCalls += 1; return { claimId: 'x', status: 'pending' }; } }));
  store.setWalletAddress('Wallet111');
  // Simulate many settled calls / gifts landing with no claim ever tapped.
  assert.equal(createCalls, 0);
  assert.equal(store.getSnapshot().claims.length, 0);
  store.dispose();
});

// -- Poll backoff (carried forward from POC coverage) ------------------------

test('poll backoff: interval doubles on repeated pending responses, capped, and stops after max attempts', async () => {
  const clock = createFakeClock();
  let pollCalls = 0;
  const store = new WalletStore(
    baseDeps({
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      pollIntervalMs: 1000,
      pollBackoffCapMs: 3000,
      pollMaxAttempts: 3,
      createClaim: async () => ({ claimId: 'claim-1', status: 'pending' }),
      fetchClaim: async () => {
        pollCalls += 1;
        return { claimId: 'claim-1', status: 'pending' };
      },
    }),
  );
  store.setWalletAddress('Wallet111');

  store.claimItem({ fixtureId: 'fx-1', itemId: 'bananas', quantity: 1, sourceEventId: 'evt-1' });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // attempt 0 -> delay 1000
  assert.equal(clock.pendingCount(), 1);
  await clock.flush(1000);
  assert.equal(pollCalls, 1);

  // attempt 1 -> delay 2000
  assert.equal(clock.pendingCount(), 1);
  await clock.flush(2000);
  assert.equal(pollCalls, 2);

  // attempt 2 -> delay would be 4000 but capped at 3000
  assert.equal(clock.pendingCount(), 1);
  await clock.flush(3000);
  assert.equal(pollCalls, 3);

  // attempt 3 === pollMaxAttempts: stop scheduling further polls.
  assert.equal(clock.pendingCount(), 0, 'gives up after pollMaxAttempts, still pending but no more timers');
  const claim = store.getSnapshot().claims[0];
  assert.equal(claim.status, 'pending');

  store.dispose();
});

test('getWalletStore singleton returns the same instance until reset', async () => {
  const mod = await import('../src/state/wallet-store.ts');
  const storeA = mod.getWalletStore(baseDeps());
  const storeB = mod.getWalletStore(baseDeps({ createClaim: async () => ({ claimId: 'other', status: 'pending' }) }));
  assert.equal(storeA, storeB, 'deps are only consulted on first call');

  mod.__resetWalletStoreForTests();
  const storeC = mod.getWalletStore(baseDeps());
  assert.notEqual(storeA, storeC);

  storeA.dispose();
  storeC.dispose();
});

test('in-memory default storage works standalone (no native dependency required)', async () => {
  const store = new WalletStore(baseDeps({ storage: createInMemoryWalletStorage() }));
  store.setWalletAddress('Wallet111');
  assert.equal(store.getSnapshot().status, 'ready');
  store.dispose();
});
