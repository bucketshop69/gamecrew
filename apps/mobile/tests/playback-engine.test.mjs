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

function scene(id, durationHint = { minMs: 1000, maxMs: 1000 }, playbackDurationMs) {
  return {
    id,
    fixtureId: 'fx-1',
    kind: 'ambient',
    startRevision: 0,
    sourceFrameIds: [id],
    durationHint,
    ...(playbackDurationMs === undefined
      ? {}
      : { playback: { playbackOffsetMs: 0, playbackDurationMs } }),
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
      syncLiveStatus: () => {},
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

test('live mode drains a three-scene poll burst in source order after the time buffer', async () => {
  const { director } = countingDirector();
  const clock = createFakeClock();
  const { handle, push } = createFakeSession(
    baseSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'live' }),
  );

  const engine = new PlaybackEngine(handle, { director, clock, liveBufferMs: 4000 });
  assert.equal(engine.getSnapshot().playheadIndex, 0);

  push(
    baseSnapshot({
      frames: [frame('f1', 1), frame('f2', 2), frame('f3', 3), frame('f4', 4)],
      headRevision: 4,
      status: 'live',
    }),
  );

  assert.equal(engine.getSnapshot().headIndex, 3, 'data head advances immediately');
  assert.equal(engine.getSnapshot().currentScene.id, 'f1', 'playhead waits behind the time buffer');

  const played = [];
  const unsubscribe = engine.subscribe((snapshot) => {
    const id = snapshot.currentScene?.id;
    if (id && played.at(-1) !== id) played.push(id);
  });

  await clock.flush(4000);
  assert.equal(engine.getSnapshot().currentScene.id, 'f2');
  await clock.flush(1000);
  assert.equal(engine.getSnapshot().currentScene.id, 'f3');
  await clock.flush(1000);
  assert.equal(engine.getSnapshot().currentScene.id, 'f4');
  assert.deepEqual(played, ['f2', 'f3', 'f4']);

  unsubscribe();
  engine.dispose();
});

