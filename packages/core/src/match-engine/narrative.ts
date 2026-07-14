import type {
  CanonicalMatchState,
  CommentaryBeat,
  MatchEngineParticipant,
  MatchEnginePhase,
  MatchEngineScore,
  SimulationCue,
} from './types';

/**
 * Classifies how a confirmed goal changes the score story. A goal can satisfy
 * more than one label (a stoppage-time goal that also completes a comeback is
 * both `comeback` and `late_winner`), so `scoreStory.events` is an ordered
 * array rather than a single enum. Ordering is most-specific first:
 * `comeback` / `late_winner` (narratively strongest) before the structural
 * `lead_change`, `equaliser`, `opener`, `extends_lead` labels.
 *
 * Classification rules (evaluated against the score immediately before this
 * goal vs. immediately after):
 * - `opener`: before score was 0-0.
 * - `equaliser`: after score is level and before score was not level.
 * - `extends_lead`: the scoring team already led before the goal and still
 *   leads after it (the gap grows or stays but nobody was level/behind).
 * - `lead_change`: the scoring team was not leading before the goal (behind
 *   or level) and leads after it, excluding the `opener` case (0-0 before)
 *   which is labelled `opener` only.
 * - `comeback`: the scoring team was trailing by 2 or more goals at some
 *   point earlier in the match and this goal brings the score level or in
 *   front for the first time since falling behind by 2+.
 * - `late_winner`: this goal's time context is `closing_stages` or
 *   `stoppage`, and it moves the match from level to a decisive lead for the
 *   scoring team (i.e. a `lead_change` or the second half of an `equaliser`
 *   turning into a lead is not late_winner - it must go from level to ahead).
 */
export type NarrativeScoreEvent =
  | 'opener'
  | 'equaliser'
  | 'extends_lead'
  | 'comeback'
  | 'lead_change'
  | 'late_winner';

/**
 * Coarse phase-and-clock bucket used to decide whether a beat deserves extra
 * narrative weight. Derived from `CommentaryBeat.matchClockSeconds` (falling
 * back to the beat's source facts' `phase` where available) plus the phase
 * carried alongside it in beat history.
 *
 * - `early`: first 10 minutes of a half (0-599s of playing time in that half).
 * - `normal`: mid-half play, nothing time-notable.
 * - `pre_halftime`: last 5 minutes of the first half (2400-2699s), before any
 *   stoppage time is added.
 * - `closing_stages`: last 10 minutes of regulation in the second half
 *   (4800-5399s).
 * - `stoppage`: match clock has passed a half's regulation length (>=2700s in
 *   the first half, >=5400s in the second half). First-half stoppage is
 *   reported as `stoppage` (not `pre_halftime`) once the clock crosses 45:00,
 *   since it is the more specific and more narratively relevant bucket.
 */
export type NarrativeTimeContext =
  | 'early'
  | 'normal'
  | 'pre_halftime'
  | 'closing_stages'
  | 'stoppage';

const HALF_REGULATION_SECONDS = 45 * 60;
const EARLY_WINDOW_SECONDS = 10 * 60;
const PRE_HALFTIME_WINDOW_SECONDS = 5 * 60;
const CLOSING_STAGES_WINDOW_SECONDS = 10 * 60;
/** Momentum window: recent match-minutes considered for set-piece counting. */
const MOMENTUM_WINDOW_SECONDS = 10 * 60;
/** Trailing-by-2 threshold that qualifies a subsequent goal as a `comeback`. */
const COMEBACK_DEFICIT_THRESHOLD = 2;

export interface BeatNarrativeScoreStory {
  before: MatchEngineScore;
  after: MatchEngineScore;
  /** Ordered, most-narratively-significant first. Always has at least one entry. */
  events: readonly NarrativeScoreEvent[];
  /** Total number of times the lead has changed hands (excluding level-to-level), up to and including this goal. */
  leadChangeCount: number;
  derivedFrom: readonly string[];
}

export interface BeatNarrativeDiscipline {
  teamYellowCount: number;
  teamRedCount: number;
  /** Yellow cards this player had accumulated strictly before this beat's card. */
  playerPriorYellows: number;
  /** True when this beat's card is a red shown for a second bookable offence. */
  secondYellowRed: boolean;
  /** True when the carded player's side has fewer than 11 eligible players remaining as a result. */
  menRemainingReduced: boolean;
  derivedFrom: readonly string[];
}

