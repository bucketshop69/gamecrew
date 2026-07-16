import type { NarrativeScoreEvent } from './narrative';
import type {
  MatchEngineLifecycle,
  MatchEngineParticipant,
  MatchEnginePhase,
  MatchEnginePlayer,
  MatchEnginePressure,
  MatchEngineScore,
  SemanticFrame,
  SimulationCue,
} from './types';

/**
 * The Game View scene taxonomy (see docs/prds/game_view.md, "Scene kinds").
 * Every kind maps to source cue kinds that already exist in the engine.
 */
export type GameViewSceneKind =
  | 'ambient'
  | 'set_piece'
  | 'shot'
  | 'goal_sequence'
  | 'goal_retracted'
  | 'card'
  | 'substitution'
  | 'var_review'
  | 'phase_break'
  | 'restart';

/**
 * A semantic band, never a pitch coordinate. Reuses `MatchEnginePressure`
 * because the engine's own possession/pressure bands already are the zones
 * Game View is allowed to show (see the Honesty Rule).
 */
export type GameViewZone = MatchEnginePressure;

/**
 * Ordered beat within a `goal_sequence` scene. The goal sequence's tension
 * and celebration beats are modeled as scene-internal steps on one scene
 * (see `GameViewScene.beats`) rather than as separate sibling scenes,
 * because they are one continuous takeover of the screen with no ambient
 * state in between. The reset beat is intentionally NOT one of these steps:
 * it is emitted as its own adjacent `restart` scene, because `restart` is
 * already a first-class scene kind in the taxonomy and a `restart` cue can
 * also arrive on its own (half-time, kickoff) without a preceding goal.
 * Keeping restart as a separate scene means the renderer has exactly one
 * place that knows how to play a restart, whether or not a goal preceded it.
 */
export type GameViewGoalBeatKind = 'tension' | 'celebration';

export interface GameViewGoalBeat {
  kind: GameViewGoalBeatKind;
  lifecycle: MatchEngineLifecycle;
  sourceFrameIds: readonly string[];
  player?: MatchEnginePlayer;
  /** Pre-goal on tension; committed post-goal on celebration. */
  scoreAtMoment?: MatchEngineScore;
}

/** Playback pacing hint in milliseconds. Presentation only, never a source claim. */
export interface GameViewDurationHint {
  minMs: number;
  maxMs: number;
}

export interface GameViewScene {
  id: string;
  fixtureId: number | string;
  kind: GameViewSceneKind;
  /** State revision this scene first became true at. */
  startRevision: number;
  sourceFrameIds: readonly string[];
  sourceCueIds: readonly string[];
  participant?: MatchEngineParticipant;
  teamId?: number | string;
  zone?: GameViewZone;
  pressure?: MatchEnginePressure;
  /** Only present when the source frame(s) supplied player identity. */
  player?: MatchEnginePlayer;
  scoreAtMoment?: MatchEngineScore;
  clockSeconds?: number;
  phase?: MatchEnginePhase;
  durationHint: GameViewDurationHint;
  lifecycle?: MatchEngineLifecycle;
  /**
   * The source cue's incident action for scenes whose rendering varies by it
   * (card: yellow_card/red_card; set_piece: corner/free_kick/throw_in/penalty).
   * Copied verbatim from the cue value; absent when the source omits it.
   */
  sourceAction?: string;
  /** Only present on goal_sequence scenes. See `GameViewGoalBeatKind` doc. */
  beats?: readonly GameViewGoalBeat[];
  /** Only present on goal_sequence celebration takeovers. */
  scoreEvents?: readonly NarrativeScoreEvent[];
  /**
   * Computed playback timing, only present when `GameViewTimelineOptions.pacing`
   * is supplied. Presentation metadata only (like `durationHint`): the director
   * stays pure and emits no timers, wall-clock reads, or side effects. See
   * `computeReplayPacing`.
   */
  playback?: GameViewPlaybackTiming;
}

/**
 * Computed playback offset/duration for one scene, in a replay's own
 * timeline (milliseconds from the start of playback). Distinct from
 * `durationHint`, which is a source-agnostic presentation range for how long
 * a scene kind *could* play; `playback` is the pacing engine's concrete
 * schedule for *this* scene in *this* timeline, after quiet-stretch
 * compression has been applied.
 */
export interface GameViewPlaybackTiming {
  playbackOffsetMs: number;
  playbackDurationMs: number;
}

export interface GameViewReplayPacingOptions {
  mode: 'replay';
  /**
   * `summary` deterministically samples routine play before pacing so staged
   * moments remain readable; `complete` keeps every derived scene (useful for
   * debugging). Live/unpaced timelines never run replay selection. Defaults
   * to `summary`.
   */
  sceneSelection?: 'summary' | 'complete';
  /**
   * Upper bound, in milliseconds, on how long any single ambient stretch is
   * allowed to occupy in the compressed replay timeline, regardless of how
   * much match-clock time it actually spanned. Quiet stretches longer than
   * this shrink toward the cap; short ones play at (approximately) their
   * real pace. Defaults to `DEFAULT_REPLAY_AMBIENT_CAP_MS`.
   */
  ambientStretchCapMs?: number;
  /**
   * Best-effort total replay length in milliseconds. Every retained
   * non-ambient scene keeps its full `durationHint.minMs`; only ambient time
   * scales, and never below its readability floor. The result may exceed the
   * target when protected moments plus floors already consume more than the
   * budget. Defaults to `DEFAULT_REPLAY_TARGET_DURATION_MS`; pass `null` to
   * disable ambient scaling.
   */
  targetDurationMs?: number | null;
  /**
   * Milliseconds of playback time per match-clock second for ambient
   * stretches before the cap is applied ("real pace" for uncapped quiet
   * play). Defaults to `DEFAULT_REPLAY_MS_PER_MATCH_SECOND`.
   */
  msPerMatchSecond?: number;
  /**
   * Uniform wall-clock acceleration applied after scene selection and
   * duration planning. A value of 2 plays every retained scene at 2x while
   * preserving its facts, ordering, and source ids. Defaults to 1.
   */
  playbackRate?: number;
}

