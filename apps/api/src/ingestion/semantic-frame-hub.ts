import type { SemanticFrame } from '@gamecrew/core';

export interface SemanticFrameBacklogStore {
  listFramesAfter(
    fixtureId: string,
    afterRevision: number,
  ): Promise<readonly (SemanticFrame | { frame: SemanticFrame })[]>;
  getCheckpoint?(
    fixtureId: string,
  ): Promise<{ projectionGeneration: number } | undefined>;
}

export interface SemanticFrameDelivery {
  projectionGeneration?: number;
}

export type SemanticFrameListener = (
  frame: SemanticFrame,
  delivery: SemanticFrameDelivery,
) => void | Promise<void>;

export interface SemanticFrameSubscriberError {
  error: unknown;
  fixtureId: string;
  frame: SemanticFrame;
}

export interface SemanticFrameHubOptions {
  onSubscriberError?: (failure: SemanticFrameSubscriberError) => void;
}

export interface SemanticFrameSubscriptionOptions {
  afterRevision?: number;
  projectionGeneration?: number;
  onResyncRequired?: (generation: number) => void;
}

interface SubscriberState {
  fixtureId: string;
  listener: SemanticFrameListener;
  queue: Array<{ frame: SemanticFrame; projectionGeneration?: number }>;
  queuedFrameKeys: Set<string>;
  afterRevision: number;
  ready: boolean;
  running: boolean;
  active: boolean;
  projectionGeneration?: number;
  onResyncRequired?: (generation: number) => void;
}

/**
 * An in-process fan-out hub. Each listener owns an independent serial queue, so
 * slow or failing listeners cannot delay projection or other subscribers.
 */
export class SemanticFrameHub {
  private readonly subscribers = new Map<string, Map<symbol, SubscriberState>>();
  private readonly onSubscriberError?: (failure: SemanticFrameSubscriberError) => void;

  constructor(
    private readonly store: SemanticFrameBacklogStore,
    options: SemanticFrameHubOptions = {},
  ) {
    this.onSubscriberError = options.onSubscriberError;
  }

  async subscribe(
    fixtureId: string | number,
    listener: SemanticFrameListener,
    options: SemanticFrameSubscriptionOptions = {},
  ): Promise<() => void> {
    const key = String(fixtureId);
    const token = Symbol(key);
    const state: SubscriberState = {
      fixtureId: key,
      listener,
      queue: [],
      queuedFrameKeys: new Set(),
      afterRevision: options.afterRevision ?? 0,
      ready: false,
      running: false,
      active: true,
      projectionGeneration: options.projectionGeneration,
      onResyncRequired: options.onResyncRequired,
    };
    const fixtureSubscribers = this.subscribers.get(key) ?? new Map();
    fixtureSubscribers.set(token, state);
    this.subscribers.set(key, fixtureSubscribers);

    try {
      const checkpoint = await this.store.getCheckpoint?.(key);
      if (checkpoint) state.projectionGeneration = checkpoint.projectionGeneration;
      if (
        checkpoint
        && options.projectionGeneration !== undefined
        && options.projectionGeneration !== checkpoint.projectionGeneration
      ) {
        state.afterRevision = 0;
        this.notifyResync(state, checkpoint.projectionGeneration);
      }
      const backlog = (await this.store.listFramesAfter(key, state.afterRevision))
        .map((stored) => 'frame' in stored ? stored.frame : stored);
      this.enqueue(state, backlog, false, state.projectionGeneration);
      state.ready = true;
      this.scheduleDrain(state);
    } catch (error) {
      fixtureSubscribers.delete(token);
      if (fixtureSubscribers.size === 0) this.subscribers.delete(key);
      state.active = false;
      throw error;
    }

    return () => {
      if (!state.active) return;
      state.active = false;
      state.queue.length = 0;
      state.queuedFrameKeys.clear();
      const current = this.subscribers.get(key);
      current?.delete(token);
      if (current?.size === 0) this.subscribers.delete(key);
    };
  }

  publish(
    fixtureId: string | number,
    frames: readonly SemanticFrame[],
    options: { replaceExisting?: boolean; projectionGeneration?: number } = {},
  ): void {
    const fixtureSubscribers = this.subscribers.get(String(fixtureId));
    if (!fixtureSubscribers) return;
    for (const state of fixtureSubscribers.values()) {
      const generationChanged = options.projectionGeneration !== undefined
        && state.projectionGeneration !== undefined
        && options.projectionGeneration !== state.projectionGeneration;
      if (generationChanged) {
        state.queue.length = 0;
        state.queuedFrameKeys.clear();
        state.afterRevision = 0;
        state.projectionGeneration = options.projectionGeneration;
        this.notifyResync(state, options.projectionGeneration!);
      } else if (options.projectionGeneration !== undefined) {
        state.projectionGeneration = options.projectionGeneration;
      }
      const legacyForcedReplacement = options.replaceExisting === true
        && options.projectionGeneration === undefined;
      this.enqueue(
        state,
        frames,
        generationChanged || legacyForcedReplacement,
        options.projectionGeneration ?? state.projectionGeneration,
      );
      this.scheduleDrain(state);
    }
  }

  subscriberCount(fixtureId: string | number): number {
    return this.subscribers.get(String(fixtureId))?.size ?? 0;
  }

  private enqueue(
    state: SubscriberState,
    frames: readonly SemanticFrame[],
    replaceExisting = false,
    projectionGeneration?: number,
  ): void {
    for (const frame of frames) {
      if (String(frame.fixtureId) !== state.fixtureId || (!replaceExisting && frame.stateRevision <= state.afterRevision)) {
        continue;
      }
      const frameKey = `${frame.id}:${frame.stateRevision}`;
      if (replaceExisting) state.queuedFrameKeys.delete(frameKey);
      if (state.queuedFrameKeys.has(frameKey)) continue;
      state.queuedFrameKeys.add(frameKey);
      state.queue.push({ frame, projectionGeneration });
    }
    state.queue.sort((left, right) =>
      left.frame.stateRevision - right.frame.stateRevision
      || left.frame.seq - right.frame.seq
      || left.frame.id.localeCompare(right.frame.id));
  }

  private scheduleDrain(state: SubscriberState): void {
    if (!state.active || !state.ready || state.running || state.queue.length === 0) return;
    state.running = true;
    queueMicrotask(() => {
      void this.drain(state);
    });
  }

  private notifyResync(state: SubscriberState, generation: number): void {
    try {
      state.onResyncRequired?.(generation);
    } catch {
      // A consumer reset hook must not prevent corrected frames reaching other
      // subscribers (or this subscriber's own delivery queue).
    }
  }

  private async drain(state: SubscriberState): Promise<void> {
    try {
      while (state.active) {
        const queued = state.queue.shift();
        if (!queued) break;
        const { frame } = queued;
        try {
          await state.listener(frame, { projectionGeneration: queued.projectionGeneration });
        } catch (error) {
          this.onSubscriberError?.({ error, fixtureId: state.fixtureId, frame });
        } finally {
          state.afterRevision = Math.max(state.afterRevision, frame.stateRevision);
        }
      }
    } finally {
      state.running = false;
      this.scheduleDrain(state);
    }
  }
}
