import type { SemanticFrame } from '@gamecrew/core';

import type { EngineFramesResponse } from '../api/gamecrew';

/**
 * A per-fixture, append-only log of semantic frames polled from the engine
 * frames endpoint. One `MatchSession` is shared by every consumer (Match
 * Pulse, Game View, the debug panel) so switching tabs never interrupts
 * polling — see docs/issues/game-view-director-and-playback.md, item 6.
 *
 * The session owns *data acquisition* only (fetch, dedupe, append, resync,
 * staleness). It has no opinion about playback pacing or scene timelines —
 * that is `PlaybackEngine`'s job (state/playback-engine.ts).
 *
 * This module has no runtime import of `../api/gamecrew`: the real fetcher
 * is supplied by `match-session-defaults.ts` (imported only from the React
 * hook layer), so this file can be imported directly by unit tests under the
 * mobile package's plain `node --experimental-strip-types` runner, which
 * requires fully-resolvable runtime import graphs (see playback-engine.ts's
 * header comment for the same constraint on the director).
 */

export type MatchSessionStatus = 'loading' | 'live' | 'complete' | 'stale' | 'error';

export interface MatchSessionSnapshot {
  fixtureId: string;
  frames: readonly SemanticFrame[];
  headRevision: number;
  projectionGeneration: number;
  status: MatchSessionStatus;
  errorMessage?: string;
  /** Wall-clock ms (per the injected clock) of the most recent successful poll. */
  lastUpdatedAtMs?: number;
}

export type MatchSessionListener = (snapshot: MatchSessionSnapshot) => void;

export interface MatchSessionHandle {
  /** Subscribe to snapshot updates. Returns an unsubscribe function. */
  subscribe(listener: MatchSessionListener): () => void;
  /** Current snapshot, readable without subscribing. */
  getSnapshot(): MatchSessionSnapshot;
  /** Re-evaluate `isLive` after the fixture changes phase without replacing this shared session. */
  syncLiveStatus(): void;
  /** Release this consumer's hold on the session. Disposes once refcount hits 0. */
  release(): void;
}

/** Injectable dependencies so the session is unit-testable without real network/timers. */
export interface MatchSessionDeps {
  fetchFrames: (
    fixtureId: string,
    options: { afterRevision?: number; projectionGeneration?: number; signal?: AbortSignal },
  ) => Promise<EngineFramesResponse>;
  /** Returns whether the fixture should keep polling (live) or backfill once (finished). */
  isLive: () => boolean;
  /** setTimeout-alike, injectable for tests. */
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
  pollIntervalMs: number;
  /** A poll window past which, if no fresh data arrives, status flips to 'stale'. Live only. */
  staleAfterMs: number;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

class MatchSession {
  readonly fixtureId: string;

  private deps: MatchSessionDeps;
  private listeners = new Set<MatchSessionListener>();
  private refcount = 0;
  private frames: SemanticFrame[] = [];
  private frameIds = new Set<string>();
  private headRevision = 0;
  private projectionGeneration = 0;
  private hasProjectionGeneration = false;
  private status: MatchSessionStatus = 'loading';
  private errorMessage: string | undefined;
  private lastUpdatedAtMs: number | undefined;
  private timerHandle: unknown = null;
  private staleTimerHandle: unknown = null;
  private inFlight: AbortController | null = null;
  private disposed = false;

  constructor(fixtureId: string, deps: MatchSessionDeps) {
    this.fixtureId = fixtureId;
    this.deps = deps;
  }

  acquire(): MatchSessionHandle {
    this.refcount += 1;
    if (this.refcount === 1) {
      this.start();
    }

    let released = false;

    return {
      subscribe: (listener) => this.subscribe(listener),
      getSnapshot: () => this.getSnapshot(),
      syncLiveStatus: () => this.syncLiveStatus(),
      release: () => {
        if (released) return;
        released = true;
        this.releaseOne();
      },
    };
  }

  private subscribe(listener: MatchSessionListener): () => void {
    this.listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
    };
  }

  private getSnapshot(): MatchSessionSnapshot {
    return {
      fixtureId: this.fixtureId,
      frames: this.frames,
      headRevision: this.headRevision,
      projectionGeneration: this.projectionGeneration,
      status: this.status,
      errorMessage: this.errorMessage,
      lastUpdatedAtMs: this.lastUpdatedAtMs,
    };
  }

