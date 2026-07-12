import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MatchEngineProjector } from '../src/ingestion/match-engine-projector.ts';
import { SqliteIngestionStore } from '../src/ingestion/sqlite-ingestion-store.ts';

const fixture = JSON.parse(readFileSync(
  new URL('../../../packages/core/tests/fixtures/txline-18179759-lifecycle.json', import.meta.url),
  'utf8',
));

const players = Object.fromEntries(Object.entries(fixture.players).map(([id, player]) => [id, {
  normativeId: player.normativeId,
  participant: player.participant,
  teamId: player.teamId,
  sourcePreferredName: player.name,
  fixturePlayerId: player.fixturePlayerId,
  sourceId: player.sourcePlayerId,
  starter: player.starter,
  positionId: player.positionId,
  statusId: player.statusId,
  unitId: player.unitId,
  rosterNumber: player.rosterNumber,
  starred: player.starred,
  raw: player,
}]));
const context = {
  fixtureId: fixture.fixture.fixtureId,
  participants: fixture.fixture.participants,
  confirmedScore: { participant1: 0, participant2: 0 },
  players,
};

class MemoryProjectionStore {
  constructor(records) {
    this.candidates = records.map((record) => ({ record }));
    this.frames = new Map();
    this.checkpoint = undefined;
    this.commitCount = 0;
  }

  async listRawCandidates() {
    return this.candidates;
  }

  async getCheckpoint() {
    return this.checkpoint;
  }

  async commitProjection({ checkpoint, frames }) {
    this.commitCount += 1;
    const inserted = [];
    for (const frame of frames) {
      const key = `${frame.id}:${frame.stateRevision}`;
      if (!this.frames.has(key)) {
        this.frames.set(key, frame);
        inserted.push(frame);
      }
    }
    this.checkpoint = checkpoint;
  }

  async listFramesAfter(_fixtureId, afterRevision) {
    return [...this.frames.values()]
      .filter((frame) => frame.stateRevision > afterRevision)
      .map((frame) => ({ frame }));
  }
}

test('projects the persisted lifecycle ledger before publishing committed frames', async () => {
  const store = new MemoryProjectionStore(fixture.records);
  const publications = [];
  const projector = new MatchEngineProjector(store, {
    now: () => new Date('2026-07-11T00:00:00.000Z'),
    publisher: {
      publish(fixtureId, frames) {
        assert.ok(store.checkpoint, 'checkpoint must be durable before publish');
        assert.equal(store.frames.size, 164, 'frames must be durable before publish');
        publications.push({ fixtureId, frames });
      },
    },
  });

  const result = await projector.project(fixture.fixture.fixtureId, context);

  assert.equal(result.replay.ledger.length, 164);
  assert.equal(result.replay.frames.length, 164);
  assert.deepEqual(result.replay.ledger
    .filter((record) => record.Seq >= 772 && record.Seq <= 774)
    .map((record) => record.Seq), [772, 773, 774]);
  assert.equal(result.checkpoint.lastAppliedSeq, 885);
  assert.equal(result.checkpoint.stateRevision, 164);
  assert.equal(result.checkpoint.state.phase, 'finalised');
  assert.deepEqual(result.checkpoint.state.confirmedScore,
    { participant1: 2, participant2: 0 });
  assert.deepEqual(result.checkpoint.state.finalScore,
    { participant1: 2, participant2: 0 });
  assert.equal(result.committedFrames.length, 164);
  assert.equal(publications.length, 1);
  assert.equal(publications[0].fixtureId, '18179759');

  const goals = Object.values(result.checkpoint.state.incidents)
    .filter((incident) => incident.action === 'goal');
  assert.equal(goals.length, 2);
  assert.deepEqual(goals.map((goal) => goal.player?.sourcePreferredName), [
    'Quinones Quinones, Julian Andres',
    'Jimenez Rodriguez, Raul Alonso',
  ]);
});

test('restart over the same durable ledger is idempotent and publishes nothing', async () => {
  const store = new MemoryProjectionStore(fixture.records);
  const publications = [];
  const first = new MatchEngineProjector(store, {
    publisher: { publish: (_fixtureId, frames) => publications.push(frames) },
  });
  await first.project(fixture.fixture.fixtureId, context);

  const restarted = new MatchEngineProjector(store, {
    publisher: { publish: (_fixtureId, frames) => publications.push(frames) },
  });
  const result = await restarted.project(fixture.fixture.fixtureId, context);

  assert.equal(result.idempotent, true);
  assert.equal(result.committedFrames.length, 0);
  assert.equal(store.commitCount, 1);
  assert.equal(publications.length, 1);
});

test('forced empty replacement advances generation and publishes a reset', async () => {
  const store = new MemoryProjectionStore([]);
  const publications = [];
  const projector = new MatchEngineProjector(store, {
    publisher: {
      publish: (_fixtureId, frames, options) => publications.push({ frames, options }),
    },
  });
  await projector.project(fixture.fixture.fixtureId, context);
  const replacement = await projector.project(fixture.fixture.fixtureId, context, { forceReplace: true });
  assert.equal(replacement.checkpoint.projectionGeneration, 1);
  assert.equal(replacement.committedFrames.length, 0);
  assert.equal(publications.length, 1);
  assert.deepEqual(publications[0].frames, []);
  assert.equal(publications[0].options.replaceExisting, true);
  assert.equal(publications[0].options.projectionGeneration, 1);
});

