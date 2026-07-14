import assert from 'node:assert/strict';
import test from 'node:test';

import { PlaybackEngine } from '../src/state/playback-engine.ts';

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

function scene(id, durationHint = { minMs: 1000, maxMs: 1000 }) {
  return {
    id,
    fixtureId: 'fx-1',
    kind: 'ambient',
    startRevision: 0,
    sourceFrameIds: [id],
    durationHint,
  };
}

/** A minimal fake MatchSessionHandle: no network, snapshot pushed manually by the test. */
function createFakeSession(initialSnapshot) {
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
      release: () => {
        released = true;
      },
    },
    isReleased: () => released,
    /** Push a new snapshot to the engine, as MatchSession would after a poll. */
    push(next) {
      snapshot = next;
      for (const listener of [...listeners]) {
        listener(snapshot);
      }
    },
    listenerCount: () => listeners.size,
  };
}

function baseSnapshot(overrides = {}) {
  return {
    fixtureId: 'fx-1',
    frames: [],
    headRevision: 0,
    projectionGeneration: 1,
    status: 'loading',
    ...overrides,
  };
}

/** A fake clock matching PlaybackClock, with due-time-aware flush (see match-session tests). */
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
    },
    pendingCount: () => pending.size,
  };
}

function countingDirector() {
  let calls = 0;
  return {
    director: (frames) => {
      calls += 1;
      return frames.map((f) => scene(f.id));
    },
    callCount: () => calls,
  };
}

test('derives the scene timeline from session frames via the injected director', () => {
  const { director } = countingDirector();
  const { handle } = createFakeSession(
    baseSnapshot({ frames: [frame('f1', 1), frame('f2', 2)], headRevision: 2, status: 'live' }),
  );

  const engine = new PlaybackEngine(handle, { director });
  const snapshot = engine.getSnapshot();

  assert.equal(snapshot.timeline.length, 2);
  assert.deepEqual(snapshot.timeline.map((s) => s.id), ['f1', 'f2']);

  engine.dispose();
});

test('live mode tracks the head minus the live buffer', () => {
  const { director } = countingDirector();
  const { handle, push } = createFakeSession(
    baseSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'live' }),
  );

  const engine = new PlaybackEngine(handle, { director, liveBufferScenes: 1 });

  // Only one scene exists; buffer clamps to index 0 (can't go negative).
  assert.equal(engine.getSnapshot().playheadIndex, 0);

  push(
    baseSnapshot({
      frames: [frame('f1', 1), frame('f2', 2), frame('f3', 3)],
      headRevision: 3,
      status: 'live',
    }),
  );

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.headIndex, 2, 'head is the newest scene index');
  assert.equal(snapshot.playheadIndex, 1, 'playhead lags the head by the live buffer');
  assert.equal(snapshot.currentScene.id, 'f2');

  engine.dispose();
});

test('pause freezes the playhead even as new data arrives', () => {
  const { director } = countingDirector();
  const { handle, push } = createFakeSession(
    baseSnapshot({
      frames: [frame('f1', 1), frame('f2', 2)],
      headRevision: 2,
      status: 'live',
    }),
  );

  const engine = new PlaybackEngine(handle, { director, liveBufferScenes: 0 });
  assert.equal(engine.getSnapshot().playheadIndex, 1);

  engine.pause();
  assert.equal(engine.getSnapshot().mode, 'paused');

  push(
    baseSnapshot({
      frames: [frame('f1', 1), frame('f2', 2), frame('f3', 3)],
      headRevision: 3,
      status: 'live',
    }),
  );

  assert.equal(engine.getSnapshot().playheadIndex, 1, 'paused playhead does not follow new head');
  assert.equal(engine.getSnapshot().headIndex, 2, 'head still advances while paused');

  engine.dispose();
});

test('scrubTo moves the playhead to an explicit index and clamps to bounds', () => {
  const { director } = countingDirector();
  const { handle } = createFakeSession(
    baseSnapshot({
      frames: [frame('f1', 1), frame('f2', 2), frame('f3', 3)],
      headRevision: 3,
      status: 'live',
    }),
  );

  const engine = new PlaybackEngine(handle, { director });

  engine.scrubTo(0);
  assert.equal(engine.getSnapshot().mode, 'scrubbing');
  assert.equal(engine.getSnapshot().playheadIndex, 0);

  engine.scrubTo(99);
  assert.equal(engine.getSnapshot().playheadIndex, 2, 'clamped to the last scene');

  engine.scrubTo(-5);
  assert.equal(engine.getSnapshot().playheadIndex, 0, 'clamped to the first scene');

  engine.dispose();
});

