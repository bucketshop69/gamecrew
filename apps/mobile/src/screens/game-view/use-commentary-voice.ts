import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { resolveCommentaryAudioClipUrl } from '../../api/gamecrew';
import {
  decideCommentaryVoiceQueueAction,
  type CommentaryVoiceClip,
} from './commentary-voice-logic';

/**
 * Native adapter for the pure commentary-voice queue policy
 * (commentary-voice-logic.ts). Owns ONE expo-audio player for voice clips
 * at module scope -- same singleton pattern as game-view-sound-preference.ts
 * -- so playback state (what's speaking, isSpeaking) survives Match
 * Pulse <-> Game View tab switches instead of being torn down on remount.
 *
 * Fired from MatchDetailScreen (see gamecrew-screens.tsx), not from inside
 * GameViewScreen, so voice speaks on both tabs off the one shared playback
 * clock. `startCommentaryVoiceSession` / `stopCommentaryVoiceSession` are
 * exported explicitly (not just internal effects) so a later phase can lift
 * this session to live app-wide (e.g. above tab navigation) without
 * reshaping this module.
 */

let player: AudioPlayer | undefined;
let currentClip: CommentaryVoiceClip | undefined;
let speaking = false;
let appIsActive = AppState.currentState === 'active';
let audioModePromise: Promise<void> | undefined;
let statusSubscription: { remove: () => void } | undefined;
let appStateSubscription: { remove: () => void } | undefined;
let activeFixtureId: string | undefined;
let sessionRefCount = 0;

const speakingListeners = new Set<() => void>();
/** Maps a prefetched clip URL to the AbortController for its still-pending fetch (or is a no-op marker once it settles). Scoped per fixture -- cleared/aborted alongside `activeFixtureId` changes so a stale fixture's prefetches never keep running (or leak) into the next one. */
const prefetchControllers = new Map<string, AbortController>();

function notifySpeakingListeners() {
  speakingListeners.forEach((listener) => listener());
}

function setSpeaking(next: boolean) {
  if (speaking === next) return;
  speaking = next;
  notifySpeakingListeners();
}

function ensureAudioMode(): Promise<void> {
  audioModePromise ??= setAudioModeAsync({
    allowsRecording: false,
    interruptionMode: 'mixWithOthers',
    playsInSilentMode: false,
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  }).catch((error) => {
    audioModePromise = undefined;
    throw error;
  });
  return audioModePromise;
}

function ensurePlayer(): AudioPlayer {
  if (player) return player;
  player = createAudioPlayer(null, { updateInterval: 250 });
  statusSubscription = player.addListener('playbackStatusUpdate', (status) => {
    if (status.didJustFinish) {
      currentClip = undefined;
      setSpeaking(false);
    }
  });
  return player;
}

/**
 * Starts (or joins) the voice session for a fixture. Refcounted so that
 * Match Pulse and Game View mounting the same MatchDetailScreen instance
 * don't tear each other's session down; only the last stop() call actually
 * releases the player. Switching to a different fixtureId clears any
 * in-flight clip and prefetch cache from the previous match.
 */
export function startCommentaryVoiceSession(fixtureId: string): void {
  if (activeFixtureId !== fixtureId) {
    stopCommentaryVoiceImmediately();
    abortPendingPrefetches();
    activeFixtureId = fixtureId;
  }
  sessionRefCount += 1;
  ensurePlayer();
  void ensureAudioMode().catch(() => undefined);

  if (!appStateSubscription) {
    appStateSubscription = AppState.addEventListener('change', (nextState) => {
      appIsActive = nextState === 'active';
      if (!appIsActive) {
        player?.pause();
      } else if (currentClip) {
        player?.play();
      }
    });
  }
}

/** Releases this consumer's hold on the session; stops playback once the last consumer releases. */
export function stopCommentaryVoiceSession(): void {
  sessionRefCount = Math.max(0, sessionRefCount - 1);
  if (sessionRefCount > 0) return;
  stopCommentaryVoiceImmediately();
  appStateSubscription?.remove();
  appStateSubscription = undefined;
  activeFixtureId = undefined;
  abortPendingPrefetches();
}

/** Stops whatever is speaking right now with no fade -- for checkpoint jumps, seeks, and tab/screen exits. */
export function stopCommentaryVoiceImmediately(): void {
  currentClip = undefined;
  player?.pause();
  setSpeaking(false);
}

/**
 * Plays `clip` if the queue policy says to (idle, or a big moment
 * interrupting something routine); silently drops it otherwise. `clipUrl`
 * failing to load is swallowed -- voice must never delay or block the
 * replay it's narrating.
 */
export function playCommentaryVoiceClip(clip: CommentaryVoiceClip, clipUrl: string): void {
  if (!appIsActive) return;
  const decision = decideCommentaryVoiceQueueAction(currentClip, clip);
  if (decision === 'drop') return;

  const activePlayer = ensurePlayer();
  currentClip = clip;
  try {
    activePlayer.replace({ uri: clipUrl });
    activePlayer.volume = 1;
    activePlayer.play();
    setSpeaking(true);
  } catch {
    // A failed replace/play must not block the replay it's narrating.
    currentClip = undefined;
    setSpeaking(false);
  }
}

/** Warms the given clip URLs with an abortable fetch(); failures (including aborts) are silently ignored -- prefetch must never surface an error to the caller. */
export function prefetchCommentaryVoiceClips(clipUrls: readonly string[]): void {
  for (const url of clipUrls) {
    if (prefetchControllers.has(url)) continue;
    const controller = new AbortController();
    prefetchControllers.set(url, controller);
    fetch(url, { signal: controller.signal })
      .catch(() => undefined)
      .finally(() => {
        // Only clear this URL's own entry -- a fixture change may have
        // already replaced it with a fresh controller for the same URL.
        if (prefetchControllers.get(url) === controller) {
          prefetchControllers.delete(url);
        }
      });
  }
}

/** Aborts every still-pending prefetch and clears the per-fixture bookkeeping -- called on fixture change and on session stop so a stale fixture's prefetches never keep running or leak into the next one. */
function abortPendingPrefetches(): void {
  for (const controller of prefetchControllers.values()) {
    controller.abort();
  }
  prefetchControllers.clear();
}

function subscribeSpeaking(listener: () => void) {
  speakingListeners.add(listener);
  return () => speakingListeners.delete(listener);
}

function getSpeakingSnapshot() {
  return speaking;
}

function getSpeakingServerSnapshot() {
  return false;
}

/** Reactive isSpeaking flag, for ducking the crowd/ambient soundscape while voice is talking. */
export function useCommentaryVoiceSpeaking(): boolean {
  return useSyncExternalStore(subscribeSpeaking, getSpeakingSnapshot, getSpeakingServerSnapshot);
}

/**
 * Convenience hook: joins the voice session for `fixtureId` for the
 * lifetime of the owning component (MatchDetailScreen), and leaves it on
 * unmount. Firing individual clips is a separate, explicit call
 * (playCommentaryVoiceClip) driven by the entry-became-current bridge, not
 * by this hook itself.
 */
export function useCommentaryVoiceSession(fixtureId: string | undefined): void {
  useEffect(() => {
    if (!fixtureId) return;
    startCommentaryVoiceSession(fixtureId);
    return () => stopCommentaryVoiceSession();
  }, [fixtureId]);
}

/** Builds the clip URL for an entry id off the same API base URL used for pulse fetches. */
export function resolveCommentaryVoiceClipUrl(fixtureId: string, entryId: string): string {
  return resolveCommentaryAudioClipUrl(fixtureId, entryId);
}
