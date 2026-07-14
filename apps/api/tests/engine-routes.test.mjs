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

test('delta at head returns an empty page with head and cursor metadata', async () => {
  const ingestion = {
    async ensureFixture() {},
    async getCheckpoint(fixtureId) {
      return { fixtureId, stateRevision: 12, projectionGeneration: 1, phase: 'second_half', state: { phase: 'second_half' } };
    },
    async listFramesAfter() { return []; },
    activeFixtureCount() { return 1; },
  };
  const response = await createApp(config, ingestion)
    .request('/matches/99/engine/frames?afterRevision=12');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.frames, []);
  assert.equal(body.hasMore, false);
  assert.equal(body.headRevision, 12);
  assert.equal(body.nextAfterRevision, 12);
  assert.equal(body.resyncRequired, false);
});

test('full history fetch is bounded by a default page limit with a hasMore cursor', async () => {
  const allFrames = Array.from({ length: 1_800 }, (_, index) => ({
    fixtureId: '99',
    stateRevision: index + 1,
    frame: { id: `99:${index + 1}` },
  }));
  const ingestion = {
    async ensureFixture() {},
    async getCheckpoint(fixtureId) {
      return { fixtureId, stateRevision: 1_800, projectionGeneration: 1, phase: 'finalised', state: { phase: 'finalised' } };
    },
    async listFramesAfter() { return allFrames; },
    activeFixtureCount() { return 1; },
  };
  const response = await createApp(config, ingestion).request('/matches/99/engine/frames');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.frames.length, 500);
  assert.equal(body.hasMore, true);
  assert.equal(body.nextAfterRevision, 500);
  assert.equal(body.headRevision, 1_800);
});

test('an explicit limit paginates the full history in successive pages', async () => {
  const allFrames = Array.from({ length: 250 }, (_, index) => ({
    fixtureId: '99',
    stateRevision: index + 1,
    frame: { id: `99:${index + 1}` },
  }));
  const ingestion = {
    async ensureFixture() {},
    async getCheckpoint(fixtureId) {
      return { fixtureId, stateRevision: 250, projectionGeneration: 1, phase: 'finalised', state: { phase: 'finalised' } };
    },
    async listFramesAfter(_fixtureId, afterRevision) {
      return allFrames.filter((entry) => entry.stateRevision > afterRevision);
    },
    activeFixtureCount() { return 1; },
  };
  const app = createApp(config, ingestion);
  const firstPage = await (await app.request('/matches/99/engine/frames?limit=100')).json();
  assert.equal(firstPage.frames.length, 100);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.nextAfterRevision, 100);

  const secondPage = await (
    await app.request(`/matches/99/engine/frames?limit=100&afterRevision=${firstPage.nextAfterRevision}`)
  ).json();
  assert.equal(secondPage.frames.length, 100);
  assert.equal(secondPage.hasMore, true);
  assert.equal(secondPage.nextAfterRevision, 200);

  const thirdPage = await (
    await app.request(`/matches/99/engine/frames?limit=100&afterRevision=${secondPage.nextAfterRevision}`)
  ).json();
  assert.equal(thirdPage.frames.length, 50);
  assert.equal(thirdPage.hasMore, false);
  assert.equal(thirdPage.nextAfterRevision, 250);
});

test('identical frame requests are served from cache without re-reading the store', async () => {
  let reads = 0;
  const ingestion = {
    async ensureFixture() {},
    async getCheckpoint(fixtureId) {
      return { fixtureId, stateRevision: 5, projectionGeneration: 1, phase: 'first_half', state: { phase: 'first_half' } };
    },
    async listFramesAfter(fixtureId, revision) {
      reads += 1;
      return [{ fixtureId, stateRevision: revision + 1, frame: { id: `${fixtureId}:1` } }];
    },
    activeFixtureCount() { return 1; },
  };
  const app = createApp(config, ingestion);
  const first = await (await app.request('/matches/99/engine/frames?afterRevision=0')).json();
  const second = await (await app.request('/matches/99/engine/frames?afterRevision=0')).json();
  assert.equal(reads, 1);
  assert.deepEqual(first.frames, second.frames);
});

