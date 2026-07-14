import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CommentaryProjectionConsumer, commentaryEntryFromBeat } from '../src/ingestion/commentary-projection-consumer.ts';
import { SemanticFrameHub } from '../src/ingestion/semantic-frame-hub.ts';
import { FileMatchPulseCommentaryStore, SqliteMatchPulseCommentaryStore } from '../src/match-pulse-commentary-store.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

function readLastError(path, entryId) {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare(
      'SELECT last_error FROM match_pulse_commentary_enrichment_jobs WHERE entry_id = ?',
    ).get(entryId);
    return row?.last_error ?? undefined;
  } finally {
    db.close();
  }
}

const fixtureId = '18179759';
const teams = [
  { participant: 1, teamId: 10, name: 'Home FC', isHome: true },
  { participant: 2, teamId: 20, name: 'Away FC', isHome: false },
];

function cornerFrame(revision, teamId = 10) {
  const fact = {
    id: `fact-${revision}`,
    kind: 'incident',
    lifecycle: 'confirmed',
    basis: 'direct',
    revision,
    participant: teamId === 10 ? 1 : 2,
    teamId,
    value: { action: 'corner' },
    sourceSeqs: [revision],
    provenance: { fixtureId, action: 'corner', sourceId: revision, seq: revision },
  };
  return {
    id: `frame-${revision}`,
    fixtureId,
    seq: revision,
    stateRevision: revision,
    matchClockSeconds: revision * 60,
    facts: [
      {
        ...fact,
        id: `phase-${revision}`,
        kind: 'phase',
        value: { phase: 'first_half' },
        provenance: { ...fact.provenance, action: 'status' },
      },
      fact,
    ],
    simulationCues: [{
      id: `cue-${revision}`,
      kind: 'set_piece',
      updateMode: 'incident_upsert',
      lifecycle: 'confirmed',
      basis: 'direct',
      revision,
      participant: fact.participant,
      teamId,
      value: { action: 'corner' },
      occurrenceSeconds: revision * 60,
      sourceSeqs: [revision],
      factIds: [fact.id],
    }],
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('proactively persists engine beats and atomically replaces a corrected generation', async () => {
  let generation = 0;
  let frames = [cornerFrame(1)];
  const frameStore = {
    async getCheckpoint() { return { phase: 'finalised', projectionGeneration: generation }; },
    async listFramesAfter(_fixtureId, revision) {
      return frames.filter((frame) => frame.stateRevision > revision);
    },
  };
  const hub = new SemanticFrameHub(frameStore);
  const store = new SqliteMatchPulseCommentaryStore(':memory:');
  const consumer = new CommentaryProjectionConsumer(frameStore, hub, store);

  try {
    await consumer.ensureFixture(fixtureId, teams);
    const initial = await store.listEntries(fixtureId);
    assert.equal(initial.length, 1);
    assert.equal(initial[0].commentary, 'Home FC win a corner.');
    assert.equal(initial[0].projectionGeneration, 0);
    assert.equal(initial[0].period, 'first_half');
    assert.deepEqual(initial[0].sourceFrameIds, ['frame-1']);
    assert.equal(initial[0].enrichmentStatus, 'pending');

    generation = 1;
    frames = [cornerFrame(1, 20)];
    hub.publish(fixtureId, frames, { replaceExisting: true, projectionGeneration: 1 });
    await flush();
    await flush();

    const corrected = await store.listEntries(fixtureId);
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].commentary, 'Away FC win a corner.');
    assert.equal(corrected[0].projectionGeneration, 1);
    assert.equal((await store.getProjectionCursor(fixtureId)).projectionGeneration, 1);

    await store.upsertEntries([{
      ...initial[0],
      commentary: 'Late stale enrichment.',
      generation: 'llm',
      enrichmentStatus: 'complete',
    }]);
    assert.deepEqual(
      (await store.listEntries(fixtureId)).map((entry) => [entry.projectionGeneration, entry.commentary]),
      [[1, 'Away FC win a corner.']],
    );
  } finally {
    await consumer.close();
    store.close();
  }
});

test('reconciliation preserves an enriched entry when its deterministic beat id is unchanged', async () => {
  const store = new SqliteMatchPulseCommentaryStore(':memory:');
  const entry = {
    id: 'beat-1', fixtureId, batchId: 'engine:0:1-1', fromSeq: 1, toSeq: 1,
    period: 'first_half', clock: { label: "1'" }, kind: 'corner', sourceEvents: [],
    commentary: 'Fallback.', intensity: 'building', momentumSide: 'home',
    confidence: 'source_backed', generation: 'rule_based', fallbackCommentary: 'Fallback.',
    enrichmentStatus: 'pending', projectionGeneration: 0,
  };
  try {
    await store.commitEngineProjection(fixtureId, 0, 1, [entry], { replace: true });
    await store.upsertEntries([{
      ...entry,
      commentary: 'A better live line.',
      generation: 'llm',
      enrichmentStatus: 'complete',
      coveredFrameIds: ['frame-1'],
      enrichmentPromptVersion: 'engine-commentary-v1',
    }]);
    await store.commitEngineProjection(fixtureId, 0, 2, [entry], { replace: true });
    const [persisted] = await store.listEntries(fixtureId);
    assert.equal(persisted.commentary, 'A better live line.');
    assert.equal(persisted.generation, 'llm');
    assert.deepEqual(persisted.coveredFrameIds, ['frame-1']);
    assert.equal(persisted.enrichmentPromptVersion, 'engine-commentary-v1');
  } finally {
    store.close();
  }
});