export interface BeatNarrativePlayerMemory {
  /** Number of confirmed goals by this scorer in the match, including this one. */
  scorerGoalsThisMatch: number;
  derivedFrom: readonly string[];
}

export interface BeatNarrativeMomentum {
  /** Consecutive pressure/routine beats immediately preceding (and including) this one for the same team. */
  pressureSpellBeats: number;
  /** Corner and free-kick set pieces for this team within the recent match-minute window (see MOMENTUM_WINDOW_SECONDS = 10 match-minutes). */
  setPieceCountRecentWindow: number;
  derivedFrom: readonly string[];
}

export interface BeatNarrative {
  scoreStory?: BeatNarrativeScoreStory;
  discipline?: BeatNarrativeDiscipline;
  playerMemory?: BeatNarrativePlayerMemory;
  momentum?: BeatNarrativeMomentum;
  timeContext?: NarrativeTimeContext;
}

export interface ComputeBeatNarrativeArgs {
  beat: CommentaryBeat;
  beatIndex: number;
  /** Ordered full beat history up to and including `beat` (beats[beatIndex] === beat). */
  beats: readonly CommentaryBeat[];
  state: CanonicalMatchState;
}

/**
 * Computes a deterministic, relevance-gated narrative memory slice for a
 * single beat. Returns `undefined` when the beat is routine and nothing
 * about it is notable enough to carry memory (the common case).
 *
 * Relevance gating: goal beats may carry `scoreStory` + `playerMemory` (+
 * `timeContext` when notable); card beats may carry `discipline` (+
 * `timeContext` when notable); set-piece/pressure beats may carry
 * `momentum`. `timeContext` is never attached on its own to a beat that
 * otherwise has no other slice - it only rides along with a slice above, or
 * is omitted.
 */
export function computeBeatNarrative(args: ComputeBeatNarrativeArgs): BeatNarrative | undefined {
  const { beat, beatIndex, beats, state } = args;
  const goalCue = beat.simulationCues.find((cue) => cue.kind === 'goal_confirmed');
  const cardCue = beat.simulationCues.find((cue) => cue.kind === 'card');
  const isMomentumBeat = beat.kind === 'pressure'
    || beat.simulationCues.some((cue) => cue.kind === 'set_piece' || cue.kind === 'possession_pressure');

  const narrative: BeatNarrative = {};

  if (goalCue) {
    const scoreStory = computeScoreStory(beat, beatIndex, beats, goalCue);
    if (scoreStory) narrative.scoreStory = scoreStory;
    const playerMemory = computePlayerMemory(beat, beatIndex, beats, goalCue);
    if (playerMemory) narrative.playerMemory = playerMemory;
  } else if (cardCue) {
    const discipline = computeDiscipline(beat, beatIndex, beats, state, cardCue);
    if (discipline) narrative.discipline = discipline;
  } else if (isMomentumBeat) {
    const momentum = computeMomentum(beat, beatIndex, beats);
    if (momentum) narrative.momentum = momentum;
  }

  const hasSlice = narrative.scoreStory || narrative.discipline || narrative.playerMemory || narrative.momentum;
  if (hasSlice) {
    const timeContext = deriveTimeContext(beat, beats, beatIndex);
    if (timeContext === 'pre_halftime' || timeContext === 'closing_stages' || timeContext === 'stoppage') {
      narrative.timeContext = timeContext;
    }
  }

  return hasSlice ? narrative : undefined;
}

function scoreBeforeGoal(
  beats: readonly CommentaryBeat[],
  beatIndex: number,
): { score: MatchEngineScore; derivedFrom: string[] } {
  for (let index = beatIndex - 1; index >= 0; index -= 1) {
    const priorScoreCue = beats[index]!.simulationCues.find((cue) => cue.kind === 'score_commit');
    if (priorScoreCue) {
      const value = priorScoreCue.value as { participant1?: unknown; participant2?: unknown };
      if (typeof value.participant1 === 'number' && typeof value.participant2 === 'number') {
        return {
          score: { participant1: value.participant1, participant2: value.participant2 },
          derivedFrom: [priorScoreCue.id],
        };
      }
    }
  }
  return { score: { participant1: 0, participant2: 0 }, derivedFrom: [] };
}

