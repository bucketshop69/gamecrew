import type { GameViewScene, SemanticFrame } from '@gamecrew/core';

import type { MatchSessionHandle, MatchSessionSnapshot } from './match-session';

/**
 * Plays a `GameViewScene` timeline derived from a `MatchSession`'s frame
 * log. The engine owns scene scheduling; renderers may animate inside the
 * exposed active window, but must never advance the playhead themselves.
 *
 * The director is injected rather than imported at module scope so this file
 * remains runnable under the mobile package's plain Node test runner.
 */

export type GameViewDirector = (frames: readonly SemanticFrame[]) => readonly GameViewScene[];

export type PlaybackMode = 'live' | 'paused' | 'scrubbing' | 'replay';

/**
 * Authoritative presentation window for the active scene. `durationMs` is
 * the scene's animation window; in live mode the final pose may remain held
 * after that duration until another source-grounded scene is ready.
 */
export interface ActiveSceneWindow {
  /** Changes whenever this scene is entered again or its projection generation is replaced. */
  instanceKey: string;
  sceneId: string;
  startedAtMs: number;
  durationMs: number;
  mode: PlaybackMode;
}

export interface PlaybackSnapshot {
  mode: PlaybackMode;
  /** Index into the derived scene timeline the viewer is currently watching. */
  playheadIndex: number;
  /** Index of the newest scene the director has produced (== timeline.length - 1, or -1 if empty). */
  headIndex: number;
  timeline: readonly GameViewScene[];
  currentScene: GameViewScene | undefined;
  activeSceneWindow: ActiveSceneWindow | undefined;
  sessionStatus: MatchSessionSnapshot['status'];
  headRevision: number;
  projectionGeneration: number;
  frameCount: number;
  /**
   * Set only while a bounded replay range (`startReplayAt`'s `stopAtIndex`
   * option) is active: the scene index this range will stop *at* -- the
   * engine plays through that scene's own window and then halts (mode stays
   * `'replay'`, the advance timer is not rescheduled) instead of continuing
   * to the next scene. Consumers (e.g. the checkpoint-clip / highlights
   * sequencer) watch for `playheadIndex === rangeStopAtIndex` to know a
   * bounded window has finished. `undefined` for an ordinary unbounded
   * replay/live/scrub.
   */
  rangeStopAtIndex: number | undefined;
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

/** Mirrors core's current live-buffer guidance while keeping this Node-testable module self-contained. */
const DEFAULT_LIVE_BUFFER_MS = 4000;
/** Ambient scenes have an open-ended duration hint and need a readable animation window. */
const DEFAULT_AMBIENT_WINDOW_MS = 2500;

interface QueuedLiveScene {
  index: number;
  availableAtMs: number;
}

export interface PlaybackEngineOptions {
  clock?: PlaybackClock;
  /** Time each newly fetched live scene waits behind the data head before it is eligible. */
  liveBufferMs?: number;
  /** Production passes the replay-paced core director. */
  director?: GameViewDirector;
}

export class PlaybackEngine {
  private session: MatchSessionHandle;
  private clock: PlaybackClock;
  private liveBufferMs: number;
  private director: GameViewDirector;

  private unsubscribeSession: () => void;
  private listeners = new Set<PlaybackListener>();

  private mode: PlaybackMode = 'live';
  private timeline: readonly GameViewScene[] = [];
  private lastHeadRevisionBuilt = -1;
  private lastProjectionGenerationBuilt = -1;
  private lastFrameCountBuilt = -1;
  private lastSessionStatus: MatchSessionSnapshot['status'];
  private playheadIndex = -1;
  private activeSceneWindow: ActiveSceneWindow | undefined;
  private windowSerial = 0;
  private advanceTimer: unknown = null;
  private liveQueue: QueuedLiveScene[] = [];
  private disposed = false;
  /** See `PlaybackSnapshot.rangeStopAtIndex`'s doc comment. */
  private rangeStopAtIndex: number | undefined;

  constructor(session: MatchSessionHandle, options: PlaybackEngineOptions) {
    this.session = session;
    this.clock = options.clock ?? defaultClock();
    this.liveBufferMs = Math.max(0, options.liveBufferMs ?? DEFAULT_LIVE_BUFFER_MS);
    if (!options.director) {
      throw new Error('PlaybackEngine requires a director.');
    }
    this.director = options.director;

    const initialSnapshot = session.getSnapshot();
    this.lastSessionStatus = initialSnapshot.status;
    this.rebuildTimeline(initialSnapshot);
    this.primeLiveAtHead();

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
      activeSceneWindow: this.activeSceneWindow,
      sessionStatus: session.status,
      headRevision: session.headRevision,
      projectionGeneration: session.projectionGeneration,
      frameCount: session.frames.length,
      rangeStopAtIndex: this.rangeStopAtIndex,
    };
  }

