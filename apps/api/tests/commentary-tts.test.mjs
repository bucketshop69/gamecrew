import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { SqliteCommentaryAudioStore } from '../src/tts/commentary-audio-store.ts';
import { TtsRequestError } from '../src/tts/tts-client.ts';
import {
  generateCommentaryAudio,
  hashVoicedText,
  selectVoicedText,
} from '../src/tts/generate-commentary-audio.ts';
import {
  parseArgs,
  runCommentaryTtsCli,
  deriveClockMinute,
  filterEntriesUntilMinute,
} from '../src/generate-commentary-tts.ts';
import { createCommentaryAudioRoutes } from '../src/tts/commentary-audio-routes.ts';
import { decorateCommentaryTimeline } from '../src/tts/decorate-commentary-text.ts';
import { Hono } from 'hono';

const DEFAULT_SPEED = 1.0;

function makeEntry(overrides = {}) {
  return {
    id: overrides.id ?? 'e1',
    fixtureId: overrides.fixtureId ?? 'f1',
    batchId: 'batch-1',
    period: 'first_half',
    clock: overrides.clock ?? { seconds: 300, minute: 5, label: "5'" },
    kind: 'goal',
    sourceEvents: [],
    commentary: overrides.commentary ?? 'Default commentary text.',
    ...(overrides.voiceLine !== undefined ? { voiceLine: overrides.voiceLine } : {}),
    intensity: 'major',
    momentumSide: 'home',
    confidence: 'verified',
    generation: 'rule_based',
    fallbackCommentary: 'Fallback.',
    enrichmentStatus: 'complete',
    ...overrides,
  };
}

function bytes(length, seed = 1) {
  const array = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) array[i] = (i * seed) % 256;
  return array;
}

function fakeClient(overrides = {}) {
  let callCount = 0;
  const calls = [];
  return {
    calls,
    get callCount() {
      return callCount;
    },
    resetCallCount() {
      callCount = 0;
      calls.length = 0;
    },
    async synthesize(request) {
      callCount += 1;
      calls.push(request);
      if (overrides.synthesize) return overrides.synthesize(request, callCount);
      return { audio: bytes(10), codec: 'mp3', sampleRate: 44100, bitRate: 128000 };
    },
  };
}

function upsert(store, overrides = {}) {
  store.upsertAudio({
    entryId: 'e1', fixtureId: 'f1', voiceId: 'v1', speed: DEFAULT_SPEED, textHash: 'h1', sourceText: 'a',
    codec: 'mp3', sampleRate: 44100, bitRate: 128000, byteLength: 10, audio: bytes(10),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// STORE
// ---------------------------------------------------------------------------

test('STORE-001: upsertAudio then getAudio round-trips bytes exactly', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const audio = bytes(5000, 7);
  store.upsertAudio({
    entryId: 'e1', fixtureId: 'f1', voiceId: 'v1', speed: 1.1, textHash: 'h1', sourceText: 'Goal!',
    codec: 'mp3', sampleRate: 44100, bitRate: 128000, byteLength: 5000, audio,
  });
  const record = store.getAudio('e1');
  assert.ok(record);
  assert.deepEqual(record.audio, audio);
  assert.equal(record.byteLength, 5000);
  assert.equal(record.audio.length, 5000);
  assert.equal(record.voiceId, 'v1');
  assert.equal(record.speed, 1.1);
  assert.equal(record.textHash, 'h1');
  assert.equal(record.sourceText, 'Goal!');
  assert.equal(record.codec, 'mp3');
  assert.equal(record.sampleRate, 44100);
  assert.equal(record.bitRate, 128000);
  store.close();
});

test('STORE-002: getAudio returns undefined for an unknown entryId', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  assert.equal(store.getAudio('does-not-exist'), undefined);
  store.close();
});

test('STORE-003: upsertAudio on an existing entryId overwrites in place, not appends', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  upsert(store, { textHash: 'h1', sourceText: 'first', byteLength: 100, audio: bytes(100, 1) });
  upsert(store, { textHash: 'h2', sourceText: 'second', byteLength: 200, audio: bytes(200, 2) });
  const record = store.getAudio('e1');
  assert.equal(record.textHash, 'h2');
  assert.equal(record.byteLength, 200);
  assert.deepEqual(record.audio, bytes(200, 2));
  const manifest = store.listManifest('f1');
  assert.equal(manifest.length, 1);
  store.close();
});

test('STORE-004: upsertAudio overwrite updates updated_at but preserves created_at', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  upsert(store, { textHash: 'h1', sourceText: 'first' });
  const first = store.getAudio('e1');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  upsert(store, { textHash: 'h2', sourceText: 'second', audio: bytes(10, 3) });
  const second = store.getAudio('e1');
  assert.equal(second.createdAt, first.createdAt);
  assert.ok(second.updatedAt >= first.updatedAt);
  store.close();
});

test('STORE-005: listManifest excludes the audio blob', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  upsert(store, { entryId: 'e1', textHash: 'h1', sourceText: 'a', byteLength: 1000, audio: bytes(1000, 1) });
  upsert(store, { entryId: 'e2', textHash: 'h2', sourceText: 'b', byteLength: 2000, audio: bytes(2000, 2) });
  const manifest = store.listManifest('f1');
  for (const row of manifest) {
    assert.equal('audio' in row, false);
    assert.ok(row.entryId);
    assert.ok(row.voiceId);
    assert.ok(row.textHash);
    assert.ok(row.byteLength > 0);
    assert.equal(typeof row.speed, 'number');
  }
  store.close();
});

test('STORE-006: listManifest is fixture-scoped', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  upsert(store, { entryId: 'e1', fixtureId: 'f1', textHash: 'h1', sourceText: 'a' });
  upsert(store, { entryId: 'e2', fixtureId: 'f2', textHash: 'h2', sourceText: 'b' });
  const manifest = store.listManifest('f1');
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].entryId, 'e1');
  store.close();
});

test('STORE-007: listManifest returns replay order matching commentary entry order', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  // Insert scrambled: sortSeq=3 entry first.
  upsert(store, { entryId: 'e-seq3', textHash: 'h3', sourceText: 'third' });
  upsert(store, { entryId: 'e-seq1', textHash: 'h1', sourceText: 'first' });
  upsert(store, { entryId: 'e-seq2', textHash: 'h2', sourceText: 'second' });
  const replayOrder = ['e-seq1', 'e-seq2', 'e-seq3'];
  const manifest = store.listManifest('f1', replayOrder);
  assert.deepEqual(manifest.map((entry) => entry.entryId), replayOrder);
  store.close();
});

test('STORE-008: listManifest on a fixture with no audio returns an empty array', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const manifest = store.listManifest('unknown-fixture');
  assert.deepEqual(manifest, []);
  store.close();
});