function computeScoreStory(
  beat: CommentaryBeat,
  beatIndex: number,
  beats: readonly CommentaryBeat[],
  goalCue: SimulationCue,
): BeatNarrativeScoreStory | undefined {
  const scoreCue = beat.simulationCues.find((cue) => cue.kind === 'score_commit');
  const afterValue = scoreCue?.value as { participant1?: unknown; participant2?: unknown } | undefined;
  if (typeof afterValue?.participant1 !== 'number' || typeof afterValue?.participant2 !== 'number') return undefined;
  const after: MatchEngineScore = { participant1: afterValue.participant1, participant2: afterValue.participant2 };

  const scorer = goalCue.participant;
  if (scorer !== 1 && scorer !== 2) return undefined;

  const { score: before, derivedFrom: beforeDerivedFrom } = scoreBeforeGoal(beats, beatIndex);

  const events: NarrativeScoreEvent[] = [];
  const beforeLevel = before.participant1 === before.participant2;
  const afterLevel = after.participant1 === after.participant2;
  const scorerLedBefore = scorer === 1 ? before.participant1 > before.participant2 : before.participant2 > before.participant1;
  const scorerLeadsAfter = scorer === 1 ? after.participant1 > after.participant2 : after.participant2 > after.participant1;

  if (beforeLevel && before.participant1 === 0) {
    events.push('opener');
  }
  if (!beforeLevel && afterLevel) {
    events.push('equaliser');
  }
  if (scorerLedBefore && scorerLeadsAfter) {
    events.push('extends_lead');
  }
  // lead_change: the scorer's side was not leading before (trailing or
  // level) and takes the lead with this goal. The pure "0-0 -> 1-0" and
  // "level -> level-broken-by-equaliser" cases are covered by the more
  // specific `opener` / `equaliser` labels above and are not double-labelled
  // as lead_change unless the scorer specifically moves from behind/level to
  // in front (equaliser only reaches level, never ahead, so no overlap there).
  if (!scorerLedBefore && scorerLeadsAfter && !(beforeLevel && before.participant1 === 0)) {
    events.push('lead_change');
  }

  // Comeback: the scorer's side was down by 2+ at some earlier point in the
  // match and this goal is the moment they reach level or in front again.
  const wasDownByTwoOrMore = beats.slice(0, beatIndex).some((priorBeat) => {
    const priorScore = priorBeat.simulationCues.find((cue) => cue.kind === 'score_commit')?.value as
      | { participant1?: unknown; participant2?: unknown }
      | undefined;
    if (typeof priorScore?.participant1 !== 'number' || typeof priorScore?.participant2 !== 'number') return false;
    const deficit = scorer === 1
      ? priorScore.participant2 - priorScore.participant1
      : priorScore.participant1 - priorScore.participant2;
    return deficit >= COMEBACK_DEFICIT_THRESHOLD;
  });
  if (wasDownByTwoOrMore && (afterLevel || scorerLeadsAfter) && !scorerLedBefore) {
    events.push('comeback');
  }

  const timeContext = deriveTimeContext(beat, beats, beatIndex);
  const isLate = timeContext === 'closing_stages' || timeContext === 'stoppage';
  if (isLate && beforeLevel && !afterLevel && scorerLeadsAfter) {
    events.push('late_winner');
  }

  if (events.length === 0) {
    // Every confirmed goal has at least a structural classification: if none
    // of the above matched, the scorer's side already led before and still
    // leads (covered by extends_lead) or nothing changed relative to level
    // play - fall back to extends_lead as the safe structural default when
    // the scoring side led both before and after without qualifying above.
    if (scorerLedBefore || scorerLeadsAfter) events.push('extends_lead');
  }
  if (events.length === 0) return undefined;

  const orderedEvents = orderScoreEvents(events);
  const leadChangeCount = countLeadChanges(beats, beatIndex);

  return {
    before,
    after,
    events: orderedEvents,
    leadChangeCount,
    derivedFrom: [...new Set([...beforeDerivedFrom, ...(scoreCue ? [scoreCue.id] : []), goalCue.id])],
  };
}