  /** Jump back to the current live head; subsequent scenes drain through the buffered queue. */
  play(): void {
    this.resetScheduling();
    this.mode = 'live';
    this.rangeStopAtIndex = undefined;
    this.primeLiveAtHead();
    this.emit();
  }

  pause(): void {
    this.clearAdvanceTimer();
    this.mode = 'paused';
    this.rangeStopAtIndex = undefined;
    this.emit();
  }

  /** Manually move the playhead. API-only per the spec (no scrub UI yet). */
  scrubTo(index: number): void {
    this.resetScheduling();
    this.mode = 'scrubbing';
    this.rangeStopAtIndex = undefined;
    if (this.timeline.length === 0) {
      this.playheadIndex = -1;
      this.activeSceneWindow = undefined;
    } else {
      this.setActiveScene(clamp(index, 0, this.timeline.length - 1), 'scrubbing');
    }
    this.emit();
  }

  /** Play the paced timeline from the start. */
  startReplay(): void {
    this.startReplayAt(0);
  }

  /**
   * Play the paced timeline from an explicit scene. This is the same replay
   * scheduler as `startReplay`, exposed for the future seek bar so navigation
   * never needs a second timer or fixture-specific playback path.
   *
   * `options.stopAtIndex`, when given, bounds this replay to a clip: the
   * engine advances scene-by-scene exactly as an unbounded replay does, but
   * once the playhead reaches `stopAtIndex` it plays that scene's own window
   * and then halts -- `scheduleReplayAdvance` simply does not re-arm past it.
   * This is the minimal, additive mechanism checkpoint clips (item 8) and the
   * highlights sequencer (item 13) build on: callers watch
   * `PlaybackSnapshot.rangeStopAtIndex`/`playheadIndex` to know when the
   * bounded window has finished (see `hasPlaybackReachedRangeStop`).
   */
  startReplayAt(index: number, options?: { stopAtIndex?: number }): void {
    this.resetScheduling();
    this.mode = 'replay';
    if (this.session.getSnapshot().status === 'loading' || this.timeline.length === 0) {
      this.playheadIndex = -1;
      this.activeSceneWindow = undefined;
      this.rangeStopAtIndex = undefined;
      this.emit();
      return;
    }

    const clampedIndex = clamp(index, 0, this.timeline.length - 1);
    this.rangeStopAtIndex = options?.stopAtIndex === undefined
      ? undefined
      : clamp(options.stopAtIndex, clampedIndex, this.timeline.length - 1);
    this.setActiveScene(clampedIndex, 'replay');
    this.emit();
    this.scheduleReplayAdvance();
  }

  /**
   * Re-run the injected director over the current durable frame log even
   * when the session head itself has not changed. The React adapter uses
   * this at the live/replay boundary, where the same facts intentionally
   * project to either a complete live timeline or a compressed replay.
   */
  refreshProjection(): void {
    if (this.disposed) return;
    this.lastHeadRevisionBuilt = -1;
    this.lastProjectionGenerationBuilt = -1;
    this.lastFrameCountBuilt = -1;
    this.onSessionUpdate(this.session.getSnapshot());
  }

