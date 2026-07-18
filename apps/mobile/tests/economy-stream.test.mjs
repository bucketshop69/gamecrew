import assert from 'node:assert/strict';
import test from 'node:test';

import { EconomyStreamGate, mergeEconomyStream, selectReleasedEvents } from '../src/state/economy-stream.ts';

function event(id, seq, text = id) {
  return {
    id,
    kind: 'match_moment',
    fixtureId: 'fx-1',
    userId: 'user-1',
    seq,
    sourceFrameId: id,
    stateRevision: seq,
    coolnessDelta: 0,
    itemDeltas: [],
    text,
  };
}

/** Fake clock matching EconomyStreamGateClock, with due-time-aware flush (see match-session/playback-engine tests). */
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

test('selectReleasedEvents filters strictly by seq <= releasedThroughSeq', () => {
  const events = [event('a', 1), event('b', 2), event('c', 3)];
  assert.deepEqual(selectReleasedEvents(events, 2).map((e) => e.id), ['a', 'b']);
  assert.deepEqual(selectReleasedEvents(events, 0).map((e) => e.id), []);
  assert.deepEqual(selectReleasedEvents(events, 3).map((e) => e.id), ['a', 'b', 'c']);
});

test('live mode releases every event immediately as it lands', () => {
  const clock = createFakeClock();
  const gate = new EconomyStreamGate('live', { clock });

  const seen = [];
  gate.subscribe((events) => seen.push(events.map((e) => e.id)));

  gate.setEvents([event('a', 1)]);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a']);

  gate.setEvents([event('a', 1), event('b', 2)]);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a', 'b'], 'live mode never gates behind a timer');
  assert.equal(clock.pendingCount(), 0, 'no release timer running in live mode');

  gate.dispose();
});

test('replay mode holds an event back until its release timer fires, then reveals it', async () => {
  const clock = createFakeClock();
  const gate = new EconomyStreamGate('replay', { clock, releaseIntervalMs: 1000 });

  gate.setEvents([event('a', 1), event('b', 2)]);

  // Nothing released yet: replay always paces from -Infinity, one seq step at a time.
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), [], 'event not revealed before release');

  await clock.flush(1000);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a'], 'first event revealed after one interval');

  await clock.flush(1000);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a', 'b'], 'second event revealed after the next interval');

  gate.dispose();
});

test('replay mode releases same-seq events together in one step', async () => {
  const clock = createFakeClock();
  const gate = new EconomyStreamGate('replay', { clock, releaseIntervalMs: 500 });

  gate.setEvents([event('a', 5, 'first'), event('b', 5, 'second'), event('c', 6)]);

  await clock.flush(500);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a', 'b'], 'both seq=5 events release in the same step');

  await clock.flush(500);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a', 'b', 'c']);

  gate.dispose();
});

test('replay mode does not jump the cursor forward just because new (later) data arrived', async () => {
  const clock = createFakeClock();
  const gate = new EconomyStreamGate('replay', { clock, releaseIntervalMs: 1000 });

  gate.setEvents([event('a', 1)]);
  await clock.flush(1000);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a']);

  // A poll extends the engine log far ahead; nothing beyond 'a' should leak
  // out until its own release timer fires.
  gate.setEvents([event('a', 1), event('b', 2), event('c', 3)]);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a'], 'still gated even though more data exists');

  await clock.flush(1000);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a', 'b']);

  gate.dispose();
});

test('setMode from replay to live immediately releases everything buffered', async () => {
  const clock = createFakeClock();
  const gate = new EconomyStreamGate('replay', { clock, releaseIntervalMs: 1000 });

  gate.setEvents([event('a', 1), event('b', 2), event('c', 3)]);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), []);

  gate.setMode('live');
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a', 'b', 'c'], 'switching to live flushes the gate');
  assert.equal(clock.pendingCount(), 0, 'replay release timer cleared on mode switch');

  gate.dispose();
});

test('setMode from live to replay resumes gating for subsequent events', async () => {
  const clock = createFakeClock();
  const gate = new EconomyStreamGate('live', { clock, releaseIntervalMs: 1000 });

  gate.setEvents([event('a', 1)]);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a']);

  gate.setMode('replay');
  gate.setEvents([event('a', 1), event('b', 2)]);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a'], 'already-released events stay released; new ones gate');

  await clock.flush(1000);
  assert.deepEqual(gate.getReleasedEvents().map((e) => e.id), ['a', 'b']);

  gate.dispose();
});

