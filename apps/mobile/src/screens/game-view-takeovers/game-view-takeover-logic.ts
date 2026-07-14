import type {
  GameViewGoalBeat,
  GameViewScene,
  GameViewSceneKind,
  MatchEnginePhase,
  MatchEngineScore,
  NarrativeScoreEvent,
} from '@gamecrew/core';

/**
 * Pure presentation logic for the Game View takeover renderers. Nothing in
 * this file touches React, Animated, or any RN API, so it is testable with
 * plain `node:test` assertions (see tests/game-view-takeover-logic.test.mjs).
 * Components import from here and stay thin.
 */

// ---------------------------------------------------------------------------
// Player display name
// ---------------------------------------------------------------------------

/**
 * Humanizes a raw source player name into "firstname surname" display order.
 * Mirrors packages/core's internal `displayPlayerName` (match-engine/commentary.ts),
 * which is not part of @gamecrew/core's public surface, so the takeover
 * renderers carry their own copy of the same rule rather than reaching into
 * core's internals. Source names arrive either already in display order, or
 * as "Surname, Given Name" -- the comma is the only signal we act on.
 */
export function formatPlayerDisplayName(rawName: string | undefined): string | undefined {
  if (!rawName) return undefined;
  const trimmed = rawName.trim();
  if (!trimmed) return undefined;

  const commaIndex = trimmed.indexOf(',');
  if (commaIndex === -1) return dedupeAdjacentTokens(trimmed);

  const surnamePart = trimmed.slice(0, commaIndex).trim();
  const givenPart = trimmed.slice(commaIndex + 1).trim();
  if (!surnamePart || !givenPart) {
    return dedupeAdjacentTokens(trimmed.replace(/,/g, ' ').replace(/\s+/g, ' ').trim());
  }

  const surname = dedupeAdjacentTokens(surnamePart);
  return `${givenPart} ${surname}`.replace(/\s+/g, ' ').trim();
}

function dedupeAdjacentTokens(value: string): string {
  const tokens = value.split(/\s+/).filter(Boolean);
  const deduped: string[] = [];
  for (const token of tokens) {
    if (deduped[deduped.length - 1]?.toLowerCase() !== token.toLowerCase()) deduped.push(token);
  }
  return deduped.join(' ');
}

/** Preferred display name for a scene/beat's player: displayName, else the source's preferred name, humanized. */
export function playerDisplayName(
  player: { displayName?: string; sourcePreferredName?: string } | undefined,
): string | undefined {
  if (!player) return undefined;
  const raw = player.displayName ?? player.sourcePreferredName;
  return formatPlayerDisplayName(raw);
}

// ---------------------------------------------------------------------------
// Scoreline formatting
// ---------------------------------------------------------------------------

/** Formats a score as "home-away" with no invented separators or padding beyond the digits themselves. */
export function formatScoreline(score: MatchEngineScore | undefined): string {
  if (!score) return '';
  return `${score.participant1}-${score.participant2}`;
}

// ---------------------------------------------------------------------------
// Goal sequence: beat sequencing / timing plan
// ---------------------------------------------------------------------------

export interface GoalBeatPlanEntry {
  beat: GameViewGoalBeat;
  index: number;
  /** Offset in ms from the start of the goal_sequence takeover playback. */
  offsetMs: number;
  /** How long this beat should hold before advancing (or firing onComplete on the last beat). */
  durationMs: number;
}

/** Minimum readable hold time for a single beat, used when a scene's durationHint leaves little room per beat. */
const MIN_BEAT_MS = 1200;

/**
 * Splits a goal_sequence scene's `durationHint` across its ordered beats,
 * weighting celebration (the payoff) more than tension (the setup). A scene
 * with only one beat (e.g. a still-pending goal with just its tension beat)
 * gets the full duration. Never returns zero beats for a scene that has
 * beats; an empty/undefined `beats` array yields an empty plan, and the
 * caller (the component) is responsible for deciding what a beat-less
 * goal_sequence scene means.
 */
