import {
  TxlineApiClient,
  type MatchEngineContext,
  type MatchEngineTeam,
  type TxlineFixture,
  type TxlineScore,
} from '@gamecrew/core';
import type { ApiConfig } from '../config.js';
import { createMatchPulseCommentaryStore } from '../match-pulse-commentary-store.js';
import { createMatchPulseEnrichmentService } from '../match-pulse-llm.js';
import { CommentaryProjectionConsumer } from './commentary-projection-consumer.js';
import { FixtureIngestionSession } from './fixture-ingestion-session.js';
import { IngestionSupervisor } from './ingestion-supervisor.js';
import { buildMatchEngineContext } from './match-engine-context.js';
import { MatchEngineProjector } from './match-engine-projector.js';
import { SemanticFrameHub } from './semantic-frame-hub.js';
import { SqliteIngestionStore } from './sqlite-ingestion-store.js';
import { TxlineAuthSession } from './txline-auth-session.js';
import { TxlineFeedSource } from './txline-feed-source.js';

export function createIngestionRuntime(config: ApiConfig) {
  const client = new TxlineApiClient({ baseUrl: config.txlineBaseUrl, apiToken: config.txlineApiToken });
  const auth = new TxlineAuthSession(client);
  const feed = new TxlineFeedSource(client, auth);
  const store = new SqliteIngestionStore(config.matchPulseSqlitePath);
  const hub = new SemanticFrameHub(store);
  const projector = new MatchEngineProjector(store, { publisher: hub });
  const commentaryStore = createMatchPulseCommentaryStore({
    driver: config.matchPulseStoreDriver,
    filePath: config.matchPulseStorePath,
    sqlitePath: config.matchPulseSqlitePath,
  });
  const commentary = new CommentaryProjectionConsumer(store, hub, commentaryStore, {
    enrichment: createMatchPulseEnrichmentService(config),
    enrichmentBatchSize: config.llmBatchSize,
    onEnrichmentError(error, fixtureId) {
      console.error(JSON.stringify({
        event: 'match_pulse_background_enrichment_failed',
        fixtureId,
        reason: error instanceof Error ? error.message : String(error),
      }));
    },
  });
  const supervisor = new IngestionSupervisor(async (fixtureId) => {
    const existingCheckpoint = await store.getCheckpoint(fixtureId);
    const correctionWindowMs = remainingCorrectionWindowMs(
      existingCheckpoint?.finalisedAt,
      config.txlineFinalisationCorrectionMs,
    );
    const local = await store.listRawCandidates(fixtureId);
    const storedFixtureContext = await store.getFixtureContext(fixtureId);
    const localScores = local.flatMap(({ payloadJson }) => {
      try { return [JSON.parse(payloadJson) as TxlineScore]; } catch { return []; }
    });
    const localFixture = reconstructFixture(fixtureId, localScores);
    if (localFixture) {
      const sourceFixture = hasNamedParticipants(storedFixtureContext?.participants)
        ? localFixture
        : await findFixtureMetadata(feed, fixtureId, localScores).catch(() => localFixture);
      const context = withStoredParticipants(
        buildMatchEngineContext(sourceFixture, localScores),
        hasNamedParticipants(storedFixtureContext?.participants)
          ? storedFixtureContext?.participants
          : undefined,
      );
      await persistFixtureContext(store, context);
      await commentary.ensureFixture(fixtureId, context.participants);
      return new FixtureIngestionSession({
        fixtureId, context, feed, store, projector,
        finalisationCorrectionWindowMs: correctionWindowMs,
      });
    }
    const [fixtures, snapshot] = await Promise.all([
      feed.fetchFixtures(),
      feed.fetchSnapshot(fixtureId),
    ]);
    const fixture = fixtures.find((candidate) => String(candidate.FixtureId) === fixtureId)
      ?? reconstructFixture(fixtureId, snapshot);
    if (!fixture) throw new Error(`TxLINE fixture ${fixtureId} could not be reconstructed.`);
    const context = buildMatchEngineContext(fixture, snapshot);
    await persistFixtureContext(store, context);
    await commentary.ensureFixture(fixtureId, context.participants);
    return new FixtureIngestionSession({
      fixtureId, context, feed, store, projector,
      finalisationCorrectionWindowMs: correctionWindowMs,
    });
  });

  return {
    ensureFixture: (fixtureId: string) => supervisor.ensureFixture(fixtureId),
    getCheckpoint: (fixtureId: string) => store.getCheckpoint(fixtureId),
    listFramesAfter: (fixtureId: string, revision: number) => store.listFramesAfter(fixtureId, revision),
    listCommentaryEntries: (fixtureId: string) => commentaryStore.listEntries(fixtureId),
    subscribe: hub.subscribe.bind(hub),
    activeFixtureCount: () => supervisor.activeFixtureCount(),
    async restore() {
      const fixtureIds = await store.listFixtureIds();
      await Promise.allSettled(fixtureIds.map(async (fixtureId) => {
        const local = await store.listRawCandidates(fixtureId);
        const storedFixtureContext = await store.getFixtureContext(fixtureId);
        const localScores = local.flatMap(({ payloadJson }) => {
          try { return [JSON.parse(payloadJson) as TxlineScore]; } catch { return []; }
        });
        const localFixture = reconstructFixture(fixtureId, localScores);
        if (localFixture) {
          const sourceFixture = hasNamedParticipants(storedFixtureContext?.participants)
            ? localFixture
            : await findFixtureMetadata(feed, fixtureId, localScores).catch(() => localFixture);
          const restoredContext = withStoredParticipants(
            buildMatchEngineContext(sourceFixture, localScores),
            hasNamedParticipants(storedFixtureContext?.participants)
              ? storedFixtureContext?.participants
              : undefined,
          );
          await persistFixtureContext(store, restoredContext);
          await commentary.ensureFixture(
            fixtureId,
            restoredContext.participants,
          );
        }
        const checkpoint = await store.getCheckpoint(fixtureId);
        const finalisedAt = checkpoint?.finalisedAt ? Date.parse(checkpoint.finalisedAt) : Number.NaN;
        const correctionWindowOpen = checkpoint?.phase === 'finalised'
          && Number.isFinite(finalisedAt)
          && Date.now() - finalisedAt < config.txlineFinalisationCorrectionMs;
        if (checkpoint?.phase !== 'finalised' || correctionWindowOpen) {
          await supervisor.ensureFixture(fixtureId);
        }
      }));
    },
    async close() {
      await supervisor.stop();
      await commentary.close();
      const closeableCommentaryStore = commentaryStore as typeof commentaryStore & { close?: () => void };
      closeableCommentaryStore.close?.();
      store.close();
    },
  };
}

