import { useSyncExternalStore } from 'react';

let soundEnabled = false;
const listeners = new Set<() => void>();

/**
 * Registered by the headless listening-session driver
 * (state/commentary-listening-session.ts) so turning sound or voice off
 * app-wide also stops any off-screen session (item 1c) -- a plain callback
 * rather than a static import of that module to avoid a cycle (the driver
 * already imports the snapshot getters below).
 */
let onSoundOrVoiceDisabled: (() => void) | undefined;

export function registerSoundOrVoiceDisabledListener(listener: () => void): () => void {
  onSoundOrVoiceDisabled = listener;
  return () => {
    if (onSoundOrVoiceDisabled === listener) onSoundOrVoiceDisabled = undefined;
  };
}

function notifySoundOrVoiceDisabled() {
  onSoundOrVoiceDisabled?.();
}

/**
 * Session-wide preference shared across Game View remounts (for example,
 * switching between Match Pulse and Game View). It intentionally defaults to
 * off: sound begins only from an explicit user gesture and therefore also
 * satisfies browser autoplay policy.
 */
export function useGameViewSoundPreference() {
  const enabled = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  return [enabled, setGameViewSoundEnabled] as const;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return soundEnabled;
}

function getServerSnapshot() {
  return false;
}

/** Non-hook accessor for callers outside a React render (the headless listening-session driver). */
export function getGameViewSoundEnabledSnapshot(): boolean {
  return soundEnabled;
}

/** Also exported non-hook for entry-time resets (see MatchDetailScreen's completed-match default-state effect). */
export function setGameViewSoundEnabled(enabled: boolean) {
  if (soundEnabled === enabled) return;
  soundEnabled = enabled;
  listeners.forEach((listener) => listener());
  if (!enabled) notifySoundOrVoiceDisabled();
}

// -- Commentary voice preference --------------------------------------------
// A second, independent flag layered on top of the SOUND pill above: the
// mic chip toggles voice commentary specifically. Voice only ever plays when
// BOTH `soundEnabled` and `voiceEnabled` are true (see
// resolveCommentaryVoicePlaybackAllowed in use-commentary-voice.ts) --
// muting the whole broadcast with the SOUND pill also silences voice without
// needing to flip this flag off.

let voiceEnabled = true;
const voiceListeners = new Set<() => void>();

/** Session-wide preference for whether commentary voice lines should speak (default on). */
export function useGameViewVoicePreference() {
  const enabled = useSyncExternalStore(
    subscribeVoice,
    getVoiceSnapshot,
    getVoiceServerSnapshot,
  );

  return [enabled, setGameViewVoiceEnabled] as const;
}

function subscribeVoice(listener: () => void) {
  voiceListeners.add(listener);
  return () => voiceListeners.delete(listener);
}

function getVoiceSnapshot() {
  return voiceEnabled;
}

function getVoiceServerSnapshot() {
  return true;
}

/** Non-hook accessor for callers outside a React render (the headless listening-session driver). */
export function getGameViewVoiceEnabledSnapshot(): boolean {
  return voiceEnabled;
}

/** Also exported non-hook for entry-time resets (see MatchDetailScreen's completed-match default-state effect). */
export function setGameViewVoiceEnabled(enabled: boolean) {
  if (voiceEnabled === enabled) return;
  voiceEnabled = enabled;
  voiceListeners.forEach((listener) => listener());
  if (!enabled) notifySoundOrVoiceDisabled();
}
