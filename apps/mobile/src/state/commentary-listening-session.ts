import { buildGameViewTimeline, type MatchPulseCommentaryEntry } from '@gamecrew/core';
import { useEffect, useSyncExternalStore } from 'react';

import { fetchCommentaryAudioManifest, fetchMatchPulseCommentary, isAbortError, matchRefreshIntervalMs } from '../api/gamecrew';
import { resolveCommentaryVoicePrefetchWindow } from '../screens/game-view/commentary-voice-logic';
import {
  isGameViewCommentaryProjectionCompatible,
  selectVisibleGameViewCommentary,
} from '../screens/game-view/game-view-commentary-logic';
import {
  getGameViewSoundEnabledSnapshot,
  getGameViewVoiceEnabledSnapshot,
  registerSoundOrVoiceDisabledListener,
} from '../screens/game-view/game-view-sound-preference';
import {
  playCommentaryVoiceClip,
  prefetchCommentaryVoiceClips,
  resolveCommentaryVoiceClipUrl,
  startCommentaryVoiceSession,
  stopCommentaryVoiceImmediately,
  stopCommentaryVoiceSession,
} from '../screens/game-view/use-commentary-voice';
import {
  applyListeningSessionAction,
  buildListeningSessionLabel,
  decideListeningSessionEnter,
  decideScreenDetachAction,
  deriveNowListeningBarVisible,
  IDLE_LISTENING_SESSION_STATE,
  isListeningSessionEngineAdvancing,
  shouldPreferenceDisableStopSession,
  type ListeningSessionInfo,
  type ListeningSessionState,
} from './commentary-listening-session-logic';
import { createMatchSessionDefaultDeps } from './match-session-defaults';
import { acquireMatchSession, type MatchSessionHandle } from './match-session';
import { PlaybackEngine, type PlaybackSnapshot } from './playback-engine';

// This file is only consumed by React screens (bundled by Metro), never by
// the mobile package's plain-Node test runner -- same constraint documented
// in use-playback-engine.ts/use-economy.ts (real @gamecrew/core director,
// real API fetchers, real audio player module). The reducer/decision logic
// it's built on (commentary-listening-session-logic.ts) is the Node-testable
// half; this module is the stateful adapter, exercised by the app itself.

export type { ListeningSessionInfo, ListeningSessionState } from './commentary-listening-session-logic';
export { buildListeningSessionLabel };

/**
 * Headless, module-level "now listening" driver (demo-lockdown item 1).
 * Extracted out of MatchDetailScreen's firing effect (see
 * gamecrew-screens.tsx's old `newestVisibleVoiceEntry` effect) so commentary
 * keeps narrating the replay after the user leaves the match screen, until
 * they explicitly pause it, open a different match, or turn sound/voice
 * off.
 *
 * MatchDetailScreen already owns its own `PlaybackEngine` (via
 * `usePlaybackEngine`, unchanged) for on-screen rendering AND for checkpoint/
 * highlights/full-replay seeks (`playback.controls.startReplayAt` etc). That
 * engine must stay the single source of truth for playhead position while
 * the screen is mounted -- a second, independently-advancing engine for the
 * same fixture would desync voice from whatever the user just jumped to on
 * screen. So instead of always owning its own engine, this driver has two
 * modes:
 *
 * - **Attached** (`attachListeningSessionEngine`, called by MatchDetailScreen
 *   in an effect while mounted): the driver fires voice off snapshots fed to
 *   it from the screen's own engine, and does not construct one of its own.
 *   This is the in-match path -- identical clip decisions to before the
 *   lift, just routed through this module instead of a local effect.
 * - **Headless** (no screen attached): the driver constructs its own
 *   `PlaybackEngine` sharing the same refcounted `MatchSession` frame log
 *   (`acquireMatchSession`), continuing from the current session state. Its
 *   own timers (playback-engine.ts's `scheduleReplayAdvance`/
 *   `scheduleLiveQueue`) keep the replay advancing with no React tree
 *   mounted at all.
 *
 * `detachListeningSessionEngine` (called on MatchDetailScreen unmount) hands
 * control from attached back to headless without stopping anything -- the
 * session keeps running off-screen from wherever the on-screen engine left
 * off (live matches naturally continue from the live head either way;
 * finished-match replay position is not carried over to the headless engine,
 * which is an accepted narrowing -- see the doc comment on
 * `detachListeningSessionEngine`).
 */