export function planGoalSequenceBeats(scene: GameViewScene): readonly GoalBeatPlanEntry[] {
  const beats = scene.beats ?? [];
  if (beats.length === 0) return [];

  const totalMs = Math.max(scene.durationHint.minMs, MIN_BEAT_MS * beats.length);

  // Weight: tension beats get 1 share, celebration beats get 2 shares, so the
  // payoff beat holds roughly twice as long as the checking treatment.
  const weights = beats.map((beat) => (beat.kind === 'celebration' ? 2 : 1));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  let offsetMs = 0;
  const plan: GoalBeatPlanEntry[] = [];
  beats.forEach((beat, index) => {
    const share = weights[index]! / totalWeight;
    const durationMs = index === beats.length - 1
      ? Math.max(MIN_BEAT_MS, totalMs - offsetMs)
      : Math.max(MIN_BEAT_MS, Math.round(totalMs * share));
    plan.push({ beat, index, offsetMs, durationMs });
    offsetMs += durationMs;
  });

  return plan;
}

/** Total planned playback duration across all beats, in ms. */
export function totalGoalSequenceDurationMs(plan: readonly GoalBeatPlanEntry[]): number {
  const last = plan[plan.length - 1];
  if (!last) return 0;
  return last.offsetMs + last.durationMs;
}

/**
 * Resolves which beat of a planned goal_sequence should be considered
 * "active" at `elapsedMs` since the takeover started. `GoalSequenceTakeover`
 * itself tracks its active beat with its own timer-driven React state (see
 * `AnimatedGoalSequence`); this pure function gives `GameViewScreen` a way
 * to derive the same beat-boundary information independently, for fix #3
 * (no score spoiler) -- it schedules an equivalent beat-boundary timer so it
 * knows when the celebration beat has actually started and it's safe to
 * commit the new score to the header/score rail, see `resolveScoreRailScore`
 * in game-view-screen-logic.ts. Clamps to the last beat once `elapsedMs`
 * exceeds the plan (matches "the takeover holds on the last beat"
 * behavior). Returns 0 for an empty plan.
 */
