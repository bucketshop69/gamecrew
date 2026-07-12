import { createHash } from 'node:crypto';
import { TxlineTransportError } from '@gamecrew/core';
import type {
  MatchEngineContext,
  MatchEngineReplayResult,
  TxlineScore,
  TxlineScoreStreamEvent,
} from '@gamecrew/core';
import type { IngestionStore } from './ingestion-store.js';
import type { RawIngestionSource } from './ingestion-types.js';
import { applySnapshotBaseline, clearSnapshotBaseline } from './match-engine-context.js';

export interface FixtureFeed {
  fetchHistorical(fixtureId: string): Promise<readonly TxlineScore[]>;
  fetchSnapshot(fixtureId: string): Promise<readonly TxlineScore[]>;
  fetchUpdates(fixtureId: string): Promise<readonly TxlineScore[]>;
  fetchInterval?(
    epochDay: number,
    hour: number,
    interval: number,
    fixtureId: string,
  ): Promise<readonly TxlineScore[]>;
  streamFixture(
    fixtureId: string,
    options: { lastEventId?: string; signal: AbortSignal; onOpen?: () => void | Promise<void> },
  ): AsyncIterable<TxlineScoreStreamEvent>;
}

export interface FixtureProjector {
  project(
    fixtureId: string,
    context: MatchEngineContext,
    options?: { throughSeq?: number; forceReplace?: boolean },
  ): Promise<{ replay: MatchEngineReplayResult }>;
}

export interface FixtureIngestionSessionOptions {
  fixtureId: string;
  context: MatchEngineContext;
  feed: FixtureFeed;
  store: IngestionStore;
  projector: FixtureProjector;
  now?: () => Date;
  reconnectDelayMs?: number;
  streamReadyTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  gapRecoveryAttempts?: number;
  gapRecoveryDelayMs?: number;
  finalisationCorrectionWindowMs?: number;
}