const PULSE_POLL_INTERVAL_MS = matchRefreshIntervalMs;

interface DriverState {
  fixtureId: string;
  matchInfo: ListeningSessionInfo;
  session: MatchSessionHandle;
  /** Only set in headless mode; undefined while a screen is attached (the screen owns its own engine instance). */
  ownEngine: PlaybackEngine | undefined;
  unsubscribeOwnEngine: (() => void) | undefined;
  /** True while a mounted MatchDetailScreen is feeding this driver its own engine's snapshots via `attachListeningSessionEngine`. */
  attached: boolean;
  playing: boolean;
  lastEngineSnapshot: PlaybackSnapshot | undefined;
  pulseEntries: readonly MatchPulseCommentaryEntry[];
  pulseProjectionGeneration: number | undefined;
  pulsePollAbort: AbortController | undefined;
  pulsePollTimer: ReturnType<typeof setTimeout> | undefined;
  pulsePollDisposed: boolean;
  manifestEntryIds: readonly string[];
  manifestAbort: AbortController | undefined;
  firedEntryId: string | undefined;
}

let driver: DriverState | undefined;
const listeners = new Set<() => void>();

// Item 1c: turning sound or voice off app-wide stops any off-screen
// (headless) session outright -- matching in-match behavior, where the
// firing effect simply never plays while either preference is off, without
// needing to tear the driver down. Registered once at module load, not
// per-session, since the preference singletons themselves are module-level
// too.
//
// Bug fix: this must NOT stop the driver while a MatchDetailScreen is
// attached (see `shouldPreferenceDisableStopSession`'s doc comment) --
// doing so previously killed commentary permanently for the rest of the
// visit (toggle voice off -> stop -> play again -> toggle voice back on ->
// no driver left for `evaluateFiring` to fire from, and nothing re-creates
// one until the screen remounts). While attached, preferences only gate
// firing (see `evaluateFiring` below), so simply not stopping here is
// sufficient: the driver survives, stays silent while disabled, and the
// very next fired entry speaks again once re-enabled.
registerSoundOrVoiceDisabledListener(() => {
  if (!driver) return;
  if (!shouldPreferenceDisableStopSession(driver.attached)) return;
  stopListeningSession();
});

function notify() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// useSyncExternalStore requires getSnapshot to return a referentially stable
// value until the underlying state actually changes -- a fresh object every
// call makes React treat each render as a state change and loop forever.
let cachedSnapshot: ListeningSessionState = IDLE_LISTENING_SESSION_STATE;

function getSnapshot(): ListeningSessionState {
  const active = driver?.matchInfo;
  const isPlaying = driver?.playing ?? false;
  if (cachedSnapshot.active !== active || cachedSnapshot.isPlaying !== isPlaying) {
    cachedSnapshot = active ? { active, isPlaying } : IDLE_LISTENING_SESSION_STATE;
  }
  return cachedSnapshot;
}

function getServerSnapshot(): ListeningSessionState {
  return IDLE_LISTENING_SESSION_STATE;
}

/** Reactive listening-session snapshot for the now-listening bar and any other consumer. */
export function useListeningSessionState(): ListeningSessionState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Reactive bar-visibility derivation (item 2): active + playing + viewer not already on that match's screen. */
export function useNowListeningBarVisible(viewingFixtureId: string | undefined): boolean {
  const state = useListeningSessionState();
  return deriveNowListeningBarVisible(state, viewingFixtureId);
}

/**
 * Entering a match hands the headless session over. Called from
 * MatchDetailScreen on mount/fixture change (see gamecrew-screens.tsx).
 * `matchInfo` describes the match being entered; a fresh session uses it to
 * start, and even an 'adopt' (same fixture already active) refreshes the
 * stored label/live status -- a live match can flip to finished while the
 * session keeps running off-screen -- without resetting playback position
 * or prefetch state. Does not itself attach the screen's engine -- see
 * `attachListeningSessionEngine`, called separately once the screen's own
 * `usePlaybackEngine` instance exists.
 */
export function enterListeningSession(matchInfo: ListeningSessionInfo): void {
  const decision = decideListeningSessionEnter(driver?.matchInfo, matchInfo.fixtureId);

  if (decision.kind === 'swap') {
    teardownDriver();
  }

  if (decision.kind === 'start' || decision.kind === 'swap') {
    driver = createHeadlessDriver(matchInfo);
  } else {
    driver!.matchInfo = matchInfo;
  }

  driver!.playing = true;
  notify();
}

