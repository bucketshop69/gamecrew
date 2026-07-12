import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { TxlineTransportError } from '@gamecrew/core';

import { FixtureIngestionSession } from '../src/ingestion/fixture-ingestion-session.ts';
import { IngestionSupervisor } from '../src/ingestion/ingestion-supervisor.ts';
import { MatchEngineProjector } from '../src/ingestion/match-engine-projector.ts';
import { SemanticFrameHub } from '../src/ingestion/semantic-frame-hub.ts';
import { SqliteIngestionStore } from '../src/ingestion/sqlite-ingestion-store.ts';

const context = {
  fixtureId: 99,
  participants: [
    { participant: 1, teamId: 1, name: 'One' },
    { participant: 2, teamId: 2, name: 'Two' },
  ],
  confirmedScore: { participant1: 0, participant2: 0 },
};

const record = (Seq, Action, extra = {}) => ({ FixtureId: 99, Seq, Id: Seq, Action, ...extra });
const quietStream = async function* (_fixtureId, { signal, onOpen }) {
  await onOpen?.();
  if (signal.aborted) return;
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
};

test('persists finalisation and keeps a bounded correction window open', async () => {
  const store = new SqliteIngestionStore(':memory:');
  const projector = new MatchEngineProjector(store, { now: () => new Date('2026-01-01T00:00:00Z') });
  const feed = {
    async fetchHistorical() {
      return [
        record(0, 'status', { StatusId: 5, Data: { StatusId: 5 } }),
        record(1, 'game_finalised', {
          Score: {
            Participant1: { Total: { Goals: 0 } },
            Participant2: { Total: { Goals: 0 } },
          },
        }),
      ];
    },
    async fetchSnapshot() { return []; },
    async fetchUpdates() { return []; },
    streamFixture: quietStream,
  };
  const session = new FixtureIngestionSession({
    fixtureId: '99', context, feed, store, projector, finalisationCorrectionWindowMs: 5,
  });
  await session.start();
  const cursor = await store.getCursor('99');
  const checkpoint = await store.getCheckpoint('99');
  assert.equal(cursor.lastSeenSeq, 1);
  assert.equal(checkpoint.state.phase, 'finalised');
  assert.equal((await store.listRawCandidates('99')).length, 2);
  assert.equal(session.isStopped(), false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.isStopped(), true);
  await session.stop();
  store.close();
});

test('ingests a correction delivered after game_finalised inside the correction window', async () => {
  const store = new SqliteIngestionStore(':memory:');
  const projector = new MatchEngineProjector(store);
  const feed = {
    async fetchHistorical() {
      return [
        record(0, 'status', { StatusId: 5, Data: { StatusId: 5 } }),
        record(1, 'game_finalised', {
          Score: {
            Participant1: { Total: { Goals: 0 } },
            Participant2: { Total: { Goals: 0 } },
          },
        }),
      ];
    },
    async fetchSnapshot() { return []; },
    async fetchUpdates() { return []; },
    async *streamFixture(_fixtureId, { signal, onOpen }) {
      await onOpen?.();
      yield {
        kind: 'score',
        score: record(2, 'yellow_card', { Confirmed: true, Participant: 1 }),
        message: { id: 'post-final-correction', data: '' },
        scoreIndex: 0,
        scoreCount: 1,
        isLastInMessage: true,
      };
      if (!signal.aborted) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      }
    },
  };
  const session = new FixtureIngestionSession({
    fixtureId: '99', context, feed, store, projector, finalisationCorrectionWindowMs: 1_000,
  });
  await session.start();
  assert.equal(session.isStopped(), false);
  assert.equal((await store.getCursor('99')).lastSeenSeq, 2);
  assert.equal((await store.listRawCandidates('99')).length, 3);
  await session.stop();
  store.close();
});

test('buffers a sequence gap and advances only after recovery supplies the missing row', async () => {
  const store = new SqliteIngestionStore(':memory:');
  const projectedThrough = [];
  const projector = {
    async project(_fixtureId, _context, options) {
      projectedThrough.push(options.throughSeq);
      return { replay: { state: { phase: 'first_half' } } };
    },
  };
  const feed = {
    async fetchHistorical() { return [record(0, 'coverage_update'), record(2, 'possession')]; },
    async fetchSnapshot() { return []; },
    async fetchUpdates() { return [record(1, 'status', { Data: { StatusId: 2 } })]; },
    streamFixture: quietStream,
  };
  const session = new FixtureIngestionSession({ fixtureId: '99', context, feed, store, projector });
  await session.start();
  assert.deepEqual(projectedThrough, [0, 2]);
  assert.equal((await store.getCursor('99')).lastSeenSeq, 2);
  assert.deepEqual((await store.listRawCandidates('99')).map(({ seq }) => seq), [0, 1, 2]);
  await session.stop();
  store.close();
});

