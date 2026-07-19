import type { GameCrewMatchStatus } from '@gamecrew/core';

import type { PlaybackMode } from '../state/playback-engine';

/**
 * Pure label/state derivation for the transport strip (demo-lockdown round
 * 5, item 7) -- no React/RN here, matching the split already used by
 * game-view-screen-logic.ts / game-view-checkpoint-logic.ts. The strip
 * itself (match-transport-strip.tsx) renders a single play/pause button plus
 * a short state label, and (for a finished match with something playing) a
 * stop/"back to full time" affordance, derived from the shared playback
 * snapshot + `gameViewIntent` (the same Game View intent state
 * gamecrew-screens.tsx already tracks for the full-time board) + the
 * match's own status.
 */

export type GameViewIntent = 'idle' | 'clip' | 'highlights' | 'full';

export interface TransportStripInput {
  matchStatus: GameCrewMatchStatus;
  playbackMode: PlaybackMode;
  gameViewIntent: GameViewIntent;
  /** Current scene's match-clock minute (1-based, already rounded up -- same convention as the checkpoint rail's own `minute`), when known. */
  currentMinute: number | undefined;
  /**
   * Item 4 (fix round): the match's own kickoff time, already formatted by
   * the caller (gamecrew-screens.tsx already owns the app's kickoff
   * formatting helpers -- this module stays free of `Intl`/date concerns,
   * matching its no-React/no-formatting convention). Only read for
   * `upcoming`/`hosted` matches; ignored otherwise.
   */
  kickoffLabel?: string | undefined;
}

export type TransportStripLabel =
  | { kind: 'full_time' }
  | { kind: 'playing_highlights' }
  | { kind: 'replay'; minute: number | undefined }
  | { kind: 'clip'; minute: number | undefined }
  | { kind: 'live' }
  /** Item 4: an upcoming/hosted fixture that hasn't kicked off yet -- the strip reads "Kickoff" (or "Kickoff {time}" when threaded) instead of a misleading "LIVE". */
  | { kind: 'kickoff'; kickoffLabel: string | undefined };

/**
 * Resolves the strip's short state label from playback snapshot +
 * `gameViewIntent` + match status:
 * - a finished/replayable match with nothing playing (`gameViewIntent ===
 *   'idle'`) reads "Full time";
 * - `gameViewIntent === 'highlights'` reads "Playing highlights" regardless
 *   of the underlying bounded-clip mechanics (highlights are a sequence of
 *   clips under the hood, but the label speaks to the user's actual
 *   action);
 * - `gameViewIntent === 'full'` (the full from-kickoff replay) reads
 *   "Replay {minute}'";
 * - `gameViewIntent === 'clip'` (a single checkpoint clip) reads "Watching
 *   {minute}' moment";
 * - a live match (playbackMode 'live', or paused mid-live-tail) reads
 *   "LIVE".
 *
 * `gameViewIntent` alone can't distinguish live from replay for a match
 * whose status is 'live' (gameViewIntent stays 'idle' for a live match,
 * since the full-time board never shows for one -- see
 * `shouldLandAtFullTime`), so `matchStatus === 'live'` is checked first.
 *
 * Item 4 (fix round): an `upcoming`/`hosted` match that hasn't kicked off
 * reads "Kickoff" (or "Kickoff {kickoffLabel}" when the caller threaded a
 * formatted time) instead of falling through to a bare replay/LIVE label --
 * checked right after `live`, before any `gameViewIntent` branch, since an
 * upcoming fixture has nothing queued to reflect one either way.
 */
export function resolveTransportStripLabel(input: TransportStripInput): TransportStripLabel {
  const { currentMinute, gameViewIntent, kickoffLabel, matchStatus, playbackMode } = input;

  if (matchStatus === 'live') return { kind: 'live' };
  if (matchStatus === 'upcoming' || matchStatus === 'hosted') return { kind: 'kickoff', kickoffLabel };

  if (gameViewIntent === 'highlights') return { kind: 'playing_highlights' };
  if (gameViewIntent === 'full') return { kind: 'replay', minute: currentMinute };
  if (gameViewIntent === 'clip') return { kind: 'clip', minute: currentMinute };

  // idle: a genuinely completed match with nothing playing shows "Full
  // time"; anything else (a completed match whose engine hasn't settled to
  // idle intent yet) falls back to a plain replay label rather than a
  // misleading "Full time" -- playbackMode covers that edge without needing
  // a third input just for it.
  if (matchStatus === 'finished' || matchStatus === 'replayable') return { kind: 'full_time' };
  return playbackMode === 'live' ? { kind: 'live' } : { kind: 'replay', minute: currentMinute };
}

