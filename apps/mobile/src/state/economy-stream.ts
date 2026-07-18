import type { EconomyEvent } from '@gamecrew/core';

/**
 * Merge/gating layer between `EconomySession`'s engine-derived event log and
 * what the chat-stream UI is allowed to show right now.
 *
 * The engine's output (`buildEconomyTimeline`) is a deterministic array
 * keyed to frame `seq`/`stateRevision` -- it has no notion of "has this
 * moment aired yet." In live mode that is fine (events arrive as frames
 * arrive, so "computed" and "aired" are the same moment). In replay, the
 * chat tab may be mounted independently of `GameViewScreen`'s
 * `PlaybackEngine` (its own scene timeline, its own pacing), so this module
 * cannot assume a shared playhead index is available. Instead it runs a
 * light release scheduler directly over the engine's frame `seq` ordering:
 * events are released in `seq` order, one at a time, on a fixed per-event
 * pacing interval, exactly cloning the timer-driven advance pattern in
 * `playback-engine.ts`'s `scheduleReplayAdvance` (a `setTimer`/`clearTimer`
 * pair driven by an injected clock) rather than building a second full
 * pacing engine.
 *
 * This is intentionally *not* a scene director: there is no per-event
 * duration hint to consume, just a flat release cadence. If Global Chat
 * later wants to sync exactly with Game View's scene pacing, the natural
 * next step is threading `PlaybackEngine`'s `playheadIndex`/frame id through
 * as an alternate release source -- this module's `EconomyStreamGate`
 * interface is deliberately narrow (`releasedThroughSeq`) so that swap does
 * not change any caller.
 *
 * User-authored actions are never gated here: `claimGift`/`takeBet` mutate
 * `UserPileStore`'s local action log directly and take effect immediately,
 * independent of what has "aired." The *engine's* resulting `bet_taken`
 * event (and any settlement it causes) still passes through this gate like
 * any other event -- it cannot appear ahead of the prompt it answers, because
 * a user can only act on a prompt already visible in their gated stream, and
 * the engine always places `bet_taken` at or after that prompt's frame seq.
 */

export type EconomyReleaseMode = 'live' | 'replay';

export interface EconomyStreamGateClock {
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
}

export interface EconomyStreamGateOptions {
  clock?: EconomyStreamGateClock;
  /** Fixed spacing between released events in replay mode. Live mode releases immediately (no artificial delay). */
  releaseIntervalMs?: number;
}

const DEFAULT_RELEASE_INTERVAL_MS = 1500;