/**
 * MatchDetailScreen calls this in an effect (dependent on its own
 * `usePlaybackEngine` snapshot) so the ALREADY-entered session fires voice
 * off the screen's own engine instead of a second, independently-advancing
 * one -- this is what keeps checkpoint/highlights/replay seeks in lockstep
 * with voice while in-match, matching pre-lift behavior exactly. A no-op if
 * no session is active for this fixture (e.g. called before
 * `enterListeningSession`, or for a fixture that isn't the active session --
 * MatchDetailScreen always calls `enterListeningSession` first in the same
 * render pass, so this is defensive only in practice).
 *
 * Belt-and-braces re-entry: `matchInfo`, when provided, lets this rebuild a
 * missing/mismatched driver for the currently-mounted fixture instead of
 * silently no-op'ing -- covers any path (besides the one already fixed by
 * `shouldPreferenceDisableStopSession`) that might kill the driver while a
 * screen is still attached. Runs on every render (see
 * `useAttachListeningSessionEngine`'s undated effect), so a killed driver is
 * rebuilt on the very next render rather than staying dead for the rest of
 * the visit.
 */
export function attachListeningSessionEngine(
  fixtureId: string,
  snapshot: PlaybackSnapshot,
  matchInfo?: ListeningSessionInfo,
): void {
  if ((!driver || driver.fixtureId !== fixtureId) && matchInfo) {
    enterListeningSession(matchInfo);
  }
  if (!driver || driver.fixtureId !== fixtureId) return;
  if (!driver.attached) {
    // Handing off from headless to attached: stop the driver's own engine
    // (its polling/timers), the screen's engine takes over as the sole
    // source of playhead position from here.
    disposeOwnEngine(driver);
    driver.attached = true;
  }
  driver.lastEngineSnapshot = snapshot;
  evaluateFiring(driver);
}

/**
 * MatchDetailScreen calls this on unmount. Round 5/item 4 (the owner's
 * status-based rule): what happens next depends on whether the match is
 * still LIVE or has FINISHED (see `decideScreenDetachAction`) --
 *
 * - LIVE: hands control back to a headless engine so the session keeps
 *   advancing with no screen mounted. The headless engine is a fresh
 *   `PlaybackEngine` over the same shared, refcounted `MatchSession` (so it
 *   continues from the current durable frame log, not from scratch) --
 *   naturally resumes at the live head, matching what the user was just
 *   watching.
 * - FINISHED: the session stops outright (`stopListeningSession`) -- no
 *   headless engine spins up at all, the bar never appears, and commentary
 *   falls silent. This corrects the previous behavior, which always handed
 *   off to a fresh headless engine regardless of match status: for a
 *   finished match mid-replay/mid-clip, that headless engine would restart
 *   the fixture's default replay pacing from scene zero (since
 *   `PlaybackEngine` has no "resume my exact on-screen playhead" API),
 *   which could leave voice audibly "STARTING" on Home after the user left
 *   a silent full-time board -- a finished match has nothing worth
 *   continuing off-screen, so this now just stops.
 */
export function detachListeningSessionEngine(fixtureId: string): void {
  if (!driver || driver.fixtureId !== fixtureId || !driver.attached) return;

  const action = decideScreenDetachAction(driver.matchInfo.isLive);
  if (action.kind === 'stop') {
    stopListeningSession();
    return;
  }

  driver.attached = false;
  // The driver's previous session handle was already released when it
  // handed off to the screen at attach time (see attachListeningSessionEngine
  // -> disposeOwnEngine, whose PlaybackEngine.dispose() called
  // session.release()) -- that handle must not be reused (its `release()` is
  // now a permanent no-op, so a second engine built on it would not hold a
  // genuine refcount on the shared MatchSession). Acquire a fresh handle
  // instead, exactly as re-entering headless mode from scratch would.
  driver.session = acquireMatchSession(
    driver.fixtureId,
    createMatchSessionDefaultDeps(() => driver?.matchInfo.isLive ?? false),
  );
  driver.ownEngine = createEngineForSession(driver.session);
  driver.unsubscribeOwnEngine = driver.ownEngine.subscribe((snapshot) => onEngineSnapshot(driver!, snapshot));
  onEngineSnapshot(driver, driver.ownEngine.getSnapshot());
}

