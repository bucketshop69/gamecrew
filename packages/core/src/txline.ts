import { sampleTxlineMatches } from './sample-data';
import type {
  GameCrewMatch,
  GameCrewMatchFilter,
  GameCrewMatchStatus,
  MatchClock,
  MatchScore,
  MatchTeam,
  TeamColorSet,
} from './match';

export interface TxlineMatchQuery {
  filter?: GameCrewMatchFilter;
  limit?: number;
}

export interface TxlineMatchAdapter {
  listMatches(query?: TxlineMatchQuery): Promise<readonly GameCrewMatch[]>;
}

export interface TxlineClientConfig {
  baseUrl: string;
  apiToken: string;
  fetcher?: TxlineFetcher;
}

export interface TxlineResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type TxlineFetcher = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
  },
) => Promise<TxlineResponse>;

export interface TxlineFixture {
  Ts: number;
  StartTime: number;
  Competition: string;
  CompetitionId: number;
  FixtureGroupId: number;
  Participant1Id: number;
  Participant1: string;
  Participant2Id: number;
  Participant2: string;
  FixtureId: number;
  Participant1IsHome: boolean;
}

export interface TxlineScore {
  fixtureId?: number;
  FixtureId?: number;
  id?: string | number;
  action?: string;
  gameState?: string;
  participant1Score?: number;
  participant2Score?: number;
  homeScore?: number;
  awayScore?: number;
  score1?: number;
  score2?: number;
  minute?: number;
  matchMinute?: number;
  clock?: string;
  ts?: number;
}

export interface TxlineGuestSession {
  jwt: string;
}

const countryVisuals: Record<string, { code: string; bands: readonly string[]; colors: TeamColorSet }> = {
  Argentina: {
    code: 'AR',
    bands: ['#74ACDF', '#FFFFFF', '#74ACDF'],
    colors: { primary: '#74ACDF', secondary: '#FFFFFF', accent: '#F6B40E' },
  },
  Australia: {
    code: 'AU',
    bands: ['#002B7F', '#FFFFFF', '#E4002B'],
    colors: { primary: '#002B7F', secondary: '#FFFFFF', accent: '#E4002B' },
  },
  Belgium: {
    code: 'BE',
    bands: ['#000000', '#FAE042', '#ED2939'],
    colors: { primary: '#FAE042', secondary: '#ED2939', accent: '#000000' },
  },
  Brazil: {
    code: 'BR',
    bands: ['#009B3A', '#FFDF00', '#002776'],
    colors: { primary: '#009B3A', secondary: '#FFDF00', accent: '#002776' },
  },
  Colombia: {
    code: 'CO',
    bands: ['#FCD116', '#003893', '#CE1126'],
    colors: { primary: '#FCD116', secondary: '#003893', accent: '#CE1126' },
  },
  England: {
    code: 'GB-ENG',
    bands: ['#FFFFFF', '#CE1124', '#FFFFFF'],
    colors: { primary: '#FFFFFF', secondary: '#CE1124' },
  },
  France: {
    code: 'FR',
    bands: ['#002395', '#FFFFFF', '#ED2939'],
    colors: { primary: '#002395', secondary: '#FFFFFF', accent: '#ED2939' },
  },
  Germany: {
    code: 'DE',
    bands: ['#000000', '#DD0000', '#FFCE00'],
    colors: { primary: '#DD0000', secondary: '#FFCE00', accent: '#000000' },
  },
  Japan: {
    code: 'JP',
    bands: ['#FFFFFF', '#BC002D', '#FFFFFF'],
    colors: { primary: '#FFFFFF', secondary: '#BC002D' },
  },
  Mexico: {
    code: 'MX',
    bands: ['#006847', '#FFFFFF', '#CE1126'],
    colors: { primary: '#006847', secondary: '#FFFFFF', accent: '#CE1126' },
  },
  Morocco: {
    code: 'MA',
    bands: ['#C1272D', '#006233', '#C1272D'],
    colors: { primary: '#C1272D', secondary: '#006233' },
  },
  Netherlands: {
    code: 'NL',
    bands: ['#AE1C28', '#FFFFFF', '#21468B'],
    colors: { primary: '#AE1C28', secondary: '#FFFFFF', accent: '#21468B' },
  },
  Portugal: {
    code: 'PT',
    bands: ['#006600', '#FF0000', '#FFCC00'],
    colors: { primary: '#006600', secondary: '#FF0000', accent: '#FFCC00' },
  },
  Spain: {
    code: 'ES',
    bands: ['#AA151B', '#F1BF00', '#AA151B'],
    colors: { primary: '#AA151B', secondary: '#F1BF00' },
  },
  Switzerland: {
    code: 'CH',
    bands: ['#D52B1E', '#FFFFFF', '#D52B1E'],
    colors: { primary: '#D52B1E', secondary: '#FFFFFF' },
  },
  USA: {
    code: 'US',
    bands: ['#3C3B6E', '#FFFFFF', '#B22234'],
    colors: { primary: '#3C3B6E', secondary: '#FFFFFF', accent: '#B22234' },
  },
};

