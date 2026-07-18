import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  applyMatchQuery,
  type GameCrewMatch,
  type GameCrewMatchFilter,
  type MatchTeam,
} from '@gamecrew/core';
import type { ApiConfig } from './config.js';
import { createTxlineService } from './txline-service.js';
import type { IngestionRuntime } from './ingestion/ingestion-runtime.js';
import { ResponseCache } from './response-cache.js';
import type { EconomyRuntime } from './economy/economy-runtime.js';
import { createCommentaryAudioRoutes, type CommentaryAudioRoutesStore } from './tts/commentary-audio-routes.js';

const DEFAULT_FRAMES_PAGE_LIMIT = 500;
const MAX_FRAMES_PAGE_LIMIT = 2_000;
const ENGINE_CACHE_TTL_MS = 5_000;
const ENGINE_CACHE_MAX_ENTRIES = 500;

type StoredFrames = Awaited<ReturnType<IngestionRuntime['listFramesAfter']>>;

interface FramesPage {
  page: StoredFrames;
  hasMore: boolean;
}

export function createApp(
  config: ApiConfig,
  ingestion?: IngestionRuntime,
  economy?: EconomyRuntime,
  commentaryAudio?: CommentaryAudioRoutesStore,
) {
  const app = new Hono();
  const txline = createTxlineService(config);
  const engineCache = new ResponseCache<unknown>({
    ttlMs: ENGINE_CACHE_TTL_MS,
    maxEntries: ENGINE_CACHE_MAX_ENTRIES,
  });

  app.use('*', cors());

  if (commentaryAudio) {
    app.route('/', createCommentaryAudioRoutes(commentaryAudio));
  }

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
    if (!checkpoint) {
      return context.json({ error: `No engine state for fixture ${fixtureId}.` }, 404);
    }

    const cacheKey = `state:${fixtureId}`;
    const cacheVersion = `${checkpoint.stateRevision}:${checkpoint.projectionGeneration}`;
    const cached = engineCache.get(cacheKey, cacheVersion);
    if (cached) return context.json(cached);

    const body = { fixtureId, checkpoint };
    engineCache.set(cacheKey, cacheVersion, body);
    return context.json(body);
  });

  app.get('/matches/:fixtureId/engine/frames', async (context) => {
    if (!ingestion) return context.json({ error: 'Ingestion runtime is unavailable.' }, 503);
    const fixtureId = normalizeFixtureId(context.req.param('fixtureId'));
    const afterRevision = Number(context.req.query('afterRevision') ?? 0);
    const requestedGeneration = Number(context.req.query('generation'));
    const limit = parseFramesLimit(context.req.query('limit'));
    const safeAfterRevision = Number.isFinite(afterRevision) && afterRevision >= 0 ? afterRevision : 0;

    const loadFramesPage = async (checkpoint: Awaited<ReturnType<IngestionRuntime['getCheckpoint']>>) => {
      const resyncRequired = Boolean(
        checkpoint
        && Number.isFinite(requestedGeneration)
        && requestedGeneration !== checkpoint.projectionGeneration,
      );
      const effectiveAfterRevision = resyncRequired ? 0 : safeAfterRevision;
      const cacheKey = `frames:${fixtureId}:${effectiveAfterRevision}:${limit}`;
      const cacheVersion = checkpoint ? `${checkpoint.stateRevision}:${checkpoint.projectionGeneration}` : undefined;
      const cached = cacheVersion ? engineCache.get(cacheKey, cacheVersion) as FramesPage | undefined : undefined;
      if (cached) return { ...cached, resyncRequired, effectiveAfterRevision };

      const fetched = await ingestion!.listFramesAfter(fixtureId, effectiveAfterRevision);
      const hasMore = fetched.length > limit;
      const page = hasMore ? fetched.slice(0, limit) : fetched;
      const result: FramesPage = { page, hasMore };
      if (cacheVersion) engineCache.set(cacheKey, cacheVersion, result);
      return { ...result, resyncRequired, effectiveAfterRevision };
    };

    let checkpoint = await ingestion.getCheckpoint(fixtureId);
    let { page: frames, hasMore, resyncRequired, effectiveAfterRevision } = await loadFramesPage(checkpoint);
    if (checkpoint || frames.length > 0) {
      void ingestion.ensureFixture(fixtureId).catch(() => undefined);
    } else {
      await ingestion.ensureFixture(fixtureId);
      checkpoint = await ingestion.getCheckpoint(fixtureId);
      ({ page: frames, hasMore, resyncRequired, effectiveAfterRevision } = await loadFramesPage(checkpoint));
    }

    const headRevision = checkpoint?.stateRevision
      ?? frames.reduce((max, entry) => Math.max(max, entry.stateRevision), effectiveAfterRevision);
    const nextAfterRevision = frames.length > 0
      ? frames[frames.length - 1]!.stateRevision
      : effectiveAfterRevision;

    return context.json({
      fixtureId,
      projectionGeneration: checkpoint?.projectionGeneration ?? 0,
      resyncRequired,
      frames,
      headRevision,
      nextAfterRevision,
      hasMore,
    });
  });

  app.get('/matches', async (context) => {
    const filter = parseFilter(context.req.query('filter'));
    const limit = parseLimit(context.req.query('limit'));
    const [remoteResult, localResult] = await Promise.allSettled([
      txline.listMatches(),
      ingestion?.listMatches() ?? Promise.resolve([]),
    ]);
    const remoteMatches = remoteResult.status === 'fulfilled' ? remoteResult.value.matches : [];
    const localMatches = localResult.status === 'fulfilled' ? localResult.value : [];
    if (remoteResult.status === 'rejected' && localMatches.length === 0) {
      throw remoteResult.reason;
    }
    const matches = applyMatchQuery(mergeMatches(remoteMatches, localMatches), { filter, limit });
    const source = remoteMatches.length > 0 && localMatches.length > 0
      ? 'combined'
      : localMatches.length > 0
        ? 'engine'
        : 'txline';

    return context.json({ matches, source });
  });

  app.get('/matches/:fixtureId/pulse', async (context) => {
    const fixtureId = context.req.param('fixtureId');
    const result = await txline.listMatchPulse(fixtureId);

    return context.json(result);
  });

  app.get('/matches/:fixtureId/pulse/commentary', async (context) => {
    const fixtureId = normalizeFixtureId(context.req.param('fixtureId'));
    if (ingestion) {
      const projection = await ingestion.getCommentaryProjection(fixtureId);
      return context.json({
        fixtureId,
        projectionGeneration: projection.cursor?.projectionGeneration ?? 0,
        entries: projection.entries,
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

  app.post('/economy/claims', async (context) => {
    if (!economy) return context.json({ error: 'Economy runtime is unavailable.' }, 503);
    const body = await parseJsonBody(context.req.raw);
    if (!body) return context.json({ error: 'Invalid JSON body.' }, 400);

    const walletAddress = requireNonEmptyString(body.walletAddress);
    const fixtureId = requireNonEmptyString(body.fixtureId);
    const itemId = requireNonEmptyString(body.itemId);
    const sourceEventId = requireNonEmptyString(body.sourceEventId);
    const quantity = requirePositiveInteger(body.quantity);
    const minute = optionalNonNegativeInteger(body.minute);
    if (!walletAddress || !fixtureId || !itemId || !sourceEventId || quantity === undefined) {
      return context.json({
        error: 'walletAddress, fixtureId, itemId, sourceEventId, and a positive integer quantity are required.',
      }, 400);
    }

    const claim = await economy.createClaim({
      walletAddress,
      fixtureId,
      itemId,
      quantity,
      ...(minute === undefined ? {} : { minute }),
      sourceEventId,
    });
    return context.json({ claimId: claim.claimId, status: claim.status }, 202);
  });

  app.get('/economy/claims/:claimId', async (context) => {
    if (!economy) return context.json({ error: 'Economy runtime is unavailable.' }, 503);
    const claim = await economy.getClaim(context.req.param('claimId'));
    if (!claim) return context.json({ error: 'Claim not found.' }, 404);
    return context.json(claim);
  });

  app.get('/economy/wallets/:walletAddress/claims', async (context) => {
    if (!economy) return context.json({ error: 'Economy runtime is unavailable.' }, 503);
    const walletAddress = context.req.param('walletAddress');
    const claims = await economy.listClaimsForWallet(walletAddress);
    return context.json({ walletAddress, claims });
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

function mergeMatches(
  remoteMatches: readonly GameCrewMatch[],
  localMatches: readonly GameCrewMatch[],
): readonly GameCrewMatch[] {
  const merged = new Map(remoteMatches.map((match) => [match.txline.fixtureId, match]));
  for (const local of localMatches) {
    const remote = merged.get(local.txline.fixtureId);
    if (!remote) {
      merged.set(local.txline.fixtureId, local);
      continue;
    }

    const combined = {
      ...remote,
      ...local,
      competition: remote.competition || local.competition,
      round: remote.round ?? local.round,
      kickoffUtc: remote.kickoffUtc || local.kickoffUtc,
      homeTeam: mergeRemoteTeamMetadata(local.homeTeam, remote),
      awayTeam: mergeRemoteTeamMetadata(local.awayTeam, remote),
    };

    merged.set(local.txline.fixtureId, isCompletedMatch(remote)
      ? {
          ...combined,
          filter: remote.filter,
          status: remote.status,
          score: remote.score ?? local.score,
          clock: remote.clock,
          pulse: remote.pulse,
          replay: remote.replay,
        }
      : combined);
  }
  return [...merged.values()];
}

function isCompletedMatch(match: GameCrewMatch): boolean {
  return match.status === 'finished' || match.status === 'replayable';
}

function mergeRemoteTeamMetadata(local: MatchTeam, remoteMatch: GameCrewMatch): MatchTeam {
  const remote = [remoteMatch.homeTeam, remoteMatch.awayTeam].find((team) => team.id === local.id);
  return remote ? { ...remote, name: local.name, shortName: local.shortName } : local;
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

function parseFramesLimit(value?: string): number {
  if (!value) return DEFAULT_FRAMES_PAGE_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FRAMES_PAGE_LIMIT;
  return Math.min(Math.floor(parsed), MAX_FRAMES_PAGE_LIMIT);
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function requireNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function requirePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
