/**
 * Pure decision layer for the headless listening session (demo-lockdown item
 * 1) -- no React/audio/network imports, mirroring the separation already
 * used for the voice queue (commentary-voice-logic.ts) and sound
 * (game-view-sound-logic.ts). The stateful driver
 * (commentary-listening-session.ts) consumes these functions; this file is
 * exercised directly by the plain-Node test runner.
 */

export interface ListeningSessionInfo {
  fixtureId: string;
  label: string;
  isLive: boolean;
}

export interface ListeningSessionState {
  active: ListeningSessionInfo | undefined;
  isPlaying: boolean;
}

export const IDLE_LISTENING_SESSION_STATE: ListeningSessionState = {
  active: undefined,
  isPlaying: false,
};

export type ListeningSessionEnterDecision =
  /** No session active yet: start a fresh one for this fixture. */
  | { kind: 'start' }
  /** Entering the same fixture already active: (re)join/keep it, resume playing -- never restart. */
  | { kind: 'adopt' }
  /** A different fixture's session is active: stop it, start fresh for the new one. */
  | { kind: 'swap' };

/**
 * Decides what happens when a match screen for `fixtureId` mounts (or
 * hands control to the session, e.g. on becoming visible) while
 * `current` describes whatever session state exists beforehand (undefined
 * if none). Entering the SAME fixture that's already active (e.g.
 * re-opening the match you were already listening to) adopts the existing
 * session rather than restarting it -- restarting would reset playback
 * position and re-trigger prefetch for no reason. A different fixture
 * always swaps: only one match's commentary plays at a time.
 */
export function decideListeningSessionEnter(
  current: ListeningSessionInfo | undefined,
  fixtureId: string,
): ListeningSessionEnterDecision {
  if (!current) return { kind: 'start' };
  if (current.fixtureId === fixtureId) return { kind: 'adopt' };
  return { kind: 'swap' };
}

/**
 * Item 1's core rule: leaving the match screen never stops the session by
 * itself. This function exists mainly as executable documentation of that
 * rule (there is deliberately no "on unmount, stop" decision function) --
 * the only paths that stop a session are explicit pause/stop from the bar,
 * opening a different match (see decideListeningSessionEnter's 'swap'), or
 * sound/voice being toggled off (handled by the driver reading the existing
 * sound/voice preference stores, not by this state machine).
 *
 * Round 5/item 4 REFINES this rule: it only holds for a LIVE match. See
 * `decideScreenDetachAction` below for the status-based split the owner
 * asked for.
 */
export function shouldStopOnScreenLeave(): boolean {
  return false;
}

export type ScreenDetachAction =
  /** Match is still live: keep the session running headless (item 1's original behavior). */
  | { kind: 'persist' }
  /** Match has finished: stop the session entirely -- no headless engine, no bar, silence. */
  | { kind: 'stop' };

/**
 * Round 5/item 4 (the owner's status-based rule): when the user leaves
 * MatchDetailScreen, what happens to that fixture's listening session
 * depends on whether the match is still LIVE or has FINISHED --
 *
 * - LIVE: the session continues headless exactly as item 1 originally
 *   specified (bar shows on Home, commentary keeps talking).
 * - FINISHED: the session stops outright. No headless engine spins up, no
 *   bar appears, nothing plays. This corrects the previous behavior where
 *   detaching always handed off to a fresh headless engine even for a
 *   finished match, which could leave voice "STARTING" on Home after the
 *   user left a silent full-time board.
 *
 * `isLive` is read from the session's own `ListeningSessionInfo.isLive`
 * (kept fresh by `enterListeningSession`'s adopt path, which refreshes it on
 * every re-entry even when the fixture doesn't change) -- not recomputed
 * here, so this function stays a pure one-line decision over already-known
 * state.
 */
export function decideScreenDetachAction(isLive: boolean): ScreenDetachAction {
  return isLive ? { kind: 'persist' } : { kind: 'stop' };
}