test('STORE-009: hasCurrentAudio is true when entryId, textHash, voiceId, and speed all match', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  upsert(store, { textHash: 'h1', speed: 1.1 });
  assert.equal(store.hasCurrentAudio('e1', 'h1', 'v1', 1.1), true);
  store.close();
});

test('STORE-010: hasCurrentAudio is false when the entryId has no row', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  assert.equal(store.hasCurrentAudio('missing', 'h1', 'v1', DEFAULT_SPEED), false);
  store.close();
});

test('STORE-011: hasCurrentAudio is false on textHash mismatch', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  upsert(store, { textHash: 'h1' });
  assert.equal(store.hasCurrentAudio('e1', 'h-different', 'v1', DEFAULT_SPEED), false);
  store.close();
});

test('STORE-012: hasCurrentAudio is false on voiceId mismatch', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  upsert(store, { textHash: 'h1' });
  assert.equal(store.hasCurrentAudio('e1', 'h1', 'v-different', DEFAULT_SPEED), false);
  store.close();
});

test('STORE-SPEED-001: hasCurrentAudio is false on speed mismatch even when text and voice match', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  upsert(store, { textHash: 'h1', speed: 1.0 });
  assert.equal(store.hasCurrentAudio('e1', 'h1', 'v1', 1.1), false);
  assert.equal(store.hasCurrentAudio('e1', 'h1', 'v1', 1.0), true);
  store.close();
});

test('STORE-013: table/index creation is idempotent across repeated construction', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'commentary-audio-'));
  const path = join(dir, 'audio.sqlite');

  const first = new SqliteCommentaryAudioStore(path);
  upsert(first, { textHash: 'h1' });
  first.close();

  const second = new SqliteCommentaryAudioStore(path);
  const record = second.getAudio('e1');
  assert.ok(record);
  assert.equal(record.entryId, 'e1');
  second.close();
});

test('STORE-014: byte_length is stored independently of actual blob length', () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  upsert(store, { textHash: 'h1', byteLength: 999, audio: bytes(50) });
  const record = store.getAudio('e1');
  assert.equal(record.byteLength, 999);
  assert.equal(record.audio.length, 50);
  store.close();
});

// ---------------------------------------------------------------------------
// TEXT
// ---------------------------------------------------------------------------

test('TEXT-001: voiceLine is preferred over commentary when both are present', () => {
  const text = selectVoicedText({ voiceLine: 'Short punchy line.', commentary: 'Long descriptive commentary.' });
  assert.equal(text, 'Short punchy line.');
});

test('TEXT-002: commentary is used when voiceLine is absent', () => {
  const text = selectVoicedText({ voiceLine: undefined, commentary: 'Fallback commentary text.' });
  assert.equal(text, 'Fallback commentary text.');
});

test('TEXT-003: commentary is used when voiceLine is an empty string', () => {
  const text = selectVoicedText({ voiceLine: '', commentary: 'Fallback commentary text.' });
  assert.equal(text, 'Fallback commentary text.');
});

test('TEXT-004: commentary is used when voiceLine is whitespace-only', () => {
  const text = selectVoicedText({ voiceLine: '   ', commentary: 'Fallback commentary text.' });
  assert.equal(text, 'Fallback commentary text.');
});

test('TEXT-005: leading/trailing whitespace is trimmed before hashing and voicing', async () => {
  const client = fakeClient();
  const store = new SqliteCommentaryAudioStore(':memory:');
  const entry = makeEntry({ voiceLine: '  Goal for the home side!  ' });
  // decorate: false -- this case is about selectVoicedText's trim behavior, not decoration.
  await generateCommentaryAudio({
    store, client, entries: [entry], voiceId: 'v1', speed: DEFAULT_SPEED, decorate: false,
  });
  assert.equal(client.calls[0].text, 'Goal for the home side!');
  const record = store.getAudio(entry.id);
  assert.equal(record.textHash, hashVoicedText('Goal for the home side!'));
  store.close();
});

test('TEXT-006: entries with empty voiced text are skipped, not sent to the client', async () => {
  const client = fakeClient();
  const store = new SqliteCommentaryAudioStore(':memory:');
  const emptyEntry = makeEntry({ id: 'empty', voiceLine: undefined, commentary: '   ' });
  const normalEntry = makeEntry({ id: 'normal', commentary: 'Real commentary.' });
  const summary = await generateCommentaryAudio({
    store, client, entries: [emptyEntry, normalEntry], voiceId: 'v1', speed: DEFAULT_SPEED, decorate: false,
  });
  assert.equal(client.callCount, 1);
  assert.equal(client.calls[0].text, 'Real commentary.');
  assert.equal(summary.emptySkipped, 1);
  assert.equal(store.getAudio('empty'), undefined);
  store.close();
});

// ---------------------------------------------------------------------------
// GEN
// ---------------------------------------------------------------------------

test('GEN-001: a brand-new entry is generated and stored', async () => {
  const client = fakeClient();
  const store = new SqliteCommentaryAudioStore(':memory:');
  const entry = makeEntry();
  const summary = await generateCommentaryAudio({ store, client, entries: [entry], voiceId: 'v1', speed: DEFAULT_SPEED });
  assert.equal(client.callCount, 1);
  assert.equal(client.calls[0].speed, DEFAULT_SPEED);
  assert.ok(store.getAudio(entry.id));
  assert.equal(store.getAudio(entry.id).speed, DEFAULT_SPEED);
  assert.deepEqual(summary, { generated: 1, regenerated: 0, skipped: 0, emptySkipped: 0, failed: [] });
  store.close();
});

test('GEN-002: idempotent re-run makes ZERO API calls', async () => {
  const client = fakeClient();
  const store = new SqliteCommentaryAudioStore(':memory:');
  const entries = Array.from({ length: 5 }, (_, i) => makeEntry({ id: `e${i}`, commentary: `Line ${i}` }));
  await generateCommentaryAudio({ store, client, entries, voiceId: 'v1', speed: DEFAULT_SPEED });
  client.resetCallCount();
  const secondRunBytes = entries.map((entry) => store.getAudio(entry.id).audio);
  const summary = await generateCommentaryAudio({ store, client, entries, voiceId: 'v1', speed: DEFAULT_SPEED });
  assert.equal(client.callCount, 0);
  assert.deepEqual(summary, { generated: 0, regenerated: 0, skipped: 5, emptySkipped: 0, failed: [] });
  entries.forEach((entry, i) => assert.deepEqual(store.getAudio(entry.id).audio, secondRunBytes[i]));
  store.close();
});

