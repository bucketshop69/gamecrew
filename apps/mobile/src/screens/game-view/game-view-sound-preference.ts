import { useSyncExternalStore } from 'react';

let soundEnabled = false;
const listeners = new Set<() => void>();

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

function setGameViewSoundEnabled(enabled: boolean) {
  if (soundEnabled === enabled) return;
  soundEnabled = enabled;
  listeners.forEach((listener) => listener());
}