test('replay plays from the start and advances on the fake clock per scene duration', async () => {
  const { director } = countingDirector();
  const clock = createFakeClock();
  const { handle } = createFakeSession(
    baseSnapshot({
      frames: [frame('f1', 1), frame('f2', 2), frame('f3', 3)],
      headRevision: 3,
      status: 'complete',
    }),
  );

  const engine = new PlaybackEngine(handle, { director, clock, replaySpeed: 1 });

  engine.startReplay();
  assert.equal(engine.getSnapshot().mode, 'replay');
  assert.equal(engine.getSnapshot().playheadIndex, 0);

  // Each scene here has durationHint {1000,1000} -> 1000ms per step at replaySpeed 1.
  await clock.flush(1000);
  assert.equal(engine.getSnapshot().playheadIndex, 1);

  await clock.flush(1000);
  assert.equal(engine.getSnapshot().playheadIndex, 2);

  // Reached the end: holds at the last scene, no further timers pending.
  await clock.flush(1000);
  assert.equal(engine.getSnapshot().playheadIndex, 2);

  engine.dispose();
});

test('replay pacing is compressed by replaySpeed', async () => {
  const { director } = countingDirector();
  const clock = createFakeClock();
  const { handle } = createFakeSession(
    baseSnapshot({
      frames: [frame('f1', 1), frame('f2', 2)],
      headRevision: 2,
      status: 'complete',
    }),
  );

  const engine = new PlaybackEngine(handle, { director, clock, replaySpeed: 10 });
  engine.startReplay();

  // durationHint {1000,1000} / replaySpeed 10 = 100ms per step.
  await clock.flush(100);
  assert.equal(engine.getSnapshot().playheadIndex, 1);

  engine.dispose();
});

test('play() after replay/pause resumes live-buffer tracking', () => {
  const { director } = countingDirector();
  const { handle } = createFakeSession(
    baseSnapshot({
      frames: [frame('f1', 1), frame('f2', 2), frame('f3', 3)],
      headRevision: 3,
      status: 'live',
    }),
  );

  const engine = new PlaybackEngine(handle, { director, liveBufferScenes: 1 });
  engine.scrubTo(0);
  assert.equal(engine.getSnapshot().playheadIndex, 0);

  engine.play();
  assert.equal(engine.getSnapshot().mode, 'live');
  assert.equal(engine.getSnapshot().playheadIndex, 1, 'back to head minus buffer');

  engine.dispose();
});

test('timeline is memoized on headRevision: the director does not re-run when head is unchanged', () => {
  const { director, callCount } = countingDirector();
  const { handle, push } = createFakeSession(
    baseSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'live' }),
  );

  const engine = new PlaybackEngine(handle, { director });
  const callsAfterConstruction = callCount();
  assert.ok(callsAfterConstruction >= 1);

  // Push an "update" that does not actually change headRevision (e.g. a
  // stale-window re-emit or an unrelated status change).
  push(baseSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'stale' }));

  assert.equal(callCount(), callsAfterConstruction, 'director was not re-run for an unchanged head');

  // A genuine head advance must re-run the director.
  push(
    baseSnapshot({
      frames: [frame('f1', 1), frame('f2', 2)],
      headRevision: 2,
      status: 'live',
    }),
  );

  assert.equal(callCount(), callsAfterConstruction + 1, 'director re-ran once the head advanced');

  engine.dispose();
});

test('dispose unsubscribes from the session and releases the handle', () => {
  const { director } = countingDirector();
  const { handle, isReleased, listenerCount } = createFakeSession(
    baseSnapshot({ frames: [], headRevision: 0, status: 'loading' }),
  );

  const engine = new PlaybackEngine(handle, { director });
  assert.equal(listenerCount(), 1);

  engine.dispose();

  assert.equal(isReleased(), true);
  assert.equal(listenerCount(), 0);
});
