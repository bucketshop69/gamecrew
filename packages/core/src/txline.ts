import { sampleTxlineMatches } from './sample-data';
import type {
  GameCrewMatch,
  GameCrewMatchFilter,
  GameCrewMatchStatus,
  MatchClock,
  MatchPulse,
  MatchPulseIntensity,
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
  Id?: string | number;
  action?: string;
  Action?: string;
  gameState?: string;
  GameState?: string;
  participant1Score?: number;
  participant2Score?: number;
  homeScore?: number;
  awayScore?: number;
  score1?: number;
  score2?: number;
  minute?: number;
  matchMinute?: number;
  clock?: string;
  Clock?: {
    Running?: boolean;
    Seconds?: number;
  };
  Confirmed?: boolean;
  Participant?: number;
  PossessionType?: string;
  StatusId?: number;
  Stats?: Record<string, number>;
  ts?: number;
  Ts?: number;
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
  'Congo DR': {
    code: 'CD',
    bands: ['#007FFF', '#F7D618', '#CE1021'],
    colors: { primary: '#007FFF', secondary: '#F7D618', accent: '#CE1021' },
  },
  Ecuador: {
    code: 'EC',
    bands: ['#FFD100', '#003893', '#CE1126'],
    colors: { primary: '#FFD100', secondary: '#003893', accent: '#CE1126' },
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
  Senegal: {
    code: 'SN',
    bands: ['#00853F', '#FDEF42', '#E31B23'],
    colors: { primary: '#00853F', secondary: '#FDEF42', accent: '#E31B23' },
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
  const latestClock = getLatestClockScore(scores) ?? latestScore;
  const latestStats = getLatestStatsScore(scores) ?? latestScore;
  const latestPulse = getLatestPulseScore(scores);
  const kickoffUtc = new Date(fixture.StartTime).toISOString();
  const status = getMatchStatus(fixture.StartTime, latestClock);
  const filter = getFilterForStatus(status);
  const clock = getMatchClock(fixture.StartTime, status, latestClock);
  const homeTeam = buildTeam({
    id: fixture.Participant1Id,
    name: fixture.Participant1,
  });
  const awayTeam = buildTeam({
    id: fixture.Participant2Id,
    name: fixture.Participant2,
  });

  return {
    id: `txline-${fixture.FixtureId}`,
    txline: {
      fixtureId: String(fixture.FixtureId),
      scoreSnapshotId: getScoreId(latestStats),
      source: 'live',
    },
    filter,
    status,
    competition: fixture.Competition,
    round: getRoundLabel(fixture.FixtureGroupId),
    kickoffUtc,
    homeTeam,
    awayTeam,
    score: getMatchScore(latestStats),
    clock,
    pulse: status === 'live' ? getMatchPulse(latestPulse, homeTeam, awayTeam) : undefined,
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
  const statusId = latestScore?.StatusId;
  const gameState = getGameState(latestScore);

  if (
    statusId === 5 ||
    statusId === 10 ||
    statusId === 13 ||
    (gameState && /final|ended|complete|full/i.test(gameState))
  ) {
    return 'replayable';
  }

  if (
    latestScore?.Clock?.Running ||
    statusId === 2 ||
    statusId === 3 ||
    statusId === 4 ||
    statusId === 7 ||
    statusId === 8 ||
    statusId === 9 ||
    statusId === 12 ||
    (now >= startTimeMs && now <= liveWindowEnd)
  ) {
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
    const statusId = latestScore?.StatusId;
    if (statusId === 3 || statusId === 8) {
      return {
        label: 'Half time',
        phase: 'half_time',
      };
    }

    if (statusId === 6) {
      return {
        label: 'Extra time pending',
        phase: 'extra_time',
      };
    }

    const minute =
      latestScore?.minute ??
      latestScore?.matchMinute ??
      getClockMinute(latestScore) ??
      Math.max(1, Math.floor((Date.now() - startTimeMs) / 60000));
    return {
      minute,
      label: `Live ${minute}'`,
      phase: getClockPhase(statusId, minute),
    };
  }

  if (status === 'replayable') {
    return {
      label: getGameState(latestScore) ?? 'Full time',
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

function getLatestClockScore(scores: readonly TxlineScore[]): TxlineScore | undefined {
  return [...scores]
    .filter((score) => typeof score.Clock?.Seconds === 'number')
    .sort((left, right) => getScoreTimestamp(right) - getScoreTimestamp(left))[0];
}

function getLatestStatsScore(scores: readonly TxlineScore[]): TxlineScore | undefined {
  return [...scores]
    .filter((score) => score.Stats && typeof score.Stats['1'] === 'number' && typeof score.Stats['2'] === 'number')
    .sort((left, right) => getScoreTimestamp(right) - getScoreTimestamp(left))[0];
}

function getLatestPulseScore(scores: readonly TxlineScore[]): TxlineScore | undefined {
  return [...scores]
    .filter(isPulseEvent)
    .sort((left, right) => getScoreTimestamp(right) - getScoreTimestamp(left))[0];
}

function isPulseEvent(score: TxlineScore): boolean {
  const action = score.Action ?? score.action;
  if (!action) {
    return false;
  }

  return !ignoredPulseActions.has(action);
}

const ignoredPulseActions = new Set([
  'comment',
  'connected',
  'coverage_update',
  'disconnected',
  'jersey',
  'lineups',
  'pitch',
  'standby',
  'status',
  'weather',
]);

function getScoreTimestamp(score: TxlineScore): number {
  return score.Ts ?? score.ts ?? 0;
}

function getMatchScore(score?: TxlineScore): MatchScore | undefined {
  if (!score) {
    return undefined;
  }

  const home = score.homeScore ?? score.participant1Score ?? score.score1 ?? score.Stats?.['1'];
  const away = score.awayScore ?? score.participant2Score ?? score.score2 ?? score.Stats?.['2'];

  if (typeof home !== 'number' || typeof away !== 'number') {
    return undefined;
  }

  return { home, away };
}

function getScoreId(score?: TxlineScore): string | undefined {
  const id = score?.id ?? score?.Id;
  return id === undefined ? undefined : String(id);
}

function getGameState(score?: TxlineScore): string | undefined {
  return score?.GameState ?? score?.gameState;
}

function getClockMinute(score?: TxlineScore): number | undefined {
  if (typeof score?.Clock?.Seconds !== 'number') {
    return undefined;
  }

  return Math.max(1, Math.floor(score.Clock.Seconds / 60) + 1);
}

function getClockPhase(statusId: number | undefined, minute: number): MatchClock['phase'] {
  if (statusId === 4) {
    return 'second_half';
  }

  if (statusId === 7 || statusId === 9 || minute > 90) {
    return 'extra_time';
  }

  return minute <= 45 ? 'first_half' : 'second_half';
}

function getMatchPulse(
  score: TxlineScore | undefined,
  homeTeam: MatchTeam,
  awayTeam: MatchTeam,
): MatchPulse | undefined {
  const action = score?.Action ?? score?.action;
  if (!score || !action) {
    return undefined;
  }

  const team = score.Participant === 1 ? homeTeam : score.Participant === 2 ? awayTeam : undefined;
  const readableAction = getReadableAction(action, score.PossessionType);

  return {
    label: team ? `${team.shortName}: ${readableAction}` : readableAction,
    intensity: getPulseIntensity(action, score.PossessionType),
    verified: score.Confirmed,
    teamId: team?.id,
    updatedAt: score.Ts ? new Date(score.Ts).toISOString() : undefined,
  };
}

function getReadableAction(action: string, possessionType?: string): string {
  if (possessionType === 'HighDangerPossession') {
    return 'high danger attack';
  }

  if (possessionType === 'DangerPossession') {
    return 'danger attack';
  }

  return action
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function getPulseIntensity(action: string, possessionType?: string): MatchPulseIntensity {
  if (action === 'goal' || action === 'penalty' || action === 'red_card') {
    return 'major';
  }

  if (
    action === 'shot' ||
    action === 'corner' ||
    action === 'danger_possession' ||
    action === 'high_danger_possession' ||
    possessionType === 'DangerPossession' ||
    possessionType === 'HighDangerPossession'
  ) {
    return 'danger';
  }

  if (action === 'attack_possession' || action === 'free_kick') {
    return 'building';
  }

  return 'quiet';
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
