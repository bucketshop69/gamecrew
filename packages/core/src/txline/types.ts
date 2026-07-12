import type {
  GameCrewMatch,
  GameCrewMatchFilter,
  GameCrewMatchStatus,
  MatchClock,
  MatchPulseEvent,
  MatchPulseEventAction,
  MatchPulseIntensity,
  MatchPulseSourceEventRef,
  MatchScore,
  MatchTeam,
} from '../match';

export interface TxlineMatchQuery {
  filter?: GameCrewMatchFilter;
  limit?: number;
}

export interface TxlineMatchAdapter {
  listMatches(query?: TxlineMatchQuery): Promise<readonly GameCrewMatch[]>;
  listMatchPulse(fixtureId: string | number): Promise<readonly MatchPulseEvent[]>;
}

export interface TxlineClientConfig {
  baseUrl: string;
  apiToken: string;
  fetcher?: TxlineFetcher;
}

export interface TxlineFixtureSnapshotOptions {
  startEpochDay?: number;
  competitionId?: number;
}

export interface TxlineScoreSnapshotOptions {
  asOf?: number;
}

export interface TxlineScoreIntervalOptions {
  fixtureId?: string | number;
}

export interface TxlineSseMessage {
  id?: string;
  event?: string;
  retry?: number;
  data: string;
}

export type TxlineScoreStreamEvent =
  | {
      kind: 'score';
      message: TxlineSseMessage;
      score: TxlineScore;
      scoreIndex: number;
      scoreCount: number;
      isLastInMessage: boolean;
    }
  | {
      kind: 'heartbeat';
      message: TxlineSseMessage;
      timestamp?: number;
    }
  | {
      kind: 'control';
      message: TxlineSseMessage;
    };

/** Structural subset implemented by the platform AbortSignal. */
export interface TxlineAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

export interface TxlineScoreStreamOptions {
  lastEventId?: string;
  signal?: TxlineAbortSignal;
  onEvent?: (event: TxlineScoreStreamEvent) => void | Promise<void>;
  onScore?: (score: TxlineScore, message: TxlineSseMessage) => void | Promise<void>;
  onHeartbeat?: (event: Extract<TxlineScoreStreamEvent, { kind: 'heartbeat' }>) => void | Promise<void>;
  onOpen?: () => void | Promise<void>;
}

export interface TxlineStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(reason?: unknown): Promise<void>;
  releaseLock?(): void;
}

export interface TxlineReadableBody {
  getReader(): TxlineStreamReader;
}

export interface TxlineResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body?: TxlineReadableBody | null;
}

export type TxlineFetcher = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: TxlineAbortSignal;
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
  seq?: number;
  Seq?: number;
  fixtureId?: number;
  FixtureId?: number;
  Ts?: number;
  StartTime?: number;
  IsTeam?: boolean;
  FixtureGroupId?: number;
  CompetitionId?: number;
  CountryId?: number;
  SportId?: number;
  Participant1IsHome?: boolean;
  Participant1Id?: number;
  Participant1?: string;
  Participant2Id?: number;
  Participant2?: string;
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
  Possession?: unknown;
  StatusId?: number;
  Stats?: Record<string, number>;
  Data?: unknown;
  PossibleEvent?: unknown;
  ts?: number;
}

export interface TxlineGuestSession {
  jwt: string;
}

export type TxlineMatchPulseSource = 'snapshot' | 'history' | 'update';

export type TxlineMatchPulseFreshnessStatus = 'fresh' | 'stale' | 'empty';

export interface TxlineMatchPulseFreshness {
  status: TxlineMatchPulseFreshnessStatus;
  latestTimestamp?: number;
  updatedAt?: string;
  ageMs?: number;
  staleAfterMs: number;
}

export interface TxlineMatchPulseEventTeam {
  id: string;
  name: string;
  shortName: string;
  side: 'home' | 'away';
}

export interface TxlineMatchPulseSourceEvent {
  source: TxlineMatchPulseSource;
  sourceRef: MatchPulseSourceEventRef;
  fixtureId: string;
  seq: number;
  timestamp?: number;
  updatedAt?: string;
  rawAction?: string;
  normalizedAction?: MatchPulseEventAction;
  label?: string;
  intensity: MatchPulseIntensity;
  clock: MatchPulseEvent['clock'];
  clockSeconds?: number;
  participant?: 1 | 2;
  team?: TxlineMatchPulseEventTeam;
  confirmed?: boolean;
  score?: MatchScore;
  gameState?: string;
  statusId?: number;
  possessionType?: string;
}

export interface TxlineMatchPulseSourceContextFixture {
  fixtureId: string;
  competition: string;
  competitionId: string;
  fixtureGroupId: string;
  kickoffUtc: string;
}

export interface TxlineMatchPulseSourceCounts {
  snapshot: number;
  history: number;
  update: number;
}

export interface TxlineMatchPulseSourceContext {
  fixture: TxlineMatchPulseSourceContextFixture;
  homeTeam: MatchTeam;
  awayTeam: MatchTeam;
  status: GameCrewMatchStatus;
  score?: MatchScore;
  clock: MatchClock;
  phase: MatchClock['phase'];
  snapshotScoreId?: string;
  sourceCounts: TxlineMatchPulseSourceCounts;
  freshness: TxlineMatchPulseFreshness;
  sourceEvents: readonly TxlineMatchPulseSourceEvent[];
  snapshotEvents: readonly TxlineMatchPulseSourceEvent[];
  historyEvents: readonly TxlineMatchPulseSourceEvent[];
  updateEvents: readonly TxlineMatchPulseSourceEvent[];
}

export interface BuildTxlineMatchPulseSourceContextOptions {
  fixture: TxlineFixture;
  snapshotScores?: readonly TxlineScore[];
  historyScores?: readonly TxlineScore[];
  updateScores?: readonly TxlineScore[];
  nowMs?: number;
  staleAfterMs?: number;
}