test('retries a bootstrap gap even when the live stream stays quiet', async () => {
  const store = new SqliteIngestionStore(':memory:');
  let updateCalls = 0;
  const feed = {
    async fetchHistorical() { return [record(0, 'coverage_update'), record(2, 'possession')]; },
    async fetchSnapshot() { return []; },
    async fetchUpdates() {
      updateCalls += 1;
      return updateCalls >= 2 ? [record(1, 'status', { Data: { StatusId: 2 } })] : [];
    },
    streamFixture: quietStream,
  };
  const session = new FixtureIngestionSession({
    fixtureId: '99', context, feed, store, gapRecoveryDelayMs: 1,
    projector: {
      async project() { return { replay: { state: { phase: 'first_half' } } }; },
    },
  });
  await session.start();
  assert.equal(updateCalls >= 2, true);
  assert.equal((await store.getCursor('99')).lastSeenSeq, 2);
  await session.stop();
  store.close();
});

test('resumes the stream with the last durably stored event id', async () => {
  const store = new SqliteIngestionStore(':memory:');
  await store.saveCursor({ fixtureId: '99', lastSeenSeq: -1, lastEventId: 'event-221', updatedAt: 'now' });
  let receivedCursor;
  const feed = {
    async fetchHistorical() { return []; },
    async fetchSnapshot() { return []; },
    async fetchUpdates() { return []; },
    async *streamFixture(_fixtureId, options) {
      receivedCursor = options.lastEventId;
      await options.onOpen?.();
      if (options.signal.aborted) return;
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const session = new FixtureIngestionSession({
    fixtureId: '99', context, feed, store,
    projector: { async project() { throw new Error('no projection expected'); } },
  });
  await session.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(receivedCursor, 'event-221');
  await session.stop();
  store.close();
});

test('establishes a snapshot baseline without replaying overlapping timeline rows', async () => {
  const store = new SqliteIngestionStore(':memory:');
  const projector = new MatchEngineProjector(store);
  const snapshotRows = [
    record(19, 'goal', {
      Confirmed: true,
      Score: {
        Participant1: { Total: { Goals: 2 } },
        Participant2: { Total: { Goals: 1 } },
      },
    }),
    record(20, 'status', { StatusId: 4, Data: { StatusId: 4 }, Clock: { Running: true, Seconds: 4200 } }),
  ];
  const feed = {
    async fetchHistorical() { return []; },
    async fetchSnapshot() { return snapshotRows; },
    async fetchUpdates() { return [...snapshotRows, record(21, 'possession', { Participant: 1, Possession: 1 })]; },
    streamFixture: quietStream,
  };
  const session = new FixtureIngestionSession({
    fixtureId: '99',
    context: { ...context, phase: 'second_half', confirmedScore: { participant1: 2, participant2: 1 } },
    feed, store, projector,
  });
  await session.start();
  assert.equal((await store.listRawCandidates('99')).length, 3);
  assert.equal((await store.listRawCandidates('99')).find(({ seq }) => seq === 19).source, 'snapshot');
  assert.equal((await store.listRawCandidates('99')).find(({ seq }) => seq === 20).source, 'snapshot');
  assert.equal((await store.getCursor('99')).lastSeenSeq, 21);
  assert.equal((await store.getCursor('99')).sessionStatus, 'live');
  assert.equal((await store.getCursor('99')).timelineComplete, false);
  assert.equal((await store.getCursor('99')).timelineStartSeq, 20);
  const checkpoint = await store.getCheckpoint('99');
  assert.equal(checkpoint.lastAppliedSeq, 21);
  assert.equal(checkpoint.stateRevision, 1);
  assert.equal(checkpoint.state.phase, 'second_half');
  assert.deepEqual(checkpoint.state.confirmedScore, { participant1: 2, participant2: 1 });
  assert.equal((await store.listFramesAfter('99', 0)).length, 1);
  await session.stop();
  store.close();
});

test('promotes a snapshot baseline to a complete Seq 0 history and rebuilds from pre-match truth', async () => {
  const store = new SqliteIngestionStore(':memory:');
  const hub = new SemanticFrameHub(store);
  const snapshotRows = [
    record(19, 'goal', {
      Confirmed: true,
      Score: {
        Participant1: { Total: { Goals: 2 } },
        Participant2: { Total: { Goals: 1 } },
      },
    }),
    record(20, 'status', { StatusId: 4, Data: { StatusId: 4 }, Clock: { Running: true } }),
  ];
  const projectedContexts = [];
  const realProjector = new MatchEngineProjector(store, { publisher: hub });
  const projector = {
    async project(fixtureId, projectedContext, options) {
      projectedContexts.push(structuredClone(projectedContext));
      return realProjector.project(fixtureId, projectedContext, options);
    },
  };
  const baselineSession = new FixtureIngestionSession({
    fixtureId: '99', context, store, projector,
    feed: {
      async fetchHistorical() { return []; },
      async fetchSnapshot() { return snapshotRows; },
      async fetchUpdates() { return []; },
      streamFixture: quietStream,
    },
  });
  await baselineSession.start();
  await baselineSession.stop();
  assert.equal((await store.getCursor('99')).timelineComplete, false);
  assert.equal((await store.getCheckpoint('99')).projectionGeneration, 0);

  const generations = [];
  const received = [];
  const unsubscribe = await hub.subscribe('99', (frame, delivery) => {
    received.push([frame.stateRevision, delivery.projectionGeneration]);
  }, {
    afterRevision: 0,
    projectionGeneration: 0,
    onResyncRequired: (generation) => generations.push(generation),
  });

  const completeHistory = Array.from({ length: 21 }, (_, seq) => (
    snapshotRows.find((row) => row.Seq === seq) ?? record(seq, 'coverage_update')
  ));
  const completeSession = new FixtureIngestionSession({
    fixtureId: '99', context, store, projector,
    feed: {
      async fetchHistorical() { return completeHistory; },
      async fetchSnapshot() { return snapshotRows; },
      async fetchUpdates() { return []; },
      streamFixture: quietStream,
    },
  });
  await completeSession.start();

  const cursor = await store.getCursor('99');
  assert.equal(cursor.timelineComplete, true);
  assert.equal(cursor.timelineStartSeq, 0);
  assert.equal(cursor.lastSeenSeq, 20);
  const promotedContext = projectedContexts.at(-1);
  assert.equal(promotedContext.sequenceBefore, undefined);
  assert.deepEqual(promotedContext.confirmedScore, { participant1: 0, participant2: 0 });
  assert.equal(promotedContext.phase, 'pre_match');
  const raw = await store.listRawCandidates('99');
  assert.equal(raw.length, 21);
  assert.equal(raw.find(({ seq }) => seq === 19).source, 'historical');
  assert.equal(raw.find(({ seq }) => seq === 20).source, 'historical');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.getCheckpoint('99')).projectionGeneration, 1);
  assert.deepEqual(generations, [1]);
  assert.equal(received.length, 21);
  assert.equal(received.every(([, generation]) => generation === 1), true);
  unsubscribe();
  await completeSession.stop();
  store.close();
});