test('GEN-003: a text change on one entry regenerates only that entry', async () => {
  const client = fakeClient();
  const store = new SqliteCommentaryAudioStore(':memory:');
  const e1 = makeEntry({ id: 'e1', commentary: 'One.' });
  const e2 = makeEntry({ id: 'e2', commentary: 'Two.' });
  const e3 = makeEntry({ id: 'e3', commentary: 'Three.' });
  // decorate: false -- this case is about text-change regeneration, not decoration (covered by TAG-INTEGRATION-003).
  await generateCommentaryAudio({
    store, client, entries: [e1, e2, e3], voiceId: 'v1', speed: DEFAULT_SPEED, decorate: false,
  });
  const e1Before = store.getAudio('e1').audio;
  const e3Before = store.getAudio('e3').audio;

  client.resetCallCount();
  const e2Changed = makeEntry({ id: 'e2', voiceLine: undefined, commentary: 'Two but different now.' });
  const summary = await generateCommentaryAudio({
    store, client, entries: [e1, e2Changed, e3], voiceId: 'v1', speed: DEFAULT_SPEED, decorate: false,
  });

  assert.equal(client.callCount, 1);
  assert.equal(client.calls[0].text, 'Two but different now.');
  assert.equal(store.getAudio('e2').textHash, hashVoicedText('Two but different now.'));
  assert.deepEqual(store.getAudio('e1').audio, e1Before);
  assert.deepEqual(store.getAudio('e3').audio, e3Before);
  assert.deepEqual(summary, { generated: 0, regenerated: 1, skipped: 2, emptySkipped: 0, failed: [] });
  store.close();
});

test('GEN-004: a voiceId change regenerates all entries even when text is unchanged', async () => {
  const client = fakeClient();
  const store = new SqliteCommentaryAudioStore(':memory:');
  const entries = [makeEntry({ id: 'e1' }), makeEntry({ id: 'e2' })];
  await generateCommentaryAudio({ store, client, entries, voiceId: 'voice-a', speed: DEFAULT_SPEED });
  client.resetCallCount();
  const summary = await generateCommentaryAudio({ store, client, entries, voiceId: 'voice-b', speed: DEFAULT_SPEED });
  assert.equal(client.callCount, 2);
  assert.equal(store.getAudio('e1').voiceId, 'voice-b');
  assert.equal(store.getAudio('e2').voiceId, 'voice-b');
  assert.equal(summary.generated, 0);
  assert.equal(summary.regenerated, 2);
  assert.equal(summary.skipped, 0);
  store.close();
});

test('GEN-SPEED-001: a speed change regenerates all entries even when text and voice are unchanged', async () => {
  const client = fakeClient();
  const store = new SqliteCommentaryAudioStore(':memory:');
  const entries = [makeEntry({ id: 'e1' }), makeEntry({ id: 'e2' })];
  await generateCommentaryAudio({ store, client, entries, voiceId: 'v1', speed: 1.0 });
  client.resetCallCount();
  const summary = await generateCommentaryAudio({ store, client, entries, voiceId: 'v1', speed: 1.1 });
  assert.equal(client.callCount, 2);
  assert.equal(client.calls[0].speed, 1.1);
  assert.equal(store.getAudio('e1').speed, 1.1);
  assert.equal(store.getAudio('e2').speed, 1.1);
  assert.equal(summary.generated, 0);
  assert.equal(summary.regenerated, 2);
  assert.equal(summary.skipped, 0);
  store.close();
});

test('GEN-005: summary counts sum to total input entries', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const fresh = Array.from({ length: 6 }, (_, i) => makeEntry({ id: `fresh${i}`, commentary: `Fresh ${i}` }));
  const current = Array.from({ length: 2 }, (_, i) => makeEntry({ id: `current${i}`, commentary: `Current ${i}` }));
  const empty = makeEntry({ id: 'empty', voiceLine: undefined, commentary: '  ' });
  const willFail = makeEntry({ id: 'willfail', commentary: 'This will fail forever.' });

  // Pre-seed "current" entries so the second run treats them as already up to date.
  const seedClient = fakeClient();
  await generateCommentaryAudio({
    store, client: seedClient, entries: current, voiceId: 'v1', speed: DEFAULT_SPEED, decorate: false,
  });

  const client = fakeClient({
    synthesize: async (request) => {
      if (request.text === 'This will fail forever.') throw new TtsRequestError(400, 'bad request');
      return { audio: bytes(10), codec: 'mp3', sampleRate: 44100, bitRate: 128000 };
    },
  });
  const summary = await generateCommentaryAudio({
    store, client, entries: [...fresh, ...current, empty, willFail], voiceId: 'v1', speed: DEFAULT_SPEED, decorate: false,
  });

  assert.equal(summary.generated, 6);
  assert.equal(summary.regenerated, 0);
  assert.equal(summary.skipped, 2);
  assert.equal(summary.emptySkipped, 1);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].entryId, 'willfail');
  const total = summary.generated + summary.regenerated + summary.skipped + summary.emptySkipped + summary.failed.length;
  assert.equal(total, 10);
  store.close();
});

test('GEN-006: mixed batch of new, current, and changed entries are each classified correctly', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const seedClient = fakeClient();
  const e1 = makeEntry({ id: 'e1', commentary: 'Current text.' });
  const e2Original = makeEntry({ id: 'e2', commentary: 'Stale text.' });
  await generateCommentaryAudio({
    store, client: seedClient, entries: [e1, e2Original], voiceId: 'v1', speed: DEFAULT_SPEED,
  });

  const client = fakeClient();
  const e2Changed = makeEntry({ id: 'e2', commentary: 'Changed text.' });
  const e3 = makeEntry({ id: 'e3', commentary: 'Brand new text.' });
  const summary = await generateCommentaryAudio({
    store, client, entries: [e1, e2Changed, e3], voiceId: 'v1', speed: DEFAULT_SPEED,
  });

  assert.equal(client.callCount, 2);
  assert.deepEqual(summary, { generated: 1, regenerated: 1, skipped: 1, emptySkipped: 0, failed: [] });
  store.close();
});

test('GEN-007: onProgress callback fires per processed entry with a stable shape', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const seedClient = fakeClient();
  const toSkip = makeEntry({ id: 'skip', commentary: 'Already current.' });
  await generateCommentaryAudio({
    store, client: seedClient, entries: [toSkip], voiceId: 'v1', speed: DEFAULT_SPEED, decorate: false,
  });

  const client = fakeClient({
    synthesize: async (request) => {
      if (request.text === 'Will fail.') throw new TtsRequestError(400, 'bad');
      return { audio: bytes(10), codec: 'mp3', sampleRate: 44100, bitRate: 128000 };
    },
  });
  const events = [];
  await generateCommentaryAudio({
    store, client,
    entries: [makeEntry({ id: 'generate', commentary: 'Will succeed.' }), toSkip, makeEntry({ id: 'fail', commentary: 'Will fail.' })],
    voiceId: 'v1',
    speed: DEFAULT_SPEED,
    decorate: false,
    onProgress: (event) => events.push(event),
  });
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.ok(typeof event.entryId === 'string' && event.entryId.length > 0);
    assert.ok(['generated', 'regenerated', 'skipped', 'emptySkipped', 'failed'].includes(event.outcome));
  }
  store.close();
});