  private emit() {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private releaseOne() {
    this.refcount = Math.max(0, this.refcount - 1);
    if (this.refcount === 0) {
      this.dispose();
    }
  }

  private start() {
    this.disposed = false;
    this.poll(0);
  }

  /**
   * The match list can move a fixture from upcoming to live while this
   * refcounted session remains mounted. A completed one-shot backfill has no
   * timer left to notice that change, so the React adapter explicitly nudges
   * the session through this seam when `isLive` changes.
   */
  private syncLiveStatus() {
    if (this.disposed) return;

    if (!this.deps.isLive()) {
      if (this.timerHandle !== null) {
        this.deps.clearTimer(this.timerHandle);
        this.timerHandle = null;
      }
      if (this.staleTimerHandle !== null) {
        this.deps.clearTimer(this.staleTimerHandle);
        this.staleTimerHandle = null;
      }
      if (this.status === 'live' || this.status === 'stale') {
        this.status = 'complete';
        this.emit();
      }
      return;
    }

    if (this.inFlight !== null || this.timerHandle !== null) return;
    void this.poll(this.headRevision);
  }

  private dispose() {
    this.disposed = true;
    if (this.timerHandle !== null) {
      this.deps.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.staleTimerHandle !== null) {
      this.deps.clearTimer(this.staleTimerHandle);
      this.staleTimerHandle = null;
    }
    this.inFlight?.abort();
    this.inFlight = null;
    registry.delete(this.fixtureId);
  }

  /** Reset the append-only log and refetch from zero (resync). */
  private resetLog() {
    this.frames = [];
    this.frameIds.clear();
    this.headRevision = 0;
  }

  private appendFrames(newFrames: readonly SemanticFrame[]) {
    for (const frame of newFrames) {
      if (this.frameIds.has(frame.id)) continue;
      this.frameIds.add(frame.id);
      this.frames.push(frame);
    }
    // Keep the append-only log ordered by state revision, then seq, since
    // pagination can interleave with resync-triggered restarts.
    this.frames.sort((a, b) => a.stateRevision - b.stateRevision || a.seq - b.seq);
  }

  private scheduleStaleWatch() {
    if (this.staleTimerHandle !== null) {
      this.deps.clearTimer(this.staleTimerHandle);
      this.staleTimerHandle = null;
    }
    if (!this.deps.isLive()) return;

    this.staleTimerHandle = this.deps.setTimer(() => {
      this.staleTimerHandle = null;
      if (this.disposed) return;
      const sinceUpdate = this.deps.now() - (this.lastUpdatedAtMs ?? this.deps.now());
      if (sinceUpdate >= this.deps.staleAfterMs && this.status === 'live') {
        this.status = 'stale';
        this.emit();
      }
    }, this.deps.staleAfterMs);
  }

  private async poll(afterRevision: number) {
    if (this.disposed) return;

    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    try {
      const response = await this.deps.fetchFrames(this.fixtureId, {
        afterRevision,
        ...(this.hasProjectionGeneration
          ? { projectionGeneration: this.projectionGeneration }
          : {}),
        signal: controller.signal,
      });

      if (this.disposed || this.inFlight !== controller) return;

      if (response.resyncRequired) {
        this.resetLog();
        this.projectionGeneration = response.projectionGeneration;
        this.hasProjectionGeneration = true;
        this.status = 'loading';
        this.errorMessage = undefined;
        this.emit();
        this.inFlight = null;
        void this.poll(0);
        return;
      }

      this.appendFrames(response.frames);
      this.headRevision = Math.max(this.headRevision, response.headRevision);
      this.projectionGeneration = response.projectionGeneration;
      this.hasProjectionGeneration = true;
      this.lastUpdatedAtMs = this.deps.now();
      this.errorMessage = undefined;

      const live = this.deps.isLive();

      if (response.hasMore) {
        // Full backfill: keep paging immediately until caught up.
        this.status = 'loading';
        this.emit();
        this.inFlight = null;
        void this.poll(response.nextAfterRevision);
        return;
      }

      this.status = live ? 'live' : 'complete';
      this.emit();
      this.scheduleStaleWatch();

      if (live) {
        this.inFlight = null;
        this.timerHandle = this.deps.setTimer(() => {
          this.timerHandle = null;
          void this.poll(response.nextAfterRevision);
        }, this.deps.pollIntervalMs);
      } else {
        this.inFlight = null;
      }
    } catch (error) {
      if (this.disposed || isAbortError(error)) return;
      if (this.inFlight !== controller) return;

      this.inFlight = null;
      this.errorMessage = error instanceof Error ? error.message : 'Game View data is unavailable.';
      this.status = this.frames.length > 0 ? this.status : 'error';
      this.emit();

      // Back off and retry on the normal poll cadence rather than hammering.
      if (this.deps.isLive()) {
        this.timerHandle = this.deps.setTimer(() => {
          this.timerHandle = null;
          void this.poll(afterRevision);
        }, this.deps.pollIntervalMs);
      }
    }
  }
}

const registry = new Map<string, MatchSession>();

/**
 * Acquire a shared session for `fixtureId`. Multiple consumers calling this
 * for the same fixture share one poller (refcounted); the session keeps
 * polling as long as any handle is held and disposes when the last one
 * calls `release()`.
 *
 * `deps` is required in full on first acquisition for a given fixture (the
 * React hook layer supplies the real network/timer deps via
 * `match-session-defaults.ts`; tests supply a fake fetcher + fake clock
 * directly). Later acquisitions of an already-live session share its
 * existing deps and ignore any `deps` passed in.
 */
export function acquireMatchSession(
  fixtureId: string,
  deps: MatchSessionDeps,
): MatchSessionHandle {
  let session = registry.get(fixtureId);
  if (!session) {
    session = new MatchSession(fixtureId, deps);
    registry.set(fixtureId, session);
  }
  return session.acquire();
}

/** Test/debug helper: number of live sessions in the registry. */
export function matchSessionRegistrySize(): number {
  return registry.size;
}

/** Test-only helper: force-clear the registry between test cases. */
export function __resetMatchSessionRegistryForTests(): void {
  registry.clear();
}
