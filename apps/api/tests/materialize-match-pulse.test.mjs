import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  COMMENTARY_PROMPT_BUNDLE,
  inspectMaterialization,
  parseMaterializeArgs,
  publishedMaterializationNeedsReenrichment,
} from '../src/materialize-match-pulse.ts';
import {
  MatchPulseMaterializationStore,
  isMaterializationAvailable,
  isPublishedMaterializationStatus,
} from '../src/match-pulse-materialization-store.ts';
import { findFixtureMetadata } from '../src/ingestion/ingestion-runtime.ts';

test('materialization CLI requires explicit fixture IDs and deduplicates them', () => {
  assert.throws(() => parseMaterializeArgs([]), /at least one explicit fixture ID/);
  assert.throws(() => parseMaterializeArgs(['18179759', '--prepare-onl']), /Unknown materialization argument/);
  assert.throws(() => parseMaterializeArgs(['--fixtures=18179759,nope']), /only comma-separated numeric/);
  assert.deepEqual(
    parseMaterializeArgs([
      '--',
      '18179759',
      '--fixtures=18209181,18179759',
      '--database=/tmp/archive.sqlite',
      '--timeout-ms=5000',
    ]),
    {
      fixtureIds: ['18179759', '18209181'],
      databasePath: '/tmp/archive.sqlite',
      prepareOnly: false,
      timeoutMs: 5000,
      pollMs: 250,
    },
  );
});

