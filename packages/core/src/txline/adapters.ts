import { sampleTxlineMatches } from '../sample-data';
import type { GameCrewMatch, MatchPulseEvent } from '../match';
import { TxlineApiClient } from './client';
import { applyMatchQuery, mapTxlineFixtureToGameCrewMatch } from './match-mapper';
import { mapTxlineScoresToMatchPulseEvents, normalizePulseAction } from './pulse';
import { getFixtureMatchScore } from './score';
import type {
  TxlineFixture,
  TxlineMatchAdapter,
  TxlineMatchQuery,
  TxlineScore,
} from './types';

const MILLISECONDS_PER_DAY = 86_400_000;
const HISTORICAL_FIXTURE_LOOKBACK_DAYS = 30;
const ARCHIVAL_SCORE_CACHE_AGE_MS = MILLISECONDS_PER_DAY;
const ARCHIVAL_SCORE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SCORE_FETCH_CONCURRENCY = 20;

interface ScoreCacheEntry {
  cachedAt: number;
  scores: readonly TxlineScore[];
}

export class SampleTxlineMatchAdapter implements TxlineMatchAdapter {
  constructor(private readonly matches: readonly GameCrewMatch[] = sampleTxlineMatches) {}

  async listMatches(query: TxlineMatchQuery = {}): Promise<readonly GameCrewMatch[]> {
    return applyMatchQuery(this.matches, query);
  }

  async listMatchPulse(fixtureId: string | number): Promise<readonly MatchPulseEvent[]> {
    const match = this.matches.find((candidate) => candidate.txline.fixtureId === String(fixtureId));
    if (!match?.pulse) {
      return [];
    }

    return [
      {
        id: `${match.txline.fixtureId}-latest-pulse`,
        fixtureId: String(fixtureId),
        seq: 0,
        action: normalizePulseAction(match.pulse.action) ?? 'kickoff',
        label: match.pulse.label,
        intensity: match.pulse.intensity,
        clock: {
          minute: match.clock.minute,
          label: match.clock.minute ? `${match.clock.minute}'` : match.clock.label,
        },
        teamId: match.pulse.teamId,
        confirmed: match.pulse.verified,
        updatedAt: match.pulse.updatedAt,
      },
    ];
  }
}

export class LiveTxlineMatchAdapter implements TxlineMatchAdapter {
  private readonly archivalScoreCache = new Map<string, ScoreCacheEntry>();
  private readonly scoreRequests = new Map<string, Promise<readonly TxlineScore[]>>();

  constructor(private readonly client: TxlineApiClient) {}

  async listMatches(query: TxlineMatchQuery = {}): Promise<readonly GameCrewMatch[]> {
    const { jwt } = await this.client.startGuestSession();
    const now = Date.now();
    const currentEpochDay = Math.floor(now / MILLISECONDS_PER_DAY);
    const fixtures = await this.client.listFixtures(jwt, {
      startEpochDay: currentEpochDay - HISTORICAL_FIXTURE_LOOKBACK_DAYS,
    });
    this.pruneScoreCache(fixtures, now);
    const sortedFixtures = [...fixtures].sort((left, right) => left.StartTime - right.StartTime);
    const scores = await mapWithConcurrency(
      sortedFixtures,
      SCORE_FETCH_CONCURRENCY,
      (fixture) => this.listMatchScores(fixture, jwt, now),
    );
    const matches = sortedFixtures.map((fixture, index) =>
      mapTxlineFixtureToGameCrewMatch(fixture, scores[index] ?? []),
    );

    return applyMatchQuery(matches, query);
  }

  async listMatchPulse(fixtureId: string | number): Promise<readonly MatchPulseEvent[]> {
    const { jwt } = await this.client.startGuestSession();
    const updates = await this.client.listScoreUpdates(fixtureId, jwt);
    const scores = updates.length > 0 ? updates : await this.client.listScoreHistory(fixtureId, jwt);

    return mapTxlineScoresToMatchPulseEvents(String(fixtureId), scores);
  }

  private async listMatchScores(
    fixture: TxlineFixture,
    jwt: string,
    now: number,
  ): Promise<readonly TxlineScore[]> {
    if (fixture.StartTime > now) return [];

    const fixtureId = String(fixture.FixtureId);
    const isArchival = now >= fixture.StartTime + ARCHIVAL_SCORE_CACHE_AGE_MS;
    const cached = this.archivalScoreCache.get(fixtureId);
    if (isArchival && cached && now - cached.cachedAt < ARCHIVAL_SCORE_CACHE_TTL_MS) {
      return cached.scores;
    }

    const inFlight = this.scoreRequests.get(fixtureId);
    if (inFlight) return inFlight;

    const request = this.client.listScoreSnapshot(fixture.FixtureId, jwt)
      .then((scores) => {
        if (isArchival && scores.some((score) => getFixtureMatchScore(fixture, score))) {
          this.archivalScoreCache.set(fixtureId, { cachedAt: now, scores });
        }
        return scores;
      })
      .catch(() => [])
      .finally(() => this.scoreRequests.delete(fixtureId));
    this.scoreRequests.set(fixtureId, request);
    return request;
  }

  private pruneScoreCache(fixtures: readonly TxlineFixture[], now: number): void {
    const listedFixtureIds = new Set(fixtures.map(({ FixtureId }) => String(FixtureId)));
    for (const [fixtureId, cached] of this.archivalScoreCache) {
      if (
        !listedFixtureIds.has(fixtureId) ||
        now - cached.cachedAt >= ARCHIVAL_SCORE_CACHE_TTL_MS
      ) {
        this.archivalScoreCache.delete(fixtureId);
      }
    }
  }
}

export const sampleTxlineMatchAdapter = new SampleTxlineMatchAdapter();

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );

  return results;
}