test('enriches pending fallback commentary in the background after durable projection', async () => {
  const frames = [cornerFrame(1)];
  const frameStore = {
    async getCheckpoint() { return { phase: 'first_half', projectionGeneration: 0 }; },
    async listFramesAfter(_fixtureId, revision) {
      return frames.filter((frame) => frame.stateRevision > revision);
    },
  };
  const hub = new SemanticFrameHub(frameStore);
  const store = new SqliteMatchPulseCommentaryStore(':memory:');
  const contexts = [];
  const enrichment = {
    async enrichCommentaryEntries(context, pending) {
      contexts.push(context);
      return {
        entries: pending.map((entry) => ({
          ...entry,
          commentary: 'Home FC turn the pressure up and earn another corner.',
          generation: 'llm',
          enrichmentStatus: 'complete',
        })),
        provider: 'openai-compatible', attempted: pending.length, completed: pending.length, failed: 0,
      };
    },
  };
  const consumer = new CommentaryProjectionConsumer(frameStore, hub, store, { enrichment });
  try {
    await consumer.ensureFixture(fixtureId, teams);
    await flush();
    const [entry] = await store.listEntries(fixtureId);
    assert.equal(entry.generation, 'llm');
    assert.equal(contexts[0].homeTeam.name, 'Home FC');
    assert.deepEqual(contexts[0].allowedSourceFrameIds, ['frame-1']);
  } finally {
    await consumer.close();
    store.close();
  }
});

test('rejects an in-flight LLM result after the engine projection generation changes', async () => {
  let generation = 0;
  let frames = [cornerFrame(1)];
  let releaseOld;
  const oldRequest = new Promise((resolve) => { releaseOld = resolve; });
  let calls = 0;
  const enrichment = {
    async enrichCommentaryEntries(_context, pending) {
      calls += 1;
      const call = calls;
      if (call === 1) await oldRequest;
      return {
        entries: call === 1 ? pending.map((entry) => ({
          ...entry, commentary: 'Stale old-generation line.', generation: 'llm', enrichmentStatus: 'complete',
        })) : [],
        provider: 'openai-compatible', attempted: pending.length, completed: call === 1 ? pending.length : 0, failed: 0,
      };
    },
  };
  const frameStore = {
    async getCheckpoint() { return { phase: 'first_half', projectionGeneration: generation }; },
    async listFramesAfter(_fixtureId, revision) {
      return frames.filter((frame) => frame.stateRevision > revision);
    },
  };
  const hub = new SemanticFrameHub(frameStore);
  const store = new SqliteMatchPulseCommentaryStore(':memory:');
  const consumer = new CommentaryProjectionConsumer(frameStore, hub, store, { enrichment });
  try {
    await consumer.ensureFixture(fixtureId, teams);
    generation = 1;
    frames = [cornerFrame(1, 20)];
    hub.publish(fixtureId, frames, { replaceExisting: true, projectionGeneration: 1 });
    await flush();
    await flush();
    releaseOld();
    await flush();
    await flush();
    const entries = await store.listEntries(fixtureId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].projectionGeneration, 1);
    assert.notEqual(entries[0].commentary, 'Stale old-generation line.');
  } finally {
    releaseOld?.();
    await consumer.close();
    store.close();
  }
});