export class FixtureIngestionSession {
  private readonly fixtureId: string;
  private readonly now: () => Date;
  private context: MatchEngineContext;
  private controller?: AbortController;
  private streamTask?: Promise<void>;
  private stopped = false;
  private bootstrapping = true;
  private readonly streamBuffer: Array<{ score: TxlineScore; eventId?: string }> = [];
  private ingestQueue: Promise<void> = Promise.resolve();
  private markStreamReady?: () => void;
  private finalisationTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: FixtureIngestionSessionOptions) {
    this.fixtureId = options.fixtureId;
    this.now = options.now ?? (() => new Date());
    this.context = options.context;
  }

  async start(): Promise<void> {
    if (this.streamTask) return;
    this.stopped = false;
    this.bootstrapping = true;
    this.controller = new AbortController();
    const streamReady = new Promise<void>((resolve) => { this.markStreamReady = resolve; });
    this.streamTask = this.consumeStream(this.controller.signal);
    await Promise.race([
      streamReady,
      waitForReconnect(this.options.streamReadyTimeoutMs ?? 2_000, this.controller.signal),
    ]);
    const recoveredLocal = await this.recoverLocalLedger();
    const results = await Promise.allSettled([
      this.options.feed.fetchHistorical(this.fixtureId),
      this.options.feed.fetchSnapshot(this.fixtureId),
      this.options.feed.fetchUpdates(this.fixtureId),
    ]);
    const sources: RawIngestionSource[] = ['historical', 'snapshot', 'updates'];
    const history = results[0].status === 'fulfilled' ? results[0].value : [];
    const snapshot = results[1].status === 'fulfilled' ? results[1].value : [];
    const updates = results[2].status === 'fulfilled' ? results[2].value : [];
    const existingTimeline = (await this.options.store.listRawCandidates(this.fixtureId))
      .filter(({ source }) => source !== 'snapshot');
    const existingCursor = await this.options.store.getCursor(this.fixtureId);
    const historyStartsAtZero = history.some((score) => (score.Seq ?? score.seq) === 0);
    const promoteBaseline = historyStartsAtZero
      && (existingCursor?.timelineComplete === false || existingCursor?.sessionStatus === 'baseline_incomplete');
    if (
      promoteBaseline
    ) {
      await this.options.store.promoteToCompleteTimeline(
        this.fixtureId,
        this.now().toISOString(),
        this.toCandidates(history, 'historical'),
      );
      this.context = clearSnapshotBaseline(this.context);
    }
    if (existingTimeline.length === 0 && history.length === 0 && snapshot.length > 0) {
      await this.establishSnapshotBaseline(snapshot);
    }
    let successes = 0;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === 'fulfilled') {
        successes += 1;
        await this.ingest(result.value, sources[index], undefined, promoteBaseline && index === 0);
      }
    }
    const bootstrapCursor = await this.options.store.getCursor(this.fixtureId);
    if (bootstrapCursor?.sessionStatus === 'degraded' && !this.stopped) {
      await this.recoverGapRepeatedly([...history, ...updates]);
    }
    this.bootstrapping = false;
    for (const buffered of this.streamBuffer.splice(0)) {
      await this.ingest([buffered.score], 'stream', buffered.eventId);
    }
    if (successes === 0 && !recoveredLocal) {
      await this.stop();
      throw new Error(`TxLINE bootstrap failed for fixture ${this.fixtureId}.`);
    }
  }

  async pollOnce(): Promise<void> {
    await this.ingest(await this.options.feed.fetchUpdates(this.fixtureId), 'updates');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.finalisationTimer) clearTimeout(this.finalisationTimer);
    this.finalisationTimer = undefined;
    this.controller?.abort();
    await this.streamTask?.catch(() => undefined);
    this.streamTask = undefined;
    this.controller = undefined;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  private async consumeStream(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.stopped) {
      const cursor = await this.options.store.getCursor(this.fixtureId);
      const connection = new AbortController();
      const abortConnection = () => connection.abort(signal.reason);
      signal.addEventListener('abort', abortConnection, { once: true });
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      const resetHeartbeat = () => {
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        heartbeatTimer = setTimeout(
          () => connection.abort(new Error('TxLINE heartbeat timeout.')),
          this.options.heartbeatTimeoutMs ?? 30_000,
        );
      };
      try {
        for await (const event of this.options.feed.streamFixture(this.fixtureId, {
          lastEventId: cursor?.lastEventId,
          signal: connection.signal,
          onOpen: () => {
            this.markStreamReady?.();
            resetHeartbeat();
          },
        })) {
          resetHeartbeat();
          if (event.kind !== 'score') continue;
          if (this.bootstrapping) {
            this.streamBuffer.push({
              score: event.score,
              eventId: event.isLastInMessage === false ? undefined : event.message.id,
            });
          } else {
            await this.ingest(
              [event.score],
              'stream',
              event.isLastInMessage === false ? undefined : event.message.id,
            );
          }
        }
        if (!signal.aborted && !this.stopped) throw new Error('TxLINE stream ended.');
      } catch (error) {
        if (signal.aborted || this.stopped) return;
        if (error instanceof TxlineTransportError && error.status === 403) {
          await this.saveStatus('failed_access', error);
          this.stopped = true;
          return;
        }
        await this.saveStatus('reconnecting', error);
        await this.pollOnce().catch(async (pollError) => this.saveStatus('degraded', pollError));
        if (error instanceof TxlineTransportError && error.status === 400 && cursor?.lastEventId) {
          await this.options.store.clearCursorEventId(this.fixtureId);
        }
      } finally {
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        signal.removeEventListener('abort', abortConnection);
      }
      await waitForReconnect(this.options.reconnectDelayMs ?? 1_000, signal);
    }
  }

  private async ingest(
    scores: readonly TxlineScore[],
    source: RawIngestionSource,
    eventId?: string,
    forceReplace = false,
  ): Promise<void> {
    const run = this.ingestQueue.then(() => this.applyIngest(scores, source, eventId, forceReplace));
    this.ingestQueue = run.then(() => undefined, () => undefined);
    const result = await run;
    if (result.hasGap && source === 'stream' && !this.stopped) {
      await this.recoverGapRepeatedly(scores);
    }
  }

  private async recoverGapRepeatedly(scores: readonly TxlineScore[]): Promise<void> {
    const attempts = Math.max(1, this.options.gapRecoveryAttempts ?? 3);
    for (let attempt = 0; attempt < attempts && !this.stopped; attempt += 1) {
      if (attempt > 0) {
        await waitForReconnect(
          this.options.gapRecoveryDelayMs ?? this.options.reconnectDelayMs ?? 1_000,
          this.controller?.signal ?? new AbortController().signal,
        );
      }
      if (this.stopped) return;
      const beforeRecovery = await this.options.store.getCursor(this.fixtureId);
      const recovery = await this.recoverGap(scores);
      if (recovery.attemptedInterval) {
        await this.recordGapRecoveryAttempt(recovery.attemptedInterval);
      }
      if (recovery.rows.length > 0) await this.ingest(recovery.rows, recovery.source);
      let cursor = await this.options.store.getCursor(this.fixtureId);
      if (
        recovery.source === 'interval'
        && cursor?.sessionStatus === 'degraded'
        && cursor.lastSeenSeq <= (beforeRecovery?.lastSeenSeq ?? -1)
      ) {
        const updateRows = await this.options.feed.fetchUpdates(this.fixtureId).catch(() => []);
        if (updateRows.length > 0) await this.ingest(updateRows, 'updates');
        cursor = await this.options.store.getCursor(this.fixtureId);
      }
      if (cursor?.sessionStatus !== 'degraded') return;
    }
  }

  private async recoverGap(scores: readonly TxlineScore[]): Promise<{
    rows: readonly TxlineScore[];
    source: 'interval' | 'updates';
    attemptedInterval?: string;
  }> {
    const latestTimestamp = Math.max(...scores.map((score) => score.Ts ?? score.ts ?? -1));
    if (latestTimestamp > 0 && this.options.feed.fetchInterval) {
      const date = new Date(latestTimestamp);
      const epochDay = Math.floor(latestTimestamp / 86_400_000);
      const hour = date.getUTCHours();
      const interval = Math.floor(date.getUTCMinutes() / 5);
      const attemptedInterval = `${epochDay}/${hour}/${interval}`;
      const intervalRows = await this.options.feed.fetchInterval(
        epochDay,
        hour,
        interval,
        this.fixtureId,
      ).catch(() => []);
      if (intervalRows.length > 0) {
        return { rows: intervalRows, source: 'interval', attemptedInterval };
      }
      return {
        rows: await this.options.feed.fetchUpdates(this.fixtureId).catch(() => []),
        source: 'updates',
        attemptedInterval,
      };
    }
    return {
      rows: await this.options.feed.fetchUpdates(this.fixtureId).catch(() => []),
      source: 'updates',
    };
  }

  private async recordGapRecoveryAttempt(interval: string): Promise<void> {
    const run = this.ingestQueue.then(async () => {
      const cursor = await this.options.store.getCursor(this.fixtureId);
      await this.options.store.saveCursor({
        fixtureId: this.fixtureId,
        lastSeenSeq: cursor?.lastSeenSeq ?? -1,
        lastEventId: cursor?.lastEventId,
        lastBackfilledInterval: interval,
        timelineStartSeq: cursor?.timelineStartSeq,
        timelineComplete: cursor?.timelineComplete,
        sessionStatus: cursor?.sessionStatus ?? 'degraded',
        lastError: cursor?.lastError,
        updatedAt: this.now().toISOString(),
      });
    });
    this.ingestQueue = run.then(() => undefined, () => undefined);
    await run;
  }

  private async applyIngest(
    scores: readonly TxlineScore[],
    source: RawIngestionSource,
    eventId?: string,
    forceReplace = false,
  ): Promise<{ hasGap: boolean }> {
    const candidates = this.toCandidates(scores, source, eventId);
    if (candidates.length === 0) return { hasGap: false };
    await this.options.store.appendRawCandidates(candidates);
    const previous = await this.options.store.getCursor(this.fixtureId);
    const all = await this.options.store.listRawCandidates(this.fixtureId);
    const sequences = new Set(all.filter(({ source: candidateSource }) => candidateSource !== 'snapshot')
      .map(({ seq }) => seq));
    if (sequences.size === 0) return { hasGap: false };
    let contiguous = previous?.lastSeenSeq ?? -1;
    while (sequences.has(contiguous + 1)) contiguous += 1;
    const maxSeen = Math.max(...sequences);
    const minSeen = Math.min(...sequences);
    const hasGap = contiguous < maxSeen;
    await this.options.store.saveCursor({
      fixtureId: this.fixtureId,
      lastSeenSeq: contiguous,
      lastEventId: eventId ?? previous?.lastEventId,
      lastBackfilledInterval: previous?.lastBackfilledInterval,
      timelineStartSeq: previous?.timelineStartSeq ?? minSeen,
      timelineComplete: previous?.timelineComplete ?? sequences.has(0),
      sessionStatus: forceReplace ? 'promotion_pending' : hasGap ? 'degraded' : 'live',
      ...(hasGap ? { lastError: `Sequence gap after ${contiguous}; buffered through ${maxSeen}.` } : {}),
      updatedAt: this.now().toISOString(),
    });
    if (contiguous >= 0) {
      const projected = await this.options.projector.project(this.fixtureId, this.context, {
        throughSeq: contiguous,
        forceReplace,
      });
      if (forceReplace) {
        const promoted = await this.options.store.getCursor(this.fixtureId);
        await this.options.store.saveCursor({
          fixtureId: this.fixtureId,
          lastSeenSeq: promoted?.lastSeenSeq ?? contiguous,
          lastEventId: promoted?.lastEventId,
          lastBackfilledInterval: promoted?.lastBackfilledInterval,
          timelineStartSeq: 0,
          timelineComplete: true,
          sessionStatus: hasGap ? 'degraded' : 'live',
          ...(hasGap ? { lastError: `Sequence gap after ${contiguous}; buffered through ${maxSeen}.` } : {}),
          updatedAt: this.now().toISOString(),
        });
      }
      if (projected.replay.state.phase === 'finalised') {
        this.scheduleFinalisationStop();
      }
    }
    return { hasGap };
  }

  private toCandidates(
    scores: readonly TxlineScore[],
    source: RawIngestionSource,
    eventId?: string,
  ) {
    return scores.flatMap((score) => {
      const fixtureId = score.FixtureId ?? score.fixtureId;
      const seq = score.Seq ?? score.seq;
      if (String(fixtureId) !== this.fixtureId || typeof seq !== 'number') return [];
      const payloadJson = JSON.stringify(score);
      return [{
        fixtureId: this.fixtureId,
        seq,
        payloadHash: createHash('sha256').update(payloadJson).digest('hex'),
        source,
        ...(eventId ? { eventId } : {}),
        sourceTimestamp: score.Ts ?? score.ts,
        receivedAt: this.now().toISOString(),
        payloadJson,
      }];
    });
  }

  private async recoverLocalLedger(): Promise<boolean> {
    const all = await this.options.store.listRawCandidates(this.fixtureId);
    const previous = await this.options.store.getCursor(this.fixtureId);
    if (previous?.timelineComplete === false || previous?.sessionStatus === 'baseline_incomplete') {
      const snapshotScores = all.filter(({ source }) => source === 'snapshot').flatMap(({ payloadJson }) => {
        try { return [JSON.parse(payloadJson) as TxlineScore]; } catch { return []; }
      });
      this.context = applySnapshotBaseline(this.context, snapshotScores);
    }
    const sequences = new Set(all.filter(({ source }) => source !== 'snapshot').map(({ seq }) => seq));
    if (sequences.size === 0) return Boolean(await this.options.store.getCheckpoint(this.fixtureId));
    let contiguous = previous?.lastSeenSeq ?? -1;
    while (sequences.has(contiguous + 1)) contiguous += 1;
    if (contiguous < 0) return false;
    const promotionPending = previous?.sessionStatus === 'promotion_pending';
    if (promotionPending) this.context = clearSnapshotBaseline(this.context);
    const projected = await this.options.projector.project(this.fixtureId, this.context, {
      throughSeq: contiguous,
      forceReplace: promotionPending,
    });
    if (projected.replay.state.phase === 'finalised') this.scheduleFinalisationStop();
    if (!previous || previous.lastSeenSeq !== contiguous || promotionPending) {
      await this.options.store.saveCursor({
        fixtureId: this.fixtureId,
        lastSeenSeq: contiguous,
        lastEventId: previous?.lastEventId,
        lastBackfilledInterval: previous?.lastBackfilledInterval,
        timelineStartSeq: previous?.timelineStartSeq,
        timelineComplete: previous?.timelineComplete,
        sessionStatus: promotionPending ? 'live' : 'recovering',
        updatedAt: this.now().toISOString(),
      });
    }
    return true;
  }

  private async establishSnapshotBaseline(snapshot: readonly TxlineScore[]): Promise<void> {
    const seqs = snapshot.map((score) => score.Seq ?? score.seq).filter((seq): seq is number => typeof seq === 'number');
    if (seqs.length === 0) return;
    const baseline = Math.max(...seqs);
    this.context = applySnapshotBaseline(this.context, snapshot);
    await this.options.store.saveCursor({
      fixtureId: this.fixtureId,
      lastSeenSeq: baseline,
      timelineStartSeq: baseline,
      timelineComplete: false,
      sessionStatus: 'baseline_incomplete',
      lastError: `Timeline before snapshot baseline Seq ${baseline} is unavailable.`,
      updatedAt: this.now().toISOString(),
    });
    await this.options.projector.project(this.fixtureId, this.context, { throughSeq: baseline });
  }

  private async saveStatus(status: string, error: unknown): Promise<void> {
    const run = this.ingestQueue.then(() => this.applyStatus(status, error));
    this.ingestQueue = run.then(() => undefined, () => undefined);
    await run;
  }

  private scheduleFinalisationStop(): void {
    if (this.finalisationTimer) return;
    const correctionWindowMs = Math.max(0, this.options.finalisationCorrectionWindowMs ?? 15 * 60_000);
    if (correctionWindowMs === 0) {
      this.stopped = true;
      this.controller?.abort();
      return;
    }
    this.finalisationTimer = setTimeout(() => {
      this.finalisationTimer = undefined;
      this.stopped = true;
      this.controller?.abort();
    }, correctionWindowMs);
    this.finalisationTimer.unref?.();
  }

  private async applyStatus(status: string, error: unknown): Promise<void> {
    const cursor = await this.options.store.getCursor(this.fixtureId);
    await this.options.store.saveCursor({
      fixtureId: this.fixtureId,
      lastSeenSeq: cursor?.lastSeenSeq ?? -1,
      lastEventId: cursor?.lastEventId,
      lastBackfilledInterval: cursor?.lastBackfilledInterval,
      timelineStartSeq: cursor?.timelineStartSeq,
      timelineComplete: cursor?.timelineComplete,
      sessionStatus: status,
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: this.now().toISOString(),
    });
  }
}

function waitForReconnect(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