/**
 * Fix round item 3 (the owner's sound model): commentary voice must never
 * fire against a PARKED engine -- most concretely, re-entering a finished
 * match whose full-time board is idle. The driver tears itself down when a
 * finished match's screen detaches (`decideScreenDetachAction`'s 'stop'
 * case), so re-entering that same fixture always builds a brand-new driver
 * with a fresh (undefined) `firedEntryId` -- without this guard, the firing
 * loop (`evaluateFiring` in commentary-listening-session.ts) would treat the
 * "newest visible" entry at the parked playhead as unheard and speak it
 * again the instant the screen (re)attaches, with no user press involved.
 * `'live'`/`'replay'` are the only engine modes where the playhead is
 * genuinely advancing; `'paused'`/`'scrubbing'` (including a freshly
 * force-parked full-time landing) must stay silent, matching
 * `resolveGameViewPlaybackActive`'s same treatment of the ambient/effect
 * soundscape in game-view-screen-logic.ts.
 */
export function isListeningSessionEngineAdvancing(mode: 'live' | 'paused' | 'scrubbing' | 'replay'): boolean {
  return mode === 'live' || mode === 'replay';
}

/**
 * Bug fix (owner repro: toggle voice off mid-match -> stop -> play again ->
 * toggle voice back on -> commentary never returns until app reload). Sound
 * or voice being turned off must only tear down the whole driver in the
 * HEADLESS case (no screen attached) -- that behavior is intentional and
 * unchanged (item 1c: an off-screen session with sound/voice off has nothing
 * left to do, so it fully stops rather than idling forever).
 *
 * While a MatchDetailScreen is attached, the driver must survive a
 * sound/voice toggle: preferences already GATE firing on every fire (see
 * `evaluateFiring`'s snapshot reads of `getGameViewSoundEnabledSnapshot`/
 * `getGameViewVoiceEnabledSnapshot` in commentary-listening-session.ts), so
 * simply not-stopping is sufficient for playback to correctly stay silent
 * while disabled and resume the moment the preference flips back on -- no
 * teardown/rebuild needed, and therefore no window where re-enabling voice
 * has nothing left to attach to.
 */
export function shouldPreferenceDisableStopSession(attached: boolean): boolean {
  return !attached;
}

/**
 * The now-listening bar (item 2) shows only when a session is active, it is
 * currently playing (paused sessions don't float a bar back up -- muting is
 * the same as "nothing to show"), and the viewer is NOT already on that
 * match's own screen (no point floating a bar over the match you're
 * looking at).
 */
export function deriveNowListeningBarVisible(
  state: ListeningSessionState,
  viewingFixtureId: string | undefined,
): boolean {
  if (!state.active || !state.isPlaying) return false;
  return state.active.fixtureId !== viewingFixtureId;
}

export type ListeningSessionAction =
  | { kind: 'enter'; matchInfo: ListeningSessionInfo }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' };

/**
 * Pure state-shape transition for pause/resume/stop (+ the state half of
 * enter, alongside `decideListeningSessionEnter`'s start/adopt/swap
 * decision) -- the stateful driver (commentary-listening-session.ts) calls
 * this for the `ListeningSessionState` it exposes to the bar, and layers its
 * own side effects (tearing down/creating engines, silencing the audio
 * player, network polling) around it separately. Kept pure and total so
 * every transition -- including the no-op cases (pausing/resuming/stopping
 * with no active session) -- is exercised directly by the plain-Node test
 * runner without a real engine/session/audio player in play.
 */
export function applyListeningSessionAction(
  state: ListeningSessionState,
  action: ListeningSessionAction,
): ListeningSessionState {
  switch (action.kind) {
    case 'enter':
      return { active: action.matchInfo, isPlaying: true };
    case 'pause':
      if (!state.active) return state;
      return { ...state, isPlaying: false };
    case 'resume':
      if (!state.active) return state;
      return { ...state, isPlaying: true };
    case 'stop':
      return IDLE_LISTENING_SESSION_STATE;
    default:
      return state;
  }
}

/**
 * Builds the compact match label the bar (and any other headless-session
 * consumer) shows, e.g. "England vs Argentina". Falls back to the fixture id
 * if both team names are somehow empty (defensive only).
 */
export function buildListeningSessionLabel(homeTeamName: string, awayTeamName: string): string {
  const home = homeTeamName.trim();
  const away = awayTeamName.trim();
  if (!home && !away) return '';
  if (!home) return away;
  if (!away) return home;
  return `${home} vs ${away}`;
}
