import { buildGameViewTimeline } from '@gamecrew/core';
import { useEffect, useRef, useState } from 'react';

import { createMatchSessionDefaultDeps } from './match-session-defaults';
import { acquireMatchSession } from './match-session';
import { PlaybackEngine, type PlaybackSnapshot } from './playback-engine';

// This file is only consumed by React screens (bundled by Metro), never by
// the mobile package's plain-Node test runner, so static imports of the
// real director from @gamecrew/core and the real session deps are safe
// here. See match-session.ts / playback-engine.ts header comments for why
// those modules themselves take the director/fetcher injected instead.

const EMPTY_SNAPSHOT: PlaybackSnapshot = {
  mode: 'live',
  playheadIndex: -1,
  headIndex: -1,
  timeline: [],
  currentScene: undefined,
  sessionStatus: 'loading',
  headRevision: 0,
  frameCount: 0,
};

export interface PlaybackEngineControls {
  play: () => void;
  pause: () => void;
  startReplay: () => void;
  scrubTo: (index: number) => void;
}

const NOOP_CONTROLS: PlaybackEngineControls = {
  play: () => {},
  pause: () => {},
  startReplay: () => {},
  scrubTo: () => {},
};

/**
 * React adapter over `MatchSession` + `PlaybackEngine`. Mirrors the
 * hand-rolled useState/useEffect style already used by
 * `use-match-pulse.ts` / `use-gamecrew-matches.ts` rather than introducing a
 * new state-management dependency (e.g. useSyncExternalStore).
 *
 * Acquires a shared, refcounted session for `fixtureId` in an effect and
 * releases it on cleanup. Because the session lives in a module-level
 * registry, switching tabs (unmounting/remounting this hook while another
 * consumer still holds the session) never interrupts polling — only the
 * last release() actually tears the session down.
 */
export function usePlaybackEngine(
  fixtureId: string,
  isLive: boolean,
): { snapshot: PlaybackSnapshot; controls: PlaybackEngineControls } {
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;

  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(EMPTY_SNAPSHOT);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const [controls, setControls] = useState<PlaybackEngineControls>(NOOP_CONTROLS);

  useEffect(() => {
    const session = acquireMatchSession(
      fixtureId,
      createMatchSessionDefaultDeps(() => isLiveRef.current),
    );
    const engine = new PlaybackEngine(session, { director: buildGameViewTimeline });
    engineRef.current = engine;

    const unsubscribe = engine.subscribe(setSnapshot);
    setSnapshot(engine.getSnapshot());
    setControls({
      play: () => engine.play(),
      pause: () => engine.pause(),
      startReplay: () => engine.startReplay(),
      scrubTo: (index: number) => engine.scrubTo(index),
    });

    return () => {
      unsubscribe();
      engine.dispose();
      engineRef.current = null;
      setControls(NOOP_CONTROLS);
    };
  }, [fixtureId]);

  return { snapshot, controls };
}
