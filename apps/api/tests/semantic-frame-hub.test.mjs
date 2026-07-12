import assert from 'node:assert/strict';
import test from 'node:test';

import { SemanticFrameHub } from '../src/ingestion/semantic-frame-hub.ts';

const frame = (fixtureId, revision) => ({
  id: `${fixtureId}:${revision}`,
  fixtureId,
  seq: revision,
  stateRevision: revision,
  facts: [],
  simulationCues: [],
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a slow subscriber does not block another subscriber or publish', async () => {
  const store = { listFramesAfter: async () => [] };
  const hub = new SemanticFrameHub(store);
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const slowReceived = [];
  const fastReceived = [];

  await hub.subscribe('fixture-1', async (value) => {
    slowReceived.push(value.stateRevision);
    await slowGate;
  });
  await hub.subscribe('fixture-1', (value) => {
    fastReceived.push(value.stateRevision);
  });

  hub.publish('fixture-1', [frame('fixture-1', 1), frame('fixture-1', 2)]);
  await flush();

  assert.deepEqual(slowReceived, [1]);
  assert.deepEqual(fastReceived, [1, 2]);
  releaseSlow();
  await flush();
  assert.deepEqual(slowReceived, [1, 2]);
});

test('subscriber failures are isolated and later frames continue', async () => {
  const failures = [];
  const hub = new SemanticFrameHub(
    { listFramesAfter: async () => [] },
    { onSubscriberError: (failure) => failures.push(failure) },
  );
  const healthy = [];
  let failingCalls = 0;
  await hub.subscribe(1, () => {
    failingCalls += 1;
    throw new Error('listener failed');
  });
  await hub.subscribe(1, (value) => healthy.push(value.stateRevision));

  hub.publish(1, [frame(1, 1), frame(1, 2)]);
  await flush();

  assert.equal(failingCalls, 2);
  assert.equal(failures.length, 2);
  assert.deepEqual(healthy, [1, 2]);
});

test('loads backlog after a revision and deduplicates overlapping live frames', async () => {
  const persisted = [frame('fixture-2', 1), frame('fixture-2', 2), frame('fixture-2', 3)];
  const store = {
    listFramesAfter: async (_fixtureId, afterRevision) =>
      persisted.filter((value) => value.stateRevision > afterRevision),
  };
  const hub = new SemanticFrameHub(store);
  const received = [];

  const unsubscribe = await hub.subscribe(
    'fixture-2',
    (value) => received.push(value.stateRevision),
    { afterRevision: 1 },
  );
  hub.publish('fixture-2', [frame('fixture-2', 3), frame('fixture-2', 4)]);
  await flush();

  assert.deepEqual(received, [2, 3, 4]);
  assert.equal(hub.subscriberCount('fixture-2'), 1);
  unsubscribe();
  assert.equal(hub.subscriberCount('fixture-2'), 0);
  hub.publish('fixture-2', [frame('fixture-2', 5)]);
  await flush();
  assert.deepEqual(received, [2, 3, 4]);
});

test('keeps fixture subscriptions isolated', async () => {
  const hub = new SemanticFrameHub({ listFramesAfter: async () => [] });
  const first = [];
  const second = [];
  await hub.subscribe('a', (value) => first.push(value.id));
  await hub.subscribe('b', (value) => second.push(value.id));

  hub.publish('a', [frame('a', 1)]);
  hub.publish('b', [frame('b', 1)]);
  hub.publish('a', [frame('b', 2)]);
  await flush();

  assert.deepEqual(first, ['a:1']);
  assert.deepEqual(second, ['b:1']);
});

test('forced conflict resync redelivers an already-seen stable frame id', async () => {
  const hub = new SemanticFrameHub({ listFramesAfter: async () => [] });
  const received = [];
  await hub.subscribe('a', (value) => received.push(value.facts.length));
  const original = frame('a', 1);
  hub.publish('a', [original]);
  await flush();
  hub.publish('a', [{ ...original, facts: [{ id: 'corrected' }] }], { replaceExisting: true });
  await flush();
  assert.deepEqual(received, [0, 1]);
});

test('late subscribers reset their backlog when projection generation changed', async () => {
  const persisted = [frame('a', 1), frame('a', 2), frame('a', 3)];
  const requestedRevisions = [];
  const hub = new SemanticFrameHub({
    async getCheckpoint() { return { projectionGeneration: 2 }; },
    async listFramesAfter(_fixtureId, revision) {
      requestedRevisions.push(revision);
      return persisted.filter((value) => value.stateRevision > revision);
    },
  });
  const generations = [];
  const received = [];
  await hub.subscribe('a', (value) => received.push(value.stateRevision), {
    afterRevision: 3,
    projectionGeneration: 1,
    onResyncRequired: (generation) => generations.push(generation),
  });
  await flush();
  assert.deepEqual(requestedRevisions, [0]);
  assert.deepEqual(generations, [2]);
  assert.deepEqual(received, [1, 2, 3]);
});

test('active subscribers discard stale queued frames and receive one corrected generation replay', async () => {
  const hub = new SemanticFrameHub({
    async getCheckpoint() { return { projectionGeneration: 0 }; },
    async listFramesAfter() { return []; },
  });
  let releaseFirst;
  const firstDelivery = new Promise((resolve) => { releaseFirst = resolve; });
  const deliveries = [];
  const applied = [];
  const generations = [];
  let activeGeneration = 0;
  await hub.subscribe('a', async (value, delivery) => {
    deliveries.push(`${value.facts[0]?.id ?? 'old'}:${value.stateRevision}:g${delivery.projectionGeneration}`);
    if (deliveries.length === 1) await firstDelivery;
    if (delivery.projectionGeneration === activeGeneration) {
      applied.push(`${value.facts[0]?.id ?? 'old'}:${value.stateRevision}`);
    }
  }, {
    projectionGeneration: 0,
    onResyncRequired: (generation) => {
      activeGeneration = generation;
      applied.length = 0;
      generations.push(generation);
    },
  });

  hub.publish('a', [frame('a', 1), frame('a', 2)], { projectionGeneration: 0 });
  await flush();
  hub.publish('a', [
    { ...frame('a', 1), facts: [{ id: 'corrected' }] },
    { ...frame('a', 2), facts: [{ id: 'corrected' }] },
  ], { replaceExisting: true, projectionGeneration: 1 });
  // Re-publishing the same generation must not trigger or enqueue a second reset.
  hub.publish('a', [
    { ...frame('a', 1), facts: [{ id: 'corrected' }] },
    { ...frame('a', 2), facts: [{ id: 'corrected' }] },
  ], { replaceExisting: true, projectionGeneration: 1 });

  releaseFirst();
  await flush();
  await flush();

  assert.deepEqual(generations, [1]);
  assert.deepEqual(deliveries, ['old:1:g0', 'corrected:1:g1', 'corrected:2:g1']);
  assert.deepEqual(applied, ['corrected:1', 'corrected:2']);
});

test('notifies a generation reset even when the corrected projection has no frames', async () => {
  const hub = new SemanticFrameHub({
    async getCheckpoint() { return { projectionGeneration: 0 }; },
    async listFramesAfter() { return []; },
  });
  const generations = [];
  await hub.subscribe('a', () => {}, {
    projectionGeneration: 0,
    onResyncRequired: (generation) => generations.push(generation),
  });
  hub.publish('a', [], { replaceExisting: true, projectionGeneration: 1 });
  assert.deepEqual(generations, [1]);
});
