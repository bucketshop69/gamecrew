import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireMatchSession,
  __resetMatchSessionRegistryForTests,
} from '../src/state/match-session.ts';

function frame(id, stateRevision, seq = stateRevision) {
  return {
    id,
    fixtureId: 'fx-1',
    seq,
    stateRevision,
    facts: [],
    simulationCues: [],
  };
}

/**
 * A fake clock: setTimer/clearTimer never actually schedule real timers.
 * Timers are tracked with their due time (now + delayMs) so `flush` only
 * fires callbacks that are actually due after advancing the clock — timers
 * registered with a longer delay than the advance amount stay pending, the
 * same way real timers would.
 */
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
    /** Advance the clock and fire every timer whose due time has now passed. */
    async flush(advanceMs = 0) {
      now += advanceMs;
      const due = [...pending.entries()].filter(([, entry]) => entry.dueAt <= now);
      for (const [handle, entry] of due) {
        pending.delete(handle);
        entry.callback();
      }
      // allow queued microtasks (the poll's async fetch) to settle
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    pendingCount: () => pending.size,
  };
}

function createFakeFetcher(responses) {
  let call = 0;
  const calls = [];
  return {
    fn: async (fixtureId, options) => {
      calls.push({ fixtureId, ...options });
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (response instanceof Error) throw response;
      return response;
    },
    calls,
  };
}

test.beforeEach(() => {
  __resetMatchSessionRegistryForTests();
});

test('appends frames, dedupes by id, and reaches live status after backfill', async () => {
  const clock = createFakeClock();
  const fetcher = createFakeFetcher([
    {
      fixtureId: 'fx-1',
      projectionGeneration: 1,
      resyncRequired: false,
      frames: [frame('f1', 1), frame('f2', 2)],
      headRevision: 2,
      nextAfterRevision: 2,
      hasMore: false,
    },
  ]);

  const handle = acquireMatchSession('fx-1', { isLive: () => true,
      fetchFrames: fetcher.fn,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now,
      pollIntervalMs: 10_000,
      staleAfterMs: 30_000,
    });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const snapshot = handle.getSnapshot();
  assert.equal(snapshot.status, 'live');
  assert.equal(snapshot.frames.length, 2);
  assert.equal(snapshot.headRevision, 2);
  assert.deepEqual(snapshot.frames.map((f) => f.id), ['f1', 'f2']);

  handle.release();
});

test('dedupes frames by id across overlapping pages', async () => {
  const clock = createFakeClock();
  const fetcher = createFakeFetcher([
    {
      fixtureId: 'fx-1',
      projectionGeneration: 1,
      resyncRequired: false,
      frames: [frame('f1', 1), frame('f2', 2)],
      headRevision: 3,
      nextAfterRevision: 2,
      hasMore: false,
    },
  ]);

  const handle = acquireMatchSession('fx-1', { isLive: () => true,
      fetchFrames: fetcher.fn,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now,
      pollIntervalMs: 10_000,
      staleAfterMs: 30_000,
    });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // Simulate a poll cadence returning an overlapping frame plus one new frame.
  await clock.flush(10_000);
  fetcher.calls.push('manual-check');

  const snapshot = handle.getSnapshot();
  assert.equal(snapshot.frames.length, 2, 'still deduped after a second poll of the same page');

  handle.release();
});

test('omits generation on bootstrap then sends the active generation on subsequent requests', async () => {
  const clock = createFakeClock();
  const fetcher = createFakeFetcher([
    {
      fixtureId: 'fx-1',
      projectionGeneration: 7,
      resyncRequired: false,
      frames: [frame('f1', 1)],
      headRevision: 1,
      nextAfterRevision: 1,
      hasMore: false,
    },
  ]);

  const handle = acquireMatchSession('fx-1', {
    isLive: () => true,
    fetchFrames: fetcher.fn,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    pollIntervalMs: 10_000,
    staleAfterMs: 30_000,
  });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetcher.calls[0].projectionGeneration, undefined);

  await clock.flush(10_000);
  assert.equal(fetcher.calls[1].projectionGeneration, 7);

  handle.release();
});

