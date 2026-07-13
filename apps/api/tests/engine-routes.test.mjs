import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.ts';
import { createIngestionRuntime } from '../src/ingestion/ingestion-runtime.ts';
import { SqliteIngestionStore } from '../src/ingestion/sqlite-ingestion-store.ts';

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

test('commentary reads return one saved projection snapshot while the engine correction is ahead', async () => {
  let ensureCalls = 0;
  let checkpointReads = 0;
  const saved = [{ id: 'engine-beat-1', fixtureId: '99', commentary: 'Saved before the listener arrived.' }];
  const ingestion = {
    async ensureFixture() { ensureCalls += 1; },
    async getCheckpoint() { checkpointReads += 1; return { projectionGeneration: 5 }; },
    async listFramesAfter() { return []; },
    async getCommentaryProjection(fixtureId) {
      assert.equal(fixtureId, '99');
      return {
        entries: saved,
        cursor: { fixtureId, projectionGeneration: 4, lastStateRevision: 8 },
      };
    },
    activeFixtureCount() { return 0; },
  };
  const response = await createApp(config, ingestion)
    .request('/matches/txline-99/pulse/commentary');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.entries, saved);
  assert.equal(body.fixtureId, '99');
  assert.equal(body.projectionGeneration, 4);
  assert.equal(body.source, 'engine');
  assert.equal(ensureCalls, 0);
  assert.equal(checkpointReads, 0);
});

test('durable match mapping honors persisted participant-one-away truth', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-away-match-'));
  const path = join(directory, 'match.sqlite');
  const fixtureId = '99';
  const seed = new SqliteIngestionStore(path);
  try {
    await seed.appendRawCandidates([{
      fixtureId, seq: 0, payloadHash: 'raw-0', source: 'historical', receivedAt: '2026-07-01T00:00:00.000Z',
      payloadJson: JSON.stringify({
        FixtureId: 99, Seq: 0, Id: 0, Action: 'coverage_update', Ts: 1,
        StartTime: Date.parse('2026-07-01T12:00:00.000Z'), CompetitionId: 72,
        FixtureGroupId: 5, Participant1Id: 10, Participant2Id: 20,
        Participant1IsHome: true,
      }),
    }]);
    await seed.saveFixtureContext({
      fixtureId,
      participants: [
        { participant: 1, teamId: 10, name: 'Away FC', isHome: false },
        { participant: 2, teamId: 20, name: 'Home FC', isHome: true },
      ],
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    await seed.commitProjection({
      checkpoint: {
        fixtureId, engineVersion: 'test', lastAppliedSeq: 1, stateRevision: 1,
        stateHash: 'state', conflictHash: '', projectionGeneration: 2,
        phase: 'finalised', finalisedAt: '2026-07-01T14:00:00.000Z',
        updatedAt: '2026-07-01T14:00:00.000Z',
        state: {
          fixtureId, lastAppliedSeq: 1, stateRevision: 1, phase: 'finalised',
          confirmedScore: { participant1: 1, participant2: 3 },
          finalScore: { participant1: 1, participant2: 3 }, possibleEvents: {},
          activePlayerIdsByParticipant: {}, disciplineByPlayerId: {}, incidents: {},
          supportedFacts: {}, simulationCues: {}, integrityWarnings: [],
        },
      },
      frames: [],
    });
  } finally {
    seed.close();
  }

  const runtime = createIngestionRuntime({
    ...config,
    matchPulseSqlitePath: path,
    txlineFinalisationCorrectionMs: 0,
  });
  try {
    const [match] = await runtime.listMatches({ filter: 'replay' });
    assert.equal(match.homeTeam.name, 'Home FC');
    assert.equal(match.homeTeam.id, 'txline-team-20');
    assert.equal(match.awayTeam.name, 'Away FC');
    assert.equal(match.awayTeam.id, 'txline-team-10');
    assert.deepEqual(match.score, { home: 3, away: 1 });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('lists durable replay fixtures when TxLINE is offline', async () => {
  const historical = {
    id: 'txline-18179759', txline: { fixtureId: '18179759', source: 'live' },
    filter: 'replay', status: 'replayable', competition: 'Stored cup',
    kickoffUtc: '2026-07-01T12:00:00.000Z',
    homeTeam: { id: 'home', name: 'Mexico', shortName: 'MEX', countryCode: 'MEX', colors: { primary: '#000', secondary: '#fff' }, flag: { code: 'MEX', bands: [] } },
    awayTeam: { id: 'away', name: 'Ecuador', shortName: 'ECU', countryCode: 'ECU', colors: { primary: '#000', secondary: '#fff' }, flag: { code: 'ECU', bands: [] } },
    score: { home: 2, away: 0 }, clock: { label: 'Full time', phase: 'replay_ready' },
    replay: { available: true, label: 'Replay ready' },
  };
  const ingestion = {
    async listMatches() { return [historical]; },
    activeFixtureCount() { return 0; },
  };
  const response = await createApp(config, ingestion).request('/matches?filter=replay&limit=1');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.matches.length, 1);
  assert.equal(body.matches[0].txline.fixtureId, '18179759');
  assert.deepEqual(body.matches[0].score, { home: 2, away: 0 });
  assert.equal(body.source, 'engine');
});

test('deduplicates TxLINE metadata with canonical local score and phase before filtering and limiting', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/auth/guest/start') return Response.json({ token: 'jwt' });
    if (path === '/api/fixtures/snapshot') return Response.json([{
      FixtureId: 18179759, StartTime: Date.parse('2026-07-01T12:00:00.000Z'),
      Competition: 'Remote World Cup', CompetitionId: 72, FixtureGroupId: 10115677,
      Participant1Id: 2545, Participant1: 'Mexico', Participant2Id: 1892,
      Participant2: 'Ecuador', Participant1IsHome: true, Ts: 1,
    }]);
    if (path === '/api/scores/snapshot/18179759') return Response.json([]);
    return new Response('Not found', { status: 404 });
  };
  try {
    const historical = {
      id: 'txline-18179759', txline: { fixtureId: '18179759', source: 'live' },
      filter: 'replay', status: 'replayable', competition: 'Competition 72',
      kickoffUtc: '2026-07-01T12:00:00.000Z',
      homeTeam: { id: 'home', name: 'Mexico', shortName: 'MEX', countryCode: 'MEX', colors: { primary: '#000', secondary: '#fff' }, flag: { code: 'MEX', bands: [] } },
      awayTeam: { id: 'away', name: 'Ecuador', shortName: 'ECU', countryCode: 'ECU', colors: { primary: '#000', secondary: '#fff' }, flag: { code: 'ECU', bands: [] } },
      score: { home: 2, away: 0 }, clock: { label: 'Full time', phase: 'replay_ready' },
      replay: { available: true, label: 'Replay ready' },
    };
    const ingestion = {
      async listMatches() { return [historical]; },
      activeFixtureCount() { return 0; },
    };
    const response = await createApp(config, ingestion).request('/matches?filter=replay&limit=1');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.matches.length, 1);
    assert.equal(body.matches[0].competition, 'Remote World Cup');
    assert.equal(body.matches[0].status, 'replayable');
    assert.deepEqual(body.matches[0].score, { home: 2, away: 0 });
    assert.equal(body.source, 'combined');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