const fallbackVisuals: readonly { bands: readonly string[]; colors: TeamColorSet }[] = [
  {
    bands: ['#FFFFFF', '#111111', '#FFFFFF'],
    colors: { primary: '#FFFFFF', secondary: '#111111' },
  },
  {
    bands: ['#00A3FF', '#FFFFFF', '#FF4D4D'],
    colors: { primary: '#00A3FF', secondary: '#FFFFFF', accent: '#FF4D4D' },
  },
  {
    bands: ['#2FD17C', '#FFFFFF', '#F4CA3A'],
    colors: { primary: '#2FD17C', secondary: '#FFFFFF', accent: '#F4CA3A' },
  },
  {
    bands: ['#FF7A1A', '#FFFFFF', '#1E5BFF'],
    colors: { primary: '#FF7A1A', secondary: '#FFFFFF', accent: '#1E5BFF' },
  },
];

export class SampleTxlineMatchAdapter implements TxlineMatchAdapter {
  constructor(private readonly matches: readonly GameCrewMatch[] = sampleTxlineMatches) {}

  async listMatches(query: TxlineMatchQuery = {}): Promise<readonly GameCrewMatch[]> {
    return applyMatchQuery(this.matches, query);
  }
}

export class TxlineApiClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly fetcher: TxlineFetcher;

  constructor(config: TxlineClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiToken = config.apiToken;
    this.fetcher = config.fetcher ?? getGlobalFetch();
  }

  async startGuestSession(): Promise<TxlineGuestSession> {
    const response = await this.fetcher(`${this.baseUrl}/auth/guest/start`, { method: 'POST' });
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new Error(`TxLINE guest session failed (${response.status}): ${body.text}`);
    }

    const token = body.json?.token ?? body.json?.jwt ?? body.json?.accessToken ?? body.text.trim();
    if (!token) {
      throw new Error('TxLINE guest session did not return a JWT.');
    }

    return { jwt: token };
  }

  async listFixtures(jwt: string): Promise<readonly TxlineFixture[]> {
    return this.requestJson<readonly TxlineFixture[]>('/api/fixtures/snapshot', jwt);
  }

  async listScoreSnapshot(fixtureId: string | number, jwt: string): Promise<readonly TxlineScore[]> {
    return this.requestJson<readonly TxlineScore[]>(`/api/scores/snapshot/${fixtureId}`, jwt);
  }

  private async requestJson<T>(path: string, jwt: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Api-Token': this.apiToken,
      },
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new Error(`TxLINE request failed (${response.status} ${path}): ${body.text}`);
    }

    return body.json as T;
  }
}

export class LiveTxlineMatchAdapter implements TxlineMatchAdapter {
  constructor(private readonly client: TxlineApiClient) {}

  async listMatches(query: TxlineMatchQuery = {}): Promise<readonly GameCrewMatch[]> {
    const { jwt } = await this.client.startGuestSession();
    const fixtures = await this.client.listFixtures(jwt);
    const sortedFixtures = [...fixtures].sort((left, right) => left.StartTime - right.StartTime);
    const scoreResults = await Promise.allSettled(
      sortedFixtures.map((fixture) => this.client.listScoreSnapshot(fixture.FixtureId, jwt)),
    );
    const matches = sortedFixtures.map((fixture, index) =>
      mapTxlineFixtureToGameCrewMatch(fixture, scoreResults[index]?.status === 'fulfilled'
        ? scoreResults[index].value
        : []),
    );

    return applyMatchQuery(matches, query);
  }
}

export function mapTxlineFixtureToGameCrewMatch(
  fixture: TxlineFixture,
  scores: readonly TxlineScore[] = [],
): GameCrewMatch {
  const latestScore = getLatestScore(scores);
  const kickoffUtc = new Date(fixture.StartTime).toISOString();
  const status = getMatchStatus(fixture.StartTime, latestScore);
  const filter = getFilterForStatus(status);
  const clock = getMatchClock(fixture.StartTime, status, latestScore);

  return {
    id: `txline-${fixture.FixtureId}`,
    txline: {
      fixtureId: String(fixture.FixtureId),
      scoreSnapshotId: latestScore?.id === undefined ? undefined : String(latestScore.id),
      source: 'live',
    },
    filter,
    status,
    competition: fixture.Competition,
    round: getRoundLabel(fixture.FixtureGroupId),
    kickoffUtc,
    homeTeam: buildTeam({
      id: fixture.Participant1Id,
      name: fixture.Participant1,
    }),
    awayTeam: buildTeam({
      id: fixture.Participant2Id,
      name: fixture.Participant2,
    }),
    score: getMatchScore(latestScore),
    clock,
    replay: status === 'replayable' ? { available: true, label: 'Replay ready' } : undefined,
  };
}