test('paginates full backfill via hasMore/nextAfterRevision before settling to live', async () => {
  const clock = createFakeClock();
  const fetcher = createFakeFetcher([
    {
      fixtureId: 'fx-1',
      projectionGeneration: 1,
      resyncRequired: false,
      frames: [frame('f1', 1)],
      headRevision: 3,
      nextAfterRevision: 1,
      hasMore: true,
    },
    {
      fixtureId: 'fx-1',
      projectionGeneration: 1,
      resyncRequired: false,
      frames: [frame('f2', 2), frame('f3', 3)],
      headRevision: 3,
      nextAfterRevision: 3,
      hasMore: false,
    },
  ]);

  const handle = acquireMatchSession('fx-1', { isLive: () => true,
      fetchFrames: fetcher.fn,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now,
      pollIntervalMs: 10_000,
      staleAfterMs: 30_000,
    });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const snapshot = handle.getSnapshot();
  assert.equal(snapshot.status, 'live');
  assert.equal(snapshot.frames.length, 3);
  assert.equal(fetcher.calls.filter((c) => typeof c === 'object').length, 2);
  assert.equal(fetcher.calls[1].afterRevision, 1);

  handle.release();
});

test('resyncRequired clears the log and refetches from zero', async () => {
  const clock = createFakeClock();
  const fetcher = createFakeFetcher([
    {
      fixtureId: 'fx-1',
      projectionGeneration: 1,
      resyncRequired: false,
      frames: [frame('f1', 1), frame('f2', 2)],
      headRevision: 2,
      nextAfterRevision: 2,
      hasMore: false,
    },
  ]);

  const handle = acquireMatchSession('fx-1', {
    isLive: () => true,
    // Indirection so reassigning fetcher.fn mid-test takes effect (the
    // session captures this wrapper once at acquire time, not fetcher.fn
    // itself).
    fetchFrames: (fixtureId, options) => fetcher.fn(fixtureId, options),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    pollIntervalMs: 10_000,
    staleAfterMs: 30_000,
  });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(handle.getSnapshot().frames.length, 2);

  // Next poll signals a projection generation bump -> resync required.
  fetcher.calls.length = 0;
  const resyncResponse = {
    fixtureId: 'fx-1',
    projectionGeneration: 2,
    resyncRequired: true,
    frames: [],
    headRevision: 0,
    nextAfterRevision: 0,
    hasMore: false,
  };
  const freshResponse = {
    fixtureId: 'fx-1',
    projectionGeneration: 2,
    resyncRequired: false,
    frames: [frame('g1', 1)],
    headRevision: 1,
    nextAfterRevision: 1,
    hasMore: false,
  };
  let call = 0;
  fetcher.fn = async (fixtureId, options) => {
    fetcher.calls.push({ fixtureId, ...options });
    call += 1;
    return call === 1 ? resyncResponse : freshResponse;
  };

  await clock.flush(10_000);

  const snapshot = handle.getSnapshot();
  assert.equal(snapshot.frames.length, 1, 'log was reset then repopulated from zero');
  assert.deepEqual(snapshot.frames.map((f) => f.id), ['g1']);
  assert.equal(fetcher.calls.length, 2, 'the resync signal triggers one extra refetch from zero');
  assert.equal(fetcher.calls[0].projectionGeneration, 1, 'the correction is detected against the prior generation');
  assert.equal(fetcher.calls[1].afterRevision, 0, 'the refetch after resync starts from zero');
  assert.equal(fetcher.calls[1].projectionGeneration, 2, 'the refetch acknowledges the replacement generation');
  assert.equal(snapshot.projectionGeneration, 2);

  handle.release();
});

test('two subscribers share one poller; session survives one unsubscribing', async () => {
  const clock = createFakeClock();
  const fetcher = createFakeFetcher([
    {
      fixtureId: 'fx-1',
      projectionGeneration: 1,
      resyncRequired: false,
      frames: [frame('f1', 1)],
      headRevision: 1,
      nextAfterRevision: 1,
      hasMore: false,
    },
  ]);

  const deps = {
    isLive: () => true,
    fetchFrames: fetcher.fn,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    pollIntervalMs: 10_000,
    staleAfterMs: 30_000,
  };

  const handleA = acquireMatchSession('fx-1', deps);
  const handleB = acquireMatchSession('fx-1', deps);

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // Only one poll should have happened for two acquisitions of the same fixture.
  assert.equal(fetcher.calls.length, 1);
  assert.equal(handleA.getSnapshot().frames.length, 1);
  assert.equal(handleB.getSnapshot().frames.length, 1);

  // Releasing one handle must not stop the session (the other still holds it).
  handleB.release();
  await clock.flush(10_000);

  assert.equal(fetcher.calls.length, 2, 'polling continued after only one of two subscribers released');
  assert.equal(handleA.getSnapshot().frames.length, 1);

  handleA.release();
});