export interface GameViewTimelineOptions {
  /** Replay compression / live buffer pacing. Computes `GameViewScene.playback` when set. */
  pacing?: GameViewReplayPacingOptions;
}

/** Default cap on a single compressed ambient stretch in a replay timeline. */
export const DEFAULT_REPLAY_AMBIENT_CAP_MS = 2500;
/** Aspirational replay budget; protected moments/readability floors may push the result past it. */
export const DEFAULT_REPLAY_TARGET_DURATION_MS = 300_000;
/** Minimum readable window for a sampled ambient formation transition. */
const REPLAY_AMBIENT_FLOOR_MS = 900;
/** One honest ambient state sample per two match-clock minutes. */
const REPLAY_AMBIENT_BUCKET_SECONDS = 120;
/** Scene kinds that a replay summary never drops. */
const REPLAY_PROTECTED_KINDS: ReadonlySet<GameViewSceneKind> = new Set([
  'goal_sequence', 'goal_retracted', 'card', 'var_review', 'substitution',
  'phase_break', 'shot', 'restart',
]);
/** Default "real pace" ambient playback rate: 1 match-minute per 1.5 playback-seconds. */
export const DEFAULT_REPLAY_MS_PER_MATCH_SECOND = 25;

/**
 * Recommended buffer (in milliseconds of match/data time) the client should
 * hold the playhead behind the data head in live mode, so a brief network
 * hiccup or an out-of-order revision doesn't force a visible rewind. This is
 * guidance for the playback engine (work item 7); the director itself never
 * reads the wall clock or schedules anything.
 */
export const LIVE_PLAYHEAD_BUFFER_MS = 4000;

/**
 * Recommended live playhead lag: how far behind the data head (in
 * milliseconds) the client should keep the playhead while live. Kept as a
 * function (not just the constant) so the client has one seam to call
 * without depending on the exported constant's name, in case the guidance
 * ever needs to become conditional (e.g. on network jitter) without changing
 * every call site.
 */
export function getLivePlayheadBufferMs(): number {
  return LIVE_PLAYHEAD_BUFFER_MS;
}

const DEFAULT_DURATION: Record<GameViewSceneKind, GameViewDurationHint> = {
  ambient: { minMs: 0, maxMs: 0 }, // open-ended: lasts until the next scene supersedes it.
  set_piece: { minMs: 3000, maxMs: 6000 },
  shot: { minMs: 2500, maxMs: 5000 },
  goal_sequence: { minMs: 4000, maxMs: 8000 },
  goal_retracted: { minMs: 4000, maxMs: 8000 },
  card: { minMs: 4000, maxMs: 6000 },
  substitution: { minMs: 3000, maxMs: 5000 },
  var_review: { minMs: 4000, maxMs: 8000 },
  phase_break: { minMs: 4000, maxMs: 8000 },
  restart: { minMs: 2000, maxMs: 4000 },
};

/**
 * Takeover severity used when cues collide inside the same frame. Higher
 * wins. Ambient never appears here: it is never a takeover and always
 * resumes after one, at the post-event state.
 */
const TAKEOVER_PRIORITY: Record<Exclude<GameViewSceneKind, 'ambient'>, number> = {
  goal_sequence: 100,
  goal_retracted: 95,
  var_review: 90,
  card: 80, // red vs yellow severity is applied within this tier, see cardPriority().
  substitution: 60,
  set_piece: 50,
  shot: 40,
  phase_break: 30,
  restart: 20,
};

function cardPriority(cue: SimulationCue): number {
  // Red cards outrank yellow cards within the card tier without leaving the
  // tier, per PRD priority: goal > var/retraction > red card > yellow card >
  // substitution > set piece > shot > ambient.
  return cue.value.action === 'red_card' ? TAKEOVER_PRIORITY.card + 1 : TAKEOVER_PRIORITY.card;
}

function scenePriority(kind: GameViewSceneKind, cue: SimulationCue): number {
  if (kind === 'card') return cardPriority(cue);
  if (kind === 'ambient') return -1;
  return TAKEOVER_PRIORITY[kind];
}

/** Deterministic id: fixture + kind + the ordered source frame and cue ids it was built from. */
function sceneId(
  fixtureId: number | string,
  kind: GameViewSceneKind,
  sourceFrameIds: readonly string[],
  sourceCueIds: readonly string[],
): string {
  const cueKey = uniqueSourceIds(sourceCueIds)
    .map((cueId) => encodeURIComponent(cueId))
    .join('+');
  return `${fixtureId}:game-view:${kind}:${sourceFrameIds.join('+')}:cues:${cueKey}`;
}

function compareFrames(left: SemanticFrame, right: SemanticFrame): number {
  return left.seq - right.seq || left.id.localeCompare(right.id);
}

function uniqueSourceIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

interface AmbientAccumulator {
  fixtureId: number | string;
  startRevision: number;
  sourceFrameIds: string[];
  sourceCueIds: string[];
  participant?: MatchEngineParticipant;
  teamId?: number | string;
  zone?: GameViewZone;
  pressure?: MatchEnginePressure;
  scoreAtMoment?: MatchEngineScore;
  clockSeconds?: number;
  phase?: MatchEnginePhase;
}

function freezeAmbient(accumulator: AmbientAccumulator): GameViewScene {
  return {
    id: sceneId(
      accumulator.fixtureId,
      'ambient',
      accumulator.sourceFrameIds,
      accumulator.sourceCueIds,
    ),
    fixtureId: accumulator.fixtureId,
    kind: 'ambient',
    startRevision: accumulator.startRevision,
    sourceFrameIds: uniqueSourceIds(accumulator.sourceFrameIds),
    sourceCueIds: uniqueSourceIds(accumulator.sourceCueIds),
    participant: accumulator.participant,
    teamId: accumulator.teamId,
    zone: accumulator.zone,
    pressure: accumulator.pressure,
    scoreAtMoment: accumulator.scoreAtMoment,
    clockSeconds: accumulator.clockSeconds,
    phase: accumulator.phase,
    durationHint: DEFAULT_DURATION.ambient,
  };
}

