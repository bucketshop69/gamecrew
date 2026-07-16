import type { GameCrewMatchStatus, GameViewScene, GameViewSceneKind, MatchEngineScore } from '@gamecrew/core';

import type { MatchSessionStatus } from '../../state/match-session';
import type { ActiveSceneWindow, PlaybackMode } from '../../state/playback-engine';
import type { GameViewLoadStatus } from './game-view-board-logic';

/**
 * Pure decision logic for `GameViewScreen` (work item B4 of
 * docs/issues/game-view-board-and-presentation.md): mode selection, view-state
 * mapping, takeover-advancement ownership, and sourceAction -> takeover
 * variant mapping. Nothing here touches React or React Native, so it is
 * testable with plain `node:test` assertions -- see
 * tests/game-view-screen-logic.test.mjs.
 */

/**
 * The header/score-rail presentation state `GameViewScreen` reports up to
 * `MatchDetailScreen` (gamecrew-screens.tsx), which renders it in the
 * shared header/score rail while the Game View tab is active. Carried over
 * unchanged from the retired scripted demo's `GameViewPresentationState` so
 * `MatchDetailScreen`'s header rendering needed no changes for this swap.
 */
export interface GameViewPresentationState {
  clockLabel: string;
  phaseLabel: string;
  score: { home: number; away: number };
}

/**
 * Gives every renderer the playback engine's concrete scene window instead
 * of letting components independently reinterpret `durationHint`. The
 * director's source-grounded fields stay untouched; only the presentation
 * duration is narrowed to the active instance. A mismatched window is
 * ignored defensively so a stale React render can never time the wrong
 * scene.
 */
export function resolvePresentationScene(
  scene: GameViewScene | null | undefined,
  window: ActiveSceneWindow | undefined,
): GameViewScene | null | undefined {
  if (!scene || !window || window.sceneId !== scene.id) return scene;

  const durationMs = Math.max(0, window.durationMs);
  if (
    scene.durationHint.minMs === durationMs
    && scene.durationHint.maxMs === durationMs
  ) {
    return scene;
  }

  return {
    ...scene,
    durationHint: { minMs: durationMs, maxMs: durationMs },
  };
}

// ---------------------------------------------------------------------------
// No score spoiler (fix #3)
// ---------------------------------------------------------------------------

/**
 * Resolves the score the header/score rail should show for the current
 * scene, holding the pre-goal score through a `goal_sequence` scene's
 * `tension` beat and committing the new score only once the `celebration`
 * beat starts (fix #3: "NO SCORE SPOILER" -- the board plays "GOAL? CHECKING"
 * while the header must not already show the committed scoreline).
 *
 * `scene.scoreAtMoment` on a `goal_sequence` scene is already the
 * *post-goal* score once the celebration beat exists (see
 * packages/core's `handleGoalConfirmed`), so simply reading
 * `currentScene.scoreAtMoment` -- what `GameViewScreen` did before this fix
 * -- leaks the new score during the still-checking tension beat. This
 * function instead:
 *
 * - for any non-`goal_sequence` scene, or a `goal_sequence` scene with no
 *   beats, returns the scene's own `scoreAtMoment` (unchanged behavior);
 * - for a `goal_sequence` scene whose *current* beat is `tension`, prefers
 *   that beat's source-grounded pre-goal score, falling back to
 *   `previousScore` for legacy timelines, rather than reading the scene's
 *   post-goal `scoreAtMoment`;
 * - for a `goal_sequence` scene whose current beat is `celebration` (or any
 *   later beat), returns that beat's own `scoreAtMoment` (falling back to
 *   the scene's) -- the commit moment.
 *
 * `activeBeatIndex` identifies which beat is currently playing within the
 * scene's own beat choreography (see `GoalSequenceTakeover`'s
 * `planGoalSequenceBeats`); the screen doesn't independently track beat
 * playback today, so callers that haven't wired per-beat tracking can pass
 * `0` to conservatively hold at the first (tension) beat until a
 * celebration beat is known to be active.
 */
