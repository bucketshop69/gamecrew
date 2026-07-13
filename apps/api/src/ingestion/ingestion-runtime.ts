import {
  TxlineApiClient,
  applyMatchQuery,
  mapTxlineFixtureToGameCrewMatch,
  type GameCrewMatch,
  type GameCrewMatchFilter,
  type MatchEngineContext,
  type MatchEngineTeam,
  type TxlineFixture,
  type TxlineScore,
} from '@gamecrew/core';
import type { ApiConfig } from '../config.js';
import {
  MatchPulseMaterializationStore,
  isMaterializationAvailable,
} from '../match-pulse-materialization-store.js';
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
  const materializations = new MatchPulseMaterializationStore(config.matchPulseSqlitePath);
  const enrichmentReports = new Map<string, MatchPulseEnrichmentReport>();
  const commentary = new CommentaryProjectionConsumer(store, hub, commentaryStore, {
    enrichment: config.llmEnabled && config.llmBaseUrl
      ? createMatchPulseEnrichmentService(config)
      : undefined,
    enrichmentBatchSize: config.llmBatchSize,
    onEnrichmentError(error, fixtureId) {
      console.error(JSON.stringify({
        event: 'match_pulse_background_enrichment_failed',
        fixtureId,
        reason: error instanceof Error ? error.message : String(error),
      }));
    },
    onEnrichmentResult(result, fixtureId) {
      const current = enrichmentReports.get(fixtureId) ?? emptyEnrichmentReport();
      const stages = result.traces?.flatMap((trace) => trace.stages) ?? [];
      enrichmentReports.set(fixtureId, {
        attempted: current.attempted + result.attempted,
        completed: current.completed + result.completed,
        failed: current.failed + result.failed,
        providerCalls: current.providerCalls + stages.length,
        promptTokens: sumDefined(current.promptTokens, stages.map((stage) => stage.usage?.promptTokens)),
        completionTokens: sumDefined(
          current.completionTokens,
          stages.map((stage) => stage.usage?.completionTokens),
        ),
        totalTokens: sumDefined(current.totalTokens, stages.map((stage) => stage.usage?.totalTokens)),
      });
      void materializations.recordUsage(fixtureId, {
        attempted: result.attempted,
        completed: result.completed,
        failed: result.failed,
        providerCalls: stages.length,
        promptTokens: sumDefined(undefined, stages.map((stage) => stage.usage?.promptTokens)),
        completionTokens: sumDefined(undefined, stages.map((stage) => stage.usage?.completionTokens)),
        totalTokens: sumDefined(undefined, stages.map((stage) => stage.usage?.totalTokens)),
      });
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
    const [snapshot, historical] = await Promise.all([
      feed.fetchSnapshot(fixtureId),
      feed.fetchHistorical(fixtureId),
    ]);
    const sourceScores = [...historical, ...snapshot];
    const fixture = await findFixtureMetadata(feed, fixtureId, sourceScores);
    const context = buildMatchEngineContext(fixture, historical.length > 0 ? historical : snapshot);
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
    getIngestionCursor: (fixtureId: string) => store.getCursor(fixtureId),
    listFramesAfter: (fixtureId: string, revision: number) => store.listFramesAfter(fixtureId, revision),
    listCommentaryEntries: (fixtureId: string) => commentaryStore.listEntries(fixtureId),
    getCommentaryProjection: (fixtureId: string) => commentaryStore.getProjectionSnapshot(fixtureId),
    getEnrichmentReport: (fixtureId: string) => enrichmentReports.get(fixtureId) ?? emptyEnrichmentReport(),
    async listMatches(query: { filter?: GameCrewMatchFilter; limit?: number } = {}) {
      const [fixtureIds, materializationSnapshots] = await Promise.all([
        store.listFixtureIds(),
        materializations.list(),
      ]);
      const materializationByFixture = new Map(
        materializationSnapshots.map((snapshot) => [snapshot.fixtureId, snapshot]),
      );
      const matches = await Promise.all(fixtureIds.map(async (fixtureId) => {
        const materialization = materializationByFixture.get(fixtureId);
        if (!isMaterializationAvailable(materialization?.status)) return undefined;
        const [checkpoint, fixtureContext, raw] = await Promise.all([
          store.getCheckpoint(fixtureId),
          store.getFixtureContext(fixtureId),
          store.listRawCandidates(fixtureId),
        ]);
        if (!checkpoint || !fixtureContext) return undefined;
        const scores = raw.flatMap(({ payloadJson }) => {
          try { return [JSON.parse(payloadJson) as TxlineScore]; } catch { return []; }
        });
        const fixture = reconstructFixture(fixtureId, scores);
        if (!fixture) return undefined;
        const persistedParticipants = fixtureContext.participants;
        const participant1 = persistedParticipants.find((participant) => participant.participant === 1);
        if (typeof participant1?.isHome === 'boolean') {
          fixture.Participant1IsHome = participant1.isHome;
        }
        for (const participant of persistedParticipants) {
          if (participant.participant === 1) fixture.Participant1 = participant.name;
          if (participant.participant === 2) fixture.Participant2 = participant.name;
        }
        const mapped = mapTxlineFixtureToGameCrewMatch(fixture, scores);
        return withCanonicalCheckpoint(mapped, checkpoint, persistedParticipants);
      }));
      return applyMatchQuery(matches.filter((match): match is GameCrewMatch => Boolean(match)), query);
    },
    subscribe: hub.subscribe.bind(hub),
    activeFixtureCount: () => supervisor.activeFixtureCount(),
    async restore() {
      const fixtureIds = await store.listFixtureIds();
      await Promise.allSettled(fixtureIds.map(async (fixtureId) => {
        const materialization = await materializations.get(fixtureId);
        if (!isMaterializationAvailable(materialization?.status)) return;
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
      materializations.close();
      store.close();
    },
  };
}

export interface MatchPulseEnrichmentReport {
  attempted: number;
  completed: number;
  failed: number;
  providerCalls: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

function emptyEnrichmentReport(): MatchPulseEnrichmentReport {
  return { attempted: 0, completed: 0, failed: 0, providerCalls: 0 };
}

function sumDefined(current: number | undefined, values: readonly (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  if (current === undefined && defined.length === 0) return undefined;
  return (current ?? 0) + defined.reduce((total, value) => total + value, 0);
}

export type IngestionRuntime = ReturnType<typeof createIngestionRuntime>;

function withCanonicalCheckpoint(
  match: GameCrewMatch,
  checkpoint: Awaited<ReturnType<SqliteIngestionStore['getCheckpoint']>> & {},
  participants: readonly MatchEngineTeam[],
): GameCrewMatch {
  const participant1Home = participants.find((team) => team.participant === 1)?.isHome
    ?? match.homeTeam.id.endsWith(String(participants.find((team) => team.participant === 1)?.teamId));
  const score = checkpoint.state.finalScore ?? checkpoint.state.confirmedScore;
  const status = checkpoint.phase === 'finalised'
    ? 'replayable'
    : checkpoint.phase === 'pre_match'
      ? 'upcoming'
      : 'live';
  const clockSeconds = checkpoint.state.liveClock?.seconds;
  const minute = typeof clockSeconds === 'number' ? Math.floor(clockSeconds / 60) : undefined;
  return {
    ...match,
    filter: status === 'replayable' ? 'replay' : status,
    status,
    score: {
      home: participant1Home ? score.participant1 : score.participant2,
      away: participant1Home ? score.participant2 : score.participant1,
    },
    clock: status === 'replayable'
      ? { label: 'Full time', phase: 'replay_ready' }
      : status === 'upcoming'
        ? { label: match.clock.label, phase: 'pre_match' }
      : {
          ...(minute === undefined ? {} : { minute }),
          label: minute === undefined ? phaseLabel(checkpoint.phase) : `Live ${minute}'`,
          phase: phaseForClient(checkpoint.phase),
        },
    replay: status === 'replayable' ? { available: true, label: 'Replay ready' } : undefined,
  };
}

function phaseForClient(phase: string): GameCrewMatch['clock']['phase'] {
  if (phase === 'half_time') return 'half_time';
  if (phase === 'second_half' || phase === 'second_half_ready') return 'second_half';
  if (phase === 'finalised' || phase === 'full_time_pending') return 'full_time';
  if (phase === 'pre_match') return 'pre_match';
  return 'first_half';
}

function phaseLabel(phase: string): string {
  if (phase === 'half_time') return 'Half time';
  if (phase === 'full_time_pending') return 'Full time pending';
  if (phase === 'second_half_ready') return 'Second half ready';
  if (phase === 'first_half_ready') return 'First half ready';
  return phase === 'pre_match' ? 'Pre-match' : 'Live';
}

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

export async function findFixtureMetadata(
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
