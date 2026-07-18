import type { EconomyEvent, EconomyUserAction, SemanticFrame } from '@gamecrew/core';

import type { MatchSessionHandle, MatchSessionSnapshot } from './match-session';

/**
 * A per-fixture, refcounted derivation of the Playful Economy event log for
 * one local user. Mirrors `match-session.ts`'s acquire/release/registry
 * convention exactly: `EconomySession` owns *deriving the event log* only
 * (feeding the shared `MatchSession`'s frame log plus the user's local
 * actions through `buildEconomyTimeline`) and has no opinion about pacing
 * that stream for presentation -- that is the merge/gating layer's job (see
 * economy-stream.ts).
 *
 * The engine (`buildEconomyTimeline`) is a pure function of
 * `(frames, { userId, actions })`. Frames arrive from the shared
 * `MatchSession`; actions arrive from `UserPileStore`'s local action log for
 * this fixture. Because actions can change without a new frame landing (the
 * user taps "claim" or "take" between polls), this session exposes
 * `notifyActionsChanged()` so `UserPileStore` can push a recompute
 * immediately rather than waiting for the next poll.
 *
 * The director (`buildEconomyTimeline`) is injected rather than imported at
 * module scope so this file stays importable by the mobile package's plain
 * Node test runner, matching the constraint documented in
 * `playback-engine.ts` and `match-session.ts`.
 */

export type EconomyDirector = (
  frames: readonly SemanticFrame[],
  options: { userId: string; actions?: readonly EconomyUserAction[] },
) => readonly EconomyEvent[];

export interface EconomySessionSnapshot {
  fixtureId: string;
  userId: string;
  events: readonly EconomyEvent[];
  /** Mirrors the underlying MatchSession's status so consumers need only one status field. */
  sessionStatus: MatchSessionSnapshot['status'];
  headRevision: number;
  projectionGeneration: number;
  frameCount: number;
}

export type EconomySessionListener = (snapshot: EconomySessionSnapshot) => void;

export interface EconomySessionHandle {
  subscribe(listener: EconomySessionListener): () => void;
  getSnapshot(): EconomySessionSnapshot;
  /** Recompute immediately after the local action log changes (claim/take), without waiting on a poll. */
  notifyActionsChanged(): void;
  release(): void;
}

/** Injectable dependencies so the session is unit-testable without a real MatchSession or director. */
export interface EconomySessionDeps {
  /** Acquires (or shares) the underlying frame session for this fixture. Called once per EconomySession. */
  acquireSession: () => MatchSessionHandle;
  director: EconomyDirector;
  userId: string;
  /** Current local action log for this fixture; read fresh on every recompute. */
  getActions: () => readonly EconomyUserAction[];
}

class EconomySessionImpl {
  readonly fixtureId: string;

  private deps: EconomySessionDeps;
  private matchSession: MatchSessionHandle;
  private unsubscribeMatchSession: () => void;
  private listeners = new Set<EconomySessionListener>();
  private refcount = 0;
  private disposed = false;

  private events: readonly EconomyEvent[] = [];
  private lastHeadRevisionBuilt = -1;
  private lastProjectionGenerationBuilt = -1;
  private lastFrameCountBuilt = -1;
  private lastActionsLength = -1;
  private sessionStatus: MatchSessionSnapshot['status'] = 'loading';
  private headRevision = 0;
  private projectionGeneration = 0;
  private frameCount = 0;

  constructor(fixtureId: string, deps: EconomySessionDeps) {
    this.fixtureId = fixtureId;
    this.deps = deps;
    this.matchSession = deps.acquireSession();
    this.rebuild(this.matchSession.getSnapshot());
    this.unsubscribeMatchSession = this.matchSession.subscribe((snapshot) => {
      this.onMatchSessionUpdate(snapshot);
    });
  }

  acquire(): EconomySessionHandle {
    this.refcount += 1;
    let released = false;

    return {
      subscribe: (listener) => this.subscribe(listener),
      getSnapshot: () => this.getSnapshot(),
      notifyActionsChanged: () => this.notifyActionsChanged(),
      release: () => {
        if (released) return;
        released = true;
        this.releaseOne();
      },
    };
  }

  private subscribe(listener: EconomySessionListener): () => void {
    this.listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
    };
  }

  private getSnapshot(): EconomySessionSnapshot {
    return {
      fixtureId: this.fixtureId,
      userId: this.deps.userId,
      events: this.events,
      sessionStatus: this.sessionStatus,
      headRevision: this.headRevision,
      projectionGeneration: this.projectionGeneration,
      frameCount: this.frameCount,
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

  private dispose() {
    this.disposed = true;
    this.unsubscribeMatchSession();
    this.matchSession.release();
    this.listeners.clear();
    registry.delete(this.fixtureId);
  }

  private onMatchSessionUpdate(snapshot: MatchSessionSnapshot) {
    const rebuilt = this.rebuild(snapshot);
    if (rebuilt) this.emit();
    else {
      // Status-only changes (e.g. live -> stale) still need to reach subscribers.
      if (this.sessionStatus !== snapshot.status) {
        this.sessionStatus = snapshot.status;
        this.emit();
      }
    }
  }

  notifyActionsChanged() {
    // Force a rebuild by invalidating the actions-length memo key, even if
    // the frame log itself hasn't changed.
    this.lastActionsLength = -1;
    const rebuilt = this.rebuild(this.matchSession.getSnapshot());
    if (rebuilt) this.emit();
  }

  /** Memoized on head revision, projection generation, frame count, and actions length (pagination/status-only updates skip a re-run). */
  private rebuild(snapshot: MatchSessionSnapshot): boolean {
    const actions = this.deps.getActions();
    if (
      snapshot.headRevision === this.lastHeadRevisionBuilt
      && snapshot.projectionGeneration === this.lastProjectionGenerationBuilt
      && snapshot.frames.length === this.lastFrameCountBuilt
      && actions.length === this.lastActionsLength
    ) {
      this.sessionStatus = snapshot.status;
      return false;
    }

    this.events = this.deps.director(snapshot.frames, { userId: this.deps.userId, actions });
    this.lastHeadRevisionBuilt = snapshot.headRevision;
    this.lastProjectionGenerationBuilt = snapshot.projectionGeneration;
    this.lastFrameCountBuilt = snapshot.frames.length;
    this.lastActionsLength = actions.length;
    this.sessionStatus = snapshot.status;
    this.headRevision = snapshot.headRevision;
    this.projectionGeneration = snapshot.projectionGeneration;
    this.frameCount = snapshot.frames.length;
    return true;
  }
}

const registry = new Map<string, EconomySessionImpl>();

/**
 * Acquire a shared, refcounted `EconomySession` for `fixtureId`+`userId`. In
 * the POC there is one local user, so the registry is keyed by fixtureId
 * alone (mirroring `match-session.ts`); `deps.userId` must be stable across
 * acquisitions of the same fixture within a process lifetime.
 */
export function acquireEconomySession(
  fixtureId: string,
  deps: EconomySessionDeps,
): EconomySessionHandle {
  let session = registry.get(fixtureId);
  if (!session) {
    session = new EconomySessionImpl(fixtureId, deps);
    registry.set(fixtureId, session);
  }
  return session.acquire();
}

/** Test/debug helper: number of live economy sessions in the registry. */
export function economySessionRegistrySize(): number {
  return registry.size;
}

/** Test-only helper: force-clear the registry between test cases. */
export function __resetEconomySessionRegistryForTests(): void {
  registry.clear();
}