test('GEN-008: omitting onProgress does not throw', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const client = fakeClient();
  const summary = await generateCommentaryAudio({ store, client, entries: [makeEntry()], voiceId: 'v1', speed: DEFAULT_SPEED });
  assert.ok(summary);
  store.close();
});

// ---------------------------------------------------------------------------
// RETRY
// ---------------------------------------------------------------------------

function recordingSleep() {
  const calls = [];
  const sleep = async (ms) => {
    calls.push(ms);
  };
  sleep.calls = calls;
  return sleep;
}

test('RETRY-001: HTTP 429 is retried and eventually succeeds', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  let attempts = 0;
  const client = fakeClient({
    synthesize: async () => {
      attempts += 1;
      if (attempts === 1) throw new TtsRequestError(429, 'rate limited');
      return { audio: bytes(10), codec: 'mp3', sampleRate: 44100, bitRate: 128000 };
    },
  });
  const sleep = recordingSleep();
  const summary = await generateCommentaryAudio({
    store, client, entries: [makeEntry({ id: 'e1' })], voiceId: 'v1', speed: DEFAULT_SPEED, maxAttempts: 3, sleep,
  });
  assert.equal(client.callCount, 2);
  assert.equal(sleep.calls.length, 1);
  assert.ok(store.getAudio('e1'));
  assert.equal(summary.generated, 1);
  assert.equal(summary.failed.length, 0);
  store.close();
});

test('RETRY-002: HTTP 5xx is retried like 429', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  let attempts = 0;
  const client = fakeClient({
    synthesize: async () => {
      attempts += 1;
      if (attempts === 1) throw new TtsRequestError(500, 'server error');
      return { audio: bytes(10), codec: 'mp3', sampleRate: 44100, bitRate: 128000 };
    },
  });
  const summary = await generateCommentaryAudio({
    store, client, entries: [makeEntry({ id: 'e1' })], voiceId: 'v1', speed: DEFAULT_SPEED, maxAttempts: 3, sleep: recordingSleep(),
  });
  assert.equal(client.callCount, 2);
  assert.ok(store.getAudio('e1'));
  assert.equal(summary.failed.length, 0);
  store.close();
});

test('RETRY-003: retry exhaustion records the entry as failed and the batch continues', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const client = fakeClient({
    synthesize: async (request) => {
      if (request.text === 'e2 text') return { audio: bytes(10), codec: 'mp3', sampleRate: 44100, bitRate: 128000 };
      throw new TtsRequestError(503, 'unavailable');
    },
  });
  const summary = await generateCommentaryAudio({
    store, client,
    entries: [makeEntry({ id: 'e1', commentary: 'e1 text' }), makeEntry({ id: 'e2', commentary: 'e2 text' })],
    voiceId: 'v1', speed: DEFAULT_SPEED, maxAttempts: 3, sleep: recordingSleep(), concurrency: 1, decorate: false,
  });
  const e1Calls = client.calls.filter((call) => call.text === 'e1 text').length;
  assert.equal(e1Calls, 3);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].entryId, 'e1');
  assert.ok(summary.failed[0].message.length > 0);
  assert.equal(store.getAudio('e1'), undefined);
  assert.ok(store.getAudio('e2'));
  store.close();
});

test('RETRY-004: non-retryable 4xx fails immediately without retry', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const client = fakeClient({
    synthesize: async (request) => {
      if (request.text === 'e1 text') throw new TtsRequestError(400, 'bad request');
      return { audio: bytes(10), codec: 'mp3', sampleRate: 44100, bitRate: 128000 };
    },
  });
  const sleep = recordingSleep();
  const summary = await generateCommentaryAudio({
    store, client,
    entries: [makeEntry({ id: 'e1', commentary: 'e1 text' }), makeEntry({ id: 'e2', commentary: 'e2 text' })],
    voiceId: 'v1', speed: DEFAULT_SPEED, maxAttempts: 5, sleep, concurrency: 1, decorate: false,
  });
  const e1Calls = client.calls.filter((call) => call.text === 'e1 text').length;
  assert.equal(e1Calls, 1);
  assert.equal(sleep.calls.length, 0);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].entryId, 'e1');
  assert.ok(store.getAudio('e2'));
  store.close();
});

test('RETRY-005: backoff delay is applied via the injected sleep function, not real timers', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  let attempts = 0;
  const client = fakeClient({
    synthesize: async () => {
      attempts += 1;
      if (attempts <= 2) throw new TtsRequestError(429, 'rate limited');
      return { audio: bytes(10), codec: 'mp3', sampleRate: 44100, bitRate: 128000 };
    },
  });
  const sleep = recordingSleep();
  const start = Date.now();
  await generateCommentaryAudio({
    store, client, entries: [makeEntry({ id: 'e1' })], voiceId: 'v1', speed: DEFAULT_SPEED, maxAttempts: 3, sleep,
  });
  const elapsed = Date.now() - start;
  assert.equal(sleep.calls.length, 2);
  assert.ok(sleep.calls[1] >= sleep.calls[0]);
  assert.ok(elapsed < 1000);
  store.close();
});

test('RETRY-006: one entry\'s terminal failure never aborts entries queued after it', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const client = fakeClient({
    synthesize: async (request) => {
      if (request.text === 'e1 text') throw new TtsRequestError(400, 'bad request');
      if (request.text === 'e2 text') throw new TtsRequestError(503, 'unavailable');
      return { audio: bytes(10), codec: 'mp3', sampleRate: 44100, bitRate: 128000 };
    },
  });
  const summary = await generateCommentaryAudio({
    store, client,
    entries: [
      makeEntry({ id: 'e1', commentary: 'e1 text' }),
      makeEntry({ id: 'e2', commentary: 'e2 text' }),
      makeEntry({ id: 'e3', commentary: 'e3 text' }),
    ],
    voiceId: 'v1', speed: DEFAULT_SPEED, maxAttempts: 3, sleep: recordingSleep(), concurrency: 1, decorate: false,
  });
  assert.ok(store.getAudio('e3'));
  assert.equal(summary.failed.length, 2);
  assert.deepEqual(summary.failed.map((failure) => failure.entryId).sort(), ['e1', 'e2']);
  assert.equal(summary.generated + summary.failed.length, 3);
  store.close();
});

// ---------------------------------------------------------------------------
// CONC
// ---------------------------------------------------------------------------