test('recovers a crash after complete history is staged but before baseline projection replacement', async () => {
  const store = new SqliteIngestionStore(':memory:');
  const projector = new MatchEngineProjector(store);
  const snapshotRows = [record(2, 'status', { StatusId: 2, Data: { StatusId: 2 } })];
  const baseline = new FixtureIngestionSession({
    fixtureId: '99', context, store, projector,
    feed: {
      async fetchHistorical() { return []; },
      async fetchSnapshot() { return snapshotRows; },
      async fetchUpdates() { return []; },
      streamFixture: quietStream,
    },
  });
  await baseline.start();
  await baseline.stop();
  const completeHistory = [record(0, 'coverage_update'), record(1, 'possession'), ...snapshotRows];
  const stagedAt = '2026-07-11T12:00:00.000Z';
  await store.promoteToCompleteTimeline('99', stagedAt, completeHistory.map((score) => {
    const payloadJson = JSON.stringify(score);
    return {
      fixtureId: '99',
      seq: score.Seq,
      payloadHash: createHash('sha256').update(payloadJson).digest('hex'),
      source: 'historical',
      receivedAt: stagedAt,
      payloadJson,
    };
  }));
  assert.equal((await store.getCheckpoint('99')).projectionGeneration, 0);
  assert.equal((await store.getCursor('99')).sessionStatus, 'promotion_pending');

  const unavailable = async () => { throw new Error('TxLINE offline'); };
  const recovered = new FixtureIngestionSession({
    fixtureId: '99', context, store, projector,
    feed: {
      fetchHistorical: unavailable,
      fetchSnapshot: unavailable,
      fetchUpdates: unavailable,
      streamFixture: quietStream,
    },
  });
  await recovered.start();
  assert.equal((await store.getCursor('99')).timelineComplete, true);
  assert.equal((await store.getCursor('99')).sessionStatus, 'live');
  assert.equal((await store.getCheckpoint('99')).projectionGeneration, 1);
  assert.equal((await store.listFramesAfter('99', 0)).length, 3);
  await recovered.stop();
  store.close();
});

