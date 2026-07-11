import {
  LiveTxlineMatchAdapter,
  TxlineApiClient,
  admitTxlineMatchPulseMoments,
  buildTxlineMatchPulseCommentaryEntries,
  buildTxlineMatchPulseSourceContext,
  type GameCrewMatch,
  type GameCrewMatchFilter,
  type MatchPulseCommentaryEntry,
  type MatchPulseMoment,
  type MatchPulseEvent,
  type TxlineMatchPulseValidationReport,
  type TxlineFixture,
  type TxlineScore,
} from '@gamecrew/core';
import type { ApiConfig } from './config.js';
import {
  createMatchPulseCommentaryStore,
  type MatchPulseCommentaryStoreDriver,
  type MatchPulseCommentaryUpsertResult,
} from './match-pulse-commentary-store.js';
import { createMatchPulseEnrichmentService } from './match-pulse-llm.js';

export interface MatchListResult {
  matches: readonly GameCrewMatch[];
  source: 'txline';
}

export interface MatchListQuery {
  filter?: GameCrewMatchFilter;
  limit?: number;
}

export interface MatchPulseResult {
  events: readonly MatchPulseEvent[];
  source: 'txline';
}

export interface MatchPulseMomentsResult {
  moments: readonly MatchPulseMoment[];
  reports: readonly TxlineMatchPulseValidationReport[];
  enrichment: 'disabled' | 'openai-compatible';
  source: 'txline';
}

export interface MatchPulseCommentaryResult {
  entries: readonly MatchPulseCommentaryEntry[];
  source: 'txline';
  persistence: MatchPulseCommentaryUpsertResult & {
    store: MatchPulseCommentaryStoreDriver;
  };
}

