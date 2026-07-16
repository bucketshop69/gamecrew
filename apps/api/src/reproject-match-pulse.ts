import { loadConfig } from './config.js';
import { CommentaryProjectionConsumer } from './ingestion/commentary-projection-consumer.js';
import { SemanticFrameHub } from './ingestion/semantic-frame-hub.js';
import { SqliteIngestionStore } from './ingestion/sqlite-ingestion-store.js';
import { SqliteMatchPulseCommentaryStore } from './match-pulse-commentary-store.js';

const values = process.argv.slice(2).filter((value) => value !== '--');
const fixtureIds = values.filter((value) => /^\d+$/.test(value));
if (fixtureIds.length === 0) {
  throw new Error('Provide at least one numeric fixture id.');
}
const databasePath = values.find((value) => value.startsWith('--database='))
  ?.slice('--database='.length)
  ?? loadConfig().matchPulseSqlitePath;

const framesStore = new SqliteIngestionStore(databasePath);
const hub = new SemanticFrameHub(framesStore);
const commentaryStore = new SqliteMatchPulseCommentaryStore(databasePath);
const consumer = new CommentaryProjectionConsumer(framesStore, hub, commentaryStore);

try {
  const results = [];
  for (const fixtureId of fixtureIds) {
    const checkpoint = await framesStore.getCheckpoint(fixtureId);
    if (!checkpoint) throw new Error(`No engine checkpoint for fixture ${fixtureId}.`);
    const teams = (await framesStore.getFixtureContext(fixtureId))?.participants ?? [];
    await consumer.ensureFixture(fixtureId, teams);
    const entries = await commentaryStore.listEntries(fixtureId);
    results.push({
      fixtureId,
      projectionGeneration: checkpoint.projectionGeneration,
      stateRevision: checkpoint.stateRevision,
      entries: entries.length,
      pending: entries.filter((entry) => entry.enrichmentStatus === 'pending').length,
      complete: entries.filter((entry) => entry.enrichmentStatus === 'complete').length,
      failed: entries.filter((entry) => entry.enrichmentStatus === 'failed').length,
    });
  }
  console.log(JSON.stringify({ databasePath, results }, null, 2));
} finally {
  await consumer.close();
  commentaryStore.close();
  framesStore.close();
}