test('polls after stream failure and retries SSE without losing the cursor', async () => {
  const store = new SqliteIngestionStore(':memory:');
  let streamAttempts = 0;
  let updateCalls = 0;
  const feed = {
    async fetchHistorical() { return []; },
    async fetchSnapshot() { return []; },
    async fetchUpdates() {
      updateCalls += 1;
      return updateCalls > 1 ? [record(0, 'coverage_update')] : [];
    },
    async *streamFixture(_fixtureId, { signal }) {
      streamAttempts += 1;
      if (streamAttempts === 1) throw new Error('stream down');
      if (signal.aborted) return;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const session = new FixtureIngestionSession({
    fixtureId: '99', context, feed, store, reconnectDelayMs: 1, streamReadyTimeoutMs: 1,
    projector: { async project() { return { replay: { state: { phase: 'pre_match' } } }; } },
  });
  await session.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(streamAttempts >= 2, true);
  assert.equal((await store.getCursor('99')).lastSeenSeq, 0);
  await session.stop();
  store.close();
});

test('actively polls to fill a gap while SSE remains connected', async () => {
  const store = new SqliteIngestionStore(':memory:');
  const projectedThrough = [];
  let updateCalls = 0;
  const feed = {
    async fetchHistorical() { return []; },
    async fetchSnapshot() { return []; },
    async fetchUpdates() {
      updateCalls += 1;
      return updateCalls > 1 ? [record(1, 'status', { Data: { StatusId: 2 } })] : [];
    },
    async *streamFixture(_fixtureId, { signal, onOpen }) {
      await onOpen?.();
      for (const seq of [0, 2]) {
        yield {
          kind: 'score', score: record(seq, seq === 0 ? 'coverage_update' : 'possession'),
          message: { id: `event-${seq}`, data: '' }, scoreIndex: 0, scoreCount: 1, isLastInMessage: true,
        };
      }
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const session = new FixtureIngestionSession({
    fixtureId: '99', context, feed, store,
    projector: {
      async project(_fixtureId, _context, options) {
        projectedThrough.push(options.throughSeq);
        return { replay: { state: { phase: 'first_half' } } };
      },
    },
  });
  await session.start();
  assert.equal((await store.getCursor('99')).lastSeenSeq, 2);
  assert.deepEqual((await store.listRawCandidates('99')).map(({ seq }) => seq), [0, 1, 2]);
  assert.equal(projectedThrough.includes(2), true);
  await session.stop();
  store.close();
});

test('retries unresolved gap recovery while SSE remains quiet', async () => {
  const store = new SqliteIngestionStore(':memory:');
  let updateCalls = 0;
  const feed = {
    async fetchHistorical() { return []; },
    async fetchSnapshot() { return []; },
    async fetchUpdates() {
      updateCalls += 1;
      return updateCalls >= 3 ? [record(1, 'status', { Data: { StatusId: 2 } })] : [];
    },
    async *streamFixture(_fixtureId, { signal, onOpen }) {
      await onOpen?.();
      yield {
        kind: 'score', score: record(0, 'coverage_update'),
        message: { id: 'event-0', data: '' }, scoreIndex: 0, scoreCount: 1, isLastInMessage: true,
      };
      yield {
        kind: 'score', score: record(2, 'possession'),
        message: { id: 'event-2', data: '' }, scoreIndex: 0, scoreCount: 1, isLastInMessage: true,
      };
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const session = new FixtureIngestionSession({
    fixtureId: '99', context, feed, store, gapRecoveryDelayMs: 1,
    projector: {
      async project() { return { replay: { state: { phase: 'first_half' } } }; },
    },
  });
  await session.start();
  assert.equal(updateCalls >= 3, true);
  assert.equal((await store.getCursor('99')).lastSeenSeq, 2);
  await session.stop();
  store.close();
});

test('falls back to updates when interval recovery repeats only the later sequence', async () => {
  const store = new SqliteIngestionStore(':memory:');
  let updateCalls = 0;
  let intervalCalls = 0;
  const timestamp = Date.parse('2026-07-11T10:12:00.000Z');
  const feed = {
    async fetchHistorical() { return []; },
    async fetchSnapshot() { return []; },
    async fetchUpdates() {
      updateCalls += 1;
      return updateCalls >= 2 ? [record(1, 'status', { Data: { StatusId: 2 }, Ts: timestamp })] : [];
    },
    async fetchInterval() {
      intervalCalls += 1;
      return [record(2, 'possession', { Ts: timestamp })];
    },
    async *streamFixture(_fixtureId, { signal, onOpen }) {
      await onOpen?.();
      yield {
        kind: 'score', score: record(0, 'coverage_update', { Ts: timestamp }),
        message: { id: 'event-0', data: '' }, scoreIndex: 0, scoreCount: 1, isLastInMessage: true,
      };
      yield {
        kind: 'score', score: record(2, 'possession', { Ts: timestamp }),
        message: { id: 'event-2', data: '' }, scoreIndex: 0, scoreCount: 1, isLastInMessage: true,
      };
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const session = new FixtureIngestionSession({
    fixtureId: '99', context, feed, store, gapRecoveryDelayMs: 1,
    projector: {
      async project() { return { replay: { state: { phase: 'first_half' } } }; },
    },
  });
  await session.start();
  assert.equal(intervalCalls >= 1, true);
  assert.equal(updateCalls >= 2, true);
  assert.equal((await store.getCursor('99')).lastSeenSeq, 2);
  assert.match((await store.getCursor('99')).lastBackfilledInterval, /^\d+\/10\/2$/);
  await session.stop();
  store.close();
});

test('clears a rejected Last-Event-ID only after polling recovery and reconnects', async () => {
  const store = new SqliteIngestionStore(':memory:');
  await store.saveCursor({ fixtureId: '99', lastSeenSeq: -1, lastEventId: 'expired-cursor', updatedAt: 'now' });
  const cursors = [];
  const feed = {
    async fetchHistorical() { return []; },
    async fetchSnapshot() { return []; },
    async fetchUpdates() { return []; },
    async *streamFixture(_fixtureId, { lastEventId, signal, onOpen }) {
      cursors.push(lastEventId);
      if (cursors.length === 1) {
        throw new TxlineTransportError('cursor rejected', { path: '/stream', status: 400 });
      }
      await onOpen?.();
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const session = new FixtureIngestionSession({
    fixtureId: '99', context, feed, store, reconnectDelayMs: 1, streamReadyTimeoutMs: 1,
    projector: { async project() { throw new Error('no projection expected'); } },
  });
  await session.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(cursors.slice(0, 2), ['expired-cursor', undefined]);
  await session.stop();
  store.close();
});

test('supervisor owns only one upstream session per fixture', async () => {
  let starts = 0;
  let stops = 0;
  const supervisor = new IngestionSupervisor(() => ({
    async start() { starts += 1; },
    async stop() { stops += 1; },
  }));
  const [first, second] = await Promise.all([supervisor.ensureFixture(99), supervisor.ensureFixture('99')]);
  assert.equal(first, second);
  assert.equal(starts, 1);
  assert.equal(supervisor.activeFixtureCount(), 1);
  await supervisor.stop();
  assert.equal(stops, 1);
});

test('supervisor replaces a session that has completed its correction window', async () => {
  let creations = 0;
  const sessions = [];
  const supervisor = new IngestionSupervisor(() => {
    creations += 1;
    const session = {
      stopped: false,
      async start() {},
      async stop() { this.stopped = true; },
      isStopped() { return this.stopped; },
    };
    sessions.push(session);
    return session;
  });
  const first = await supervisor.ensureFixture('99');
  first.stopped = true;
  const second = await supervisor.ensureFixture('99');
  assert.notEqual(first, second);
  assert.equal(creations, 2);
  await supervisor.stop();
});

test('recovers a raw-insert-before-checkpoint crash while TxLINE is unavailable', async () => {
  const store = new SqliteIngestionStore(':memory:');
  const raw = record(0, 'coverage_update');
  await store.appendRawCandidates([{
    fixtureId: '99', seq: 0, payloadHash: 'crash-hash', source: 'stream',
    receivedAt: 'now', payloadJson: JSON.stringify(raw),
  }]);
  const offline = async () => { throw new Error('offline'); };
  const feed = {
    fetchHistorical: offline, fetchSnapshot: offline, fetchUpdates: offline,
    async *streamFixture() { throw new Error('offline'); },
  };
  const projector = new MatchEngineProjector(store);
  const session = new FixtureIngestionSession({
    fixtureId: '99', context, feed, store, projector,
    reconnectDelayMs: 1, streamReadyTimeoutMs: 1,
  });
  await session.start();
  assert.equal((await store.getCursor('99')).lastSeenSeq, 0);
  assert.equal((await store.getCheckpoint('99')).lastAppliedSeq, 0);
  await session.stop();
  store.close();
});