test('does not publish when the atomic projection commit fails', async () => {
  const store = new MemoryProjectionStore(fixture.records.slice(0, 4));
  store.commitProjection = async () => {
    throw new Error('simulated sqlite failure');
  };
  let publishCount = 0;
  const projector = new MatchEngineProjector(store, {
    publisher: { publish: () => { publishCount += 1; } },
  });

  await assert.rejects(
    projector.project(fixture.fixture.fixtureId, context),
    /simulated sqlite failure/,
  );
  assert.equal(publishCount, 0);
});

test('projects through the shared SQLite ingestion-store contract', async () => {
  const store = new SqliteIngestionStore(':memory:');
  try {
    await store.appendRawCandidates(fixture.records.map((record) => {
      const payloadJson = JSON.stringify(record);
      return {
        fixtureId: String(fixture.fixture.fixtureId),
        seq: record.Seq,
        payloadHash: createHash('sha256').update(payloadJson).digest('hex'),
        source: 'historical',
        sourceTimestamp: record.Ts,
        receivedAt: '2026-07-11T00:00:00.000Z',
        payloadJson,
      };
    }));
    const projector = new MatchEngineProjector(store, {
      engineVersion: 'integration-v1',
      now: () => new Date('2026-07-11T00:00:00.000Z'),
    });

    const result = await projector.project(fixture.fixture.fixtureId, context);
    const checkpoint = await store.getCheckpoint('18179759', 'integration-v1');
    const storedFrames = await store.listFramesAfter('18179759', 0, 'integration-v1');

    assert.equal(result.committedFrames.length, 164);
    assert.equal(checkpoint?.stateHash, result.checkpoint.stateHash);
    assert.equal(checkpoint?.lastAppliedSeq, 885);
    assert.equal(storedFrames.length, 164);
  } finally {
    store.close();
  }
});

test('late same-sequence conflict replaces persisted frames and publishes a resync', async () => {
  const store = new SqliteIngestionStore(':memory:');
  const publications = [];
  try {
    const initial = fixture.records.slice(0, 31);
    await store.appendRawCandidates(initial.map((record) => {
      const payloadJson = JSON.stringify(record);
      return {
        fixtureId: String(fixture.fixture.fixtureId), seq: record.Seq,
        payloadHash: createHash('sha256').update(payloadJson).digest('hex'),
        source: 'historical', receivedAt: '2026-07-11T00:00:00.000Z', payloadJson,
      };
    }));
    const projector = new MatchEngineProjector(store, {
      engineVersion: 'conflict-v1',
      publisher: { publish: (_fixtureId, frames, options) => publications.push({ frames, options }) },
    });
    await projector.project(fixture.fixture.fixtureId, context);
    assert.equal(publications.at(-1).options.projectionGeneration, 0);
    const conflict = { ...initial.find(({ Seq }) => Seq === 25), Action: 'aaa_conflict' };
    const payloadJson = JSON.stringify(conflict);
    await store.appendRawCandidates([{
      fixtureId: String(fixture.fixture.fixtureId), seq: 25,
      payloadHash: createHash('sha256').update(payloadJson).digest('hex'),
      source: 'stream', receivedAt: '2026-07-11T00:01:00.000Z', payloadJson,
    }]);

    const corrected = await projector.project(fixture.fixture.fixtureId, context);
    const stored = await store.listFramesAfter('18179759', 0, 'conflict-v1');
    assert.equal(corrected.committedFrames.length, 31);
    assert.equal(publications.at(-1).options.replaceExisting, true);
    assert.equal(publications.at(-1).options.projectionGeneration, 1);
    assert.equal(corrected.checkpoint.projectionGeneration, 1);
    assert.equal(stored.find(({ seq }) => seq === 25).frame.facts.length, 0);
    assert.equal(corrected.checkpoint.state.integrityWarnings.some((warning) => warning.includes('Conflicting duplicate')), true);

    const ordinary = fixture.records[31];
    const ordinaryJson = JSON.stringify(ordinary);
    await store.appendRawCandidates([{
      fixtureId: String(fixture.fixture.fixtureId), seq: ordinary.Seq,
      payloadHash: createHash('sha256').update(ordinaryJson).digest('hex'),
      source: 'stream', receivedAt: '2026-07-11T00:02:00.000Z', payloadJson: ordinaryJson,
    }]);
    const continued = await projector.project(fixture.fixture.fixtureId, context);
    assert.equal(continued.committedFrames.length, 1);
    assert.equal(continued.checkpoint.projectionGeneration, 1);
    assert.notEqual(publications.at(-1).options.replaceExisting, true);
    assert.equal(publications.at(-1).options.projectionGeneration, 1);
  } finally {
    store.close();
  }
});