export type IngestionRuntime = ReturnType<typeof createIngestionRuntime>;

function withStoredParticipants<T extends { participants: readonly MatchEngineTeam[] }>(
  context: T,
  participants?: readonly MatchEngineTeam[],
): T {
  return participants?.length ? { ...context, participants } : context;
}

async function persistFixtureContext(
  store: SqliteIngestionStore,
  context: Pick<MatchEngineContext, 'fixtureId' | 'participants'>,
): Promise<void> {
  await store.saveFixtureContext({
    fixtureId: String(context.fixtureId),
    participants: context.participants,
    updatedAt: new Date().toISOString(),
  });
}

function remainingCorrectionWindowMs(finalisedAt: string | undefined, configuredMs: number): number {
  if (!finalisedAt) return configuredMs;
  const finalisedAtMs = Date.parse(finalisedAt);
  if (!Number.isFinite(finalisedAtMs)) return configuredMs;
  return Math.max(0, configuredMs - (Date.now() - finalisedAtMs));
}

function reconstructFixture(fixtureId: string, scores: readonly TxlineScore[]): TxlineFixture | undefined {
  const score = scores.find((candidate) => candidate.Participant1Id && candidate.Participant2Id);
  if (!score) return undefined;
  const participant1Id = score.Participant1Id!;
  const participant2Id = score.Participant2Id!;
  return {
    Ts: score.Ts ?? score.ts ?? 0,
    StartTime: score.StartTime ?? 0,
    Competition: `Competition ${score.CompetitionId ?? 'unknown'}`,
    CompetitionId: score.CompetitionId ?? 0,
    FixtureGroupId: score.FixtureGroupId ?? 0,
    Participant1Id: participant1Id,
    Participant1: score.Participant1 ?? `Participant ${participant1Id}`,
    Participant2Id: participant2Id,
    Participant2: score.Participant2 ?? `Participant ${participant2Id}`,
    FixtureId: Number(fixtureId),
    Participant1IsHome: score.Participant1IsHome ?? true,
  };
}

async function findFixtureMetadata(
  feed: TxlineFeedSource,
  fixtureId: string,
  scores: readonly TxlineScore[],
): Promise<TxlineFixture> {
  const startTime = scores.find((score) => typeof score.StartTime === 'number')?.StartTime;
  const fixtures = await feed.fetchFixtures({
    ...(typeof startTime === 'number' ? { startEpochDay: Math.floor(startTime / 86_400_000) } : {}),
  });
  return fixtures.find((fixture) => String(fixture.FixtureId) === fixtureId)
    ?? reconstructFixture(fixtureId, scores)
    ?? Promise.reject(new Error(`Fixture ${fixtureId} metadata was unavailable.`));
}

function hasNamedParticipants(participants?: readonly MatchEngineTeam[]): boolean {
  return Boolean(participants?.length && participants.every((team) =>
    team.name.trim().length > 0 && !/^Participant\s+\d+$/i.test(team.name)));
}