test('dispose clears the pending release timer', async () => {
  const clock = createFakeClock();
  const gate = new EconomyStreamGate('replay', { clock, releaseIntervalMs: 1000 });

  gate.setEvents([event('a', 1)]);
  assert.equal(clock.pendingCount(), 1);

  gate.dispose();
  assert.equal(clock.pendingCount(), 0);
});

// ---------------------------------------------------------------------------
// mergeEconomyStream (CHAT-001, CHAT-006/007, CHAT-008, CHAT-009, REG-005)
// ---------------------------------------------------------------------------

function chatMessage(id, releasedEventCountAtSend, sentAtMs = releasedEventCountAtSend) {
  return { id, fixtureId: 'fx-1', text: `msg-${id}`, sentAtMs, releasedEventCountAtSend };
}

test('CHAT-001: a message sent after 0 released events is inserted before all events', () => {
  const events = [event('a', 1), event('b', 2)];
  const rows = mergeEconomyStream(events, [chatMessage('m1', 0)]);
  assert.deepEqual(rows.map((r) => (r.kind === 'chat' ? r.message.id : r.event.id)), ['m1', 'a', 'b']);
});

test('CHAT-001: a message sent between two released events lands between them, in chronological order', () => {
  const events = [event('a', 1), event('b', 2), event('c', 3)];
  const rows = mergeEconomyStream(events, [chatMessage('m1', 1)]);
  assert.deepEqual(rows.map((r) => (r.kind === 'chat' ? r.message.id : r.event.id)), ['a', 'm1', 'b', 'c']);
});

test('CHAT-001: a message sent after every currently-released event lands at the end', () => {
  const events = [event('a', 1), event('b', 2)];
  const rows = mergeEconomyStream(events, [chatMessage('m1', 2)]);
  assert.deepEqual(rows.map((r) => (r.kind === 'chat' ? r.message.id : r.event.id)), ['a', 'b', 'm1']);
});

test('CHAT-008: merging never mutates or reorders the underlying event array', () => {
  const events = [event('a', 1), event('b', 2)];
  const originalOrder = events.map((e) => e.id);
  mergeEconomyStream(events, [chatMessage('m1', 1)]);
  assert.deepEqual(events.map((e) => e.id), originalOrder, 'input events array untouched');
});

test('CHAT-009: multiple messages sent in quick succession at the same release count all appear, in send order, none dropped or duplicated', () => {
  const events = [event('a', 1)];
  const messages = [
    chatMessage('m1', 1, 100),
    chatMessage('m2', 1, 101),
    chatMessage('m3', 1, 102),
    chatMessage('m4', 1, 103),
    chatMessage('m5', 1, 104),
  ];
  const rows = mergeEconomyStream(events, messages);
  const chatIds = rows.filter((r) => r.kind === 'chat').map((r) => r.message.id);
  assert.deepEqual(chatIds, ['m1', 'm2', 'm3', 'm4', 'm5'], 'all five appear exactly once, in send order');
});

test('CHAT-006/007: chat messages are merged regardless of live/replay -- mergeEconomyStream itself has no mode concept, only the (already-gated) events list matters', () => {
  // mergeEconomyStream doesn't know about live/replay; it only sees whatever
  // events the gate already released. A message referencing a release count
  // beyond what's released yet (can't happen via the real hook, but exercised
  // here directly) still merges deterministically at the end.
  const events = [event('a', 1)];
  const rows = mergeEconomyStream(events, [chatMessage('m1', 5)]);
  assert.deepEqual(rows.map((r) => (r.kind === 'chat' ? r.message.id : r.event.id)), ['a', 'm1']);
});

test('mergeEconomyStream with no chat messages returns exactly the events, wrapped', () => {
  const events = [event('a', 1), event('b', 2)];
  const rows = mergeEconomyStream(events, []);
  assert.deepEqual(rows, [{ kind: 'event', event: events[0] }, { kind: 'event', event: events[1] }]);
});

test('mergeEconomyStream with no events returns exactly the chat messages', () => {
  const messages = [chatMessage('m1', 0, 1), chatMessage('m2', 0, 2)];
  const rows = mergeEconomyStream([], messages);
  assert.deepEqual(rows.map((r) => r.message.id), ['m1', 'm2']);
});
