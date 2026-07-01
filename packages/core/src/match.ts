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

export type MatchPulseIntensity = 'quiet' | 'building' | 'danger' | 'major';

export interface MatchPulse {
  action?: string;
  label: string;
  intensity: MatchPulseIntensity;
  verified?: boolean;
  teamId?: string;
  updatedAt?: string;
}

export type MatchPulseEventAction =
  | 'kickoff'
  | 'goal'
  | 'shot'
  | 'corner'
  | 'free_kick'
  | 'throw_in'
  | 'danger_possession'
  | 'high_danger_possession'
  | 'yellow_card'
  | 'red_card'
  | 'substitution'
  | 'injury'
  | 'var'
  | 'game_finalised';

export interface MatchPulseEventClock {
  seconds?: number;
  minute?: number;
  label: string;
}

export interface MatchPulseEvent {
  id: string;
  fixtureId: string;
  seq: number;
  action: MatchPulseEventAction;
  label: string;
  intensity: MatchPulseIntensity;
  clock: MatchPulseEventClock;
  participant?: 1 | 2;
  teamId?: string;
  teamName?: string;
  confirmed?: boolean;
  updatedAt?: string;
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
  pulse?: MatchPulse;
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