test('rejects an in-flight LLM result after a newer revision in the same generation', async () => {
  let revision = 1;
  let frames = [cornerFrame(1)];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let call = 0;
  const enrichment = {
    async enrichCommentaryEntries(_context, pending) {
      call += 1;
      if (call === 1) await held;
      return {
        entries: call === 1 ? pending.map((item) => ({
          ...item, commentary: 'Stale same-generation line.', generation: 'llm', enrichmentStatus: 'complete',
        })) : pending.map((item) => ({
          ...item, commentary: 'Fresh same-generation line.', generation: 'llm', enrichmentStatus: 'complete',
        })),
        provider: 'openai-compatible', attempted: pending.length, completed: pending.length, failed: 0,
      };
    },
  };
  const frameStore = {
    async getCheckpoint() { return { phase: 'first_half', projectionGeneration: 0, stateRevision: revision }; },
    async listFramesAfter(_fixtureId, afterRevision) {
      return frames.filter((item) => item.stateRevision > afterRevision);
    },
  };
  const hub = new SemanticFrameHub(frameStore);
  const store = new SqliteMatchPulseCommentaryStore(':memory:');
  const consumer = new CommentaryProjectionConsumer(frameStore, hub, store, { enrichment });
  try {
    await consumer.ensureFixture(fixtureId, teams);
    revision = 2;
    frames = [cornerFrame(1), cornerFrame(2, 20)];
    hub.publish(fixtureId, [cornerFrame(2, 20)], { projectionGeneration: 0 });
    await flush();
    await flush();
    release();
    for (let attempt = 0; attempt < 5 && call < 2; attempt += 1) await flush();
    const entries = await store.listEntries(fixtureId);
    assert.equal((await store.getProjectionCursor(fixtureId)).lastStateRevision, 2);
    assert.equal(entries.length, 2);
    assert.ok(entries.every((item) => item.commentary !== 'Stale same-generation line.'));
    assert.ok(entries.some((item) => item.commentary === 'Fresh same-generation line.'));
  } finally {
    release?.();
    await consumer.close();
    store.close();
  }
});

test('resumes pending enrichment when the durable commentary cursor is already current', async () => {
  const frames = [cornerFrame(1)];
  const frameStore = {
    async getCheckpoint() { return { phase: 'first_half', projectionGeneration: 0, stateRevision: 1 }; },
    async listFramesAfter(_fixtureId, afterRevision) { return frames.filter((item) => item.stateRevision > afterRevision); },
  };
  const hub = new SemanticFrameHub(frameStore);
  const store = new SqliteMatchPulseCommentaryStore(':memory:');
  const seedConsumer = new CommentaryProjectionConsumer(frameStore, hub, store);
  await seedConsumer.ensureFixture(fixtureId, teams);
  await seedConsumer.close();
  let attempted = 0;
  const enrichment = {
    async enrichCommentaryEntries(_context, pending) {
      attempted += pending.length;
      return {
        entries: pending.map((item) => ({ ...item, commentary: 'Resumed after restart.', generation: 'llm', enrichmentStatus: 'complete' })),
        provider: 'openai-compatible', attempted: pending.length, completed: pending.length, failed: 0,
      };
    },
  };
  const consumer = new CommentaryProjectionConsumer(frameStore, hub, store, { enrichment });
  try {
    await consumer.ensureFixture(fixtureId, teams);
    await flush();
    assert.equal(attempted, 1);
    assert.equal((await store.listEntries(fixtureId))[0].commentary, 'Resumed after restart.');
  } finally {
    await consumer.close();
    store.close();
  }
});

test('does not expose future pending beats as broadcast memory', async () => {
  const frames = [cornerFrame(1), cornerFrame(3, 20)];
  const frameStore = {
    async getCheckpoint() { return { phase: 'first_half', projectionGeneration: 0, stateRevision: 3 }; },
    async listFramesAfter(_fixtureId, afterRevision) { return frames.filter((item) => item.stateRevision > afterRevision); },
  };
  const previousBatches = [];
  const enrichment = {
    async enrichCommentaryEntries(_context, pending, previous) {
      previousBatches.push(previous.map((item) => item.id));
      return {
        entries: pending.map((item) => ({ ...item, commentary: `Enriched ${item.id}.`, generation: 'llm', enrichmentStatus: 'complete' })),
        provider: 'openai-compatible', attempted: pending.length, completed: pending.length, failed: 0,
      };
    },
  };
  const hub = new SemanticFrameHub(frameStore);
  const store = new SqliteMatchPulseCommentaryStore(':memory:');
  const consumer = new CommentaryProjectionConsumer(frameStore, hub, store, { enrichment, enrichmentBatchSize: 1 });
  try {
    await consumer.ensureFixture(fixtureId, teams);
    await flush();
    await flush();
    assert.deepEqual(previousBatches[0], []);
    assert.equal(previousBatches[1].length, 1);
  } finally {
    await consumer.close();
    store.close();
  }
});