test('a subscribed listener receives snapshot updates on poll', async () => {
  const clock = createFakeClock();
  const fetcher = createFakeFetcher([
    {
      fixtureId: 'fx-1',
      projectionGeneration: 1,
      resyncRequired: false,
      frames: [frame('f1', 1)],
      headRevision: 1,
      nextAfterRevision: 1,
      hasMore: false,
    },
  ]);

  const handle = acquireMatchSession('fx-1', { isLive: () => true,
      fetchFrames: fetcher.fn,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now,
      pollIntervalMs: 10_000,
      staleAfterMs: 30_000,
    });

  const seen = [];
  const unsubscribe = handle.subscribe((snapshot) => seen.push(snapshot.status));

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(seen.includes('live'));

  unsubscribe();
  handle.release();
});

test('flips to stale when polling stops returning fresh data past the stale window', async () => {
  const clock = createFakeClock();
  const fetcher = createFakeFetcher([
    {
      fixtureId: 'fx-1',
      projectionGeneration: 1,
      resyncRequired: false,
      frames: [frame('f1', 1)],
      headRevision: 1,
      nextAfterRevision: 1,
      hasMore: false,
    },
  ]);

  // After the first successful poll, make every subsequent fetch hang
  // forever, simulating polling that stops returning fresh data (rather
  // than a poll that succeeds with nothing new — a hang/failure is what
  // should actually count as "not fresh").
  let firstCallDone = false;
  const hangingFetch = async (fixtureId, options) => {
    if (!firstCallDone) {
      firstCallDone = true;
      return fetcher.fn(fixtureId, options);
    }
    return new Promise(() => {});
  };

  const handle = acquireMatchSession('fx-1', {
    isLive: () => true,
    fetchFrames: hangingFetch,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    pollIntervalMs: 10_000,
    staleAfterMs: 20_000,
  });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(handle.getSnapshot().status, 'live');

  // Advance past the poll interval: the next poll fires but hangs, so it
  // never refreshes lastUpdatedAtMs.
  await clock.flush(10_000);
  assert.equal(handle.getSnapshot().status, 'live', 'still live just after one missed poll');

  // Advance past the stale window measured from the last successful poll:
  // the independent stale-watch timer (scheduled at staleAfterMs, i.e. the
  // 20s mark) should now fire and flip status without needing new data.
  await clock.flush(10_000);

  const snapshot = handle.getSnapshot();
  assert.equal(snapshot.status, 'stale');

  handle.release();
});

test('single backfill for finished fixtures does not keep polling', async () => {
  const clock = createFakeClock();
  const fetcher = createFakeFetcher([
    {
      fixtureId: 'fx-1',
      projectionGeneration: 1,
      resyncRequired: false,
      frames: [frame('f1', 1)],
      headRevision: 1,
      nextAfterRevision: 1,
      hasMore: false,
    },
  ]);

  const handle = acquireMatchSession('fx-1', { isLive: () => false,
      fetchFrames: fetcher.fn,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now,
      pollIntervalMs: 10_000,
      staleAfterMs: 30_000,
    });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(handle.getSnapshot().status, 'complete');
  assert.equal(clock.pendingCount(), 0, 'no poll timer scheduled for a finished fixture');

  handle.release();
});

test('upcoming-to-live transition restarts polling on the existing session', async () => {
  const clock = createFakeClock();
  let live = false;
  const fetcher = createFakeFetcher([
    {
      fixtureId: 'fx-1',
      projectionGeneration: 1,
      resyncRequired: false,
      frames: [frame('f1', 1)],
      headRevision: 1,
      nextAfterRevision: 1,
      hasMore: false,
    },
    {
      fixtureId: 'fx-1',
      projectionGeneration: 1,
      resyncRequired: false,
      frames: [frame('f2', 2)],
      headRevision: 2,
      nextAfterRevision: 2,
      hasMore: false,
    },
  ]);

  const handle = acquireMatchSession('fx-1', {
    isLive: () => live,
    fetchFrames: fetcher.fn,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    pollIntervalMs: 10_000,
    staleAfterMs: 30_000,
  });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(handle.getSnapshot().status, 'complete');
  assert.equal(fetcher.calls.length, 1);
  assert.equal(clock.pendingCount(), 0);

  live = true;
  handle.syncLiveStatus();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(fetcher.calls.length, 2, 'kickoff nudge performs an immediate incremental poll');
  assert.equal(fetcher.calls[1].afterRevision, 1);
  assert.equal(fetcher.calls[1].projectionGeneration, 1);
  assert.equal(handle.getSnapshot().status, 'live');
  assert.deepEqual(handle.getSnapshot().frames.map((value) => value.id), ['f1', 'f2']);
  assert.ok(clock.pendingCount() > 0, 'live poll/stale timers are scheduled after kickoff');

  handle.release();
});
