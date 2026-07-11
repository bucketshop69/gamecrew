import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { GameCrewMatchFilter } from '@gamecrew/core';
import type { ApiConfig } from './config.js';
import { createTxlineService } from './txline-service.js';

export function createApp(config: ApiConfig) {
  const app = new Hono();
  const txline = createTxlineService(config);

  app.use('*', cors());

  app.get('/health', (context) =>
    context.json({
      ok: true,
      source: 'txline',
    }),
  );

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
    const fixtureId = context.req.param('fixtureId');
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