export function resolveScoreRailScore(
  scene: GameViewScene | null | undefined,
  previousScore: MatchEngineScore | undefined,
  activeBeatIndex = 0,
): MatchEngineScore | undefined {
  if (!scene) return previousScore;
  if (scene.kind !== 'goal_sequence') return scene.scoreAtMoment;

  const beats = scene.beats ?? [];
  if (beats.length === 0) return scene.scoreAtMoment;

  const clampedIndex = Math.min(Math.max(activeBeatIndex, 0), beats.length - 1);
  const activeBeat = beats[clampedIndex];

  if (activeBeat?.kind === 'tension') return activeBeat.scoreAtMoment ?? previousScore;
  return activeBeat?.scoreAtMoment ?? scene.scoreAtMoment;
}

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

export type GameViewPlaybackModeChoice = 'replay' | 'live';

/**
 * Decides which playback mode a fixture should start/stay in, from the
 * match's own status. Finished (or otherwise no-longer-live) fixtures replay
 * from the start so "a finished fixture replays end to end on device through
 * the same path a live match will use" (PRD); live fixtures track the live
 * head. `upcoming`/`hosted` fixtures are treated the same as replay -- there
 * is no live head to track yet, and any stored frames (e.g. a hosted replay)
 * should still play back rather than sit idle.
 */
export function selectPlaybackModeForMatchStatus(
  status: GameCrewMatchStatus,
): GameViewPlaybackModeChoice {
  return status === 'live' ? 'live' : 'replay';
}

/** Whether `usePlaybackEngine`'s `isLive` polling flag should be set for a given match status. */
export function isLiveMatchStatus(status: GameCrewMatchStatus): boolean {
  return status === 'live';
}

// ---------------------------------------------------------------------------
// View-state mapping
// ---------------------------------------------------------------------------

/**
 * Maps the session/playback status into the B3 state-panel vocabulary
 * (`GameViewLoadStatus`) plus a separate `isStale` flag, since stale renders
 * as a banner over the still-visible board rather than replacing it (see
 * `GameViewStatePanel`/`GameViewStaleBanner`'s doc comments).
 *
 * `hasScenes` distinguishes "loading, nothing yet" from "loaded, but the
 * director produced no scenes at all" (empty): a session can report
 * `sessionStatus: 'complete'` with zero frames for a fixture TxLINE has no
 * signal for yet, which per the PRD's empty-state copy ("Game View will
 * appear when TxLINE has enough match signal") is a distinct state from
 * still-loading or an error.
 */
export function resolveGameViewLoadState(
  sessionStatus: MatchSessionStatus,
  hasScenes: boolean,
): { status: GameViewLoadStatus; isStale: boolean } {
  if (sessionStatus === 'error' && !hasScenes) return { status: 'error', isStale: false };
  if (sessionStatus === 'loading') return { status: 'loading', isStale: false };
  if (!hasScenes) return { status: 'empty', isStale: false };

  // Frames already exist: stale/error while data exists should keep showing
  // the board (per PRD: stale "keeps the board at its last state"), with the
  // stale banner layered on top. An error after data was already flowing is
  // treated the same as stale -- the board holds its last known state rather
  // than being torn down for a transient poll failure.
  return { status: 'ready', isStale: sessionStatus === 'stale' || sessionStatus === 'error' };
}

// ---------------------------------------------------------------------------
// Takeover-advancement ownership
// ---------------------------------------------------------------------------

/**
 * Scene kinds the takeover dispatcher (`GameViewTakeover`) actually renders
 * something for. Mirrors `resolveTakeoverComponentKind`'s non-'none' cases
 * (game-view-takeover-logic.ts) but is kept independent so this module has no
 * import-time dependency on the takeovers directory.
 */
const TAKEOVER_SCENE_KINDS: ReadonlySet<GameViewSceneKind> = new Set([
  'goal_sequence',
  'card',
  'set_piece',
  'var_review',
  'goal_retracted',
  'phase_break',
  'restart',
]);

/** Whether a scene kind should render as a takeover (dispatcher + overlay slot) rather than the ambient board alone. */
export function isTakeoverSceneKind(kind: GameViewSceneKind | undefined): boolean {
  return kind !== undefined && TAKEOVER_SCENE_KINDS.has(kind);
}

