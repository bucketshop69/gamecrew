import type { BeatNarrative } from './match-engine/narrative';

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

/**
 * Visual and voice urgency for a pulse item.
 *
 * - `quiet`: low-signal or informational state.
 * - `building`: pressure or match context is developing.
 * - `danger`: source events suggest an attacking threat.
 * - `major`: confirmed major event such as a goal or card.
 */
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

/**
 * Product-level moment category rendered to users.
 *
 * Factual types are source-event shaped; intelligent types are generated from one
 * or more source facts. Unknown future TxLINE actions should be represented with
 * the closest stable type, usually `system` or `fallback`, while preserving the
 * raw source action in `sourceEvents`.
 */
export type MatchPulseMomentType =
  | 'goal'
  | 'card'
  | 'shot'
  | 'set_piece'
  | 'corner'
  | 'free_kick'
  | 'throw_in'
  | 'penalty'
  | 'danger'
  | 'pressure'
  | 'substitution'
  | 'injury'
  | 'var'
  | 'phase_change'
  | 'momentum'
  | 'tactical'
  | 'commentary'
  | 'system'
  | 'fallback';

/**
 * How strongly a user-facing moment can be trusted.
 *
 * - `verified`: directly confirmed by TxLINE or another authoritative source.
 * - `source_backed`: grounded in source facts, but not necessarily confirmed.
 * - `inferred`: interpretation from one or more source-backed facts.
 * - `low`: partial or weak context; copy should be cautious.
 */
export type MatchPulseMomentConfidence = 'verified' | 'source_backed' | 'inferred' | 'low';

/**
 * How the user-facing moment copy was produced.
 *
 * - `raw`: direct source moment with minimal formatting.
 * - `rule_based`: deterministic generated or fallback copy.
 * - `llm`: LLM-enriched copy that must remain bounded by source events.
 */
export type MatchPulseMomentGeneration = 'raw' | 'rule_based' | 'llm';

export type MatchPulseMomentumSide = 'home' | 'away' | 'neutral' | 'both' | 'unknown';

export type MatchPulseCommentaryEntryKind = MatchPulseMomentType;

export type MatchPulseEnrichmentStatus =
  | 'not_needed'
  | 'pending'
  | 'complete'
  | 'failed'
  | 'fallback';

export type MatchPulseSourceEventAction = MatchPulseEventAction | (string & {});

export type MatchPulseSourceEventKind =
  | 'match_pulse_event'
  | 'txline_score'
  | 'txline_history'
  | 'txline_update'
  | 'txline_snapshot'
  | 'system';

/**
 * Auditable link from a product moment back to the source fact or snapshot that
 * allowed it to be shown. `action` accepts future TxLINE strings so raw source
 * truth can be preserved even before the product contract learns a new moment
 * type.
 */
export interface MatchPulseSourceEventRef {
  kind: MatchPulseSourceEventKind;
  id?: string;
  eventId?: MatchPulseEvent['id'];
  fixtureId?: string;
  seq?: number;
  action?: MatchPulseSourceEventAction;
  label?: string;
  clock?: MatchPulseEventClock;
  participant?: MatchPulseEvent['participant'];
  teamId?: string;
  teamName?: string;
  confirmed?: boolean;
  scoreSnapshotId?: string;
  historicalSnapshotId?: string;
  updatedAt?: string;
}

export interface MatchPulseMomentTeamRef {
  id: string;
  name?: string;
  shortName?: string;
  side?: 'home' | 'away';
}

export type MatchPulseBoardZone =
  | 'defensive_third'
  | 'middle_third'
  | 'attacking_third'
  | 'box'
  | 'unknown';

export type MatchPulseBoardPressure = 'none' | 'building' | 'danger' | 'high_danger';

export type MatchPulseBoardBallState = 'open_play' | 'set_piece' | 'stopped' | 'unknown';

export type MatchPulseBoardDirection = 'home_to_away' | 'away_to_home' | 'unknown';

/**
 * Future abstract-board metadata. These fields should describe only the source
 * signal GameCrew actually has, not inferred player or ball tracking.
 */
export interface MatchPulseBoardHint {
  side?: MatchPulseMomentumSide;
  teamId?: string;
  zone?: MatchPulseBoardZone;
  pressure?: MatchPulseBoardPressure;
  ballState?: MatchPulseBoardBallState;
  direction?: MatchPulseBoardDirection;
}

export interface MatchPulseMoment {
  id: string;
  fixtureId: string;
  period: MatchPhase;
  clock: MatchPulseEventClock;
  sortTimestamp?: string;
  sortSeq?: number;
  type: MatchPulseMomentType;
  team?: MatchPulseMomentTeamRef;
  opponent?: MatchPulseMomentTeamRef;
  scoreAtMoment?: MatchScore;
  sourceEvents: readonly MatchPulseSourceEventRef[];
  title: string;
  body: string;
  intensity: MatchPulseIntensity;
  momentumSide: MatchPulseMomentumSide;
  confidence: MatchPulseMomentConfidence;
  generation: MatchPulseMomentGeneration;
  fallbackTitle: string;
  fallbackBody?: string;
  voiceLine?: string;
  boardHint?: MatchPulseBoardHint;
}

export interface MatchPulseCommentaryEntry {
  id: string;
  fixtureId: string;
  batchId: string;
  fromSeq?: number;
  toSeq?: number;
  period: MatchPhase;
  clock: MatchPulseEventClock;
  sortTimestamp?: string;
  sortSeq?: number;
  kind: MatchPulseCommentaryEntryKind;
  team?: MatchPulseMomentTeamRef;
  opponent?: MatchPulseMomentTeamRef;
  scoreAtMoment?: MatchScore;
  sourceEvents: readonly MatchPulseSourceEventRef[];
  commentary: string;
  voiceLine?: string;
  intensity: MatchPulseIntensity;
  momentumSide: MatchPulseMomentumSide;
  confidence: MatchPulseMomentConfidence;
  generation: MatchPulseMomentGeneration;
  fallbackCommentary: string;
  enrichmentStatus: MatchPulseEnrichmentStatus;
  boardHint?: MatchPulseBoardHint;
  /** Optional engine grounding for durable, generation-safe commentary. */
  projectionGeneration?: number;
  /** Deterministic planner contract version that produced this entry. */
  commentaryPlanVersion?: number;
  commentaryBeatKind?: 'routine' | 'pressure' | 'major';
  mustCover?: boolean;
  sourceFrameIds?: readonly string[];
  factIds?: readonly string[];
  cueIds?: readonly string[];
  groundedFacts?: readonly MatchPulseCommentaryGroundedFact[];
  coveredFrameIds?: readonly string[];
  enrichmentPromptVersion?: string;
  /** Deterministic match-memory context for this beat; relevance-gated, computed by computeBeatNarrative. */
  narrative?: BeatNarrative;
}

export interface MatchPulseCommentaryGroundedFact {
  id: string;
  kind: string;
  action?: string;
  lifecycle?: string;
  basis?: 'direct' | 'derived_probable';
  participant?: number;
  teamId?: string;
  playerName?: string;
  pressure?: string;
  probableZone?: string;
  value: Record<string, unknown>;
  sourceSeqs: readonly number[];
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
  /** TxLINE's explicit participant-to-side mapping; clients must not guess it. */
  participant1IsHome?: boolean;
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