test('newest live scene becomes visible after the time buffer without a future event', async () => {
  const { director } = countingDirector();
  const clock = createFakeClock();
  const { handle, push } = createFakeSession(
    baseSnapshot({ frames: [frame('f1', 1)], headRevision: 1, status: 'live' }),
  );
  const engine = new PlaybackEngine(handle, { director, clock, liveBufferMs: 4000 });

  push(baseSnapshot({
    frames: [frame('f1', 1), frame('f2', 2)],
    headRevision: 2,
    status: 'live',
  }));

  await clock.flush(3999);
  assert.equal(engine.getSnapshot().currentScene.id, 'f1');
  await clock.flush(1);
  assert.equal(engine.getSnapshot().currentScene.id, 'f2');
  assert.equal(clock.pendingCount(), 0, 'latest scene holds without waiting for another event');

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

  const engine = new PlaybackEngine(handle, { director, clock: createFakeClock(), liveBufferMs: 0 });
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

test('startReplayAt enters replay at an explicit scene and continues on the normal schedule', async () => {
  const clock = createFakeClock();
  const { handle } = createFakeSession(
    baseSnapshot({
      frames: [frame('f1', 1), frame('f2', 2), frame('f3', 3)],
      headRevision: 3,
      status: 'complete',
    }),
  );
  const engine = new PlaybackEngine(handle, {
    director: (frames) => frames.map((item) => scene(item.id, undefined, 1000)),
    clock,
  });

  engine.startReplayAt(1);
  assert.equal(engine.getSnapshot().mode, 'replay');
  assert.equal(engine.getSnapshot().currentScene.id, 'f2');

  await clock.flush(1000);
  assert.equal(engine.getSnapshot().currentScene.id, 'f3');

  engine.startReplayAt(999);
  assert.equal(engine.getSnapshot().currentScene.id, 'f3', 'capture/seek starts clamp to the timeline');

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

  const engine = new PlaybackEngine(handle, { director, clock });

  engine.startReplay();
  assert.equal(engine.getSnapshot().mode, 'replay');
  assert.equal(engine.getSnapshot().playheadIndex, 0);

  // No concrete playback metadata here, so the 1000ms minimum hint is the fallback window.
  await clock.flush(1000);
  assert.equal(engine.getSnapshot().playheadIndex, 1);

  await clock.flush(1000);
  assert.equal(engine.getSnapshot().playheadIndex, 2);

  // Reached the end: holds at the last scene, no further timers pending.
  await clock.flush(1000);
  assert.equal(engine.getSnapshot().playheadIndex, 2);

  engine.dispose();
});

test('replay consumes the director playback duration exactly without a second speed multiplier', async () => {
  const clock = createFakeClock();
  const { handle } = createFakeSession(
    baseSnapshot({
      frames: [frame('f1', 1), frame('f2', 2)],
      headRevision: 2,
      status: 'complete',
    }),
  );

  const director = (frames) => frames.map((f) => scene(f.id, { minMs: 4000, maxMs: 8000 }, 375));
  const engine = new PlaybackEngine(handle, { director, clock });
  engine.startReplay();

  assert.equal(engine.getSnapshot().activeSceneWindow.durationMs, 375);
  await clock.flush(374);
  assert.equal(engine.getSnapshot().playheadIndex, 0);
  await clock.flush(1);
  assert.equal(engine.getSnapshot().playheadIndex, 1);

  engine.dispose();
});

test('replay holds an initial partial loading timeline until the session settles', () => {
  const { director } = countingDirector();
  const clock = createFakeClock();
  const { handle, push } = createFakeSession(
    baseSnapshot({
      frames: [frame('partial-1', 1)],
      headRevision: 1,
      projectionGeneration: 1,
      status: 'loading',
    }),
  );
  const engine = new PlaybackEngine(handle, { director, clock });

  engine.startReplay();
  assert.equal(engine.getSnapshot().playheadIndex, -1);
  assert.equal(engine.getSnapshot().activeSceneWindow, undefined);
  assert.equal(clock.pendingCount(), 0);

  push(baseSnapshot({
    frames: [frame('partial-1', 1)],
    headRevision: 1,
    projectionGeneration: 1,
    status: 'complete',
  }));
  assert.equal(engine.getSnapshot().currentScene.id, 'partial-1');
  assert.match(engine.getSnapshot().activeSceneWindow.instanceKey, /^1:partial-1:/);
  assert.equal(clock.pendingCount(), 1);

  engine.dispose();
});

test('play() after replay/pause jumps to the current live head', () => {
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
  assert.equal(engine.getSnapshot().playheadIndex, 0);

  engine.play();
  assert.equal(engine.getSnapshot().mode, 'live');
  assert.equal(engine.getSnapshot().playheadIndex, 2, 'back to the current live head');

  engine.dispose();
});

test('timeline memoization skips status-only updates but rebuilds when the data head advances', () => {
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

test('refreshProjection re-runs the director at the same data head and remaps the live playhead', () => {
  let useSummary = true;
  let calls = 0;
  const director = (frames) => {
    calls += 1;
    return useSummary ? [scene('summary')] : frames.map((item) => scene(item.id));
  };
  const { handle } = createFakeSession(
    baseSnapshot({
      frames: [frame('f1', 1), frame('f2', 2)],
      headRevision: 2,
      status: 'live',
    }),
  );
  const engine = new PlaybackEngine(handle, { director });

  assert.deepEqual(engine.getSnapshot().timeline.map((item) => item.id), ['summary']);
  useSummary = false;
  engine.refreshProjection();

  const snapshot = engine.getSnapshot();
  assert.equal(calls, 2);
  assert.deepEqual(snapshot.timeline.map((item) => item.id), ['f1', 'f2']);
  assert.equal(snapshot.currentScene.id, 'f2', 'live mode holds the head of the refreshed timeline');

  engine.dispose();
});

test('projection generation change rebuilds and resets the active scene even at the same head revision', () => {
  const { director, callCount } = countingDirector();
  const { handle, push } = createFakeSession(
    baseSnapshot({
      frames: [frame('old', 1)],
      headRevision: 1,
      projectionGeneration: 1,
      status: 'live',
    }),
  );
  const engine = new PlaybackEngine(handle, { director });
  const oldInstanceKey = engine.getSnapshot().activeSceneWindow.instanceKey;

  push(baseSnapshot({
    frames: [frame('corrected', 1)],
    headRevision: 1,
    projectionGeneration: 2,
    status: 'live',
  }));

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.currentScene.id, 'corrected');
  assert.equal(snapshot.projectionGeneration, 2);
  assert.notEqual(snapshot.activeSceneWindow.instanceKey, oldInstanceKey);
  assert.match(snapshot.activeSceneWindow.instanceKey, /^2:corrected:/);
  assert.equal(callCount(), 2, 'same revision is rebuilt when generation changes');

  engine.dispose();
});

test('replay restarts when an empty correction generation repopulates without another generation change', async () => {
  const { director } = countingDirector();
  const clock = createFakeClock();
  const { handle, push } = createFakeSession(
    baseSnapshot({
      frames: [frame('old-1', 1), frame('old-2', 2)],
      headRevision: 2,
      projectionGeneration: 1,
      status: 'complete',
    }),
  );
  const engine = new PlaybackEngine(handle, { director, clock });
  engine.startReplay();
  assert.equal(engine.getSnapshot().currentScene.id, 'old-1');
  assert.equal(clock.pendingCount(), 1);

  push(baseSnapshot({
    frames: [],
    headRevision: 0,
    projectionGeneration: 2,
    status: 'loading',
  }));
  assert.equal(engine.getSnapshot().playheadIndex, -1);
  assert.equal(engine.getSnapshot().currentScene, undefined);
  assert.equal(clock.pendingCount(), 0);

  push(baseSnapshot({
    frames: [frame('corrected-1', 1)],
    headRevision: 1,
    projectionGeneration: 2,
    status: 'loading',
  }));
  assert.equal(engine.getSnapshot().headIndex, 0, 'partial corrected data is derived but not presented');
  assert.equal(engine.getSnapshot().playheadIndex, -1);
  assert.equal(engine.getSnapshot().currentScene, undefined);
  assert.equal(engine.getSnapshot().activeSceneWindow, undefined);
  assert.equal(clock.pendingCount(), 0, 'partial loading page never schedules replay advancement');

  push(baseSnapshot({
    frames: [frame('corrected-1', 1), frame('corrected-2', 2)],
    headRevision: 2,
    projectionGeneration: 2,
    status: 'complete',
  }));
  const corrected = engine.getSnapshot();
  assert.equal(corrected.playheadIndex, 0);
  assert.equal(corrected.currentScene.id, 'corrected-1');
  assert.match(corrected.activeSceneWindow.instanceKey, /^2:corrected-1:/);
  assert.equal(clock.pendingCount(), 1, 'corrected replay schedules scene advancement');

  await clock.flush(1000);
  assert.equal(engine.getSnapshot().currentScene.id, 'corrected-2');

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
