export type GameCrewMatchFilter = 'live' | 'upcoming' | 'replay' | 'hosted';

export type GameCrewMatchStatus =
  | 'live'
  | 'upcoming'
  | 'finished'
  | 'replayable'
  | 'hosted';

export type MatchPhase =
  | 'pre_match'
  | 'first_half'
  | 'half_time'
  | 'second_half'
  | 'extra_time'
  | 'full_time'
  | 'replay_ready'
  | 'hosted_room';

export interface TeamColorSet {
  primary: string;
  secondary: string;
  accent?: string;
}

export interface FlagVisual {
  code: string;
  emoji?: string;
  bands: readonly string[];
}

export interface MatchTeam {
  id: string;
  name: string;
  shortName: string;
  countryCode: string;
  colors: TeamColorSet;
  flag: FlagVisual;
}

export interface MatchScore {
  home: number;
  away: number;
}

export interface MatchClock {
  minute?: number;
  label: string;
  phase: MatchPhase;
}

export interface ReplayState {
  available: boolean;
  label?: string;
}

export interface HostedState {
  available: boolean;
  label: string;
}

export interface TxlineFixtureReference {
  fixtureId: string;
  scoreSnapshotId?: string;
  historicalSnapshotId?: string;
  source?: 'live' | 'sample';
}

export interface GameCrewMatch {
  id: string;
  txline: TxlineFixtureReference;
  filter: GameCrewMatchFilter;
  status: GameCrewMatchStatus;
  competition: string;
  round?: string;
  kickoffUtc: string;
  homeTeam: MatchTeam;
  awayTeam: MatchTeam;
  score?: MatchScore;
  clock: MatchClock;
  replay?: ReplayState;
  hosted?: HostedState;
}

export function getMatchTitle(match: GameCrewMatch): string {
  return `${match.homeTeam.name} vs ${match.awayTeam.name}`;
}

export function getMatchResultLabel(match: GameCrewMatch): string {
  if (match.score) {
    return `${match.score.home} - ${match.score.away}`;
  }

  return match.clock.label;
}