interface DirectorState {
  fixtureId: number | string;
  scenes: GameViewScene[];
  ambient?: AmbientAccumulator;
  /**
   * Ordinary incident scenes keyed by their stable cue id. TxLINE commonly
   * emits provisional then confirmed revisions for one throw-in/corner/shot;
   * replay upgrades the first scene in place so one real incident is staged
   * exactly once while retaining every supporting source frame.
   */
  incidentScenes: Map<string, GameViewScene>;
  /** Latest confirmed score seen so far, tracked for scoreEvents + goal_retracted restoration. */
  latestScore?: MatchEngineScore;
  /** Open goal_sequence scene awaiting its celebration beat, keyed by the goal cue id. */
  pendingGoalScenes: Map<string, { scene: GameViewScene; tensionBeat: GameViewGoalBeat }>;
  /** Confirmed goal scenes kept around so a later incident_retracted can build the takeback. */
  confirmedGoalScenes: Map<string, { scene: GameViewScene; scoreBefore?: MatchEngineScore }>;
  phase?: MatchEnginePhase;
  clockSeconds?: number;
  /**
   * The most recent semantic zone any possession cue placed the play in.
   * Set-piece scenes fall back to it when their own cue carries no zone
   * (real feeds routinely omit it on throw-ins/free kicks), so the renderer
   * can stage the dead ball where play actually was instead of guessing.
   */
  lastZone?: GameViewZone;
}

/**
 * Match-clock-basis threshold mirroring narrative.ts's `deriveTimeContext`
 * (see narrative.ts doc comment on `NarrativeTimeContext`). `deriveTimeContext`
 * itself is not exported (it operates on `CommentaryBeat` history, a shape the
 * director does not build), so the clock-basis rule it encodes is duplicated
 * here at the same thresholds rather than diverging with a director-local
 * guess: `matchClockSeconds` is a running total across both halves, so
 * "late" (closing_stages or stoppage) means second-half elapsed time
 * (clock - 45:00) has reached the last 10 minutes of the second half
 * (>= 35:00 elapsed, i.e. >= 80:00 total), not simply "past the 45:00 mark"
 * (which would flag the entire second half as late). See narrative.ts
 * HALF_REGULATION_SECONDS / CLOSING_STAGES_WINDOW_SECONDS.
 */
const HALF_REGULATION_SECONDS = 45 * 60;
const CLOSING_STAGES_WINDOW_SECONDS = 10 * 60;

/**
 * True when `matchClockSeconds` (a running total) falls in the closing
 * stages or stoppage of the second half, using the same clock basis as
 * narrative.ts's `deriveTimeContext`/`isSecondHalf` check: phase is the
 * primary signal, with a clock-only fallback when phase is unknown.
 */
function isLateGameClock(matchClockSeconds: number | undefined, phase: MatchEnginePhase | undefined): boolean {
  if (typeof matchClockSeconds !== 'number') return false;
  const isSecondHalf = phase === 'second_half'
    || phase === 'second_half_ready'
    || (matchClockSeconds >= HALF_REGULATION_SECONDS && phase !== 'first_half' && phase !== 'first_half_ready');
  if (!isSecondHalf) return false;
  const secondHalfElapsed = matchClockSeconds - HALF_REGULATION_SECONDS;
  return secondHalfElapsed >= HALF_REGULATION_SECONDS - CLOSING_STAGES_WINDOW_SECONDS;
}

function scoreValue(cue: SimulationCue | undefined): MatchEngineScore | undefined {
  const value = cue?.value as { participant1?: unknown; participant2?: unknown } | undefined;
  if (typeof value?.participant1 !== 'number' || typeof value?.participant2 !== 'number') return undefined;
  return { participant1: value.participant1, participant2: value.participant2 };
}

function closeAmbient(state: DirectorState) {
  if (!state.ambient) return;
  state.scenes.push(freezeAmbient(state.ambient));
  state.ambient = undefined;
}

function extendOrOpenAmbient(
  state: DirectorState,
  frame: SemanticFrame,
  cue: SimulationCue,
) {
  const participant = cue.participant;
  const zone = cue.probableZone ?? cue.pressure;
  const teamId = cue.teamId;
  if (zone) state.lastZone = zone;
  const current = state.ambient;

  const sameOwner = current
    && ((teamId !== undefined && current.teamId !== undefined && String(current.teamId) === String(teamId))
      || (teamId === undefined && participant !== undefined && current.participant === participant));

  if (current && sameOwner && current.zone === zone) {
    // Consecutive same-team same-zone updates extend the current ambient
    // scene rather than spawning a new one. The accumulator is mutated
    // in place and only frozen into an immutable GameViewScene when it
    // closes (mutate-before-freeze), so the emitted scene is always a
    // finished, immutable snapshot.
    current.sourceFrameIds.push(frame.id);
    current.sourceCueIds.push(cue.id);
    current.pressure = cue.pressure ?? current.pressure;
    current.scoreAtMoment = state.latestScore ?? current.scoreAtMoment;
    current.clockSeconds = frame.matchClockSeconds ?? current.clockSeconds;
    current.phase = state.phase ?? current.phase;
    return;
  }

  // Zone/team change: close the previous ambient scene and open a new one.
  closeAmbient(state);
  state.ambient = {
    fixtureId: state.fixtureId,
    startRevision: frame.stateRevision,
    sourceFrameIds: [frame.id],
    sourceCueIds: [cue.id],
    participant,
    teamId,
    zone,
    pressure: cue.pressure,
    scoreAtMoment: state.latestScore,
    clockSeconds: frame.matchClockSeconds,
    phase: state.phase,
  };
}

function baseTakeoverFields(
  state: DirectorState,
  frame: SemanticFrame,
  sourceFrameIds: readonly string[],
  sourceCueIds: readonly string[],
) {
  return {
    fixtureId: state.fixtureId,
    startRevision: frame.stateRevision,
    sourceFrameIds: uniqueSourceIds(sourceFrameIds),
    sourceCueIds: uniqueSourceIds(sourceCueIds),
    scoreAtMoment: state.latestScore,
    clockSeconds: frame.matchClockSeconds,
    phase: state.phase,
  };
}