function inFlightTrackingClient() {
  let current = 0;
  let max = 0;
  return {
    get maxObservedInFlight() {
      return max;
    },
    async synthesize() {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolveMicrotask) => setTimeout(resolveMicrotask, 5));
      current -= 1;
      return { audio: bytes(10), codec: 'mp3', sampleRate: 44100, bitRate: 128000 };
    },
  };
}

test('CONC-001: default concurrency caps in-flight client calls at 4', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const client = inFlightTrackingClient();
  const entries = Array.from({ length: 10 }, (_, i) => makeEntry({ id: `e${i}`, commentary: `Line ${i}` }));
  await generateCommentaryAudio({ store, client, entries, voiceId: 'v1', speed: DEFAULT_SPEED });
  assert.ok(client.maxObservedInFlight <= 4);
  assert.equal(client.maxObservedInFlight, 4);
  store.close();
});

test('CONC-002: explicit concurrency override is respected', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const client = inFlightTrackingClient();
  const entries = Array.from({ length: 8 }, (_, i) => makeEntry({ id: `e${i}`, commentary: `Line ${i}` }));
  await generateCommentaryAudio({ store, client, entries, voiceId: 'v1', speed: DEFAULT_SPEED, concurrency: 2 });
  assert.ok(client.maxObservedInFlight <= 2);
  assert.equal(client.maxObservedInFlight, 2);
  store.close();
});

test('CONC-003: concurrency of 1 processes strictly serially', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const client = inFlightTrackingClient();
  const entries = Array.from({ length: 5 }, (_, i) => makeEntry({ id: `e${i}`, commentary: `Line ${i}` }));
  await generateCommentaryAudio({ store, client, entries, voiceId: 'v1', speed: DEFAULT_SPEED, concurrency: 1 });
  assert.equal(client.maxObservedInFlight, 1);
  store.close();
});

test('CONC-004: a slow/failing entry under concurrency does not stall or skip sibling entries', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  let e2Attempts = 0;
  const client = {
    async synthesize(request) {
      if (request.text === 'e2 text') {
        e2Attempts += 1;
        if (e2Attempts <= 3) throw new TtsRequestError(429, 'rate limited');
      }
      await new Promise((resolveMicrotask) => setTimeout(resolveMicrotask, 1));
      return { audio: bytes(10), codec: 'mp3', sampleRate: 44100, bitRate: 128000 };
    },
  };
  const entries = ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => makeEntry({ id, commentary: `${id} text` }));
  const summary = await generateCommentaryAudio({
    store, client, entries, voiceId: 'v1', speed: DEFAULT_SPEED, concurrency: 3, maxAttempts: 5,
    sleep: recordingSleep(), decorate: false,
  });
  assert.equal(summary.generated, 5);
  assert.equal(summary.failed.length, 0);
  for (const entry of entries) assert.ok(store.getAudio(entry.id));
  store.close();
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI-001: missing --fixture argument is rejected', () => {
  assert.throws(() => parseArgs(['--voice=v1']), /--fixture/);
});

test('CLI-002: missing --voice argument is rejected', () => {
  assert.throws(() => parseArgs(['--fixture=18179759']), /--voice/);
});

test('CLI-003: both --fixture and --voice missing is rejected with a combined/clear message', () => {
  assert.throws(() => parseArgs([]), (error) => {
    assert.ok(error.message.includes('--fixture'));
    assert.ok(error.message.includes('--voice'));
    assert.ok(error.message.includes('Usage'));
    return true;
  });
});

test('CLI-004: valid --fixture and --voice runs the orchestrator and prints a summary', async () => {
  const args = parseArgs(['--fixture=18179759', '--voice=voice-1']);
  assert.equal(args.speed, DEFAULT_SPEED);
  const fakeCommentaryStore = {
    async listEntries() {
      return [makeEntry({ id: 'e1', commentary: 'One.' }), makeEntry({ id: 'e2', commentary: 'Two.' })];
    },
  };
  const audioStore = new SqliteCommentaryAudioStore(':memory:');
  const client = fakeClient();
  const result = await runCommentaryTtsCli(args, { commentaryStore: fakeCommentaryStore, audioStore, client });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.generated, 2);
  assert.equal(client.callCount, 2);
  assert.equal(client.calls[0].speed, DEFAULT_SPEED);
  audioStore.close();
});

test('CLI-005: exit code is 0 even when some entries fail', async () => {
  const args = parseArgs(['--fixture=f1', '--voice=v1', '--no-decorate']);
  const fakeCommentaryStore = {
    async listEntries() {
      return [
        makeEntry({ id: 'e1', commentary: 'Will fail.' }),
        makeEntry({ id: 'e2', commentary: 'Ok two.' }),
        makeEntry({ id: 'e3', commentary: 'Ok three.' }),
      ];
    },
  };
  const audioStore = new SqliteCommentaryAudioStore(':memory:');
  const client = fakeClient({
    synthesize: async (request) => {
      if (request.text === 'Will fail.') throw new TtsRequestError(400, 'bad');
      return { audio: bytes(10), codec: 'mp3', sampleRate: 44100, bitRate: 128000 };
    },
  });
  const result = await runCommentaryTtsCli(args, { commentaryStore: fakeCommentaryStore, audioStore, client });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.failed.length, 1);
  assert.equal(result.summary.failed[0].message.length > 0, true);
  audioStore.close();
});

test('CLI-006: exit code is non-zero when zero entries are found for the fixture', async () => {
  const args = parseArgs(['--fixture=f1', '--voice=v1']);
  const fakeCommentaryStore = { async listEntries() { return []; } };
  const audioStore = new SqliteCommentaryAudioStore(':memory:');
  const result = await runCommentaryTtsCli(args, { commentaryStore: fakeCommentaryStore, audioStore, client: fakeClient() });
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.message.includes('No commentary entries found'));
  audioStore.close();
});

test('CLI-UNTIL-MINUTE-001: --until-minute must be a positive integer', () => {
  assert.throws(() => parseArgs(['--fixture=f1', '--voice=v1', '--until-minute=0']), /--until-minute/);
  assert.throws(() => parseArgs(['--fixture=f1', '--voice=v1', '--until-minute=abc']), /--until-minute/);
  assert.throws(() => parseArgs(['--fixture=f1', '--voice=v1', '--until-minute=-3']), /--until-minute/);
  const parsed = parseArgs(['--fixture=f1', '--voice=v1', '--until-minute=10']);
  assert.equal(parsed.untilMinute, 10);
});