  dispose(): void {
    this.disposed = true;
    this.resetScheduling();
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
    const previousTimeline = this.timeline;
    const previousGeneration = this.lastProjectionGenerationBuilt;
    const wasLoading = this.lastSessionStatus === 'loading';
    this.lastSessionStatus = snapshot.status;
    const previousCurrentScene = this.playheadIndex >= 0
      ? previousTimeline[this.playheadIndex]
      : undefined;
    const rebuilt = this.rebuildTimeline(snapshot);
    const generationChanged = previousGeneration >= 0
      && previousGeneration !== snapshot.projectionGeneration;

    if (this.mode === 'replay' && snapshot.status === 'loading') {
      // Backfill/correction pages are not a playable timeline. Keep their
      // derived scenes available as data, but expose no presentation window
      // until the session settles so replay never starts from a partial page.
      this.resetScheduling();
      this.playheadIndex = -1;
      this.activeSceneWindow = undefined;
      this.emit();
      return;
    }

    if (!rebuilt) {
      // Loading can settle without changing the final page's frame count or
      // head revision. That status transition still releases replay.
      if (this.mode === 'replay' && wasLoading && this.timeline.length > 0) {
        this.rangeStopAtIndex = undefined;
        this.setActiveScene(0, 'replay');
        this.scheduleReplayAdvance();
      }
      this.emit();
      return;
    }

    if (generationChanged) {
      this.resetScheduling();
      if (this.mode === 'live') {
        this.primeLiveAtHead();
      } else if (this.mode === 'replay') {
        if (this.timeline.length > 0) {
          this.rangeStopAtIndex = undefined;
          this.setActiveScene(0, 'replay');
          this.scheduleReplayAdvance();
        } else {
          this.playheadIndex = -1;
          this.activeSceneWindow = undefined;
        }
      } else if (this.timeline.length > 0) {
        this.setActiveScene(
          clamp(this.playheadIndex, 0, this.timeline.length - 1),
          this.mode,
        );
      } else {
        this.playheadIndex = -1;
        this.activeSceneWindow = undefined;
      }
      this.emit();
      return;
    }

    if (this.mode === 'live') {
      if (
        this.playheadIndex < 0
        || previousTimeline.length === 0
        || snapshot.status === 'loading'
        || wasLoading
      ) {
        // Initial live backfill is history, not a replay queue. Start at its
        // current head, then buffer only scenes that arrive afterward.
        this.primeLiveAtHead();
      } else if (hasStablePrefix(previousTimeline, this.timeline)) {
        const availableAtMs = this.clock.now() + this.liveBufferMs;
        for (let index = previousTimeline.length; index < this.timeline.length; index += 1) {
          this.liveQueue.push({ index, availableAtMs });
        }
        this.refreshCurrentWindowIfNeeded(previousCurrentScene);
        this.scheduleLiveQueue();
      } else if (hasSameLogicalSlots(previousTimeline, this.timeline)) {
        // The director can extend the open ambient scene or refine a pending
        // goal in place. That is not a new sibling scene, but a visible
        // lifecycle/beat change must receive a fresh window identity.
        this.refreshCurrentWindowIfNeeded(previousCurrentScene);
        this.scheduleLiveQueue();
      } else {
        // Same-generation structural replacement is defensive only; never
        // play indices from a queue that no longer maps to this timeline.
        this.resetScheduling();
        this.primeLiveAtHead();
      }
    } else if (this.mode === 'replay') {
      if (this.timeline.length === 0) {
        this.playheadIndex = -1;
        this.activeSceneWindow = undefined;
        this.clearAdvanceTimer();
      } else if (this.playheadIndex < 0) {
        // A correction can announce a new projection generation with an
        // empty loading snapshot, then repopulate that same generation.
        // Re-enter replay at scene zero when those corrected frames arrive.
        this.rangeStopAtIndex = undefined;
        this.setActiveScene(0, 'replay');
        this.scheduleReplayAdvance();
      } else {
        this.refreshReplayWindow(previousCurrentScene);
      }
    } else if (this.playheadIndex >= this.timeline.length) {
      if (this.timeline.length === 0) {
        this.playheadIndex = -1;
        this.activeSceneWindow = undefined;
      } else {
        this.setActiveScene(this.timeline.length - 1, this.mode);
      }
    }

    this.emit();
  }

  /** Memoized on generation, head revision, and frame count (pagination can keep the same head). */
  private rebuildTimeline(snapshot: MatchSessionSnapshot): boolean {
    if (
      snapshot.headRevision === this.lastHeadRevisionBuilt
      && snapshot.projectionGeneration === this.lastProjectionGenerationBuilt
      && snapshot.frames.length === this.lastFrameCountBuilt
    ) {
      return false;
    }
    this.timeline = this.director(snapshot.frames);
    this.lastHeadRevisionBuilt = snapshot.headRevision;
    this.lastProjectionGenerationBuilt = snapshot.projectionGeneration;
    this.lastFrameCountBuilt = snapshot.frames.length;
    return true;
  }

  private primeLiveAtHead() {
    this.liveQueue = [];
    const headIndex = this.timeline.length - 1;
    if (headIndex < 0) {
      this.playheadIndex = -1;
      this.activeSceneWindow = undefined;
      return;
    }
    this.setActiveScene(headIndex, 'live');
  }

  private refreshCurrentWindowIfNeeded(previousScene: GameViewScene | undefined) {
    if (this.playheadIndex < 0 || !previousScene) return;
    const current = this.timeline[this.playheadIndex];
    if (!current || renderSignature(previousScene) === renderSignature(current)) return;
    this.clearAdvanceTimer();
    this.setActiveScene(this.playheadIndex, 'live');
  }

  /** Keep a running replay aligned when a paginated backfill recomputes pacing metadata. */
  private refreshReplayWindow(previousScene: GameViewScene | undefined) {
    const current = this.timeline[this.playheadIndex];
    if (!current) {
      if (this.timeline.length > 0) {
        this.setActiveScene(this.timeline.length - 1, 'replay');
        this.scheduleReplayAdvance();
      } else {
        this.playheadIndex = -1;
        this.activeSceneWindow = undefined;
      }
      return;
    }

    if (
      !previousScene
      || !this.activeSceneWindow
      || renderSignature(previousScene) !== renderSignature(current)
    ) {
      this.setActiveScene(this.playheadIndex, 'replay');
    } else {
      this.activeSceneWindow = {
        ...this.activeSceneWindow,
        sceneId: current.id,
        durationMs: sceneWindowDurationMs(current, 'replay'),
      };
    }
    this.scheduleReplayAdvance();
  }