function handleSetPiece(state: DirectorState, frame: SemanticFrame, cue: SimulationCue) {
  closeAmbient(state);
  const zone = cue.probableZone ?? cue.pressure ?? state.lastZone;
  const existing = mergeIncidentScene(state, frame, cue, 'set_piece');
  if (existing) {
    if (zone) existing.zone = zone;
    if (typeof cue.value.action === 'string') existing.sourceAction = cue.value.action;
    return;
  }
  const scene: GameViewScene = {
    ...baseTakeoverFields(state, frame, [frame.id], [cue.id]),
    id: sceneId(state.fixtureId, 'set_piece', [frame.id], [cue.id]),
    kind: 'set_piece',
    participant: cue.participant,
    teamId: cue.teamId,
    lifecycle: cue.lifecycle,
    // The semantic band where the dead ball is taken, when the source
    // supplies one -- lets the renderer stage throw-ins/free kicks at a
    // truthful pitch height instead of guessing (same band the ambient
    // scenes already use).
    ...(zone ? { zone } : {}),
    ...(typeof cue.value.action === 'string' ? { sourceAction: cue.value.action } : {}),
    durationHint: DEFAULT_DURATION.set_piece,
  };
  rememberIncidentScene(state, cue, scene);
  state.scenes.push(scene);
}

function handleShot(state: DirectorState, frame: SemanticFrame, cue: SimulationCue) {
  closeAmbient(state);
  const existing = mergeIncidentScene(state, frame, cue, 'shot');
  if (existing) return;
  const scene: GameViewScene = {
    ...baseTakeoverFields(state, frame, [frame.id], [cue.id]),
    id: sceneId(state.fixtureId, 'shot', [frame.id], [cue.id]),
    kind: 'shot',
    participant: cue.participant,
    teamId: cue.teamId,
    player: cue.player,
    lifecycle: cue.lifecycle,
    durationHint: DEFAULT_DURATION.shot,
  };
  rememberIncidentScene(state, cue, scene);
  state.scenes.push(scene);
}

function handleCard(state: DirectorState, frame: SemanticFrame, cue: SimulationCue) {
  closeAmbient(state);
  const existing = mergeIncidentScene(state, frame, cue, 'card');
  if (existing) {
    if (typeof cue.value.action === 'string') existing.sourceAction = cue.value.action;
    return;
  }
  const scene: GameViewScene = {
    ...baseTakeoverFields(state, frame, [frame.id], [cue.id]),
    id: sceneId(state.fixtureId, 'card', [frame.id], [cue.id]),
    kind: 'card',
    participant: cue.participant,
    teamId: cue.teamId,
    player: cue.player,
    lifecycle: cue.lifecycle,
    ...(typeof cue.value.action === 'string' ? { sourceAction: cue.value.action } : {}),
    durationHint: DEFAULT_DURATION.card,
  };
  rememberIncidentScene(state, cue, scene);
  state.scenes.push(scene);
}

function handleSubstitution(state: DirectorState, frame: SemanticFrame, cue: SimulationCue) {
  closeAmbient(state);
  const existing = mergeIncidentScene(state, frame, cue, 'substitution');
  if (existing) return;
  const scene: GameViewScene = {
    ...baseTakeoverFields(state, frame, [frame.id], [cue.id]),
    id: sceneId(state.fixtureId, 'substitution', [frame.id], [cue.id]),
    kind: 'substitution',
    participant: cue.participant,
    teamId: cue.teamId,
    player: cue.player,
    lifecycle: cue.lifecycle,
    durationHint: DEFAULT_DURATION.substitution,
  };
  rememberIncidentScene(state, cue, scene);
  state.scenes.push(scene);
}

function handleVar(state: DirectorState, frame: SemanticFrame, cue: SimulationCue) {
  closeAmbient(state);
  const existing = mergeIncidentScene(state, frame, cue, 'var_review');
  if (existing) return;
  const scene: GameViewScene = {
    ...baseTakeoverFields(state, frame, [frame.id], [cue.id]),
    id: sceneId(state.fixtureId, 'var_review', [frame.id], [cue.id]),
    kind: 'var_review',
    participant: cue.participant,
    teamId: cue.teamId,
    lifecycle: cue.lifecycle,
    durationHint: DEFAULT_DURATION.var_review,
  };
  rememberIncidentScene(state, cue, scene);
  state.scenes.push(scene);
}

function mergeIncidentScene(
  state: DirectorState,
  frame: SemanticFrame,
  cue: SimulationCue,
  expectedKind: GameViewSceneKind,
): GameViewScene | undefined {
  if (cue.updateMode !== 'incident_upsert') return undefined;
  const existing = state.incidentScenes.get(cue.id);
  if (!existing || existing.kind !== expectedKind) return undefined;

  existing.sourceFrameIds = uniqueSourceIds([...existing.sourceFrameIds, frame.id]);
  existing.sourceCueIds = uniqueSourceIds([...existing.sourceCueIds, cue.id]);
  existing.lifecycle = cue.lifecycle;
  existing.participant = cue.participant ?? existing.participant;
  existing.teamId = cue.teamId ?? existing.teamId;
  existing.player = cue.player ?? existing.player;
  existing.scoreAtMoment = state.latestScore ?? existing.scoreAtMoment;
  existing.clockSeconds = frame.matchClockSeconds ?? existing.clockSeconds;
  existing.phase = state.phase ?? existing.phase;
  return existing;
}

function rememberIncidentScene(
  state: DirectorState,
  cue: SimulationCue,
  scene: GameViewScene,
): void {
  if (cue.updateMode === 'incident_upsert') state.incidentScenes.set(cue.id, scene);
}