test('CLI-UNTIL-MINUTE-002: filters entries to clock minute <= n, excluding clockless entries when set', () => {
  const withinRange = makeEntry({ id: 'e1', clock: { seconds: 300, minute: 5, label: "5'" } });
  const outOfRange = makeEntry({ id: 'e2', clock: { seconds: 900, minute: 15, label: "15'" } });
  const noClockMinute = makeEntry({ id: 'e3', clock: { label: 'HT' } });
  const filtered = filterEntriesUntilMinute([withinRange, outOfRange, noClockMinute], 10);
  assert.deepEqual(filtered.map((entry) => entry.id), ['e1']);

  const unfiltered = filterEntriesUntilMinute([withinRange, outOfRange, noClockMinute], undefined);
  assert.equal(unfiltered.length, 3);
});

test('CLI-UNTIL-MINUTE-003: deriveClockMinute prefers numeric minute, then seconds, then label digits', () => {
  assert.equal(deriveClockMinute({ minute: 7, seconds: 999, label: "20'" }), 7);
  assert.equal(deriveClockMinute({ seconds: 125, label: "20'" }), 2);
  assert.equal(deriveClockMinute({ label: "45+2'" }), 45);
  assert.equal(deriveClockMinute({ label: 'HT' }), undefined);
  assert.equal(deriveClockMinute(undefined), undefined);
});

test('CLI-UNTIL-MINUTE-004: runCommentaryTtsCli only voices entries up to --until-minute', async () => {
  const args = parseArgs(['--fixture=f1', '--voice=v1', '--until-minute=10', '--no-decorate']);
  const fakeCommentaryStore = {
    async listEntries() {
      return [
        makeEntry({ id: 'early', clock: { minute: 3, label: "3'" }, commentary: 'Early.' }),
        makeEntry({ id: 'late', clock: { minute: 40, label: "40'" }, commentary: 'Late.' }),
      ];
    },
  };
  const audioStore = new SqliteCommentaryAudioStore(':memory:');
  const client = fakeClient();
  const result = await runCommentaryTtsCli(args, { commentaryStore: fakeCommentaryStore, audioStore, client });
  assert.equal(result.exitCode, 0);
  assert.equal(result.entryCount, 1);
  assert.equal(client.callCount, 1);
  assert.equal(client.calls[0].text, 'Early.');
  audioStore.close();
});

test('CLI-SPEED-001: --speed rejects values below 0.7 and above 1.5', () => {
  assert.throws(() => parseArgs(['--fixture=f1', '--voice=v1', '--speed=0.6']), /--speed/);
  assert.throws(() => parseArgs(['--fixture=f1', '--voice=v1', '--speed=1.6']), /--speed/);
});

test('CLI-SPEED-002: --speed accepts values within 0.7-1.5 inclusive, including the atlas default of 1.1', () => {
  assert.equal(parseArgs(['--fixture=f1', '--voice=v1', '--speed=0.7']).speed, 0.7);
  assert.equal(parseArgs(['--fixture=f1', '--voice=v1', '--speed=1.5']).speed, 1.5);
  assert.equal(parseArgs(['--fixture=f1', '--voice=v1', '--speed=1.1']).speed, 1.1);
});

test('CLI-SPEED-003: --speed defaults to 1.0 when omitted', () => {
  const parsed = parseArgs(['--fixture=f1', '--voice=v1']);
  assert.equal(parsed.speed, 1.0);
});

test('CLI-SPEED-004: --speed rejects non-numeric input', () => {
  assert.throws(() => parseArgs(['--fixture=f1', '--voice=v1', '--speed=fast']), /--speed/);
});

test('CLI-SPEED-005: runCommentaryTtsCli passes --speed through to the orchestrator and store', async () => {
  const args = parseArgs(['--fixture=f1', '--voice=v1', '--speed=1.1']);
  const fakeCommentaryStore = {
    async listEntries() {
      return [makeEntry({ id: 'e1', commentary: 'One.' })];
    },
  };
  const audioStore = new SqliteCommentaryAudioStore(':memory:');
  const client = fakeClient();
  await runCommentaryTtsCli(args, { commentaryStore: fakeCommentaryStore, audioStore, client });
  assert.equal(client.calls[0].speed, 1.1);
  assert.equal(audioStore.getAudio('e1').speed, 1.1);
  audioStore.close();
});

// ---------------------------------------------------------------------------
// ROUTE
// ---------------------------------------------------------------------------

function appWithFakeStore(overrides = {}) {
  const app = new Hono();
  app.route('/', createCommentaryAudioRoutes({
    listManifest: async () => [],
    getAudio: async () => undefined,
    ...overrides,
  }));
  return app;
}

test('ROUTE-001: GET manifest returns 200 with correct JSON shape', async () => {
  const app = appWithFakeStore({
    listManifest: async (fixtureId) => (fixtureId === 'f1'
      ? [{ entryId: 'e1', voiceId: 'v1', speed: 1.1, textHash: 'h1', byteLength: 1234 }]
      : []),
  });
  const response = await app.request('/matches/f1/pulse/commentary/audio');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    fixtureId: 'f1',
    entries: [{ entryId: 'e1', voiceId: 'v1', speed: 1.1, textHash: 'h1', byteLength: 1234 }],
  });
  assert.equal('audio' in body.entries[0], false);
});

test('ROUTE-002: GET manifest for a fixture with no audio returns 200 with an empty entries array', async () => {
  const app = appWithFakeStore({ listManifest: async () => [] });
  const response = await app.request('/matches/f-empty/pulse/commentary/audio');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { fixtureId: 'f-empty', entries: [] });
});

