export type MatchEngineParticipant = 1 | 2;

export type MatchEngineLifecycle =
  | 'observed'
  | 'provisional'
  | 'confirmed'
  | 'retracted'
  | 'unresolved';

export type MatchEngineBasis = 'direct' | 'derived_probable';

export type MatchEnginePhase =
  | 'pre_match'
  | 'first_half_ready'
  | 'first_half'
  | 'half_time'
  | 'second_half_ready'
  | 'second_half'
  | 'full_time_pending'
  | 'finalised';

export type MatchEnginePressure =
  | 'neutral'
  | 'safe'
  | 'attack'
  | 'danger'
  | 'high_danger';

export interface MatchEngineTeam {
  participant: MatchEngineParticipant;
  teamId: number | string;
  name: string;
  isHome?: boolean;
}

export interface MatchEnginePlayer {
  normativeId: number;
  participant: MatchEngineParticipant;
  teamId: number | string;
  sourcePreferredName: string;
  displayName?: string;
  fixturePlayerId?: number;
  sourceId?: string;
  starter?: boolean;
  positionId?: number;
  statusId?: number;
  unitId?: number;
  rosterNumber?: string;
  starred?: boolean;
  raw?: Record<string, unknown>;
}

export interface MatchEngineContext {
  fixtureId: number | string;
  sequenceBefore?: number;
  participants: MatchEngineTeam[];
  confirmedScore: {
    participant1: number;
    participant2: number;
  };
  players?: Record<string, MatchEnginePlayer>;
  phase?: MatchEnginePhase;
}

export interface TxlineMatchEngineRecord {
  FixtureId: number | string;
  Seq: number;
  Id: number | string;
  Action: string;
  Ts?: number;
  Confirmed?: boolean;
  StatusId?: number;
  Participant?: number;
  Possession?: number;
  PossessionType?: string;
  Clock?: {
    Running?: boolean;
    Seconds?: number;
    [key: string]: unknown;
  };
  Data?: Record<string, unknown> | null;
  Score?: Record<string, unknown>;
  Stats?: Record<string, number>;
  Kickoff?: { Team?: number; [key: string]: unknown };
  Parti1State?: Record<string, unknown>;
  Parti2State?: Record<string, unknown>;
  PossibleEvent?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MatchEngineProvenance {
  fixtureId: number | string;
  action: string;
  sourceId: number | string;
  seq: number;
}

export interface CanonicalIncident {
  key: string;
  fixtureId: number | string;
  action: string;
  sourceId: number | string;
  lifecycle: MatchEngineLifecycle;
  basis: 'direct';
  revision: number;
  sourceSeqs: number[];
  firstSeenSeq: number;
  lastUpdatedSeq: number;
  occurrenceSeconds?: number;
  participant?: MatchEngineParticipant;
  teamId?: number | string;
  data: Record<string, unknown>;
  player?: MatchEnginePlayer;
  score?: MatchEngineScore;
}

export interface MatchEngineScore {
  participant1: number;
  participant2: number;
}

export interface MatchEnginePossessionState {
  participant: MatchEngineParticipant;
  teamId?: number | string;
  pressure?: MatchEnginePressure;
  /** A semantic band for animation; never an asserted pitch coordinate. */
  probableZone?: MatchEnginePressure;
  basis: MatchEngineBasis;
  seq: number;
}

export interface MatchEngineLiveClock {
  phase: MatchEnginePhase;
  running: boolean;
  seconds?: number;
  seq: number;
}

export interface MatchEnginePlayerDiscipline {
  yellowCards: number;
  redCards: number;
  sourceIncidentKeys: string[];
}

export interface SupportedFact {
  id: string;
  kind: 'incident' | 'score' | 'possession' | 'possible_event' | 'restart' | 'phase';
  lifecycle: MatchEngineLifecycle;
  basis: MatchEngineBasis;
  revision: number;
  participant?: MatchEngineParticipant;
  teamId?: number | string;
  player?: MatchEnginePlayer;
  value: Record<string, unknown>;
  occurrenceSeconds?: number;
  sourceSeqs: number[];
  provenance: MatchEngineProvenance;
}

export interface SimulationCue {
  id: string;
  kind:
    | 'set_piece'
    | 'possession_change'
    | 'possession_pressure'
    | 'possible_event'
    | 'shot_attempt'
    | 'shot_outcome'
    | 'goal_pending'
    | 'goal_confirmed'
    | 'player_highlight'
    | 'score_commit'
    | 'restart'
    | 'card'
    | 'substitution'
    | 'injury'
    | 'additional_time'
    | 'var'
    | 'incident'
    | 'incident_retracted'
    | 'phase_change';
  updateMode: 'incident_upsert' | 'state_replace';
  lifecycle: MatchEngineLifecycle;
  basis: MatchEngineBasis;
  revision: number;
  participant?: MatchEngineParticipant;
  teamId?: number | string;
  player?: MatchEnginePlayer;
  pressure?: MatchEnginePressure;
  probableZone?: MatchEnginePressure;
  value: Record<string, unknown>;
  occurrenceSeconds?: number;
  sourceSeqs: number[];
  factIds: string[];
  derivation?: {
    ruleId: string;
    ruleVersion: number;
    inputFactIds: string[];
  };
}

export interface SemanticFrame {
  id: string;
  fixtureId: number | string;
  seq: number;
  stateRevision: number;
  sourceTimestamp?: number;
  matchClockSeconds?: number;
  facts: SupportedFact[];
  simulationCues: SimulationCue[];
}

export interface CanonicalMatchState {
  fixtureId: number | string;
  lastAppliedSeq: number;
  stateRevision: number;
  phase: MatchEnginePhase;
  liveClock?: MatchEngineLiveClock;
  lastMeaningfulElapsedSeconds?: number;
  lastPlayingElapsedSeconds?: number;
  confirmedScore: MatchEngineScore;
  provisionalScore?: MatchEngineScore;
  finalScore?: MatchEngineScore;
  possession?: MatchEnginePossessionState;
  possibleEvents: Record<string, Record<string, boolean>>;
  activePlayerIdsByParticipant: Record<string, number[]>;
  disciplineByPlayerId: Record<string, MatchEnginePlayerDiscipline>;
  incidents: Record<string, CanonicalIncident>;
  supportedFacts: Record<string, SupportedFact>;
  simulationCues: Record<string, SimulationCue>;
  integrityWarnings: string[];
}

export interface MatchEngineReplayResult {
  ledger: TxlineMatchEngineRecord[];
  ignoredDuplicateCount: number;
  state: CanonicalMatchState;
  frames: SemanticFrame[];
}