function handlePhaseChange(state: DirectorState, frame: SemanticFrame, cue: SimulationCue) {
  const phase = cue.value.phase;
  if (typeof phase === 'string') state.phase = phase as MatchEnginePhase;
  closeAmbient(state);
  const scene: GameViewScene = {
    ...baseTakeoverFields(state, frame, [frame.id], [cue.id]),
    id: sceneId(state.fixtureId, 'phase_break', [frame.id], [cue.id]),
    kind: 'phase_break',
    lifecycle: cue.lifecycle,
    durationHint: DEFAULT_DURATION.phase_break,
  };
  state.scenes.push(scene);
}

function handleRestart(state: DirectorState, frame: SemanticFrame, cue: SimulationCue) {
  closeAmbient(state);
  const scene: GameViewScene = {
    ...baseTakeoverFields(state, frame, [frame.id], [cue.id]),
    id: sceneId(state.fixtureId, 'restart', [frame.id], [cue.id]),
    kind: 'restart',
    participant: cue.participant,
    teamId: cue.teamId,
    lifecycle: cue.lifecycle,
    durationHint: DEFAULT_DURATION.restart,
  };
  state.scenes.push(scene);
}

/**
 * `goal_pending` opens (or re-uses) a `goal_sequence` scene with a `tension`
 * beat. Only ever a tension beat: a provisional goal must never carry a
 * celebration beat, which is how provisional-vs-confirmed stays visually
 * distinct per the Honesty Rule.
 */
function handleGoalPending(state: DirectorState, frame: SemanticFrame, cue: SimulationCue) {
  closeAmbient(state);
  const key = cue.id;
  const existing = state.pendingGoalScenes.get(key);
  // A confirmed goal_sequence stores the post-goal score on the scene, so
  // the tension beat must carry its own immutable pre-goal score. Preserve
  // the first pending revision's value if the same incident is refined.
  const preGoalScore = existing?.tensionBeat.scoreAtMoment
    ?? state.latestScore
    ?? { participant1: 0, participant2: 0 };
  const tensionBeat: GameViewGoalBeat = {
    kind: 'tension',
    lifecycle: cue.lifecycle,
    sourceFrameIds: [frame.id],
    player: cue.player,
    scoreAtMoment: preGoalScore,
  };
  if (existing) {
    // Mutate the scene already sitting in state.scenes in place; its
    // position in the timeline (set when it was first opened) is correct
    // and does not need to move for a later tension revision.
    existing.scene.sourceFrameIds = uniqueSourceIds([...existing.scene.sourceFrameIds, frame.id]);
    existing.scene.sourceCueIds = uniqueSourceIds([...existing.scene.sourceCueIds, cue.id]);
    existing.tensionBeat = tensionBeat;
    existing.scene.beats = [tensionBeat];
    return;
  }
  const scene: GameViewScene = {
    ...baseTakeoverFields(state, frame, [frame.id], [cue.id]),
    id: sceneId(state.fixtureId, 'goal_sequence', [frame.id], [cue.id]),
    kind: 'goal_sequence',
    participant: cue.participant,
    teamId: cue.teamId,
    player: cue.player,
    lifecycle: 'provisional',
    durationHint: DEFAULT_DURATION.goal_sequence,
    beats: [tensionBeat],
  };
  state.pendingGoalScenes.set(key, { scene, tensionBeat });
  state.scenes.push(scene);
}

/** Classifies a confirmed goal's scoreEvents using the same before/after rules as narrative.ts's scoreStory (see narrative.ts doc comment on NarrativeScoreEvent). */
function classifyScoreEvents(
  before: MatchEngineScore,
  after: MatchEngineScore,
  scorer: MatchEngineParticipant,
  everTrailedByTwoOrMore: boolean,
  isLate: boolean,
): NarrativeScoreEvent[] {
  const events: NarrativeScoreEvent[] = [];
  const beforeLevel = before.participant1 === before.participant2;
  const afterLevel = after.participant1 === after.participant2;
  const scorerLedBefore = scorer === 1 ? before.participant1 > before.participant2 : before.participant2 > before.participant1;
  const scorerLeadsAfter = scorer === 1 ? after.participant1 > after.participant2 : after.participant2 > after.participant1;

  if (beforeLevel && before.participant1 === 0) events.push('opener');
  if (!beforeLevel && afterLevel) events.push('equaliser');
  if (scorerLedBefore && scorerLeadsAfter) events.push('extends_lead');
  if (!scorerLedBefore && scorerLeadsAfter && !(beforeLevel && before.participant1 === 0)) events.push('lead_change');
  if (everTrailedByTwoOrMore && (afterLevel || scorerLeadsAfter) && !scorerLedBefore) events.push('comeback');
  if (isLate && beforeLevel && !afterLevel && scorerLeadsAfter) events.push('late_winner');
  if (events.length === 0 && (scorerLedBefore || scorerLeadsAfter)) events.push('extends_lead');

  const priority: Record<NarrativeScoreEvent, number> = {
    comeback: 0, late_winner: 1, lead_change: 2, equaliser: 3, opener: 4, extends_lead: 5,
  };
  return [...new Set(events)].sort((left, right) => priority[left] - priority[right]);
}

/**
 * `goal_confirmed` / `score_commit` add the `celebration` beat to the
 * matching pending goal_sequence scene (matched by the goal cue id carried
 * in both cues' factIds/value). If no pending scene exists (out-of-order or
 * synthetic input missing goal_pending), a goal_sequence scene is created
 * directly with just a celebration beat -- a confirmed goal is a takeover
 * that may never be dropped, per the priority rule.
 *
 * The same incident key can carry more than one `goal_confirmed` cue: the
 * source replay emits an initial confirmation (revision N) and a later
 * revision once player identity resolves (see replay.ts's `emitCue` calls
 * for `cue:<incidentKey>` at increasing `revision`), both sharing `goalCue.id`.
 * A second (or later) `goal_confirmed` for a key already in
 * `confirmedGoalScenes` must merge into that existing scene -- extending
 * `sourceFrameIds` and filling in `player` if newly present -- rather than
 * spawning a sibling scene at the same score, which is what previously
 * produced duplicate goal_sequence scenes for one real goal.
 */