/**
 * Pauses playback without tearing the session down; the bar/profile can
 * resume it later. `driver.playing` is kept in lockstep with
 * `applyListeningSessionAction`'s pure 'pause' transition (see
 * commentary-listening-session-logic.test.mjs) -- computed via the reducer
 * here rather than just set to `false` inline, so the state-shape behavior
 * (a no-op when nothing is active) is provably the same function the tests
 * exercise, with only the side effects (silencing the audio player) layered
 * on top.
 */
export function pauseListeningSession(): void {
  if (!driver) return;
  const next = applyListeningSessionAction({ active: driver.matchInfo, isPlaying: driver.playing }, { kind: 'pause' });
  driver.playing = next.isPlaying;
  stopCommentaryVoiceImmediately();
  notify();
}

/** Resumes a paused session in place -- see `pauseListeningSession`'s doc comment on why this goes through the reducer. */
export function resumeListeningSession(): void {
  if (!driver) return;
  const next = applyListeningSessionAction({ active: driver.matchInfo, isPlaying: driver.playing }, { kind: 'resume' });
  driver.playing = next.isPlaying;
  evaluateFiring(driver);
  notify();
}

/** Fully stops and releases the active session (explicit stop, or sound/voice toggled off app-wide). */
export function stopListeningSession(): void {
  teardownDriver();
  notify();
}

function createEngineForSession(session: MatchSessionHandle): PlaybackEngine {
  return new PlaybackEngine(session, {
    director: (frames) => buildGameViewTimeline(frames),
  });
}

function createHeadlessDriver(matchInfo: ListeningSessionInfo): DriverState {
  const session = acquireMatchSession(
    matchInfo.fixtureId,
    createMatchSessionDefaultDeps(() => driver?.matchInfo.isLive ?? matchInfo.isLive),
  );
  const engine = createEngineForSession(session);

  const state: DriverState = {
    fixtureId: matchInfo.fixtureId,
    matchInfo,
    session,
    ownEngine: engine,
    unsubscribeOwnEngine: undefined,
    attached: false,
    playing: true,
    lastEngineSnapshot: undefined,
    pulseEntries: [],
    pulseProjectionGeneration: undefined,
    pulsePollAbort: undefined,
    pulsePollTimer: undefined,
    pulsePollDisposed: false,
    manifestEntryIds: [],
    manifestAbort: undefined,
    firedEntryId: undefined,
  };
  state.unsubscribeOwnEngine = engine.subscribe((snapshot) => onEngineSnapshot(state, snapshot));
  startCommentaryVoiceSession(matchInfo.fixtureId);
  startPulsePolling(state);
  startManifestFetch(state);
  onEngineSnapshot(state, engine.getSnapshot());

  return state;
}

function disposeOwnEngine(state: DriverState): void {
  state.unsubscribeOwnEngine?.();
  state.unsubscribeOwnEngine = undefined;
  state.ownEngine?.dispose();
  state.ownEngine = undefined;
}

function teardownDriver(): void {
  if (!driver) return;
  const finished = driver;
  driver = undefined;
  finished.pulsePollDisposed = true;
  finished.pulsePollAbort?.abort();
  if (finished.pulsePollTimer !== undefined) clearTimeout(finished.pulsePollTimer);
  finished.manifestAbort?.abort();
  // disposeOwnEngine releases finished.session via PlaybackEngine.dispose()
  // whenever the driver holds a genuine handle (headless mode: `ownEngine`
  // is set). While attached, `ownEngine` is already undefined (released at
  // attach time -- see attachListeningSessionEngine) and the mounted
  // screen's own usePlaybackEngine instance holds/releases the shared
  // MatchSession independently, so there is nothing further to release here.
  disposeOwnEngine(finished);
  stopCommentaryVoiceSession();
}

function startPulsePolling(state: DriverState): void {
  const poll = () => {
    if (state.pulsePollDisposed) return;
    state.pulsePollAbort?.abort();
    const controller = new AbortController();
    state.pulsePollAbort = controller;

    fetchMatchPulseCommentary(state.fixtureId, { signal: controller.signal })
      .then((result) => {
        if (state.pulsePollDisposed || state.pulsePollAbort !== controller) return;
        state.pulseEntries = result.entries;
        state.pulseProjectionGeneration = result.projectionGeneration;
        evaluateFiring(state);
      })
      .catch((error: unknown) => {
        if (state.pulsePollDisposed || isAbortError(error)) return;
        // A failed poll must never block the session -- keep whatever
        // entries we already have and retry on the next cadence.
      })
      .finally(() => {
        if (state.pulsePollAbort === controller) state.pulsePollAbort = undefined;
        if (state.pulsePollDisposed) return;
        state.pulsePollTimer = setTimeout(poll, PULSE_POLL_INTERVAL_MS);
      });
  };

  poll();
}