  private setActiveScene(index: number, mode: PlaybackMode) {
    const scene = this.timeline[index];
    if (!scene) {
      this.playheadIndex = -1;
      this.activeSceneWindow = undefined;
      return;
    }
    this.playheadIndex = index;
    const generation = this.session.getSnapshot().projectionGeneration;
    this.windowSerial += 1;
    this.activeSceneWindow = {
      instanceKey: `${generation}:${scene.id}:${this.windowSerial}`,
      sceneId: scene.id,
      startedAtMs: this.clock.now(),
      durationMs: sceneWindowDurationMs(scene, mode),
      mode,
    };
  }

  private scheduleReplayAdvance() {
    this.clearAdvanceTimer();
    if (this.disposed || this.mode !== 'replay' || !this.activeSceneWindow) return;
    // A bounded clip/range plays its stop scene's own window in full, then
    // halts -- no further advance timer is armed once the playhead is
    // sitting on `rangeStopAtIndex`. Mode intentionally stays 'replay' (not
    // 'paused') so `refreshReplayWindow` keeps tracking a paginated backfill
    // the same way an unbounded replay would.
    if (this.rangeStopAtIndex !== undefined && this.playheadIndex >= this.rangeStopAtIndex) return;

    const dueAt = this.activeSceneWindow.startedAtMs + this.activeSceneWindow.durationMs;
    this.advanceTimer = this.clock.setTimer(() => {
      this.advanceTimer = null;
      if (this.disposed || this.mode !== 'replay') return;
      if (this.playheadIndex >= this.timeline.length - 1) return;

      this.setActiveScene(this.playheadIndex + 1, 'replay');
      this.emit();
      this.scheduleReplayAdvance();
    }, Math.max(0, dueAt - this.clock.now()));
  }

  private scheduleLiveQueue() {
    this.clearAdvanceTimer();
    if (this.disposed || this.mode !== 'live' || this.liveQueue.length === 0) return;

    const next = this.liveQueue[0]!;
    const currentWindowEndsAt = this.activeSceneWindow
      ? this.activeSceneWindow.startedAtMs + this.activeSceneWindow.durationMs
      : this.clock.now();
    const dueAt = Math.max(next.availableAtMs, currentWindowEndsAt);

    this.advanceTimer = this.clock.setTimer(() => {
      this.advanceTimer = null;
      if (this.disposed || this.mode !== 'live') return;
      const queued = this.liveQueue.shift();
      if (!queued || !this.timeline[queued.index]) {
        this.scheduleLiveQueue();
        return;
      }

      this.setActiveScene(queued.index, 'live');
      this.emit();
      this.scheduleLiveQueue();
    }, Math.max(0, dueAt - this.clock.now()));
  }

  private clearAdvanceTimer() {
    if (this.advanceTimer !== null) {
      this.clock.clearTimer(this.advanceTimer);
      this.advanceTimer = null;
    }
  }

  private resetScheduling() {
    this.clearAdvanceTimer();
    this.liveQueue = [];
  }
}

function sceneWindowDurationMs(scene: GameViewScene, mode: PlaybackMode): number {
  if (mode === 'replay' && scene.playback) {
    return Math.max(0, scene.playback.playbackDurationMs);
  }
  return scene.durationHint.minMs > 0 ? scene.durationHint.minMs : DEFAULT_AMBIENT_WINDOW_MS;
}

function hasStablePrefix(
  previous: readonly GameViewScene[],
  next: readonly GameViewScene[],
): boolean {
  if (next.length < previous.length) return false;
  return previous.every((scene, index) => next[index]?.id === scene.id);
}

function hasSameLogicalSlots(
  previous: readonly GameViewScene[],
  next: readonly GameViewScene[],
): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((scene, index) => {
    const candidate = next[index];
    return candidate?.kind === scene.kind && candidate.startRevision === scene.startRevision;
  });
}

/** Fields that can materially change what the renderer shows within one logical scene. */
function renderSignature(scene: GameViewScene): string {
  return JSON.stringify({
    id: scene.id,
    kind: scene.kind,
    participant: scene.participant,
    teamId: scene.teamId,
    zone: scene.zone,
    pressure: scene.pressure,
    lifecycle: scene.lifecycle,
    sourceAction: scene.sourceAction,
    scoreAtMoment: scene.scoreAtMoment,
    phase: scene.phase,
    beats: scene.beats?.map((beat) => ({
      kind: beat.kind,
      lifecycle: beat.lifecycle,
      scoreAtMoment: beat.scoreAtMoment,
    })),
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