const SCORE_EVENT_PRIORITY: Record<NarrativeScoreEvent, number> = {
  comeback: 0,
  late_winner: 1,
  lead_change: 2,
  equaliser: 3,
  opener: 4,
  extends_lead: 5,
};

function orderScoreEvents(events: readonly NarrativeScoreEvent[]): NarrativeScoreEvent[] {
  return [...new Set(events)].sort((left, right) => SCORE_EVENT_PRIORITY[left] - SCORE_EVENT_PRIORITY[right]);
}

/** Total lead changes (trailing-or-level to leading transitions) up to and including this beat's goal. */
function countLeadChanges(beats: readonly CommentaryBeat[], beatIndex: number): number {
  let count = 0;
  // Seeded 'level' because the match begins 0-0; the first goal to break
  // that tie is itself a lead change (nobody led, now someone does).
  let previousLeader: MatchEngineParticipant | 'level' = 'level';
  for (let index = 0; index <= beatIndex; index += 1) {
    const cue = beats[index]!.simulationCues.find((c) => c.kind === 'score_commit');
    const value = cue?.value as { participant1?: unknown; participant2?: unknown } | undefined;
    if (typeof value?.participant1 !== 'number' || typeof value?.participant2 !== 'number') continue;
    const leader: MatchEngineParticipant | 'level' = value.participant1 === value.participant2
      ? 'level'
      : value.participant1 > value.participant2 ? 1 : 2;
    if (leader !== 'level' && leader !== previousLeader) {
      count += 1;
    }
    previousLeader = leader;
  }
  return count;
}

function computePlayerMemory(
  beat: CommentaryBeat,
  beatIndex: number,
  beats: readonly CommentaryBeat[],
  goalCue: SimulationCue,
): BeatNarrativePlayerMemory | undefined {
  const scorerId = goalCue.player?.normativeId;
  if (typeof scorerId !== 'number') return undefined;

  const derivedFrom: string[] = [goalCue.id];
  let goals = 0;
  for (let index = 0; index <= beatIndex; index += 1) {
    const priorGoal = beats[index]!.simulationCues.find((cue) => cue.kind === 'goal_confirmed');
    if (priorGoal?.player?.normativeId === scorerId) {
      goals += 1;
      if (index !== beatIndex) derivedFrom.push(priorGoal.id);
    }
  }
  if (goals === 0) return undefined;

  return { scorerGoalsThisMatch: goals, derivedFrom };
}

function computeDiscipline(
  beat: CommentaryBeat,
  beatIndex: number,
  beats: readonly CommentaryBeat[],
  state: CanonicalMatchState,
  cardCue: SimulationCue,
): BeatNarrativeDiscipline | undefined {
  const cardTeamId = cardCue.teamId;
  const cardAction = cardCue.value.action;
  if (cardAction !== 'yellow_card' && cardAction !== 'red_card') return undefined;

  const derivedFrom: string[] = [cardCue.id];
  let teamYellowCount = 0;
  let teamRedCount = 0;
  let playerPriorYellows = 0;
  const scorerId = cardCue.player?.normativeId;

  for (let index = 0; index <= beatIndex; index += 1) {
    const priorCard = beats[index]!.simulationCues.find((cue) => cue.kind === 'card');
    if (!priorCard) continue;
    const priorAction = priorCard.value.action;
    if (priorAction !== 'yellow_card' && priorAction !== 'red_card') continue;
    const sameTeam = cardTeamId !== undefined && priorCard.teamId !== undefined
      && String(priorCard.teamId) === String(cardTeamId);
    if (sameTeam) {
      if (priorAction === 'yellow_card') teamYellowCount += 1;
      else teamRedCount += 1;
      if (index !== beatIndex) derivedFrom.push(priorCard.id);
    }
    if (
      priorAction === 'yellow_card'
      && index !== beatIndex
      && typeof scorerId === 'number'
      && priorCard.player?.normativeId === scorerId
    ) {
      playerPriorYellows += 1;
      derivedFrom.push(priorCard.id);
    }
  }

  const secondYellowRed = cardAction === 'red_card' && typeof scorerId === 'number' && playerPriorYellows > 0;

  const menRemainingReduced = cardAction === 'red_card'
    && cardCue.participant !== undefined
    && (state.activePlayerIdsByParticipant[String(cardCue.participant)]?.length ?? 11) < 11;

  return {
    teamYellowCount,
    teamRedCount,
    playerPriorYellows,
    secondYellowRed,
    menRemainingReduced,
    derivedFrom: [...new Set(derivedFrom)],
  };
}