export function applyMatchQuery(
  matches: readonly GameCrewMatch[],
  query: TxlineMatchQuery = {},
): readonly GameCrewMatch[] {
  const filteredMatches = query.filter
    ? matches.filter((match) => match.filter === query.filter)
    : matches;

  return typeof query.limit === 'number' ? filteredMatches.slice(0, query.limit) : filteredMatches;
}

export const sampleTxlineMatchAdapter = new SampleTxlineMatchAdapter();

function getGlobalFetch(): TxlineFetcher {
  const maybeFetch = globalThis as typeof globalThis & { fetch?: TxlineFetcher };
  if (!maybeFetch.fetch) {
    throw new Error('TxLINE client requires a fetch implementation.');
  }

  return maybeFetch.fetch;
}

async function readResponseBody(response: TxlineResponse): Promise<{ text: string; json?: any }> {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text };
  }
}

function getMatchStatus(startTimeMs: number, latestScore?: TxlineScore): GameCrewMatchStatus {
  const now = Date.now();
  const liveWindowEnd = startTimeMs + 2.5 * 60 * 60 * 1000;

  if (latestScore?.gameState && /final|ended|complete|full/i.test(latestScore.gameState)) {
    return 'replayable';
  }

  if (now >= startTimeMs && now <= liveWindowEnd) {
    return 'live';
  }

  if (now > liveWindowEnd) {
    return 'replayable';
  }

  return 'upcoming';
}

function getFilterForStatus(status: GameCrewMatchStatus): GameCrewMatchFilter {
  if (status === 'replayable' || status === 'finished') {
    return 'replay';
  }

  if (status === 'hosted') {
    return 'hosted';
  }

  return status;
}

function getMatchClock(
  startTimeMs: number,
  status: GameCrewMatchStatus,
  latestScore?: TxlineScore,
): MatchClock {
  if (status === 'live') {
    const minute =
      latestScore?.minute ??
      latestScore?.matchMinute ??
      Math.max(1, Math.floor((Date.now() - startTimeMs) / 60000));
    return {
      minute,
      label: `Live ${minute}'`,
      phase: minute <= 45 ? 'first_half' : 'second_half',
    };
  }

  if (status === 'replayable') {
    return {
      label: latestScore?.gameState ?? 'Full time',
      phase: 'replay_ready',
    };
  }

  return {
    label: formatKickoffLabel(startTimeMs),
    phase: 'pre_match',
  };
}

function getLatestScore(scores: readonly TxlineScore[]): TxlineScore | undefined {
  return [...scores].sort((left, right) => getScoreTimestamp(right) - getScoreTimestamp(left))[0];
}

function getScoreTimestamp(score: TxlineScore): number {
  return score.ts ?? 0;
}

function getMatchScore(score?: TxlineScore): MatchScore | undefined {
  if (!score) {
    return undefined;
  }

  const home = score.homeScore ?? score.participant1Score ?? score.score1;
  const away = score.awayScore ?? score.participant2Score ?? score.score2;

  if (typeof home !== 'number' || typeof away !== 'number') {
    return undefined;
  }

  return { home, away };
}

function buildTeam({ id, name }: { id: number; name: string }): MatchTeam {
  const visual = countryVisuals[name] ?? getFallbackVisual(id);

  return {
    id: `txline-team-${id}`,
    name,
    shortName: getShortName(name),
    countryCode: visual.code ?? getShortName(name),
    colors: visual.colors,
    flag: {
      code: visual.code ?? getShortName(name),
      bands: visual.bands,
    },
  };
}

function getFallbackVisual(id: number): { code?: string; bands: readonly string[]; colors: TeamColorSet } {
  return fallbackVisuals[Math.abs(id) % fallbackVisuals.length] ?? fallbackVisuals[0];
}

function getShortName(name: string): string {
  const compact = name.replace(/[^a-z]/gi, '');
  return compact.slice(0, 3).toUpperCase() || 'TBD';
}

function getRoundLabel(fixtureGroupId: number): string {
  return fixtureGroupId === 10115677 ? 'World Cup' : `Fixture group ${fixtureGroupId}`;
}

function formatKickoffLabel(startTimeMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(startTimeMs));
}