test('ROUTE-003: GET single audio file returns 200 with mp3 bytes and correct headers', async () => {
  const app = appWithFakeStore({
    getAudio: async (entryId) => (entryId === 'e1'
      ? {
          entryId: 'e1', fixtureId: 'f1', textHash: 'h1', voiceId: 'v1', speed: 1.1, byteLength: 3,
          audio: new Uint8Array([1, 2, 3]), sourceText: 'x', codec: 'mp3', sampleRate: 44100, bitRate: 128000,
          createdAt: 'now', updatedAt: 'now',
        }
      : undefined),
  });
  const response = await app.request('/matches/f1/pulse/commentary/audio/e1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  const buffer = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...buffer], [1, 2, 3]);
  const cacheControl = response.headers.get('cache-control');
  assert.ok(cacheControl && /max-age=\d+/.test(cacheControl));
  assert.ok(response.headers.get('etag'));
});

test('ROUTE-004: ETag is derived from textHash + voiceId + speed (stable, changes when any change)', async () => {
  let textHash = 'h1';
  let speed = 1.1;
  const app = appWithFakeStore({
    getAudio: async (entryId) => (entryId === 'e1'
      ? {
          entryId: 'e1', fixtureId: 'f1', textHash, voiceId: 'v1', speed, byteLength: 3,
          audio: new Uint8Array([1, 2, 3]), sourceText: 'x', codec: 'mp3', sampleRate: 44100, bitRate: 128000,
          createdAt: 'now', updatedAt: 'now',
        }
      : undefined),
  });
  const first = await app.request('/matches/f1/pulse/commentary/audio/e1');
  const second = await app.request('/matches/f1/pulse/commentary/audio/e1');
  assert.equal(first.headers.get('etag'), second.headers.get('etag'));

  textHash = 'h2-changed';
  const third = await app.request('/matches/f1/pulse/commentary/audio/e1');
  assert.notEqual(third.headers.get('etag'), first.headers.get('etag'));

  textHash = 'h1';
  speed = 1.3;
  const fourth = await app.request('/matches/f1/pulse/commentary/audio/e1');
  assert.notEqual(fourth.headers.get('etag'), first.headers.get('etag'));
});

test('ROUTE-005: GET single audio for an unknown entryId returns 404', async () => {
  const app = appWithFakeStore({ getAudio: async () => undefined });
  const response = await app.request('/matches/f1/pulse/commentary/audio/does-not-exist');
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.ok(body.error);
});

test('ROUTE-006: GET single audio for an entryId belonging to a different fixture returns 404', async () => {
  const app = appWithFakeStore({
    getAudio: async () => ({
      entryId: 'e1', fixtureId: 'f2', textHash: 'h1', voiceId: 'v1', speed: 1.1, byteLength: 3,
      audio: new Uint8Array([1, 2, 3]), sourceText: 'x', codec: 'mp3', sampleRate: 44100, bitRate: 128000,
      createdAt: 'now', updatedAt: 'now',
    }),
  });
  const response = await app.request('/matches/f1/pulse/commentary/audio/e1');
  assert.equal(response.status, 404);
});

test('ROUTE-007: manifest route for an entirely unknown fixtureId still returns 200 with empty entries', async () => {
  const app = appWithFakeStore({ listManifest: async () => [] });
  const response = await app.request('/matches/nonexistent-fixture-id/pulse/commentary/audio');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { fixtureId: 'nonexistent-fixture-id', entries: [] });
});

test('ROUTE-008: single-audio route rejects a path-traversal-shaped entryId safely', async () => {
  const app = appWithFakeStore({ getAudio: async () => undefined });
  const response = await app.request('/matches/f1/pulse/commentary/audio/..%2f..%2fetc%2fpasswd');
  assert.equal(response.status, 404);
});

// ---------------------------------------------------------------------------
// TAG -- decorate-commentary-text.ts
// ---------------------------------------------------------------------------

test('TAG-001: goal entries get a [breath] prefix and the last sentence wrapped in <emphasis>', () => {
  const entry = makeEntry({
    id: 'g1', kind: 'goal', commentary: "Anthony Gordon scores! It's 1-0 to England!",
  });
  const decorated = decorateCommentaryTimeline([entry]);
  assert.equal(decorated.get('g1'), "[breath] Anthony Gordon scores! <emphasis>It's 1-0 to England!</emphasis>");
});

test('TAG-002: a single-sentence goal line wraps the whole line in <emphasis>', () => {
  const entry = makeEntry({ id: 'g1', kind: 'goal', commentary: 'What a goal' });
  const decorated = decorateCommentaryTimeline([entry]);
  assert.equal(decorated.get('g1'), '[breath] <emphasis>What a goal</emphasis>');
});

test('TAG-003: a three-sentence goal line only wraps the last sentence, keeping the rest as the [breath] head', () => {
  const entry = makeEntry({
    id: 'g1', kind: 'goal', commentary: 'He shoots. He scores! Unbelievable scenes!',
  });
  const decorated = decorateCommentaryTimeline([entry]);
  assert.equal(decorated.get('g1'), '[breath] He shoots. He scores! <emphasis>Unbelievable scenes!</emphasis>');
});

test('TAG-004: the two entries immediately after a goal (replay order) are wrapped in <soft>', () => {
  const goal = makeEntry({ id: 'g', kind: 'goal', commentary: 'Goal! Great strike!' });
  const after1 = makeEntry({ id: 'a1', kind: 'danger', commentary: 'The crowd goes wild.' });
  const after2 = makeEntry({ id: 'a2', kind: 'pressure', commentary: 'What a moment.' });
  const after3 = makeEntry({ id: 'a3', kind: 'shot', commentary: 'Back to normal now.' });
  const decorated = decorateCommentaryTimeline([goal, after1, after2, after3]);
  assert.equal(decorated.get('a1'), '<soft>The crowd goes wild.</soft>');
  assert.equal(decorated.get('a2'), '<soft>What a moment.</soft>');
  // Exactly two entries get the soft window -- the third is back to normal (unchanged, since its
  // kind is 'shot' which has no rule of its own).
  assert.equal(decorated.get('a3'), 'Back to normal now.');
});

test('TAG-005: var entries get a [pause] prefix', () => {
  const entry = makeEntry({ id: 'v1', kind: 'var', commentary: 'VAR check underway.' });
  const decorated = decorateCommentaryTimeline([entry]);
  assert.equal(decorated.get('v1'), '[pause] VAR check underway.');
});

test('TAG-006: card entries get a [pause] prefix', () => {
  const entry = makeEntry({ id: 'c1', kind: 'card', commentary: 'Yellow card shown.' });
  const decorated = decorateCommentaryTimeline([entry]);
  assert.equal(decorated.get('c1'), '[pause] Yellow card shown.');
});

test('TAG-007: phase_change entries are wrapped in <soft>', () => {
  const entry = makeEntry({ id: 'p1', kind: 'phase_change', commentary: 'Half time.' });
  const decorated = decorateCommentaryTimeline([entry]);
  assert.equal(decorated.get('p1'), '<soft>Half time.</soft>');
});

test('TAG-008: entries of an unlisted kind are left unchanged by default', () => {
  const entry = makeEntry({ id: 's1', kind: 'shot', commentary: 'Wide of the post.' });
  const decorated = decorateCommentaryTimeline([entry]);
  assert.equal(decorated.get('s1'), 'Wide of the post.');
});

test('TAG-009: a line that already contains "<" or "[" is returned unchanged (never double-decorated)', () => {
  const alreadyBracketed = makeEntry({ id: 'g1', kind: 'goal', commentary: 'Goal! [breath] already tagged' });
  const alreadyAngled = makeEntry({ id: 'p1', kind: 'phase_change', commentary: '<soft>already soft</soft>' });
  const decorated = decorateCommentaryTimeline([alreadyBracketed, alreadyAngled]);
  assert.equal(decorated.get('g1'), 'Goal! [breath] already tagged');
  assert.equal(decorated.get('p1'), '<soft>already soft</soft>');
});