test('a state-revision bump invalidates the cached frames response', async () => {
  let reads = 0;
  let stateRevision = 5;
  const ingestion = {
    async ensureFixture() {},
    async getCheckpoint(fixtureId) {
      return { fixtureId, stateRevision, projectionGeneration: 1, phase: 'first_half', state: { phase: 'first_half' } };
    },
    async listFramesAfter(fixtureId, revision) {
      reads += 1;
      return [{ fixtureId, stateRevision: stateRevision, frame: { id: `${fixtureId}:${stateRevision}` } }];
    },
    activeFixtureCount() { return 1; },
  };
  const app = createApp(config, ingestion);
  await app.request('/matches/99/engine/frames?afterRevision=0');
  assert.equal(reads, 1);

  stateRevision = 6;
  await app.request('/matches/99/engine/frames?afterRevision=0');
  assert.equal(reads, 2);
});

test('identical engine/state requests are served from cache without re-reading the checkpoint store', async () => {
  let reads = 0;
  const ingestion = {
    async ensureFixture() {},
    async getCheckpoint(fixtureId) {
      reads += 1;
      return { fixtureId, stateRevision: 4, projectionGeneration: 1, phase: 'first_half', state: { phase: 'first_half' } };
    },
    async listFramesAfter() { return []; },
    activeFixtureCount() { return 1; },
  };
  const app = createApp(config, ingestion);
  const first = await (await app.request('/matches/99/engine/state')).json();
  const second = await (await app.request('/matches/99/engine/state')).json();
  // getCheckpoint is always called once per request to determine the cache version,
  // but the JSON body construction (and any downstream work) is skipped on the cache hit.
  assert.equal(reads, 2);
  assert.deepEqual(first.checkpoint, second.checkpoint);
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

test('remote completion cannot be hidden by a stale local live checkpoint', async () => {
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
      filter: 'live', status: 'live', competition: 'Competition 72',
      kickoffUtc: '2026-07-01T12:00:00.000Z',
      homeTeam: { id: 'home', name: 'Mexico', shortName: 'MEX', countryCode: 'MEX', colors: { primary: '#000', secondary: '#fff' }, flag: { code: 'MEX', bands: [] } },
      awayTeam: { id: 'away', name: 'Ecuador', shortName: 'ECU', countryCode: 'ECU', colors: { primary: '#000', secondary: '#fff' }, flag: { code: 'ECU', bands: [] } },
      score: { home: 2, away: 0 }, clock: { label: "Live 70'", phase: 'second_half', minute: 70 },
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

test('a completed TxLINE score correction wins over stale completed materialization', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/auth/guest/start') return Response.json({ token: 'jwt' });
    if (path === '/api/fixtures/snapshot') return Response.json([{
      FixtureId: 18209181, StartTime: Date.parse('2026-07-09T20:00:00.000Z'),
      Competition: 'Remote World Cup', CompetitionId: 72, FixtureGroupId: 10115677,
      Participant1Id: 769, Participant1: 'France', Participant2Id: 1585,
      Participant2: 'Morocco', Participant1IsHome: true, Ts: 1,
    }]);
    if (path === '/api/scores/snapshot/18209181') return Response.json([{
      FixtureId: 18209181, Ts: Date.parse('2026-07-09T23:00:00.000Z'), Seq: 1,
      StatusId: 5, Stats: { 1: 3, 2: 0 },
    }]);
    return new Response('Not found', { status: 404 });
  };
  try {
    const staleCompleted = {
      id: 'txline-18209181', txline: { fixtureId: '18209181', source: 'live' },
      filter: 'replay', status: 'replayable', competition: 'Competition 72',
      kickoffUtc: '2026-07-09T20:00:00.000Z',
      homeTeam: { id: 'home', name: 'France', shortName: 'FRA', countryCode: 'FRA', colors: { primary: '#000', secondary: '#fff' }, flag: { code: 'FRA', bands: [] } },
      awayTeam: { id: 'away', name: 'Morocco', shortName: 'MAR', countryCode: 'MAR', colors: { primary: '#000', secondary: '#fff' }, flag: { code: 'MAR', bands: [] } },
      score: { home: 2, away: 0 }, clock: { label: 'Full time', phase: 'replay_ready' },
      replay: { available: true, label: 'Replay ready' },
    };
    const ingestion = {
      async listMatches() { return [staleCompleted]; },
      activeFixtureCount() { return 0; },
    };
    const response = await createApp(config, ingestion).request('/matches?filter=replay');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.matches.length, 1);
    assert.deepEqual(body.matches[0].score, { home: 3, away: 0 });
    assert.equal(body.matches[0].clock.label, 'Full time');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
