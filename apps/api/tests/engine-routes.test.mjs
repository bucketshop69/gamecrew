import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../src/app.ts';

const config = {
  host: '127.0.0.1',
  llmEnabled: false,
  llmBatchSize: 4,
  llmModel: 'disabled',
  llmTimeoutMs: 1000,
  matchPulseStoreDriver: 'sqlite',
  matchPulseStorePath: ':memory:',
  matchPulseSqlitePath: ':memory:',
  port: 0,
  txlineApiToken: 'test-token',
  txlineBaseUrl: 'https://example.invalid',
};

test('engine routes ensure one fixture and read persisted state/frames', async () => {
  const ensured = [];
  const ingestion = {
    async ensureFixture(fixtureId) { ensured.push(fixtureId); },
    async getCheckpoint(fixtureId) {
      return { fixtureId, stateRevision: 2, projectionGeneration: 3, phase: 'first_half', state: { phase: 'first_half' } };
    },
    async listFramesAfter(fixtureId, revision) {
      return [{ fixtureId, stateRevision: revision + 1, frame: { id: `${fixtureId}:1` } }];
    },
    activeFixtureCount() { return 1; },
  };
  const app = createApp(config, ingestion);
  const stateResponse = await app.request('/matches/txline-99/engine/state');
  assert.equal(stateResponse.status, 200);
  assert.equal((await stateResponse.json()).checkpoint.phase, 'first_half');

  const framesResponse = await app.request('/matches/99/engine/frames?afterRevision=7');
  assert.equal(framesResponse.status, 200);
  const frames = await framesResponse.json();
  assert.equal(frames.frames[0].stateRevision, 8);
  assert.equal(frames.projectionGeneration, 3);
  assert.equal(frames.resyncRequired, false);
  assert.deepEqual(ensured, ['99', '99']);
});

test('forces a full frame backlog when the polling projection generation is stale', async () => {
  const revisions = [];
  const ingestion = {
    async ensureFixture() {},
    async getCheckpoint(fixtureId) {
      return { fixtureId, stateRevision: 8, projectionGeneration: 2, state: { phase: 'first_half' } };
    },
    async listFramesAfter(_fixtureId, revision) {
      revisions.push(revision);
      return [{ stateRevision: 1, frame: { id: 'corrected:1' } }];
    },
    activeFixtureCount() { return 1; },
  };
  const response = await createApp(config, ingestion)
    .request('/matches/99/engine/frames?afterRevision=8&generation=1');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(revisions, [0]);
  assert.equal(body.projectionGeneration, 2);
  assert.equal(body.resyncRequired, true);
  assert.equal(body.frames[0].stateRevision, 1);
});

test('returns an empty durable frame page while upstream recovery is offline', async () => {
  const ingestion = {
    async ensureFixture() { throw new Error('TxLINE offline'); },
    async getCheckpoint(fixtureId) {
      return { fixtureId, stateRevision: 10, projectionGeneration: 0, state: { phase: 'second_half' } };
    },
    async listFramesAfter() { return []; },
    activeFixtureCount() { return 0; },
  };
  const response = await createApp(config, ingestion)
    .request('/matches/99/engine/frames?afterRevision=10&generation=0');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).frames, []);
});

test('engine routes are explicitly unavailable without the ingestion runtime', async () => {
  const app = createApp(config);
  const response = await app.request('/matches/99/engine/state');
  assert.equal(response.status, 503);
});

test('serves a durable checkpoint even when background upstream recovery fails', async () => {
  const ingestion = {
    async ensureFixture() { throw new Error('TxLINE offline'); },
    async getCheckpoint(fixtureId) {
      return { fixtureId, stateRevision: 10, phase: 'second_half', state: { phase: 'second_half' } };
    },
    async listFramesAfter() { return []; },
    activeFixtureCount() { return 0; },
  };
  const app = createApp(config, ingestion);
  const response = await app.request('/matches/99/engine/state');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).checkpoint.phase, 'second_half');
});
