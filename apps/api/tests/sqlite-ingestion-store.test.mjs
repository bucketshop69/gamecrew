import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SqliteIngestionStore } from '../src/ingestion/sqlite-ingestion-store.ts';

const fixtureId = '18179759';
const receivedAt = '2026-07-11T10:00:00.000Z';

function state(overrides = {}) {
  return {
    fixtureId,
    lastAppliedSeq: 10,
    stateRevision: 2,
    phase: 'first_half',
    confirmedScore: { participant1: 1, participant2: 0 },
    possibleEvents: {},
    activePlayerIdsByParticipant: { '1': [], '2': [] },
    disciplineByPlayerId: {},
    incidents: {},
    supportedFacts: {},
    simulationCues: {},
    integrityWarnings: [],
    ...overrides,
  };
}

function frame(seq, stateRevision) {
  return {
    id: `${fixtureId}:${seq}`,
    fixtureId,
    seq,
    stateRevision,
    facts: [],
    simulationCues: [],
  };
}

test('raw append is idempotent, retains conflicts, and lists deterministically', async () => {
  const store = new SqliteIngestionStore(':memory:');
  try {
    const first = {
      fixtureId,
      seq: 2,
      payloadHash: 'hash-b',
      source: 'updates',
      eventId: 'event-2',
      sourceTimestamp: 2000,
      receivedAt,
      payloadJson: '{"Seq":2,"Action":"goal"}',
    };
    const result = await store.appendRawCandidates([
      first,
      first,
      {
        ...first,
        payloadHash: 'hash-a',
        payloadJson: '{"Seq":2,"Action":"shot"}',
      },
      {
        ...first,
        seq: 1,
        payloadHash: 'hash-c',
        eventId: undefined,
        payloadJson: '{"Seq":1,"Action":"possession"}',
      },
    ]);

    assert.deepEqual(result, {
      inserted: 3,
      unchanged: 1,
      conflictingSequences: [2],
    });

    const rows = await store.listRawCandidates(fixtureId);
    assert.deepEqual(rows.map((row) => [row.seq, row.payloadHash]), [
      [1, 'hash-c'],
      [2, 'hash-a'],
      [2, 'hash-b'],
    ]);
    assert.equal(rows[0].eventId, undefined);
    assert.equal(rows[2].eventId, 'event-2');
    assert.deepEqual((await store.listRawCandidates(fixtureId, 1)).map((row) => row.seq), [2, 2]);
    assert.deepEqual(await store.listFixtureIds(), [fixtureId]);
  } finally {
    store.close();
  }
});

test('cursor upsert round-trips nullable recovery metadata', async () => {
  const store = new SqliteIngestionStore(':memory:');
  try {
    assert.equal(await store.getCursor(fixtureId), undefined);
    await store.saveCursor({
      fixtureId,
      lastSeenSeq: 20,
      lastEventId: 'sse-20',
      lastBackfilledInterval: '2026-07-01T02:00Z',
      timelineStartSeq: 0,
      timelineComplete: true,
      sessionStatus: 'streaming',
      updatedAt: receivedAt,
    });
    await store.saveCursor({
      fixtureId,
      lastSeenSeq: 21,
      sessionStatus: 'recovering',
      lastError: 'connection reset',
      updatedAt: '2026-07-11T10:01:00.000Z',
    });

    assert.deepEqual(await store.getCursor(fixtureId), {
      fixtureId,
      lastSeenSeq: 21,
      lastEventId: 'sse-20',
      lastBackfilledInterval: '2026-07-01T02:00Z',
      timelineStartSeq: 0,
      timelineComplete: true,
      sessionStatus: 'recovering',
      lastError: 'connection reset',
      updatedAt: '2026-07-11T10:01:00.000Z',
    });
    assert.equal((await store.listCursors())[0].fixtureId, fixtureId);
  } finally {
    store.close();
  }
});