function defaultClock(): EconomyStreamGateClock {
  return {
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
}

/**
 * Filters an engine event log down to events at or before `releasedThroughSeq`.
 * Pure; used both by `EconomyStreamGate` (below) and directly by tests.
 */
export function selectReleasedEvents(
  events: readonly EconomyEvent[],
  releasedThroughSeq: number,
): readonly EconomyEvent[] {
  return events.filter((event) => event.seq <= releasedThroughSeq);
}

export type EconomyStreamListener = (events: readonly EconomyEvent[]) => void;

/**
 * Stateful gate that owns the "how much of the engine log has aired"
 * cursor. In `live` mode the cursor jumps straight to the newest event's
 * seq whenever the log grows (nothing to pace against; the match is
 * happening now). In `replay` mode the cursor advances one event at a time
 * on `releaseIntervalMs`, via an injected clock so tests never depend on
 * real timers -- the same discipline as `PlaybackEngine`.
 */
export class EconomyStreamGate {
  private clock: EconomyStreamGateClock;
  private releaseIntervalMs: number;
  private mode: EconomyReleaseMode;
  private events: readonly EconomyEvent[] = [];
  private releasedThroughSeq = -Infinity;
  private timer: unknown = null;
  private listeners = new Set<EconomyStreamListener>();
  private disposed = false;

  constructor(mode: EconomyReleaseMode, options: EconomyStreamGateOptions = {}) {
    this.mode = mode;
    this.clock = options.clock ?? defaultClock();
    this.releaseIntervalMs = Math.max(0, options.releaseIntervalMs ?? DEFAULT_RELEASE_INTERVAL_MS);
  }

  subscribe(listener: EconomyStreamListener): () => void {
    this.listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
    };
  }

  private emit() {
    if (this.disposed) return;
    const released = selectReleasedEvents(this.events, this.releasedThroughSeq);
    for (const listener of this.listeners) listener(released);
  }

  getReleasedEvents(): readonly EconomyEvent[] {
    return selectReleasedEvents(this.events, this.releasedThroughSeq);
  }

  setMode(mode: EconomyReleaseMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === 'live') {
      this.releaseAllImmediately();
    } else {
      this.scheduleNextRelease();
    }
  }

  /** Feed the latest engine-derived event log. Called whenever EconomySession emits a new snapshot. */
  setEvents(events: readonly EconomyEvent[]) {
    this.events = events;
    if (this.mode === 'live') {
      this.releaseAllImmediately();
      return;
    }
    // Replay: don't jump the cursor forward on new data; just make sure a
    // release timer is running if there is anything left to release.
    this.scheduleNextRelease();
    this.emit();
  }

  private releaseAllImmediately() {
    this.clearTimer();
    const maxSeq = this.events.reduce((max, event) => Math.max(max, event.seq), this.releasedThroughSeq);
    this.releasedThroughSeq = maxSeq;
    this.emit();
  }

  private scheduleNextRelease() {
    this.clearTimer();
    if (this.disposed || this.mode !== 'replay') return;
    const nextSeq = this.nextUnreleasedSeq();
    if (nextSeq === undefined) return;
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      if (this.disposed || this.mode !== 'replay') return;
      this.releasedThroughSeq = nextSeq;
      this.emit();
      this.scheduleNextRelease();
    }, this.releaseIntervalMs);
  }

  private nextUnreleasedSeq(): number | undefined {
    let next: number | undefined;
    for (const event of this.events) {
      if (event.seq <= this.releasedThroughSeq) continue;
      if (next === undefined || event.seq < next) next = event.seq;
    }
    return next;
  }

  private clearTimer() {
    if (this.timer !== null) {
      this.clock.clearTimer(this.timer);
      this.timer = null;
    }
  }

  dispose() {
    this.disposed = true;
    this.clearTimer();
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// User chat message merge (V1: CHAT-001..011)
// ---------------------------------------------------------------------------

/**
 * A local, user-authored chat message (V1, local-first -- no chat backend).
 * Never fed into `buildEconomyTimeline`/`EconomySession`: this is purely an
 * additive row source merged with the gated engine event log at render time
 * (CHAT-008). Never gated by `EconomyStreamGate` (CHAT-006/007): a message
 * appends and is visible the instant it's sent, in both live and replay.
 *
 * `releasedEventCountAtSend` is the ordering key: it records how many engine
 * events had already been released (per `EconomyStreamGate`) at the moment
 * this message was sent, so `mergeEconomyStream` can interleave it at the
 * correct position without needing a shared clock between frame `seq` and
 * wall-clock send time. `use-economy.ts` (the only producer of this type) is
 * responsible for stamping it from the gate's current released-event count.
 */
export interface EconomyChatMessage {
  id: string;
  fixtureId: string;
  text: string;
  /** Wall-clock send time, informational only (never used for merge ordering). */
  sentAtMs: number;
  /** How many engine events were already released when this message was sent -- the merge ordering key. */
  releasedEventCountAtSend: number;
}

/** One row in the merged, render-ready chat-tab stream: either an engine-derived economy event or a user-authored message. */
export type EconomyStreamRow =
  | { kind: 'event'; event: EconomyEvent }
  | { kind: 'chat'; message: EconomyChatMessage };

/**
 * Merges the (already-gated) engine event log with the user's local chat
 * messages into one ordered row list for the chat-tab UI. Pure and
 * side-effect-free: does not mutate, filter, or delay either input --
 * `releasedEvents` keeps exactly the ordering/pacing `EconomyStreamGate`
 * already decided (REG-005/CHAT-008), and every chat message is always
 * included, unconditionally (never gated, CHAT-006/007).
 *
 * A message with `releasedEventCountAtSend === N` is inserted immediately
 * after the Nth released event (0 means "before any event has released
 * yet"). Multiple messages sent at the same count (e.g. rapid consecutive
 * sends, CHAT-009) are kept in their own relative order via a stable sort on
 * `sentAtMs` as a tiebreak. This never reorders engine events relative to
 * each other and never delays/advances any event's own release.
 */
export function mergeEconomyStream(
  releasedEvents: readonly EconomyEvent[],
  chatMessages: readonly EconomyChatMessage[],
): readonly EconomyStreamRow[] {
  const messagesByCount = new Map<number, EconomyChatMessage[]>();
  for (const message of chatMessages) {
    const bucket = messagesByCount.get(message.releasedEventCountAtSend);
    if (bucket) bucket.push(message);
    else messagesByCount.set(message.releasedEventCountAtSend, [message]);
  }
  for (const bucket of messagesByCount.values()) {
    bucket.sort((a, b) => a.sentAtMs - b.sentAtMs);
  }

  const rows: EconomyStreamRow[] = [];
  const pushedCounts = new Set<number>();
  const pushBucket = (count: number) => {
    const bucket = messagesByCount.get(count);
    if (!bucket) return;
    pushedCounts.add(count);
    for (const message of bucket) rows.push({ kind: 'chat', message });
  };

  pushBucket(0);
  releasedEvents.forEach((event, index) => {
    rows.push({ kind: 'event', event });
    pushBucket(index + 1);
  });

  // Defensive: a message stamped with a releasedEventCountAtSend beyond the
  // current releasedEvents length (shouldn't happen via the real hook, since
  // it always stamps against the gate's own current count, but a stale
  // count could appear if a caller passes a shorter releasedEvents array
  // than the one active when the message was sent) still surfaces at the
  // end rather than silently vanishing.
  const remainingCounts = [...messagesByCount.keys()]
    .filter((count) => !pushedCounts.has(count))
    .sort((a, b) => a - b);
  for (const count of remainingCounts) {
    pushBucket(count);
  }

  return rows;
}