function handleGoalConfirmed(
  state: DirectorState,
  frame: SemanticFrame,
  goalCue: SimulationCue,
  scoreCue: SimulationCue | undefined,
) {
  closeAmbient(state);
  const key = goalCue.id;

  const alreadyConfirmed = state.confirmedGoalScenes.get(key);
  if (alreadyConfirmed) {
    // A later revision of a goal already confirmed (typically carrying
    // player identity for the first time). The score does not move again
    // for the same incident, so only extend provenance and beat/player
    // details in place; scoreEvents were already computed correctly against
    // the score transition at first confirmation.
    const scene = alreadyConfirmed.scene;
    scene.sourceFrameIds = uniqueSourceIds([...scene.sourceFrameIds, frame.id]);
    scene.sourceCueIds = uniqueSourceIds([
      ...scene.sourceCueIds,
      goalCue.id,
      ...(scoreCue ? [scoreCue.id] : []),
    ]);
    if (goalCue.player && !scene.player) scene.player = goalCue.player;
    const beats = scene.beats;
    if (beats) {
      const lastBeat = beats[beats.length - 1];
      if (lastBeat?.kind === 'celebration' && goalCue.player && !lastBeat.player) {
        scene.beats = [...beats.slice(0, -1), { ...lastBeat, player: goalCue.player, sourceFrameIds: uniqueSourceIds([...lastBeat.sourceFrameIds, frame.id]) }];
      }
    }
    // A same-incident score_commit riding along with this later revision
    // (not expected in practice, but keep latestScore consistent if so).
    const riderScore = scoreValue(scoreCue);
    if (riderScore) state.latestScore = riderScore;
    return;
  }

  const after = scoreValue(scoreCue) ?? state.latestScore ?? { participant1: 0, participant2: 0 };
  const before = state.latestScore ?? { participant1: 0, participant2: 0 };

  let scoreEvents: NarrativeScoreEvent[] | undefined;
  if (goalCue.participant === 1 || goalCue.participant === 2) {
    const everTrailedByTwoOrMore = state.scenes.some((scene) => {
      if (!scene.scoreAtMoment) return false;
      const deficit = goalCue.participant === 1
        ? scene.scoreAtMoment.participant2 - scene.scoreAtMoment.participant1
        : scene.scoreAtMoment.participant1 - scene.scoreAtMoment.participant2;
      return deficit >= 2;
    });
    const isLate = isLateGameClock(frame.matchClockSeconds, state.phase);
    scoreEvents = classifyScoreEvents(before, after, goalCue.participant, everTrailedByTwoOrMore, isLate);
  }

  const celebrationBeat: GameViewGoalBeat = {
    kind: 'celebration',
    lifecycle: 'confirmed',
    sourceFrameIds: [frame.id],
    player: goalCue.player,
    scoreAtMoment: after,
  };

  const pending = state.pendingGoalScenes.get(key);
  const scoreBefore = state.latestScore;
  state.latestScore = after;

  if (pending) {
    pending.scene.sourceFrameIds = uniqueSourceIds([...pending.scene.sourceFrameIds, frame.id]);
    pending.scene.sourceCueIds = uniqueSourceIds([
      ...pending.scene.sourceCueIds,
      goalCue.id,
      ...(scoreCue ? [scoreCue.id] : []),
    ]);
    pending.scene.lifecycle = 'confirmed';
    pending.scene.scoreAtMoment = after;
    pending.scene.player = goalCue.player ?? pending.scene.player;
    pending.scene.beats = [pending.tensionBeat, celebrationBeat];
    pending.scene.scoreEvents = scoreEvents;
    state.pendingGoalScenes.delete(key);
    state.confirmedGoalScenes.set(key, { scene: pending.scene, scoreBefore });
    // Scene already in state.scenes from the goal_pending step; nothing to push.
    return;
  }

  const sourceCueIds = [goalCue.id, ...(scoreCue ? [scoreCue.id] : [])];
  const scene: GameViewScene = {
    ...baseTakeoverFields(state, frame, [frame.id], sourceCueIds),
    id: sceneId(state.fixtureId, 'goal_sequence', [frame.id], sourceCueIds),
    kind: 'goal_sequence',
    participant: goalCue.participant,
    teamId: goalCue.teamId,
    player: goalCue.player,
    lifecycle: 'confirmed',
    scoreAtMoment: after,
    durationHint: DEFAULT_DURATION.goal_sequence,
    beats: [celebrationBeat],
    scoreEvents,
  };
  state.confirmedGoalScenes.set(key, { scene, scoreBefore });
  state.scenes.push(scene);
}

/**
 * `incident_retracted` on a goal produces a `goal_retracted` takeover that
 * restores the score to its value immediately before that goal. Matches the
 * retracted cue back to its confirmed goal_sequence scene by incident key
 * (the retraction cue id equals `cue:<incidentKey>`, same as the original
 * goal cue id, per replay.ts's emitCue calls for both).
 *
 * Only goal retractions (confirmed or still-pending) become a takeover;
 * retractions of minor incidents (throw-ins, corners) are dropped so a
 * source correction never plays as a goal-overturn moment.
 */
function handleIncidentRetracted(state: DirectorState, frame: SemanticFrame, cue: SimulationCue) {
  const retractedAction = typeof cue.value.action === 'string' ? cue.value.action : undefined;
  const pendingGoal = state.pendingGoalScenes.get(cue.id);
  const isGoalRetraction = retractedAction === 'goal'
    || pendingGoal !== undefined
    || state.confirmedGoalScenes.has(cue.id);
  if (!isGoalRetraction) {
    // A complete replay must not stage a minor incident the source later
    // withdrew. Remove the provisional scene rather than silently showing a
    // corner/throw-in that final truth says did not stand.
    const retractedScene = state.incidentScenes.get(cue.id);
    if (retractedScene) {
      const index = state.scenes.indexOf(retractedScene);
      if (index >= 0) state.scenes.splice(index, 1);
      state.incidentScenes.delete(cue.id);
    }
    return;
  }
  if (pendingGoal) state.pendingGoalScenes.delete(cue.id);
  closeAmbient(state);
  const matchingGoal = state.confirmedGoalScenes.get(cue.id);
  const restoredScore = matchingGoal?.scoreBefore ?? state.latestScore ?? { participant1: 0, participant2: 0 };
  state.latestScore = restoredScore;
  if (matchingGoal) state.confirmedGoalScenes.delete(cue.id);

  const scene: GameViewScene = {
    ...baseTakeoverFields(state, frame, [frame.id], [cue.id]),
    id: sceneId(state.fixtureId, 'goal_retracted', [frame.id], [cue.id]),
    kind: 'goal_retracted',
    participant: cue.participant,
    teamId: cue.teamId,
    lifecycle: 'retracted',
    scoreAtMoment: restoredScore,
    durationHint: DEFAULT_DURATION.goal_retracted,
  };
  state.scenes.push(scene);
}