function computeMomentum(
  beat: CommentaryBeat,
  beatIndex: number,
  beats: readonly CommentaryBeat[],
): BeatNarrativeMomentum | undefined {
  const teamId = beat.teamId;
  const participant = beat.participant;
  if (teamId === undefined && participant === undefined) return undefined;

  const sameOwner = (candidate: CommentaryBeat) =>
    (teamId !== undefined && candidate.teamId !== undefined && String(candidate.teamId) === String(teamId))
    || (teamId === undefined && participant !== undefined && candidate.participant === participant);

  let pressureSpellBeats = 0;
  for (let index = beatIndex; index >= 0; index -= 1) {
    const candidate = beats[index]!;
    const isPressureLike = candidate.kind === 'pressure'
      || candidate.simulationCues.some((cue) => cue.kind === 'set_piece' || cue.kind === 'possession_pressure');
    if (!isPressureLike || !sameOwner(candidate)) break;
    pressureSpellBeats += 1;
  }

  const anchorClock = beat.matchClockSeconds;
  const derivedFrom: string[] = [];
  let setPieceCountRecentWindow = 0;
  for (let index = beatIndex; index >= 0; index -= 1) {
    const candidate = beats[index]!;
    if (!sameOwner(candidate)) continue;
    if (typeof anchorClock === 'number' && typeof candidate.matchClockSeconds === 'number') {
      if (anchorClock - candidate.matchClockSeconds > MOMENTUM_WINDOW_SECONDS) break;
    } else if (candidate !== beat) {
      break;
    }
    for (const cue of candidate.simulationCues) {
      if (cue.kind === 'set_piece' && (cue.value.action === 'corner' || cue.value.action === 'free_kick')) {
        setPieceCountRecentWindow += 1;
        derivedFrom.push(cue.id);
      }
    }
  }

  if (pressureSpellBeats <= 1 && setPieceCountRecentWindow === 0) return undefined;

  return {
    pressureSpellBeats,
    setPieceCountRecentWindow,
    derivedFrom: [...new Set(derivedFrom)],
  };
}

function phaseAt(beats: readonly CommentaryBeat[], beatIndex: number): MatchEnginePhase | undefined {
  for (let index = beatIndex; index >= 0; index -= 1) {
    const phaseCue = beats[index]!.simulationCues.find((cue) => cue.kind === 'phase_change');
    const phaseValue = phaseCue?.value.phase;
    if (typeof phaseValue === 'string') return phaseValue as MatchEnginePhase;
  }
  return undefined;
}

function deriveTimeContext(
  beat: CommentaryBeat,
  beats: readonly CommentaryBeat[],
  beatIndex: number,
): NarrativeTimeContext | undefined {
  const seconds = beat.matchClockSeconds;
  if (typeof seconds !== 'number') return undefined;
  const phase = phaseAt(beats, beatIndex);
  const isSecondHalf = phase === 'second_half' || phase === 'second_half_ready' || (seconds >= HALF_REGULATION_SECONDS && phase !== 'first_half' && phase !== 'first_half_ready');

  if (isSecondHalf) {
    const secondHalfElapsed = seconds - HALF_REGULATION_SECONDS;
    if (secondHalfElapsed >= HALF_REGULATION_SECONDS) return 'stoppage';
    if (secondHalfElapsed >= HALF_REGULATION_SECONDS - CLOSING_STAGES_WINDOW_SECONDS) return 'closing_stages';
    if (secondHalfElapsed < EARLY_WINDOW_SECONDS) return 'early';
    return 'normal';
  }

  // First half (or phase unknown, treat raw seconds as first-half clock).
  if (seconds >= HALF_REGULATION_SECONDS) return 'stoppage';
  if (seconds >= HALF_REGULATION_SECONDS - PRE_HALFTIME_WINDOW_SECONDS) return 'pre_halftime';
  if (seconds < EARLY_WINDOW_SECONDS) return 'early';
  return 'normal';
}
