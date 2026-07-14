import type { GameViewScene, SemanticFrame } from '@gamecrew/core';

import type { MatchSessionHandle, MatchSessionSnapshot } from './match-session';

/**
 * Plays a `GameViewScene` timeline derived from a `MatchSession`'s frame
 * log. Owns the playhead/head split described in
 * docs/prds/game_view.md ("Playback") and
 * docs/issues/game-view-director-and-playback.md (item 7):
 *
 * - `head` = how much data has been fetched (the session's headRevision /
 *   the end of the derived scene timeline).
 * - `playhead` = where the viewer is currently watching (a scene index).
 *
 * The engine is pure-ish: it holds no React state itself. `usePlaybackEngine`
 * below is the thin React adapter. All timers live here, not in the session
 * and not in the director, per the PRD's director/renderer split.
 *
 * The director (`buildGameViewTimeline`) is injected rather than imported at
 * module scope. Production code gets the real `@gamecrew/core` director via
 * `usePlaybackEngine`'s default; unit tests inject a fake so they can run
 * under the mobile package's plain `node --experimental-strip-types` runner,
 * which (unlike Metro/tsx) does not resolve `@gamecrew/core`'s internal
 * extensionless imports.
 */

export type GameViewDirector = (frames: readonly SemanticFrame[]) => readonly GameViewScene[];

export type PlaybackMode = 'live' | 'paused' | 'scrubbing' | 'replay';

export interface PlaybackSnapshot {
  mode: PlaybackMode;
  /** Index into the derived scene timeline the viewer is currently watching. */
  playheadIndex: number;
  /** Index of the newest scene the director has produced (== timeline.length - 1, or -1 if empty). */
  headIndex: number;
  timeline: readonly GameViewScene[];
  currentScene: GameViewScene | undefined;
  sessionStatus: MatchSessionSnapshot['status'];
  headRevision: number;
  frameCount: number;
}

export type PlaybackListener = (snapshot: PlaybackSnapshot) => void;

/** Injectable clock so tests can fake time instead of relying on real timers. */
export interface PlaybackClock {
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
}