test('TAG-010: a goal inside another goal\'s post-goal soft window still gets the goal treatment (goal wins)', () => {
  const goal1 = makeEntry({ id: 'g1', kind: 'goal', commentary: 'Goal! Great strike!' });
  const after1 = makeEntry({ id: 'a1', kind: 'danger', commentary: 'The crowd goes wild.' });
  const goal2 = makeEntry({ id: 'g2', kind: 'goal', commentary: 'Another one! Unbelievable scenes!' });
  const decorated = decorateCommentaryTimeline([goal1, after1, goal2]);
  assert.equal(decorated.get('a1'), '<soft>The crowd goes wild.</soft>');
  assert.equal(decorated.get('g2'), '[breath] Another one! <emphasis>Unbelievable scenes!</emphasis>');
});

test('TAG-011: back-to-back goals each start a fresh post-goal window', () => {
  const goal1 = makeEntry({ id: 'g1', kind: 'goal', commentary: 'First goal! Great strike!' });
  const goal2 = makeEntry({ id: 'g2', kind: 'goal', commentary: 'Second goal! Instant reply!' });
  const after1 = makeEntry({ id: 'a1', kind: 'danger', commentary: 'The crowd erupts.' });
  const after2 = makeEntry({ id: 'a2', kind: 'pressure', commentary: 'Chaos on the pitch.' });
  const after3 = makeEntry({ id: 'a3', kind: 'shot', commentary: 'Play resumes.' });
  const decorated = decorateCommentaryTimeline([goal1, goal2, after1, after2, after3]);
  assert.equal(decorated.get('a1'), '<soft>The crowd erupts.</soft>');
  assert.equal(decorated.get('a2'), '<soft>Chaos on the pitch.</soft>');
  assert.equal(decorated.get('a3'), 'Play resumes.');
});

test('TAG-012: decoration reads voiceLine over commentary, same selection rule as the orchestrator', () => {
  const entry = makeEntry({
    id: 'g1', kind: 'goal', voiceLine: 'Short goal line!', commentary: 'Long form commentary that differs.',
  });
  const decorated = decorateCommentaryTimeline([entry]);
  assert.equal(decorated.get('g1'), '[breath] <emphasis>Short goal line!</emphasis>');
});

test('TAG-013: an empty voiced entry decorates to an empty string (still handled as emptySkipped downstream)', () => {
  const entry = makeEntry({ id: 'e1', kind: 'goal', voiceLine: undefined, commentary: '   ' });
  const decorated = decorateCommentaryTimeline([entry]);
  assert.equal(decorated.get('e1'), '');
});

// ---------------------------------------------------------------------------
// TAG integration -- generateCommentaryAudio applies decoration before hash/synthesize
// ---------------------------------------------------------------------------

test('TAG-INTEGRATION-001: the orchestrator decorates text before synthesizing and stores the decorated source_text', async () => {
  const client = fakeClient();
  const store = new SqliteCommentaryAudioStore(':memory:');
  const goal = makeEntry({ id: 'g1', kind: 'goal', commentary: 'Goal! What a strike!' });
  await generateCommentaryAudio({ store, client, entries: [goal], voiceId: 'v1', speed: DEFAULT_SPEED });

  const expectedDecorated = '[breath] Goal! <emphasis>What a strike!</emphasis>';
  assert.equal(client.calls[0].text, expectedDecorated);
  const record = store.getAudio('g1');
  assert.equal(record.sourceText, expectedDecorated);
  assert.equal(record.textHash, hashVoicedText(expectedDecorated));
  store.close();
});

test('TAG-INTEGRATION-002: decorate: false voices the raw selected text with no tags applied', async () => {
  const client = fakeClient();
  const store = new SqliteCommentaryAudioStore(':memory:');
  const goal = makeEntry({ id: 'g1', kind: 'goal', commentary: 'Goal! What a strike!' });
  await generateCommentaryAudio({
    store, client, entries: [goal], voiceId: 'v1', speed: DEFAULT_SPEED, decorate: false,
  });
  assert.equal(client.calls[0].text, 'Goal! What a strike!');
  assert.equal(store.getAudio('g1').sourceText, 'Goal! What a strike!');
  store.close();
});

test('TAG-INTEGRATION-003: toggling decorate from off to on regenerates only the entries whose decorated text changed', async () => {
  const store = new SqliteCommentaryAudioStore(':memory:');
  const goal = makeEntry({ id: 'g1', kind: 'goal', commentary: 'Goal! What a strike!' });
  // Two buffer entries absorb the post-goal <soft> window so 'plain' (4th in replay order) is
  // far enough from the goal to have no decoration rule apply -- isolating the goal-only change.
  const buffer1 = makeEntry({ id: 'b1', kind: 'danger', commentary: 'The crowd roars.' });
  const buffer2 = makeEntry({ id: 'b2', kind: 'pressure', commentary: 'Still celebrating.' });
  const plain = makeEntry({ id: 's1', kind: 'shot', commentary: 'Wide of the post.' });
  const timeline = [goal, buffer1, buffer2, plain];

  const firstClient = fakeClient();
  await generateCommentaryAudio({
    store, client: firstClient, entries: timeline, voiceId: 'v1', speed: DEFAULT_SPEED, decorate: false,
  });
  assert.equal(store.getAudio('g1').sourceText, 'Goal! What a strike!');
  assert.equal(store.getAudio('s1').sourceText, 'Wide of the post.');

  const secondClient = fakeClient();
  const summary = await generateCommentaryAudio({
    store, client: secondClient, entries: timeline, voiceId: 'v1', speed: DEFAULT_SPEED, decorate: true,
  });

  // Only the goal and the two buffer entries pick up decoration; 'plain' is outside the
  // post-goal window and 'shot' has no decoration rule of its own, so its text is unchanged.
  assert.equal(secondClient.callCount, 3);
  const calledTexts = secondClient.calls.map((call) => call.text).sort();
  assert.deepEqual(calledTexts, [
    '<soft>Still celebrating.</soft>',
    '<soft>The crowd roars.</soft>',
    '[breath] Goal! <emphasis>What a strike!</emphasis>',
  ]);
  assert.equal(summary.regenerated, 3);
  assert.equal(summary.skipped, 1);
  assert.equal(store.getAudio('g1').sourceText, '[breath] Goal! <emphasis>What a strike!</emphasis>');
  assert.equal(store.getAudio('s1').sourceText, 'Wide of the post.');
  store.close();
});

// ---------------------------------------------------------------------------
// hashVoicedText sanity (used across TEXT cases)
// ---------------------------------------------------------------------------

test('hashVoicedText matches sha256 hex of the voiced text', () => {
  const text = 'Goal for the home side!';
  const expected = createHash('sha256').update(text, 'utf8').digest('hex');
  assert.equal(hashVoicedText(text), expected);
});
