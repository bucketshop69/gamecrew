import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { GameCrewMatchFilter } from '@gamecrew/core';
import type { ApiConfig } from './config.js';
import { createTxlineService } from './txline-service.js';
import type { IngestionRuntime } from './ingestion/ingestion-runtime.js';

export function createApp(config: ApiConfig, ingestion?: IngestionRuntime) {
  const app = new Hono();
  const txline = createTxlineService(config);

  app.use('*', cors());

  app.get('/health', (context) =>
    context.json({
      ok: true,
      source: 'txline',
      ingestionSessions: ingestion?.activeFixtureCount() ?? 0,
    }),
  );

  app.get('/matches/:fixtureId/engine/state', async (context) => {
    if (!ingestion) return context.json({ error: 'Ingestion runtime is unavailable.' }, 503);
    const fixtureId = normalizeFixtureId(context.req.param('fixtureId'));
    let checkpoint = await ingestion.getCheckpoint(fixtureId);
    if (checkpoint) {
      void ingestion.ensureFixture(fixtureId).catch(() => undefined);
    } else {
      await ingestion.ensureFixture(fixtureId);
      checkpoint = await ingestion.getCheckpoint(fixtureId);
    }
    return checkpoint
      ? context.json({ fixtureId, checkpoint })
      : context.json({ error: `No engine state for fixture ${fixtureId}.` }, 404);
  });

  app.get('/matches/:fixtureId/engine/frames', async (context) => {
    if (!ingestion) return context.json({ error: 'Ingestion runtime is unavailable.' }, 503);
    const fixtureId = normalizeFixtureId(context.req.param('fixtureId'));
    const afterRevision = Number(context.req.query('afterRevision') ?? 0);
    const requestedGeneration = Number(context.req.query('generation'));
    let checkpoint = await ingestion.getCheckpoint(fixtureId);
    let resyncRequired = Boolean(
      checkpoint
      && Number.isFinite(requestedGeneration)
      && requestedGeneration !== checkpoint.projectionGeneration,
    );
    const safeAfterRevision = Number.isFinite(afterRevision) && afterRevision >= 0 ? afterRevision : 0;
    let frames = await ingestion.listFramesAfter(
      fixtureId,
      resyncRequired ? 0 : safeAfterRevision,
    );
    if (checkpoint || frames.length > 0) {
      void ingestion.ensureFixture(fixtureId).catch(() => undefined);
    } else {
      await ingestion.ensureFixture(fixtureId);
      checkpoint = await ingestion.getCheckpoint(fixtureId);
      resyncRequired = Boolean(
        checkpoint
        && Number.isFinite(requestedGeneration)
        && requestedGeneration !== checkpoint.projectionGeneration,
      );
      frames = await ingestion.listFramesAfter(
        fixtureId,
        resyncRequired ? 0 : safeAfterRevision,
      );
    }
    return context.json({
      fixtureId,
      projectionGeneration: checkpoint?.projectionGeneration ?? 0,
      resyncRequired,
      frames,
    });
  });

  app.get('/matches', async (context) => {
    const filter = parseFilter(context.req.query('filter'));
    const limit = parseLimit(context.req.query('limit'));
    const result = await txline.listMatches({ filter, limit });

    return context.json(result);
  });

  app.get('/matches/:fixtureId/pulse', async (context) => {
    const fixtureId = context.req.param('fixtureId');
    const result = await txline.listMatchPulse(fixtureId);

    return context.json(result);
  });

  app.get('/matches/:fixtureId/pulse/commentary', async (context) => {
    const fixtureId = normalizeFixtureId(context.req.param('fixtureId'));
    if (ingestion) {
      return context.json({
        entries: await ingestion.listCommentaryEntries(fixtureId),
        source: 'engine',
        persistence: {
          inserted: 0,
          updated: 0,
          unchanged: 0,
          store: config.matchPulseStoreDriver,
        },
      });
    }
    const result = await txline.listMatchPulseCommentary(fixtureId);

    return context.json(result);
  });

  app.get('/matches/:fixtureId/pulse/moments', async (context) => {
    const fixtureId = context.req.param('fixtureId');
    const result = await txline.listMatchPulseMoments(fixtureId);

    return context.json(result);
  });

  app.notFound((context) => context.json({ error: 'Not found' }, 404));

  app.onError((error, context) =>
    context.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      502,
    ),
  );

  return app;
}

function normalizeFixtureId(value: string): string {
  return value.startsWith('txline-') ? value.slice('txline-'.length) : value;
}

function parseFilter(value?: string): GameCrewMatchFilter | undefined {
  if (value === 'live' || value === 'upcoming' || value === 'replay' || value === 'hosted') {
    return value;
  }

  return undefined;
}

function parseLimit(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