/** Formats a `TransportStripLabel` into the exact copy the strip renders. */
export function formatTransportStripLabel(label: TransportStripLabel): string {
  switch (label.kind) {
    case 'full_time': return 'Full time';
    case 'playing_highlights': return 'Playing highlights';
    case 'replay': return label.minute === undefined ? 'Replay' : `Replay ${label.minute}'`;
    case 'clip': return label.minute === undefined ? 'Watching moment' : `Watching ${label.minute}' moment`;
    case 'live': return 'LIVE';
    case 'kickoff': return label.kickoffLabel === undefined ? 'Kickoff' : `Kickoff ${label.kickoffLabel}`;
  }
}

export type TransportButtonAction =
  /** Finished + idle: starts the full replay (same handler as "Watch full match"). */
  | { kind: 'start_full_replay' }
  /** Something is actively playing (highlights/replay/clip/live): pauses it, and always stops voice immediately. */
  | { kind: 'pause' }
  /** Paused mid-highlights/replay/clip: resumes exactly where it left off. */
  | { kind: 'resume' }
  /** Live, paused on the tail: returns to the live head. */
  | { kind: 'return_to_live' }
  /** Item 4: upcoming/hosted, nothing to play yet -- the button renders disabled and a tap does nothing. */
  | { kind: 'none' };

/**
 * Resolves what the single play/pause button does on tap. `isPaused` is the
 * caller's own tracked pause state for the strip (playback-engine has no
 * single boolean for "the user explicitly paused mid-clip" distinct from
 * "settled to idle" -- see match-transport-strip.tsx's doc comment on why
 * this is tracked at the component level rather than derived from
 * `playbackMode` alone, since `'paused'` there also legitimately describes
 * "not yet started").
 */
export function resolveTransportButtonAction(input: {
  matchStatus: GameCrewMatchStatus;
  gameViewIntent: GameViewIntent;
  isPaused: boolean;
}): TransportButtonAction {
  const { gameViewIntent, isPaused, matchStatus } = input;

  if (matchStatus === 'upcoming' || matchStatus === 'hosted') {
    return { kind: 'none' };
  }

  if (matchStatus === 'live') {
    return isPaused ? { kind: 'return_to_live' } : { kind: 'pause' };
  }

  if (gameViewIntent === 'idle') {
    return { kind: 'start_full_replay' };
  }

  return isPaused ? { kind: 'resume' } : { kind: 'pause' };
}

/**
 * Whether the stop/"back to full time" affordance should render: only for a
 * finished match with something actively playing or paused mid-playback
 * (never while idle -- there's nothing to stop back to, the board is
 * already showing).
 */
export function shouldShowBackToFullTime(
  matchStatus: GameCrewMatchStatus,
  gameViewIntent: GameViewIntent,
): boolean {
  const isFinished = matchStatus === 'finished' || matchStatus === 'replayable';
  return isFinished && gameViewIntent !== 'idle';
}

/**
 * Item 3 (fix round): whether the strip's single button should render the
 * play glyph (▶) rather than pause (❚❚). The caller's own `isPausedByStrip`
 * flag only tracks an explicit mid-playback pause tap -- it resets to false
 * on every `gameViewIntent` change (including the settle back to idle after
 * highlights/a clip finishes), so reading it alone left the strip showing a
 * pause icon next to "Full time" once nothing was playing anymore. Nothing
 * is ever actually playing while `gameViewIntent === 'idle'` for a
 * finished/replayable match (see `resolveTransportButtonAction`'s 'idle'
 * case, which offers 'start_full_replay' -- there is no "pause" action to
 * reflect), so idle always reads as paused/play-glyph regardless of the
 * caller's own explicit flag. A live match has no idle intent at all (the
 * full-time board never renders for one), so this defers entirely to
 * `isPausedByStrip` there, unchanged from before.
 */
export function resolveTransportStripIsPaused(input: {
  gameViewIntent: GameViewIntent;
  isPausedByStrip: boolean;
  matchStatus: GameCrewMatchStatus;
}): boolean {
  const { gameViewIntent, isPausedByStrip, matchStatus } = input;
  if (matchStatus === 'upcoming' || matchStatus === 'hosted') return true;
  if (matchStatus !== 'live' && gameViewIntent === 'idle') return true;
  return isPausedByStrip;
}

/**
 * Item 4: whether the strip's play/pause button should render
 * disabled/dimmed -- true only for an upcoming/hosted fixture, where there
 * is genuinely nothing to play yet and a tap must be a no-op (see
 * `resolveTransportButtonAction`'s `'none'` case).
 */
export function resolveTransportStripButtonDisabled(matchStatus: GameCrewMatchStatus): boolean {
  return matchStatus === 'upcoming' || matchStatus === 'hosted';
}
