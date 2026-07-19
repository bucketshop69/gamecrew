import { buildGameViewTimeline, type SemanticFrame } from '@gamecrew/core';
import { useEffect, useRef, useState } from 'react';

import { createMatchSessionDefaultDeps } from './match-session-defaults';
import { acquireMatchSession, type MatchSessionHandle } from './match-session';
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
  activeSceneWindow: undefined,
  sessionStatus: 'loading',
  headRevision: 0,
  projectionGeneration: 0,
  frameCount: 0,
  rangeStopAtIndex: undefined,
};

/** Product-selected acceleration for complete historical match playback. */
const COMPLETE_REPLAY_PLAYBACK_RATE = 1.15;

/**
 * Live and historical playback both retain the complete semantic timeline.
 * Historical fixtures differ only by receiving a concrete accelerated
 * wall-clock schedule: no possession, zone transition, or incident is
 * sampled out, and this contains no fixture-specific choreography.
 */
function buildProductionTimeline(frames: readonly SemanticFrame[], isLive: boolean) {
  return isLive
    ? buildGameViewTimeline(frames)
    : buildGameViewTimeline(frames, {
        pacing: {
          mode: 'replay',
          sceneSelection: 'complete',
          playbackRate: COMPLETE_REPLAY_PLAYBACK_RATE,
        },
      });
}

export interface PlaybackEngineControls {
  play: () => void;
  pause: () => void;
  startReplay: () => void;
  startReplayAt: (index: number) => void;
  /**
   * Bounded clip playback (item 8/13): plays from `index` and halts once the
   * playhead reaches `stopAtIndex`, instead of continuing to the end of the
   * timeline. See `PlaybackEngine.startReplayAt`'s `options.stopAtIndex` and
   * `PlaybackSnapshot.rangeStopAtIndex`.
   */
  startReplayRange: (index: number, stopAtIndex: number) => void;
  scrubTo: (index: number) => void;
}

const NOOP_CONTROLS: PlaybackEngineControls = {
  play: () => {},
  pause: () => {},
  startReplay: () => {},
  startReplayAt: () => {},
  startReplayRange: () => {},
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
  const sessionRef = useRef<MatchSessionHandle | null>(null);
  const [controls, setControls] = useState<PlaybackEngineControls>(NOOP_CONTROLS);

  useEffect(() => {
    const session = acquireMatchSession(
      fixtureId,
      createMatchSessionDefaultDeps(() => isLiveRef.current),
    );
    sessionRef.current = session;
    const engine = new PlaybackEngine(session, {
      director: (frames) => buildProductionTimeline(frames, isLiveRef.current),
    });
    engineRef.current = engine;

    const unsubscribe = engine.subscribe(setSnapshot);
    setSnapshot(engine.getSnapshot());
    setControls({
      play: () => engine.play(),
      pause: () => engine.pause(),
      startReplay: () => engine.startReplay(),
      startReplayAt: (index: number) => engine.startReplayAt(index),
      startReplayRange: (index: number, stopAtIndex: number) =>
        engine.startReplayAt(index, { stopAtIndex }),
      scrubTo: (index: number) => engine.scrubTo(index),
    });

    return () => {
      unsubscribe();
      engine.dispose();
      engineRef.current = null;
      sessionRef.current = null;
      setControls(NOOP_CONTROLS);
    };
  }, [fixtureId]);

  // A completed upcoming-fixture backfill has no timer left to observe the
  // kickoff transition. Nudge the existing shared session when live status
  // changes instead of tearing down its accumulated frame log. Re-project
  // the same durable frames first because live is unpaced, while finished/
  // upcoming fixtures use the complete accelerated replay schedule.
  useEffect(() => {
    engineRef.current?.refreshProjection();
    sessionRef.current?.syncLiveStatus();
    if (isLive) engineRef.current?.play();
  }, [isLive]);

  return { snapshot, controls };
}