export function createTxlineService(config: ApiConfig) {
  const client = new TxlineApiClient({
    apiToken: config.txlineApiToken,
    baseUrl: config.txlineBaseUrl,
  });
  const adapter = new LiveTxlineMatchAdapter(
    client,
  );
  const enrichment = createMatchPulseEnrichmentService(config);
  const commentaryStore = createMatchPulseCommentaryStore({
    driver: config.matchPulseStoreDriver,
    filePath: config.matchPulseStorePath,
    sqlitePath: config.matchPulseSqlitePath,
  });
  const activeCommentaryEnrichments = new Set<string>();

  return {
    async listMatches(query: MatchListQuery = {}): Promise<MatchListResult> {
      return {
        matches: await adapter.listMatches(query),
        source: 'txline',
      };
    },

    async listMatchPulse(fixtureId: string): Promise<MatchPulseResult> {
      const txlineFixtureId = normalizeTxlineFixtureId(fixtureId);
      return {
        events: await adapter.listMatchPulse(txlineFixtureId),
        source: 'txline',
      };
    },

    async listMatchPulseCommentary(fixtureId: string): Promise<MatchPulseCommentaryResult> {
      const txlineFixtureId = normalizeTxlineFixtureId(fixtureId);
      const context = await buildLiveSourceContext(txlineFixtureId);
      if (!context) {
        return {
          entries: await commentaryStore.listEntries(txlineFixtureId),
          source: 'txline',
          persistence: {
            inserted: 0,
            updated: 0,
            unchanged: 0,
            store: config.matchPulseStoreDriver,
          },
        };
      }

      const fallbackEntries = buildTxlineMatchPulseCommentaryEntries(context);
      const persistence = await commentaryStore.upsertEntries(fallbackEntries);
      scheduleCommentaryEnrichment(txlineFixtureId, context);

      return {
        entries: await commentaryStore.listEntries(txlineFixtureId),
        source: 'txline',
        persistence: {
          ...persistence,
          store: config.matchPulseStoreDriver,
        },
      };
    },

    async listMatchPulseMoments(fixtureId: string): Promise<MatchPulseMomentsResult> {
      const txlineFixtureId = normalizeTxlineFixtureId(fixtureId);
      const context = await buildLiveSourceContext(txlineFixtureId);
      if (!context) {
        throw new Error(`TxLINE fixture ${fixtureId} was not found.`);
      }

      const fallbackMoments = admitTxlineMatchPulseMoments(context);
      const enriched = await enrichment.enrichMoments(context, fallbackMoments);

      return {
        moments: enriched.moments,
        reports: enriched.reports,
        enrichment: enriched.provider,
        source: 'txline',
      };
    },
  };

  async function buildLiveSourceContext(fixtureId: string) {
    const { jwt } = await client.startGuestSession();
    const [fixtures, snapshotScores, updateScores] = await Promise.all([
      client.listFixtures(jwt).catch(() => []),
      client.listScoreSnapshot(fixtureId, jwt).catch(() => []),
      client.listScoreUpdates(fixtureId, jwt).catch(() => []),
    ]);
    const historyScores = updateScores.length > 0
      ? []
      : await client.listScoreHistory(fixtureId, jwt).catch(() => []);
    const fixture = fixtures.find((candidate) => String(candidate.FixtureId) === fixtureId) ??
      buildReplayFixture(fixtureId, [...snapshotScores, ...historyScores, ...updateScores]);
    if (!fixture) {
      return undefined;
    }

    return buildTxlineMatchPulseSourceContext({
      fixture,
      snapshotScores,
      historyScores,
      updateScores,
    });
  }

  function scheduleCommentaryEnrichment(
    fixtureId: string,
    context: Awaited<ReturnType<typeof buildLiveSourceContext>>,
  ): void {
    if (!config.llmEnabled || !config.llmBaseUrl || !context || activeCommentaryEnrichments.has(fixtureId)) {
      return;
    }

    activeCommentaryEnrichments.add(fixtureId);
    void enrichPendingCommentaryEntries(fixtureId, context)
      .catch(() => undefined)
      .finally(() => {
        activeCommentaryEnrichments.delete(fixtureId);
      });
  }

  async function enrichPendingCommentaryEntries(
    fixtureId: string,
    context: NonNullable<Awaited<ReturnType<typeof buildLiveSourceContext>>>,
  ): Promise<void> {
    const entries = await commentaryStore.listEntries(fixtureId);
    const pendingEntries = entries
      .filter((entry) => entry.enrichmentStatus === 'pending')
      .sort(compareEntriesOldestFirst)
      .slice(0, config.llmBatchSize);
    if (pendingEntries.length === 0) {
      return;
    }

    const pendingIds = new Set(pendingEntries.map((entry) => entry.id));
    const previousEntries = entries
      .filter((entry) => !pendingIds.has(entry.id))
      .sort(compareEntriesOldestFirst);
    const result = await enrichment.enrichCommentaryEntries(context, pendingEntries, previousEntries);
    if (result.entries.length > 0) {
      await commentaryStore.upsertEntries(result.entries);
    }
  }
}

function normalizeTxlineFixtureId(fixtureId: string): string {
  return fixtureId.startsWith('txline-') ? fixtureId.slice('txline-'.length) : fixtureId;
}

function compareEntriesOldestFirst(left: MatchPulseCommentaryEntry, right: MatchPulseCommentaryEntry): number {
  return (
    (left.sortSeq ?? 0) - (right.sortSeq ?? 0) ||
    (Date.parse(left.sortTimestamp ?? '') || 0) - (Date.parse(right.sortTimestamp ?? '') || 0) ||
    getClockSeconds(left) - getClockSeconds(right)
  );
}

function getClockSeconds(entry: MatchPulseCommentaryEntry): number {
  return typeof entry.clock.seconds === 'number' ? entry.clock.seconds : -1;
}

function buildReplayFixture(
  fixtureId: string,
  scores: readonly TxlineScore[],
): TxlineFixture | undefined {
  const score = scores.find((candidate) => (
    candidate.StartTime &&
    candidate.FixtureGroupId &&
    candidate.CompetitionId &&
    candidate.Participant1Id &&
    candidate.Participant2Id
  )) ?? scores[0];
  if (!score) {
    return undefined;
  }

  const participant1Id = score.Participant1Id ?? 1;
  const participant2Id = score.Participant2Id ?? 2;

  return {
    Ts: score.Ts ?? score.ts ?? Date.now(),
    StartTime: score.StartTime ?? Date.now(),
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