function defaultClock(): PlaybackClock {
  return {
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
}

/** Live mode watches from this many scenes behind the head, so cue bursts play smoothly. */
const DEFAULT_LIVE_BUFFER_SCENES = 1;

/** Fallback per-scene duration when a scene's durationHint is open-ended (ambient: {0,0}). */
const DEFAULT_AMBIENT_REPLAY_MS = 2500;

export interface PlaybackEngineOptions {
  clock?: PlaybackClock;
  liveBufferScenes?: number;
  /** Replay pacing multiplier: 1 = real durationHint pacing, >1 = faster. */
  replaySpeed?: number;
  /** Defaults to the real `buildGameViewTimeline` director from @gamecrew/core. */
  director?: GameViewDirector;
}

export class PlaybackEngine {
  private session: MatchSessionHandle;
  private clock: PlaybackClock;
  private liveBufferScenes: number;
  private replaySpeed: number;
  private director: GameViewDirector;

  private unsubscribeSession: () => void;
  private listeners = new Set<PlaybackListener>();

  private mode: PlaybackMode = 'live';
  private timeline: readonly GameViewScene[] = [];
  private lastHeadRevisionBuilt = -1;
  private playheadIndex = -1;
  private replayTimer: unknown = null;
  private disposed = false;

  constructor(session: MatchSessionHandle, options: PlaybackEngineOptions) {
    this.session = session;
    this.clock = options.clock ?? defaultClock();
    this.liveBufferScenes = options.liveBufferScenes ?? DEFAULT_LIVE_BUFFER_SCENES;
    this.replaySpeed = options.replaySpeed ?? 6;
    if (!options.director) {
      throw new Error('PlaybackEngine requires a director (see createDefaultDirector()).');
    }
    this.director = options.director;

    this.rebuildTimeline(session.getSnapshot());
    this.applyLiveBuffer();

    this.unsubscribeSession = session.subscribe((snapshot) => {
      this.onSessionUpdate(snapshot);
    });
  }

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): PlaybackSnapshot {
    const session = this.session.getSnapshot();
    return {
      mode: this.mode,
      playheadIndex: this.playheadIndex,
      headIndex: this.timeline.length - 1,
      timeline: this.timeline,
      currentScene: this.playheadIndex >= 0 ? this.timeline[this.playheadIndex] : undefined,
      sessionStatus: session.status,
      headRevision: session.headRevision,
      frameCount: session.frames.length,
    };
  }

  /** Switch to live mode: playhead tracks head minus the live buffer. */
  play(): void {
    this.stopReplayTimer();
    this.mode = 'live';
    this.applyLiveBuffer();
    this.emit();
  }

  pause(): void {
    this.stopReplayTimer();
    this.mode = 'paused';
    this.emit();
  }

  /** Manually move the playhead. API-only per the spec (no scrub UI yet). */
  scrubTo(index: number): void {
    this.stopReplayTimer();
    this.mode = 'scrubbing';
    this.playheadIndex = clamp(index, 0, Math.max(this.timeline.length - 1, 0));
    this.emit();
  }

  /** Play the timeline from the start at compressed pacing. */
  startReplay(): void {
    this.stopReplayTimer();
    this.mode = 'replay';
    this.playheadIndex = this.timeline.length > 0 ? 0 : -1;
    this.emit();
    this.scheduleNextReplayStep();
  }

  dispose(): void {
    this.disposed = true;
    this.stopReplayTimer();
    this.unsubscribeSession();
    this.session.release();
    this.listeners.clear();
  }

  private emit() {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private onSessionUpdate(snapshot: MatchSessionSnapshot) {
    this.rebuildTimeline(snapshot);

    if (this.mode === 'live') {
      this.applyLiveBuffer();
    } else if (this.playheadIndex >= this.timeline.length) {
      this.playheadIndex = Math.max(this.timeline.length - 1, 0);
    }

    this.emit();
  }

  /** Memoized on headRevision: the director only re-runs when new data actually arrived. */
  private rebuildTimeline(snapshot: MatchSessionSnapshot) {
    if (snapshot.headRevision === this.lastHeadRevisionBuilt && this.timeline.length > 0) {
      return;
    }
    this.timeline = this.director(snapshot.frames);
    this.lastHeadRevisionBuilt = snapshot.headRevision;
  }

  private applyLiveBuffer() {
    const headIndex = this.timeline.length - 1;
    this.playheadIndex = headIndex < 0 ? -1 : Math.max(headIndex - this.liveBufferScenes, 0);
  }

  private stopReplayTimer() {
    if (this.replayTimer !== null) {
      this.clock.clearTimer(this.replayTimer);
      this.replayTimer = null;
    }
  }

  private scheduleNextReplayStep() {
    if (this.disposed || this.mode !== 'replay') return;

    const scene = this.timeline[this.playheadIndex];
    if (!scene) return;

    const durationMs = sceneReplayDurationMs(scene, this.replaySpeed);

    this.replayTimer = this.clock.setTimer(() => {
      this.replayTimer = null;
      if (this.disposed || this.mode !== 'replay') return;

      if (this.playheadIndex >= this.timeline.length - 1) {
        // Reached the end of the currently known timeline; hold at the last scene.
        this.emit();
        return;
      }

      this.playheadIndex += 1;
      this.emit();
      this.scheduleNextReplayStep();
    }, durationMs);
  }
}

function sceneReplayDurationMs(scene: GameViewScene, replaySpeed: number): number {
  const hint = scene.durationHint;
  const baseMs = hint.maxMs > 0 ? (hint.minMs + hint.maxMs) / 2 : DEFAULT_AMBIENT_REPLAY_MS;
  return Math.max(baseMs / Math.max(replaySpeed, 1), 50);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