export function activeGoalSequenceBeatIndex(
  plan: readonly GoalBeatPlanEntry[],
  elapsedMs: number,
): number {
  if (plan.length === 0) return 0;
  for (let index = plan.length - 1; index >= 0; index -= 1) {
    if (elapsedMs >= plan[index]!.offsetMs) return index;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Goal sequence: score-event variant escalation
// ---------------------------------------------------------------------------

export type GoalSequenceEscalation = 'comeback' | 'late_winner' | undefined;

/**
 * Chooses the single escalation line to show under the scoreline, from a
 * celebration scene's `scoreEvents`. Data-driven only: never invents an
 * escalation when scoreEvents doesn't carry one. `comeback` outranks
 * `late_winner` when a scene somehow carries both, since a comeback is the
 * rarer, more dramatic story (mirrors the director's own
 * comeback-before-late_winner priority ordering).
 */
export function selectGoalSequenceEscalation(
  scoreEvents: readonly NarrativeScoreEvent[] | undefined,
): GoalSequenceEscalation {
  if (!scoreEvents || scoreEvents.length === 0) return undefined;
  if (scoreEvents.includes('comeback')) return 'comeback';
  if (scoreEvents.includes('late_winner')) return 'late_winner';
  return undefined;
}

export function escalationLabel(escalation: GoalSequenceEscalation): string | undefined {
  if (escalation === 'comeback') return 'COMEBACK';
  if (escalation === 'late_winner') return 'LATE WINNER';
  return undefined;
}

// ---------------------------------------------------------------------------
// Card variant resolution
// ---------------------------------------------------------------------------

export type CardVariant = 'yellow' | 'red';

/**
 * The director's `card` scene does not carry the source cue's
 * `value.action` (only participant/team/player/lifecycle survive onto the
 * scene -- see packages/core's match-engine/game-view.ts `handleCard`), so
 * the renderer cannot derive yellow-vs-red from the scene alone. The
 * dispatcher accepts an explicit `variant` prop supplied by the caller
 * (which does have access to the originating cue) and this function just
 * normalizes/validates it with a safe default, so a missing or unrecognized
 * value never crashes the takeover -- it renders as the less severe card
 * rather than inventing a red card that didn't happen.
 */
export function resolveCardVariant(variant: CardVariant | undefined): CardVariant {
  return variant === 'red' ? 'red' : 'yellow';
}

// ---------------------------------------------------------------------------
// Set-piece variant resolution
// ---------------------------------------------------------------------------

export type SetPieceVariant = 'corner' | 'free_kick' | 'throw_in' | 'penalty';

const SET_PIECE_LABELS: Record<SetPieceVariant, string> = {
  corner: 'CORNER',
  free_kick: 'FREE KICK',
  throw_in: 'THROW-IN',
  penalty: 'PENALTY',
};

/**
 * Same shape of problem as `resolveCardVariant`: the set_piece scene itself
 * doesn't carry the specific set-piece type, so the caller supplies it from
 * the source cue. Falls back to 'free_kick' (the most generic dead-ball
 * restart) rather than guessing a more specific type the data didn't confirm.
 */
export function resolveSetPieceVariant(variant: SetPieceVariant | undefined): SetPieceVariant {
  if (variant === 'corner' || variant === 'throw_in' || variant === 'penalty') return variant;
  return 'free_kick';
}

export function setPieceLabel(variant: SetPieceVariant): string {
  return SET_PIECE_LABELS[variant];
}

// ---------------------------------------------------------------------------
// Phase break labeling
// ---------------------------------------------------------------------------

export type PhaseBreakMoment = 'kickoff' | 'half_time' | 'full_time' | 'extra_time' | 'other';

const PHASE_BREAK_MOMENT_BY_PHASE: Partial<Record<MatchEnginePhase, PhaseBreakMoment>> = {
  pre_match: 'kickoff',
  first_half_ready: 'kickoff',
  first_half: 'kickoff',
  half_time: 'half_time',
  second_half_ready: 'half_time',
  full_time_pending: 'full_time',
  finalised: 'full_time',
};

const PHASE_BREAK_LABELS: Record<PhaseBreakMoment, string> = {
  kickoff: 'KICK OFF',
  half_time: 'HALF TIME',
  full_time: 'FULL TIME',
  extra_time: 'EXTRA TIME',
  other: 'MATCH UPDATE',
};

/**
 * Maps a phase_break scene's `phase` field (the only signal it carries for
 * which break this is) to a coarse moment used to pick a label. A
 * phase_break scene always carries the *new* phase it is transitioning into
 * (see game-view.ts handlePhaseChange), so 'first_half'/'first_half_ready'
 * mean the match is kicking off, not that we're mid-first-half.
 */
export function resolvePhaseBreakMoment(phase: MatchEnginePhase | undefined): PhaseBreakMoment {
  if (!phase) return 'other';
  return PHASE_BREAK_MOMENT_BY_PHASE[phase] ?? 'other';
}

export function phaseBreakLabel(moment: PhaseBreakMoment): string {
  return PHASE_BREAK_LABELS[moment];
}

// ---------------------------------------------------------------------------
// Dispatcher mapping
// ---------------------------------------------------------------------------

export type GameViewTakeoverComponentKind =
  | 'goal_sequence'
  | 'card'
  | 'set_piece'
  | 'var_review'
  | 'goal_retracted'
  | 'phase_break'
  | 'restart'
  | 'none';

/**
 * Maps a GameViewScene.kind to the takeover component that should render it.
 * 'ambient', 'shot', and 'substitution' are not takeovers this work item
 * builds (ambient is the base layer per the PRD's "Two Layers Of Graphics";
 * shot/substitution are not in this item's scope) -- the dispatcher renders
 * nothing for them so it never claims a component that doesn't exist.
 */
export function resolveTakeoverComponentKind(kind: GameViewSceneKind): GameViewTakeoverComponentKind {
  switch (kind) {
    case 'goal_sequence': return 'goal_sequence';
    case 'card': return 'card';
    case 'set_piece': return 'set_piece';
    case 'var_review': return 'var_review';
    case 'goal_retracted': return 'goal_retracted';
    case 'phase_break': return 'phase_break';
    case 'restart': return 'restart';
    default: return 'none';
  }
}

// ---------------------------------------------------------------------------
// Reduce-motion static duration
// ---------------------------------------------------------------------------

/**
 * With reduce-motion on, a takeover still needs to hold on screen long
 * enough to be read (no animation, but not an instant flash either) and
 * still needs to call onComplete so playback advances. Uses the scene's own
 * durationHint.minMs as a floor so a caller-supplied playback schedule
 * (scene.playback) isn't second-guessed, and a sane minimum when a scene
 * carries no hint at all.
 */
export function reduceMotionHoldMs(durationHintMinMs: number | undefined): number {
  return Math.max(durationHintMinMs ?? 0, MIN_BEAT_MS);
}