test('projection commit atomically upserts checkpoint cache and ordered frames', async () => {
  const store = new SqliteIngestionStore(':memory:');
  try {
    const checkpoint = {
      fixtureId,
      engineVersion: 'engine-v1',
      lastAppliedSeq: 10,
      stateRevision: 2,
      stateHash: 'state-hash-2',
      conflictHash: 'conflicts-2',
      projectionGeneration: 0,
      phase: 'first_half',
      state: state(),
      updatedAt: receivedAt,
    };
    await store.commitProjection({
      checkpoint,
      frames: [frame(9, 1), frame(10, 2)],
    });

    assert.deepEqual(await store.getCheckpoint(fixtureId, 'engine-v1'), checkpoint);
    assert.deepEqual(
      (await store.listFramesAfter(fixtureId, 1, 'engine-v1')).map((stored) => stored.frame),
      [frame(10, 2)],
    );

    const finalState = state({
      lastAppliedSeq: 10,
      stateRevision: 3,
      phase: 'finalised',
      finalScore: { participant1: 1, participant2: 0 },
    });
    const finalCheckpoint = {
      ...checkpoint,
      stateRevision: 3,
      stateHash: 'state-hash-3',
      phase: 'finalised',
      finalisedAt: '2026-07-11T10:02:00.000Z',
      state: finalState,
      updatedAt: '2026-07-11T10:02:00.000Z',
    };
    await store.commitProjection({
      checkpoint: finalCheckpoint,
      frames: [frame(10, 3)],
      expectedCheckpoint: {
        stateRevision: checkpoint.stateRevision,
        stateHash: checkpoint.stateHash,
        projectionGeneration: checkpoint.projectionGeneration,
      },
    });

    assert.deepEqual(await store.getCheckpoint(fixtureId), finalCheckpoint);
    const revisedFrames = await store.listFramesAfter(fixtureId, 2);
    assert.equal(revisedFrames.length, 1);
    assert.equal(revisedFrames[0].seq, 10);
    assert.equal(revisedFrames[0].stateRevision, 3);
    assert.deepEqual(revisedFrames[0].frame, frame(10, 3));
  } finally {
    store.close();
  }
});

test('cursor, raw ledger, checkpoint, and frames survive a filesystem close and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-ingestion-'));
  const path = join(directory, 'ingestion.sqlite');
  try {
    const first = new SqliteIngestionStore(path);
    await first.appendRawCandidates([{
      fixtureId,
      seq: 0,
      payloadHash: 'hash-0',
      source: 'historical',
      receivedAt,
      payloadJson: JSON.stringify({ FixtureId: Number(fixtureId), Seq: 0, Id: 0, Action: 'coverage_update' }),
    }]);
    await first.saveCursor({ fixtureId, lastSeenSeq: 0, lastEventId: 'event-0', updatedAt: receivedAt });
    await first.saveFixtureContext({
      fixtureId,
      participants: [
        { participant: 1, teamId: 10, name: 'Home FC', isHome: true },
        { participant: 2, teamId: 20, name: 'Away FC', isHome: false },
      ],
      updatedAt: receivedAt,
    });
    await first.commitProjection({
      checkpoint: {
        fixtureId, engineVersion: 'engine-v1', lastAppliedSeq: 0, stateRevision: 1,
        stateHash: 'durable-hash', conflictHash: 'no-conflicts', projectionGeneration: 0,
        phase: 'first_half', state: state({ lastAppliedSeq: 0, stateRevision: 1 }),
        updatedAt: receivedAt,
      },
      frames: [frame(0, 1)],
    });
    first.close();

    const reopened = new SqliteIngestionStore(path);
    assert.equal((await reopened.listRawCandidates(fixtureId)).length, 1);
    assert.equal((await reopened.getCursor(fixtureId)).lastEventId, 'event-0');
    assert.deepEqual((await reopened.getFixtureContext(fixtureId)).participants.map(({ name }) => name), ['Home FC', 'Away FC']);
    assert.equal((await reopened.getCheckpoint(fixtureId)).stateHash, 'durable-hash');
    assert.equal((await reopened.listFramesAfter(fixtureId, 0)).length, 1);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a stale checkpoint compare-and-swap without overwriting newer state', async () => {
  const store = new SqliteIngestionStore(':memory:');
  try {
    const first = {
      fixtureId, engineVersion: 'engine-v1', lastAppliedSeq: 1, stateRevision: 1,
      stateHash: 'hash-1', conflictHash: 'conflicts-1', projectionGeneration: 0,
      phase: 'first_half', state: state({ lastAppliedSeq: 1, stateRevision: 1 }), updatedAt: receivedAt,
    };
    await store.commitProjection({ checkpoint: first, frames: [] });
    const second = {
      ...first, lastAppliedSeq: 2, stateRevision: 2, stateHash: 'hash-2',
      state: state({ lastAppliedSeq: 2, stateRevision: 2 }), updatedAt: '2026-07-11T10:01:00.000Z',
    };
    await store.commitProjection({
      checkpoint: second,
      frames: [],
      expectedCheckpoint: { stateRevision: 1, stateHash: 'hash-1', projectionGeneration: 0 },
    });
    await assert.rejects(
      store.commitProjection({
        checkpoint: { ...first, stateHash: 'stale-write' },
        frames: [],
        expectedCheckpoint: { stateRevision: 1, stateHash: 'hash-1', projectionGeneration: 0 },
      }),
      /Stale match-engine projection/,
    );
    assert.equal((await store.getCheckpoint(fixtureId, 'engine-v1')).stateHash, 'hash-2');
  } finally {
    store.close();
  }
});