/** Cue kinds this director acts on. Anything else (e.g. player_highlight, injury, additional_time, possible_event) is ignored gracefully. */
function isRelevantCue(cue: SimulationCue): boolean {
  switch (cue.kind) {
    case 'possession_change':
    case 'possession_pressure':
    case 'set_piece':
    case 'shot_attempt':
    case 'shot_outcome':
    case 'goal_pending':
    case 'goal_confirmed':
    case 'score_commit':
    case 'restart':
    case 'card':
    case 'substitution':
    case 'var':
    case 'incident_retracted':
    case 'phase_change':
      return true;
    default:
      return false;
  }
}

/**
 * Builds the ordered Game View scene timeline from a semantic frame stream.
 * Pure and deterministic: frames are sorted by seq (any input order yields
 * the same output), no wall-clock or random state is read. See
 * docs/prds/game_view.md ("Director And Renderer Split") and
 * docs/issues/game-view-director-and-playback.md (work items 2-4) for the
 * contract this implements.
 *
 * Priority when multiple takeover-worthy cues land in the same frame: goal >
 * var/retraction > red card > yellow card > substitution > set piece > shot
 * > ambient (see TAKEOVER_PRIORITY). Ambient cues never interrupt a
 * takeover in progress and resume afterward at the post-event state, because
 * every takeover handler closes the open ambient accumulator before it runs
 * and a fresh ambient scene only opens on the next ambient cue.
 */
export function buildGameViewTimeline(
  frames: readonly SemanticFrame[],
  options: GameViewTimelineOptions = {},
): readonly GameViewScene[] {
  const ordered = [...frames].sort(compareFrames);
  if (ordered.length === 0) return [];

  const state: DirectorState = {
    fixtureId: ordered[0]!.fixtureId,
    scenes: [],
    incidentScenes: new Map(),
    pendingGoalScenes: new Map(),
    confirmedGoalScenes: new Map(),
  };

  for (const frame of ordered) {
    if (frame.matchClockSeconds !== undefined) state.clockSeconds = frame.matchClockSeconds;

    const relevant = (frame.simulationCues ?? []).filter(isRelevantCue);
    if (relevant.length === 0) continue;

    // Resolve same-frame collisions by severity; process every relevant cue
    // (a frame can carry e.g. both a goal_confirmed and its score_commit)
    // but order takeover-worthy cues highest severity first so the highest
    // priority scene is what remains "current" after this frame.
    const scoreCue = relevant.find((cue) => cue.kind === 'score_commit');
    const ranked = [...relevant]
      .filter((cue) => cue.kind !== 'score_commit')
      .sort((left, right) => scenePriority(kindForCue(right), right) - scenePriority(kindForCue(left), left));

    for (const cue of ranked) {
      switch (cue.kind) {
        case 'possession_change':
        case 'possession_pressure':
          extendOrOpenAmbient(state, frame, cue);
          break;
        case 'set_piece':
          handleSetPiece(state, frame, cue);
          break;
        case 'shot_attempt':
        case 'shot_outcome':
          handleShot(state, frame, cue);
          break;
        case 'goal_pending':
          handleGoalPending(state, frame, cue);
          break;
        case 'goal_confirmed':
          handleGoalConfirmed(state, frame, cue, scoreCue);
          break;
        case 'restart':
          handleRestart(state, frame, cue);
          break;
        case 'card':
          handleCard(state, frame, cue);
          break;
        case 'substitution':
          handleSubstitution(state, frame, cue);
          break;
        case 'var':
          handleVar(state, frame, cue);
          break;
        case 'incident_retracted':
          handleIncidentRetracted(state, frame, cue);
          break;
        case 'phase_change':
          handlePhaseChange(state, frame, cue);
          break;
        default:
          break;
      }
    }
  }

  closeAmbient(state);

  if (options.pacing?.mode === 'replay') {
    const replayScenes = options.pacing.sceneSelection === 'complete'
      ? state.scenes
      : selectReplaySummaryScenes(state.scenes);
    return applyReplayPacing(replayScenes, options.pacing);
  }

  return state.scenes;
}

/**
 * Selects an honest, deterministic replay summary from the complete scene
 * sequence. This is a strict filtering pass: it never clones, merges,
 * reorders, or modifies scene truth/source ids.
 *
 * Protected incidents and staged attacking moments are retained in full.
 * Routine set pieces retain the first real example of each source action in
 * each half. Ambient play retains the last real state in each fixed
 * two-minute match-clock bucket; choosing the bucket's last state is a
 * neutral clock rule, not an intensity-based highlight choice.
 */
function selectReplaySummaryScenes(
  scenes: readonly GameViewScene[],
): readonly GameViewScene[] {
  const selected = new Set<GameViewScene>();
  const routineSetPieceKeys = new Set<string>();
  const lastAmbientByBucket = new Map<string, GameViewScene>();

  for (const scene of scenes) {
    if (REPLAY_PROTECTED_KINDS.has(scene.kind)) {
      selected.add(scene);
      continue;
    }

    if (scene.kind === 'set_piece') {
      if (isProtectedReplaySetPiece(scene)) {
        selected.add(scene);
        continue;
      }

      const action = scene.sourceAction ?? 'unknown';
      const key = `${replayHalfKey(scene)}:${action}`;
      if (!routineSetPieceKeys.has(key)) {
        routineSetPieceKeys.add(key);
        selected.add(scene);
      }
      continue;
    }

    if (scene.kind === 'ambient') {
      const bucket = typeof scene.clockSeconds === 'number'
        ? String(Math.floor(Math.max(0, scene.clockSeconds) / REPLAY_AMBIENT_BUCKET_SECONDS))
        : `unknown:${replayHalfKey(scene)}`;
      lastAmbientByBucket.set(bucket, scene);
    }
  }

  for (const scene of lastAmbientByBucket.values()) selected.add(scene);
  return scenes.filter((scene) => selected.has(scene));
}