/**
 * ADVANCEMENT OWNERSHIP DECISION (see docs/issues/game-view-board-and-presentation.md, B4):
 *
 * `PlaybackEngine` is the single owner of playhead advancement in every
 * mode:
 *
 * - `replay`: the engine's own timer (`scheduleNextReplayStep`) advances the
 *   playhead on a schedule derived from each scene's `durationHint`, whether
 *   that scene renders as an ambient board frame or a takeover. It does not
 *   know or care what the renderer draws for a given scene.
 * - `live`: the engine has no advancement timer at all; the playhead is
 *   recomputed (`applyLiveBuffer`) only when the session receives new
 *   frames, tracking a fixed buffer behind the head. There is nothing to
 *   "finish" early -- the next scene simply isn't there yet.
 * - `paused`/`scrubbing`: the playhead only moves via explicit `controls`
 *   calls.
 *
 * A takeover component's `onComplete` (see takeover-shared.tsx's
 * `TakeoverBaseProps`) is therefore NOT wired to any playback-advancement
 * call in `GameViewScreen`. It exists for the takeover's own internal
 * bookkeeping/accessibility timing contract (every takeover must call it
 * exactly once so a *future* seek-bar/manual-advance UI has a signal to hook
 * into -- see game-view-presentation-polish.md), but `GameViewScreen` passes
 * a no-op so today it never double-drives the playhead alongside the
 * engine's own timer. This function documents (and lets tests assert) that
 * decision rather than the screen silently doing nothing.
 */
export function shouldTakeoverOnCompleteAdvancePlayback(_mode: PlaybackMode): false {
  return false;
}

// ---------------------------------------------------------------------------
// sourceAction -> takeover variant mapping
// ---------------------------------------------------------------------------

export type ScreenCardVariant = 'yellow' | 'red';
export type ScreenSetPieceVariant = 'corner' | 'free_kick' | 'throw_in' | 'penalty';

/**
 * Maps a `card` scene's raw `sourceAction` (copied verbatim from the source
 * cue's `value.action`, e.g. 'yellow_card' / 'red_card' -- see
 * packages/core's game-view.ts `handleCard`) to the takeover dispatcher's
 * `CardVariant` prop. Returns undefined for anything unrecognized so the
 * dispatcher/resolveCardVariant's own safe default (yellow) applies rather
 * than this function guessing.
 */
export function mapSourceActionToCardVariant(
  sourceAction: string | undefined,
): ScreenCardVariant | undefined {
  if (sourceAction === 'red_card') return 'red';
  if (sourceAction === 'yellow_card') return 'yellow';
  return undefined;
}

/**
 * Maps a `set_piece` scene's raw `sourceAction` to the takeover dispatcher's
 * `SetPieceVariant` prop. Returns undefined for anything unrecognized so
 * `resolveSetPieceVariant`'s own safe default (free_kick) applies.
 */
export function mapSourceActionToSetPieceVariant(
  sourceAction: string | undefined,
): ScreenSetPieceVariant | undefined {
  switch (sourceAction) {
    case 'corner':
    case 'free_kick':
    case 'throw_in':
    case 'penalty':
      return sourceAction;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Minor set-piece badge vs full vignette (fix #2)
// ---------------------------------------------------------------------------

/**
 * Decides whether a `set_piece` scene should take over the full screen
 * (`SetPieceVignette`) or render as a compact badge over the still-visible
 * board. Product rule (2026-07-15, with the 22-player formation view): the
 * pitch is never blanked for a dead ball -- the players hold their
 * positions (see the cluster's 'hold' plan) and a badge names the moment.
 * Only an explicitly recognized `penalty` still owns the screen; an
 * unrecognized or missing set-piece type therefore defaults to the QUIET
 * treatment, not the loud one (this inverts the original safe-default,
 * which was how "MOROCCO FREE KICK" walls ended up covering the match).
 *
 * This does not change the playback advancement contract: the scene still
 * occupies its full playback window either way (see
 * `shouldTakeoverOnCompleteAdvancePlayback`'s doc comment) -- this function
 * only decides which visual treatment renders for that window.
 */
export function shouldSetPieceUseFullVignette(sourceAction: string | undefined): boolean {
  return mapSourceActionToSetPieceVariant(sourceAction) === 'penalty';
}