test('file commentary store serializes stale enrichment with a same-generation rebuild', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-commentary-'));
  const store = new FileMatchPulseCommentaryStore(join(directory, 'commentary.json'));
  const base = {
    fixtureId, batchId: 'engine:0:1-1', fromSeq: 1, toSeq: 1, period: 'first_half',
    clock: { label: "1'" }, kind: 'corner', sourceEvents: [], intensity: 'building',
    momentumSide: 'home', confidence: 'source_backed', projectionGeneration: 0,
  };
  const oldEntry = {
    ...base, id: 'old-beat', commentary: 'Old fallback.', generation: 'rule_based',
    fallbackCommentary: 'Old fallback.', enrichmentStatus: 'pending',
  };
  const newEntry = {
    ...base, id: 'new-beat', batchId: 'engine:0:2-2', fromSeq: 2, toSeq: 2,
    commentary: 'New fallback.', generation: 'rule_based', fallbackCommentary: 'New fallback.',
    enrichmentStatus: 'pending',
  };
  try {
    await store.commitEngineProjection(fixtureId, 0, 1, [oldEntry], { replace: true });
    const stale = store.commitEngineProjection(fixtureId, 0, 1, [{
      ...oldEntry, commentary: 'Stale enrichment.', generation: 'llm', enrichmentStatus: 'complete',
    }], { expectedCursor: { projectionGeneration: 0, lastStateRevision: 1 } });
    const rebuild = store.commitEngineProjection(fixtureId, 0, 2, [newEntry], { replace: true });
    await Promise.all([stale, rebuild]);
    assert.deepEqual((await store.listEntries(fixtureId)).map((item) => item.id), ['new-beat']);
    assert.equal((await store.getProjectionCursor(fixtureId)).lastStateRevision, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('atomically leases one SQLite enrichment batch to only one worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-commentary-claim-'));
  const path = join(directory, 'commentary.sqlite');
  const first = new SqliteMatchPulseCommentaryStore(path);
  const second = new SqliteMatchPulseCommentaryStore(path);
  const entry = {
    id: 'claim-beat', fixtureId, batchId: 'engine:0:1-1', fromSeq: 1, toSeq: 1,
    period: 'first_half', clock: { label: "1'" }, kind: 'corner', sourceEvents: [],
    commentary: 'Fallback.', intensity: 'building', momentumSide: 'home',
    confidence: 'source_backed', generation: 'rule_based', fallbackCommentary: 'Fallback.',
    enrichmentStatus: 'pending', projectionGeneration: 0,
  };
  try {
    await first.commitEngineProjection(fixtureId, 0, 1, [entry], { replace: true });
    const [left, right] = await Promise.all([
      first.claimEnrichmentBatch(fixtureId, 'worker-a', 1, 30_000, 100),
      second.claimEnrichmentBatch(fixtureId, 'worker-b', 1, 30_000, 100),
    ]);
    assert.equal([left, right].filter(Boolean).length, 1);
    assert.equal((left ?? right).attempt, 1);
    const recovered = await second.claimEnrichmentBatch(fixtureId, 'worker-b', 1, 30_000, 30_101);
    assert.equal(recovered?.entries[0].id, 'claim-beat');
    assert.equal(recovered?.attempt, 2);
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('repairs legacy terminal jobs that still have pending fallback entries on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-commentary-terminal-repair-'));
  const path = join(directory, 'commentary.sqlite');
  const entry = {
    id: 'legacy-terminal-beat', fixtureId, batchId: 'engine:0:1-1', fromSeq: 1, toSeq: 1,
    period: 'first_half', clock: { label: "1'" }, kind: 'corner', sourceEvents: [],
    commentary: 'Home win a corner.', intensity: 'building', momentumSide: 'home',
    confidence: 'source_backed', generation: 'rule_based', fallbackCommentary: 'Home win a corner.',
    enrichmentStatus: 'pending', projectionGeneration: 0,
  };
  const first = new SqliteMatchPulseCommentaryStore(path);
  try {
    await first.commitEngineProjection(fixtureId, 0, 1, [entry], { replace: true });
    const claim = await first.claimEnrichmentBatch(fixtureId, 'legacy-worker', 1, 30_000, 100);
    assert.ok(claim);
    await first.releaseEnrichmentClaim(claim, 'terminal');
  } finally {
    first.close();
  }
  const reopened = new SqliteMatchPulseCommentaryStore(path);
  try {
    const [persisted] = await reopened.listEntries(fixtureId);
    assert.equal(persisted.commentary, entry.commentary);
    assert.equal(persisted.generation, 'rule_based');
    assert.equal(persisted.enrichmentStatus, 'failed');
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('renews a lease throughout slow two-stage reflection so a second worker cannot reclaim it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-commentary-reflection-lease-'));
  const path = join(directory, 'commentary.sqlite');
  const frames = [cornerFrame(1)];
  const frameStore = {
    async getCheckpoint() { return { phase: 'first_half', projectionGeneration: 0, stateRevision: 1 }; },
    async listFramesAfter(_fixtureId, afterRevision) { return frames.filter((item) => item.stateRevision > afterRevision); },
  };
  const hub = new SemanticFrameHub(frameStore);
  let calls = 0;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const enrichment = {
    async enrichCommentaryEntries(_context, pending) {
      calls += 1;
      signalStarted();
      await wait(20); // Draft request.
      await wait(20); // Reflection request; total work exceeds the 15 ms lease.
      return {
        entries: pending.map((entry) => ({
          ...entry, commentary: 'Reflected once.', generation: 'llm', enrichmentStatus: 'complete',
        })),
        provider: 'openai-compatible', attempted: pending.length, completed: pending.length, failed: 0,
      };
    },
  };
  const firstStore = new SqliteMatchPulseCommentaryStore(path);
  const secondStore = new SqliteMatchPulseCommentaryStore(path);
  const first = new CommentaryProjectionConsumer(frameStore, hub, firstStore, {
    enrichment, workerId: 'reflection-worker-a', enrichmentLeaseMs: 15, enrichmentRetryBaseMs: 5,
  });
  const second = new CommentaryProjectionConsumer(frameStore, hub, secondStore, {
    enrichment, workerId: 'reflection-worker-b', enrichmentLeaseMs: 15, enrichmentRetryBaseMs: 5,
  });
  try {
    await first.ensureFixture(fixtureId, teams);
    await started;
    await wait(20);
    await second.ensureFixture(fixtureId, teams);
    await wait(50);
    assert.equal(calls, 1);
    assert.equal((await firstStore.listEntries(fixtureId))[0].commentary, 'Reflected once.');
  } finally {
    await Promise.all([first.close(), second.close()]);
    firstStore.close();
    secondStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists retry backoff so another consumer resumes after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-commentary-retry-'));
  const path = join(directory, 'commentary.sqlite');
  const frames = [cornerFrame(1)];
  const frameStore = {
    async getCheckpoint() { return { phase: 'first_half', projectionGeneration: 0, stateRevision: 1 }; },
    async listFramesAfter(_fixtureId, afterRevision) { return frames.filter((item) => item.stateRevision > afterRevision); },
  };
  const hub = new SemanticFrameHub(frameStore);
  const firstStore = new SqliteMatchPulseCommentaryStore(path);
  const first = new CommentaryProjectionConsumer(frameStore, hub, firstStore, {
    workerId: 'worker-a', enrichmentRetryBaseMs: 5,
    enrichment: { async enrichCommentaryEntries() { throw new Error('temporary provider outage'); } },
  });
  try {
    await first.ensureFixture(fixtureId, teams);
    await flush();
    await first.close();
    firstStore.close();
    await wait(10);

    let attempts = 0;
    const secondStore = new SqliteMatchPulseCommentaryStore(path);
    const second = new CommentaryProjectionConsumer(frameStore, hub, secondStore, {
      workerId: 'worker-b',
      enrichment: {
        async enrichCommentaryEntries(_context, pending) {
          attempts += 1;
          return { entries: pending.map((entry) => ({ ...entry, commentary: 'Recovered.', generation: 'llm', enrichmentStatus: 'complete' })), provider: 'openai-compatible', attempted: 1, completed: 1, failed: 0 };
        },
      },
    });
    try {
      await second.ensureFixture(fixtureId, teams);
      await flush();
      assert.equal(attempts, 1);
      assert.equal((await secondStore.listEntries(fixtureId))[0].commentary, 'Recovered.');
    } finally {
      await second.close();
      secondStore.close();
    }
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists returned validation failures as terminal work', async () => {
  const frames = [cornerFrame(1)];
  const frameStore = {
    async getCheckpoint() { return { phase: 'first_half', projectionGeneration: 0, stateRevision: 1 }; },
    async listFramesAfter(_fixtureId, afterRevision) { return frames.filter((item) => item.stateRevision > afterRevision); },
  };
  const hub = new SemanticFrameHub(frameStore);
  const store = new SqliteMatchPulseCommentaryStore(':memory:');
  let calls = 0;
  const enrichment = {
    async enrichCommentaryEntries(_context, pending) {
      calls += 1;
      return { entries: pending.map((entry) => ({ ...entry, enrichmentStatus: 'failed' })), provider: 'openai-compatible', attempted: 1, completed: 0, failed: 1 };
    },
  };
  const first = new CommentaryProjectionConsumer(frameStore, hub, store, { enrichment, workerId: 'worker-a' });
  try {
    await first.ensureFixture(fixtureId, teams);
    await flush();
    await first.close();
    const second = new CommentaryProjectionConsumer(frameStore, hub, store, { enrichment, workerId: 'worker-b' });
    await second.ensureFixture(fixtureId, teams);
    await flush();
    await second.close();
    assert.equal(calls, 1);
  } finally {
    await first.close();
    store.close();
  }
});

test('settles omitted provider results as failed grounded fallbacks', async () => {
  const frames = [cornerFrame(1)];
  const frameStore = {
    async getCheckpoint() { return { phase: 'first_half', projectionGeneration: 0, stateRevision: 1 }; },
    async listFramesAfter(_fixtureId, afterRevision) { return frames.filter((item) => item.stateRevision > afterRevision); },
  };
  const hub = new SemanticFrameHub(frameStore);
  const store = new SqliteMatchPulseCommentaryStore(':memory:');
  let calls = 0;
  const enrichment = {
    async enrichCommentaryEntries(_context, pending) {
      calls += 1;
      return { entries: [], provider: 'disabled', attempted: pending.length, completed: 0, failed: 0 };
    },
  };
  const first = new CommentaryProjectionConsumer(frameStore, hub, store, { enrichment, workerId: 'worker-a' });
  try {
    await first.ensureFixture(fixtureId, teams);
    await flush();
    await first.close();
    const [persisted] = await store.listEntries(fixtureId);
    assert.equal(persisted.generation, 'rule_based');
    assert.equal(persisted.enrichmentStatus, 'failed');
    const second = new CommentaryProjectionConsumer(frameStore, hub, store, { enrichment, workerId: 'worker-b' });
    await second.ensureFixture(fixtureId, teams);
    await flush();
    await second.close();
    assert.equal(calls, 1);
  } finally {
    await first.close();
    store.close();
  }
});

test('settles a final provider error as a failed grounded fallback', async () => {
  const frames = [cornerFrame(1)];
  const frameStore = {
    async getCheckpoint() { return { phase: 'first_half', projectionGeneration: 0, stateRevision: 1 }; },
    async listFramesAfter(_fixtureId, afterRevision) { return frames.filter((item) => item.stateRevision > afterRevision); },
  };
  const hub = new SemanticFrameHub(frameStore);
  const store = new SqliteMatchPulseCommentaryStore(':memory:');
  const consumer = new CommentaryProjectionConsumer(frameStore, hub, store, {
    workerId: 'terminal-worker',
    enrichmentMaxAttempts: 1,
    onEnrichmentError() {},
    enrichment: { async enrichCommentaryEntries() { throw new Error('provider unavailable'); } },
  });
  try {
    await consumer.ensureFixture(fixtureId, teams);
    await flush();
    await consumer.close();
    const [persisted] = await store.listEntries(fixtureId);
    assert.equal(persisted.generation, 'rule_based');
    assert.equal(persisted.enrichmentStatus, 'failed');
  } finally {
    await consumer.close();
    store.close();
  }
});

test('a terminal provider error persists its message as the enrichment job last_error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-commentary-provider-error-'));
  const path = join(directory, 'commentary.sqlite');
  const frames = [cornerFrame(1)];
  const frameStore = {
    async getCheckpoint() { return { phase: 'first_half', projectionGeneration: 0, stateRevision: 1 }; },
    async listFramesAfter(_fixtureId, afterRevision) { return frames.filter((item) => item.stateRevision > afterRevision); },
  };
  const hub = new SemanticFrameHub(frameStore);
  const store = new SqliteMatchPulseCommentaryStore(path);
  const consumer = new CommentaryProjectionConsumer(frameStore, hub, store, {
    workerId: 'terminal-worker',
    enrichmentMaxAttempts: 1,
    onEnrichmentError() {},
    enrichment: { async enrichCommentaryEntries() { throw new Error('provider unavailable'); } },
  });
  try {
    await consumer.ensureFixture(fixtureId, teams);
    await flush();
    await consumer.close();
    const [persisted] = await store.listEntries(fixtureId);
    assert.equal(persisted.enrichmentStatus, 'failed');
    assert.equal(readLastError(path, persisted.id), 'provider unavailable');
  } finally {
    await consumer.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('releaseEnrichmentClaim persists a last_error reason for terminal and retry outcomes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-commentary-last-error-'));
  const path = join(directory, 'commentary.sqlite');
  const store = new SqliteMatchPulseCommentaryStore(path);
  const entry = {
    id: 'last-error-beat', fixtureId, batchId: 'engine:0:1-1', fromSeq: 1, toSeq: 1,
    period: 'first_half', clock: { label: "1'" }, kind: 'corner', sourceEvents: [],
    commentary: 'Fallback.', intensity: 'building', momentumSide: 'home',
    confidence: 'source_backed', generation: 'rule_based', fallbackCommentary: 'Fallback.',
    enrichmentStatus: 'pending', projectionGeneration: 0,
  };
  try {
    await store.commitEngineProjection(fixtureId, 0, 1, [entry], { replace: true });
    const claim = await store.claimEnrichmentBatch(fixtureId, 'worker-a', 1, 30_000, 100);
    assert.ok(claim);
    await store.releaseEnrichmentClaim(claim, 'retry', Date.now(), 'temporary provider outage');
    assert.equal(readLastError(path, entry.id), 'temporary provider outage');

    const reclaimed = await store.claimEnrichmentBatch(fixtureId, 'worker-a', 1, 30_000, Date.now() + 1);
    assert.ok(reclaimed);
    await store.releaseEnrichmentClaim(reclaimed, 'terminal', Date.now(), 'Commentary omitted or changed the grounded scorer name.');
    assert.equal(
      readLastError(path, entry.id),
      'Commentary omitted or changed the grounded scorer name.',
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists the caught validation error as the enrichment job last_error for a terminal per-entry failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-commentary-terminal-reason-'));
  const path = join(directory, 'commentary.sqlite');
  const frames = [cornerFrame(1)];
  const frameStore = {
    async getCheckpoint() { return { phase: 'first_half', projectionGeneration: 0, stateRevision: 1 }; },
    async listFramesAfter(_fixtureId, afterRevision) { return frames.filter((item) => item.stateRevision > afterRevision); },
  };
  const hub = new SemanticFrameHub(frameStore);
  const store = new SqliteMatchPulseCommentaryStore(path);
  const enrichment = {
    async enrichCommentaryEntries(_context, pending) {
      return {
        entries: pending.map((entry) => ({ ...entry, enrichmentStatus: 'failed' })),
        provider: 'openai-compatible',
        attempted: pending.length,
        completed: 0,
        failed: pending.length,
        traces: pending.map((entry) => ({
          entryId: entry.id,
          stages: [],
          failureReason: 'Commentary omitted or changed the grounded scorer name.',
        })),
      };
    },
  };
  const consumer = new CommentaryProjectionConsumer(frameStore, hub, store, { enrichment, workerId: 'worker-a' });
  try {
    await consumer.ensureFixture(fixtureId, teams);
    await flush();
    await consumer.close();
    const [persisted] = await store.listEntries(fixtureId);
    assert.equal(persisted.enrichmentStatus, 'failed');
    assert.equal(
      readLastError(path, persisted.id),
      'Commentary omitted or changed the grounded scorer name.',
    );
  } finally {
    await consumer.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('coalesces a large initial frame publication instead of rebuilding per delivery', async () => {
  const frames = Array.from({ length: 886 }, (_, index) => cornerFrame(index + 1));
  let fullReads = 0;
  const frameStore = {
    async getCheckpoint() { return { phase: 'finalised', projectionGeneration: 0, stateRevision: 886 }; },
    async listFramesAfter(_fixtureId, afterRevision) {
      if (afterRevision === 0) fullReads += 1;
      return frames.filter((frame) => frame.stateRevision > afterRevision);
    },
  };
  const hub = new SemanticFrameHub(frameStore);
  const store = new SqliteMatchPulseCommentaryStore(':memory:');
  let commits = 0;
  const commitProjection = store.commitEngineProjection.bind(store);
  store.commitEngineProjection = async (...args) => {
    commits += 1;
    return commitProjection(...args);
  };
  const consumer = new CommentaryProjectionConsumer(frameStore, hub, store);
  try {
    await consumer.ensureFixture(fixtureId, teams);
    await flush();
    await flush();
    assert.ok(commits >= 1 && commits <= 2, `expected at most two coalesced rebuilds, received ${commits}`);
    // One read hydrates the hub; the remaining reads are the bounded projection rebuilds.
    assert.equal(fullReads, commits + 1);
  } finally {
    await consumer.close();
    store.close();
  }
});

// --- narrative attachment (commentaryEntryFromBeat) -----------------------

function narrativeCue(id, kind, overrides = {}) {
  return {
    id,
    kind,
    updateMode: 'incident_upsert',
    lifecycle: 'confirmed',
    basis: 'direct',
    revision: 1,
    value: {},
    sourceSeqs: [1],
    factIds: [],
    ...overrides,
  };
}

function narrativeScoreCue(id, participant1, participant2, seq) {
  return narrativeCue(id, 'score_commit', {
    updateMode: 'state_replace',
    value: { participant1, participant2 },
    sourceSeqs: [seq],
  });
}

function narrativeGoalCue(id, participant, teamId, seq, player) {
  return narrativeCue(id, 'goal_confirmed', {
    participant,
    teamId,
    value: { action: 'goal' },
    sourceSeqs: [seq],
    ...(player ? { player } : {}),
  });
}

function narrativeCardCue(id, participant, teamId, seq, action) {
  return narrativeCue(id, 'card', {
    participant,
    teamId,
    value: { action },
    sourceSeqs: [seq],
  });
}

function narrativeBeat(id, kind, cues, overrides = {}) {
  return {
    id,
    fixtureId,
    projectionGeneration: 0,
    kind,
    mustCover: kind === 'major',
    fromSeq: cues[0]?.sourceSeqs[0] ?? 0,
    toSeq: cues[cues.length - 1]?.sourceSeqs[0] ?? 0,
    participant: cues[0]?.participant,
    teamId: cues[0]?.teamId,
    sourceFrameIds: [],
    sources: [],
    factIds: [],
    cueIds: cues.map((cue) => cue.id),
    facts: [],
    simulationCues: cues,
    fallbackCommentary: 'Fallback commentary.',
    ...overrides,
  };
}

const narrativeState = {
  fixtureId,
  lastAppliedSeq: 0,
  stateRevision: 0,
  phase: 'first_half',
  confirmedScore: { participant1: 0, participant2: 0 },
  possibleEvents: {},
  activePlayerIdsByParticipant: { 1: [1, 2, 3], 2: [4, 5, 6] },
  disciplineByPlayerId: {},
  incidents: {},
  supportedFacts: {},
  simulationCues: {},
  integrityWarnings: [],
};

test('commentaryEntryFromBeat attaches scoreStory narrative to a goal beat', () => {
  const beats = [
    narrativeBeat('goal-beat', 'major', [
      narrativeGoalCue('goal:1', 1, 10, 10, { normativeId: 501, sourcePreferredName: 'Scorer One' }),
      narrativeScoreCue('score:1', 1, 0, 10),
    ], { matchClockSeconds: 600 }),
  ];
  const entry = commentaryEntryFromBeat(beats[0], 'first_half', teams, {
    beats, beatIndex: 0, state: narrativeState,
  });
  assert.ok(entry.narrative, 'expected a narrative slice on a goal beat');
  assert.deepEqual(entry.narrative.scoreStory.events, ['opener']);
  assert.equal(entry.narrative.playerMemory.scorerGoalsThisMatch, 1);
  assert.equal(entry.narrative.discipline, undefined);
  assert.equal(entry.scoreAtMoment.home, 1);
  assert.equal(entry.scoreAtMoment.away, 0);
});

test('commentaryEntryFromBeat attaches discipline narrative to a card beat', () => {
  const beats = [
    narrativeBeat('yellow-1', 'major', [narrativeCardCue('card:1', 1, 10, 20, 'yellow_card')], { matchClockSeconds: 1200 }),
    narrativeBeat('yellow-2', 'major', [narrativeCardCue('card:2', 1, 10, 30, 'yellow_card')], { matchClockSeconds: 1500 }),
  ];
  const entry = commentaryEntryFromBeat(beats[1], 'first_half', teams, {
    beats, beatIndex: 1, state: narrativeState,
  });
  assert.ok(entry.narrative, 'expected a narrative slice on a card beat');
  assert.equal(entry.narrative.discipline.teamYellowCount, 2);
  assert.equal(entry.narrative.scoreStory, undefined);
});

test('commentaryEntryFromBeat threads the latest known score onto a non-goal beat', () => {
  const beats = [
    narrativeBeat('goal-beat', 'major', [
      narrativeGoalCue('goal:1', 1, 10, 10),
      narrativeScoreCue('score:1', 1, 0, 10),
    ], { matchClockSeconds: 600 }),
    narrativeBeat('corner-beat', 'pressure', [
      narrativeCue('corner:1', 'set_piece', { participant: 2, teamId: 20, value: { action: 'corner' }, sourceSeqs: [11] }),
    ], { matchClockSeconds: 660 }),
  ];
  const entry = commentaryEntryFromBeat(beats[1], 'first_half', teams, {
    beats, beatIndex: 1, state: narrativeState,
  });
  assert.deepEqual(entry.scoreAtMoment, { home: 1, away: 0 });
});

test('commentaryEntryFromBeat omits narrative when no state is available (existing checkpoint shape)', () => {
  const beats = [
    narrativeBeat('goal-beat', 'major', [
      narrativeGoalCue('goal:1', 1, 10, 10),
      narrativeScoreCue('score:1', 1, 0, 10),
    ], { matchClockSeconds: 600 }),
  ];
  const entry = commentaryEntryFromBeat(beats[0], 'first_half', teams, { beats, beatIndex: 0, state: undefined });
  assert.equal(entry.narrative, undefined);
  // Score threading still works without a CanonicalMatchState, since it only
  // reads simulationCues off the beats themselves.
  assert.deepEqual(entry.scoreAtMoment, { home: 1, away: 0 });
});

test('commentaryEntryFromBeat omits narrative entirely when no narrative context is supplied (back-compat)', () => {
  const beat = narrativeBeat('goal-beat', 'major', [
    narrativeGoalCue('goal:1', 1, 10, 10),
    narrativeScoreCue('score:1', 1, 0, 10),
  ], { matchClockSeconds: 600 });
  const entry = commentaryEntryFromBeat(beat, 'first_half', teams);
  assert.equal(entry.narrative, undefined);
  assert.deepEqual(entry.scoreAtMoment, { home: 1, away: 0 });
});

test('a narrative-bearing entry round-trips whole through the commentary store', async () => {
  const beats = [
    narrativeBeat('goal-beat', 'major', [
      narrativeGoalCue('goal:1', 1, 10, 10, { normativeId: 501, sourcePreferredName: 'Scorer One' }),
      narrativeScoreCue('score:1', 1, 0, 10),
    ], { matchClockSeconds: 600 }),
  ];
  const entry = commentaryEntryFromBeat(beats[0], 'first_half', teams, {
    beats, beatIndex: 0, state: narrativeState,
  });
  const store = new SqliteMatchPulseCommentaryStore(':memory:');
  try {
    await store.commitEngineProjection(fixtureId, 0, 1, [entry], { replace: true });
    const [persisted] = await store.listEntries(fixtureId);
    assert.deepEqual(persisted.narrative, entry.narrative);
  } finally {
    store.close();
  }
});