function isProtectedReplaySetPiece(scene: GameViewScene): boolean {
  if (scene.sourceAction === 'corner' || scene.sourceAction === 'penalty') return true;
  return scene.sourceAction === 'free_kick'
    && (scene.zone === 'danger' || scene.zone === 'high_danger');
}

function replayHalfKey(scene: GameViewScene): 'first_half' | 'second_half' {
  if (scene.phase === 'first_half' || scene.phase === 'first_half_ready') return 'first_half';
  if (scene.phase === 'second_half' || scene.phase === 'second_half_ready') return 'second_half';
  return (scene.clockSeconds ?? 0) < HALF_REGULATION_SECONDS ? 'first_half' : 'second_half';
}

/**
 * Computes `playback.{playbackOffsetMs,playbackDurationMs}` for each scene
 * in a replay timeline. Pure post-pass over the already-built scene list: it
 * never changes scene order, kind, or any source-of-truth field, only adds
 * presentation-timing metadata, so it stays trivially composable with the
 * rest of the (also pure) director.
 *
 * Pacing model:
 * - Ambient scenes advance the playback clock at `msPerMatchSecond` per
 *   match-clock second spanned since the previous scene's clock reading,
 *   capped at `ambientStretchCapMs` so a long quiet spell (e.g. minutes of
 *   midfield possession) never stalls the replay -- it compresses toward the
 *   cap instead. Ambient scenes with no clock delta (e.g. no clock data, or
 *   the very first scene) get the readability floor so they still occupy time.
 * - Every takeover scene (everything except `ambient`) keeps its full
 *   `durationHint.minMs` as its playback duration: takeovers are never
 *   compressed, per the PRD ("takeovers keep their durationHint").
 * - `playbackOffsetMs` is the running sum of prior scenes' playback
 *   durations, so scenes tile back-to-back with no gaps -- the renderer can
 *   schedule directly off these two numbers with no timers of its own.
 */
function applyReplayPacing(
  scenes: readonly GameViewScene[],
  pacing: GameViewReplayPacingOptions,
): readonly GameViewScene[] {
  const ambientCapMs = pacing.ambientStretchCapMs ?? DEFAULT_REPLAY_AMBIENT_CAP_MS;
  const msPerMatchSecond = pacing.msPerMatchSecond ?? DEFAULT_REPLAY_MS_PER_MATCH_SECOND;
  const targetDurationMs = pacing.targetDurationMs === undefined
    ? DEFAULT_REPLAY_TARGET_DURATION_MS
    : pacing.targetDurationMs;
  const playbackRate = typeof pacing.playbackRate === 'number'
    && Number.isFinite(pacing.playbackRate)
    && pacing.playbackRate > 0
    ? pacing.playbackRate
    : 1;

  let lastClockSeconds: number | undefined;
  const rawDurations: number[] = [];
  for (const scene of scenes) {
    let durationMs: number;
    if (scene.kind === 'ambient') {
      const clockSeconds = scene.clockSeconds;
      const deltaSeconds = typeof clockSeconds === 'number' && typeof lastClockSeconds === 'number'
        ? Math.max(0, clockSeconds - lastClockSeconds)
        : 0;
      const realPaceMs = deltaSeconds * msPerMatchSecond;
      durationMs = Math.min(
        Math.max(realPaceMs, REPLAY_AMBIENT_FLOOR_MS),
        Math.max(ambientCapMs, REPLAY_AMBIENT_FLOOR_MS),
      );
    } else {
      durationMs = scene.durationHint.minMs;
    }
    rawDurations.push(durationMs);
    if (typeof scene.clockSeconds === 'number') lastClockSeconds = scene.clockSeconds;
  }

  // Best-effort fit to the target: every retained non-ambient scene keeps its
  // full staged window; only ambient time shares the remaining budget.
  let flexScale = 1;
  if (targetDurationMs !== null) {
    let fixedTotal = 0;
    let flexTotal = 0;
    scenes.forEach((scene, index) => {
      if (scene.kind === 'ambient') flexTotal += rawDurations[index];
      else fixedTotal += rawDurations[index];
    });
    if (flexTotal > 0 && fixedTotal + flexTotal > targetDurationMs) {
      flexScale = Math.max(0, targetDurationMs - fixedTotal) / flexTotal;
    }
  }

  let offsetMs = 0;
  const paced: GameViewScene[] = [];
  scenes.forEach((scene, index) => {
    const raw = rawDurations[index];
    const plannedDurationMs = scene.kind !== 'ambient' || flexScale === 1
      ? raw
      : Math.max(REPLAY_AMBIENT_FLOOR_MS, Math.round(raw * flexScale));
    const durationMs = Math.max(1, Math.round(plannedDurationMs / playbackRate));
    paced.push({ ...scene, playback: { playbackOffsetMs: offsetMs, playbackDurationMs: durationMs } });
    offsetMs += durationMs;
  });

  return paced;
}

function kindForCue(cue: SimulationCue): GameViewSceneKind {
  switch (cue.kind) {
    case 'set_piece': return 'set_piece';
    case 'shot_attempt':
    case 'shot_outcome': return 'shot';
    case 'goal_pending':
    case 'goal_confirmed': return 'goal_sequence';
    case 'restart': return 'restart';
    case 'card': return 'card';
    case 'substitution': return 'substitution';
    case 'var': return 'var_review';
    case 'incident_retracted': return 'goal_retracted';
    case 'phase_change': return 'phase_break';
    default: return 'ambient';
  }
}