test('fixture materialization status resumes attempts and publishes only ready states', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-materialization-'));
  const store = new MatchPulseMaterializationStore(join(directory, 'archive.sqlite'));
  try {
    const first = await store.start(
      '18179759', 'run-a', '2026-07-13T10:00:00.000Z', 1_000, 'model-a', 'prompt-a', 0,
    );
    assert.equal(first.status, 'running');
    assert.equal(first.attempt, 1);
    assert.equal(isPublishedMaterializationStatus(first.status), false);
    await store.recordUsage('18179759', {
      attempted: 2, completed: 1, failed: 1, providerCalls: 4, totalTokens: 40,
    });

    await assert.rejects(
      store.start(
        '18179759', 'run-b', '2026-07-13T10:00:01.000Z', 2_000, 'model-a', 'prompt-a', 500,
      ),
      /already owned/,
    );
    await assert.rejects(
      store.start(
        '18179759', 'run-b', '2026-07-13T10:01:00.000Z', 3_000, 'model-b', 'prompt-a', 1_001,
      ),
      /partial enrichment from a different model or prompt/,
    );
    const resumed = await store.start(
      '18179759', 'run-b', '2026-07-13T10:01:00.000Z', 3_000, 'model-a', 'prompt-a', 1_001,
    );
    assert.equal(resumed.attempt, 2);
    await store.recordUsage('18179759', {
      attempted: 4, completed: 3, failed: 1, providerCalls: 6, totalTokens: 100,
    });
    assert.equal(await store.complete({
      fixtureId: '18179759',
      status: 'ready',
      projectionGeneration: 0,
      stateRevision: 886,
      entryCount: 139,
      completeCount: 139,
      fallbackCount: 0,
      failedCount: 0,
      pendingCount: 0,
      notNeededCount: 0,
      model: 'test-model',
      promptVersion: 'test-prompt',
      completedAt: '2026-07-13T10:02:00.000Z',
    }, 'run-b'), true);
    assert.equal(
      await store.fail('18179759', 'run-a', new Error('stale timeout'), '2026-07-13T10:03:00.000Z'),
      false,
    );
    const ready = await store.get('18179759');
    assert.equal(ready.status, 'ready');
    assert.equal(ready.attempt, 2);
    assert.equal(ready.entryCount, 139);
    assert.equal(ready.providerCalls, 10);
    assert.equal(ready.totalTokens, 140);
    assert.equal(ready.enrichmentAttempted, 6);
    assert.equal(isPublishedMaterializationStatus(ready.status), true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('server availability and model provenance keep operator archives inert and honest', () => {
  assert.equal(isMaterializationAvailable(undefined), true, 'unmanaged live fixtures remain available');
  assert.equal(isMaterializationAvailable('running'), false);
  assert.equal(isMaterializationAvailable('prepared'), false);
  assert.equal(isMaterializationAvailable('failed'), false);
  assert.equal(isMaterializationAvailable('ready'), true);
  assert.equal(isMaterializationAvailable('ready_with_fallback'), true);

  const published = {
    status: 'ready',
    model: 'model-a',
    promptVersion: 'prompt-a',
  };
  assert.equal(publishedMaterializationNeedsReenrichment(published, 'model-a', 'prompt-a'), false);
  assert.equal(publishedMaterializationNeedsReenrichment(published, 'model-b', 'prompt-a'), true);
  assert.equal(publishedMaterializationNeedsReenrichment(published, 'model-a', 'prompt-b'), true);
  assert.equal(publishedMaterializationNeedsReenrichment({ ...published, status: 'failed' }, 'model-b', 'prompt-b'), false);
  assert.equal(
    publishedMaterializationNeedsReenrichment(
      { ...published, status: 'failed', model: 'model-a', promptVersion: 'prompt-a' },
      'model-b',
      'prompt-a',
      true,
    ),
    true,
  );
});

test('materialization readiness requires complete history and an aligned projection', async () => {
  const entry = {
    enrichmentStatus: 'complete',
    commentaryBeatKind: 'major',
  };
  const runtime = {
    async getCheckpoint() {
      return { phase: 'finalised', projectionGeneration: 3, stateRevision: 10 };
    },
    async getIngestionCursor() {
      return { timelineComplete: false };
    },
    async getCommentaryProjection() {
      return {
        cursor: { projectionGeneration: 3, lastStateRevision: 10 },
        entries: [entry],
      };
    },
  };
  const baseline = await inspectMaterialization(runtime, 'fixture');
  assert.equal(baseline.finalised, true);
  assert.equal(baseline.timelineComplete, false);
  assert.equal(baseline.projectionAligned, true);
  assert.equal(baseline.completeCount, 1);
  assert.equal(baseline.promptVersion, COMMENTARY_PROMPT_BUNDLE);

  runtime.getCommentaryProjection = async () => ({ entries: [] });
  const empty = await inspectMaterialization(runtime, 'fresh-fixture');
  assert.equal(empty.promptVersion, COMMENTARY_PROMPT_BUNDLE);

  runtime.getIngestionCursor = async () => ({ timelineComplete: true });
  runtime.getCommentaryProjection = async () => ({
    cursor: { projectionGeneration: 2, lastStateRevision: 10 },
    entries: [entry],
  });
  const stale = await inspectMaterialization(runtime, 'fixture');
  assert.equal(stale.timelineComplete, true);
  assert.equal(stale.projectionAligned, false);
});

test('historical fixture metadata is fetched from the match epoch day before using placeholders', async () => {
  const startTime = Date.UTC(2026, 6, 9, 18, 0, 0);
  let requested;
  const expected = {
    Ts: startTime,
    StartTime: startTime,
    Competition: 'World Cup',
    CompetitionId: 72,
    FixtureGroupId: 10115675,
    Participant1Id: 1999,
    Participant1: 'France',
    Participant2Id: 2530,
    Participant2: 'Morocco',
    FixtureId: 18209181,
    Participant1IsHome: true,
  };
  const fixture = await findFixtureMetadata({
    async fetchFixtures(options) {
      requested = options;
      return [expected];
    },
  }, '18209181', [{
    FixtureId: 18209181,
    StartTime: startTime,
    Participant1Id: 1999,
    Participant2Id: 2530,
  }]);
  assert.deepEqual(requested, { startEpochDay: Math.floor(startTime / 86_400_000) });
  assert.equal(fixture.Participant1, 'France');
  assert.equal(fixture.Participant2, 'Morocco');
});