function startManifestFetch(state: DriverState): void {
  const controller = new AbortController();
  state.manifestAbort = controller;
  fetchCommentaryAudioManifest(state.fixtureId, { signal: controller.signal })
    .then((manifest) => {
      if (state.pulsePollDisposed) return;
      state.manifestEntryIds = manifest.entries.map((entry) => entry.entryId);
      evaluateFiring(state);
    })
    .catch(() => undefined);
}

function onEngineSnapshot(state: DriverState, snapshot: PlaybackSnapshot): void {
  state.lastEngineSnapshot = snapshot;
  evaluateFiring(state);
}

/**
 * The extracted firing loop: same selector (selectVisibleGameViewCommentary)
 * and queue policy (playCommentaryVoiceClip -> decideCommentaryVoiceQueueAction,
 * applied inside use-commentary-voice.ts) MatchDetailScreen's in-match effect
 * used before the lift, just driven by a snapshot (fed either by the
 * attached screen engine or this driver's own headless engine) instead of a
 * React effect. Only fires while `playing` and while the shared sound/voice
 * preferences (module-level singletons, read fresh on every call -- see
 * game-view-sound-preference.ts) allow it.
 */
function evaluateFiring(state: DriverState): void {
  if (state !== driver) return;
  if (!state.playing) return;

  const snapshot = state.lastEngineSnapshot;
  if (!snapshot) return;
  // Fix round item 3: never speak against a parked engine -- see
  // isListeningSessionEngineAdvancing's doc comment (most concretely, a
  // freshly re-entered finished match's idle full-time board).
  if (!isListeningSessionEngineAdvancing(snapshot.mode)) return;

  const visible = selectVisibleGameViewCommentary(
    isGameViewCommentaryProjectionCompatible(state.pulseProjectionGeneration, snapshot.projectionGeneration)
      ? state.pulseEntries
      : [],
    snapshot.timeline,
    snapshot.playheadIndex,
  );
  const newest = visible[visible.length - 1];
  if (!newest) return;
  if (state.firedEntryId === newest.id) return;
  state.firedEntryId = newest.id;

  if (!getGameViewSoundEnabledSnapshot() || !getGameViewVoiceEnabledSnapshot()) return;
  if (!state.manifestEntryIds.includes(newest.id)) return;

  playCommentaryVoiceClip(
    { entryId: newest.id, kind: newest.kind },
    resolveCommentaryVoiceClipUrl(state.fixtureId, newest.id),
  );

  const upcoming = resolveCommentaryVoicePrefetchWindow(state.manifestEntryIds, newest.id);
  if (upcoming.length > 0) {
    prefetchCommentaryVoiceClips(upcoming.map((entryId) => resolveCommentaryVoiceClipUrl(state.fixtureId, entryId)));
  }
}

/**
 * Convenience hook: wires a mounted MatchDetailScreen's own playback engine
 * snapshot into the listening session for the lifetime of the component,
 * detaching (handing off to a headless engine) on unmount. Firing itself
 * still only happens through `evaluateFiring` above -- this hook has no
 * decision logic of its own, it's purely the attach/detach lifecycle glue.
 *
 * `matchInfo` is optional and forwarded straight to
 * `attachListeningSessionEngine`'s belt-and-braces re-entry -- see that
 * function's doc comment. Omitting it preserves the previous no-op-when-
 * missing behavior.
 */
export function useAttachListeningSessionEngine(
  fixtureId: string,
  snapshot: PlaybackSnapshot,
  matchInfo?: ListeningSessionInfo,
): void {
  useEffect(() => {
    attachListeningSessionEngine(fixtureId, snapshot, matchInfo);
  });
  useEffect(() => () => detachListeningSessionEngine(fixtureId), [fixtureId]);
}

/** Test/debug helper: whether a listening session is currently held. */
export function isListeningSessionActive(): boolean {
  return driver !== undefined;
}
