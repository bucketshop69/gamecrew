import {
  planCommentaryBeats,
  type CommentaryBeat,
  type MatchEnginePhase,
  type MatchEngineTeam,
  type MatchPulseCommentaryEntry,
  type MatchPulseCommentaryEntryKind,
  type SemanticFrame,
} from '@gamecrew/core';
import { randomUUID } from 'node:crypto';
import type { MatchPulseCommentaryStore } from '../match-pulse-commentary-store.js';
import type {
  MatchPulseCommentaryGroundingContext,
  MatchPulseEnrichmentService,
} from '../match-pulse-llm.js';
import type { SemanticFrameHub } from './semantic-frame-hub.js';

export interface CommentaryProjectionFrameStore {
  listFramesAfter(fixtureId: string, afterRevision: number): Promise<readonly (
    SemanticFrame | { frame: SemanticFrame }
  )[]>;
  getCheckpoint(fixtureId: string): Promise<{
    phase: MatchEnginePhase;
    projectionGeneration: number;
    stateRevision?: number;
  } | undefined>;
}

interface FixtureConsumerState {
  teams: readonly MatchEngineTeam[];
  unsubscribe?: () => void;
  rebuildQueue: Promise<void>;
  enrichmentRequested: boolean;
  enrichmentTask?: Promise<void>;
  rebuildScheduled: boolean;
  requestedGeneration?: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

export interface CommentaryProjectionConsumerOptions {
  enrichment?: MatchPulseEnrichmentService;
  enrichmentBatchSize?: number;
  onEnrichmentError?: (error: unknown, fixtureId: string) => void;
  enrichmentLeaseMs?: number;
  enrichmentRetryBaseMs?: number;
  enrichmentMaxAttempts?: number;
  workerId?: string;
}

/**
 * Projects the durable semantic-frame stream into saved deterministic
 * commentary. API reads only observe this projection; they never initiate LLM
 * work or rebuild source context from TxLINE.
 */
export class CommentaryProjectionConsumer {
  private readonly fixtures = new Map<string, FixtureConsumerState>();
  private readonly workerId: string;

  constructor(
    private readonly frames: CommentaryProjectionFrameStore,
    private readonly hub: SemanticFrameHub,
    private readonly commentary: MatchPulseCommentaryStore,
    private readonly options: CommentaryProjectionConsumerOptions = {},
  ) {
    this.workerId = options.workerId ?? randomUUID();
  }

  async ensureFixture(
    fixtureId: string | number,
    teams: readonly MatchEngineTeam[] = [],
  ): Promise<void> {
    const key = String(fixtureId);
    const existing = this.fixtures.get(key);
    if (existing) {
      if (teams.length > 0) existing.teams = teams;
      return;
    }

    const state: FixtureConsumerState = {
      teams,
      rebuildQueue: Promise.resolve(),
      enrichmentRequested: false,
      rebuildScheduled: false,
    };
    this.fixtures.set(key, state);
    const cursor = await this.commentary.getProjectionCursor(key);
    try {
      state.unsubscribe = await this.hub.subscribe(
        key,
        (_frame, delivery) => {
          void this.queueRebuild(key, delivery.projectionGeneration);
        },
        {
          afterRevision: cursor?.lastStateRevision ?? 0,
          projectionGeneration: cursor?.projectionGeneration,
          onResyncRequired: (generation) => {
            void this.queueRebuild(key, generation);
          },
        },
      );

      // A fixture can already have a complete durable projection but no prior
      // commentary cursor (for example after deploying Phase 6).
      if (!cursor) await this.queueRebuild(key);
      this.scheduleEnrichment(key, state);
    } catch (error) {
      this.fixtures.delete(key);
      throw error;
    }
  }

  async close(): Promise<void> {
    const states = [...this.fixtures.values()];
    this.fixtures.clear();
    for (const state of states) {
      state.unsubscribe?.();
      if (state.retryTimer) clearTimeout(state.retryTimer);
    }
    await Promise.allSettled(states.flatMap((state) => [state.rebuildQueue, state.enrichmentTask]));
  }

  private queueRebuild(fixtureId: string, expectedGeneration?: number): Promise<void> {
    const state = this.fixtures.get(fixtureId);
    if (!state) return Promise.resolve();
    state.requestedGeneration = expectedGeneration === undefined
      ? state.requestedGeneration
      : Math.max(state.requestedGeneration ?? expectedGeneration, expectedGeneration);
    if (state.rebuildScheduled) return state.rebuildQueue;
    state.rebuildScheduled = true;
    const rebuild = state.rebuildQueue.catch(() => undefined).then(async () => {
      // Hub backlog delivery advances through microtasks. Yield one event-loop
      // turn so a publication burst collapses before starting the full scan.
      await new Promise<void>((resolve) => setImmediate(resolve));
      while (state.rebuildScheduled && this.fixtures.has(fixtureId)) {
        state.rebuildScheduled = false;
        const generation = state.requestedGeneration;
        state.requestedGeneration = undefined;
        await this.rebuild(fixtureId, state, generation);
      }
    });
    state.rebuildQueue = rebuild;
    return rebuild;
  }

  private async rebuild(
    fixtureId: string,
    state: FixtureConsumerState,
    expectedGeneration?: number,
  ): Promise<void> {
    let checkpoint = await this.frames.getCheckpoint(fixtureId);
    if (!checkpoint) return;
    if (expectedGeneration !== undefined && expectedGeneration < checkpoint.projectionGeneration) return;
    let storedFrames = await this.frames.listFramesAfter(fixtureId, 0);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const confirmed = await this.frames.getCheckpoint(fixtureId);
      if (!confirmed) return;
      if (
        confirmed.projectionGeneration === checkpoint.projectionGeneration
        && confirmed.stateRevision === checkpoint.stateRevision
      ) {
        break;
      }
      checkpoint = confirmed;
      storedFrames = await this.frames.listFramesAfter(fixtureId, 0);
    }
    const finalCheckpoint = await this.frames.getCheckpoint(fixtureId);
    if (
      !finalCheckpoint
      || finalCheckpoint.projectionGeneration !== checkpoint.projectionGeneration
      || finalCheckpoint.stateRevision !== checkpoint.stateRevision
    ) {
      queueMicrotask(() => {
        void this.queueRebuild(fixtureId, finalCheckpoint?.projectionGeneration);
      });
      return;
    }
    const semanticFrames = storedFrames.map((stored) => 'frame' in stored ? stored.frame : stored);
    const beats = planCommentaryBeats(semanticFrames, {
      projectionGeneration: checkpoint.projectionGeneration,
      teams: state.teams,
    });
    const phases = phasesByFrame(semanticFrames);
    const entries = beats.map((beat) => commentaryEntryFromBeat(
      beat,
      phases.get(beat.sourceFrameIds[0] ?? '') ?? checkpoint.phase,
      state.teams,
    ));
    const lastStateRevision = semanticFrames.reduce(
      (latest, frame) => Math.max(latest, frame.stateRevision),
      0,
    );
    await this.commentary.commitEngineProjection(
      fixtureId,
      checkpoint.projectionGeneration,
      lastStateRevision,
      entries,
      { replace: true },
    );
    this.scheduleEnrichment(fixtureId, state);
  }

  private scheduleEnrichment(fixtureId: string, state: FixtureConsumerState): void {
    if (!this.options.enrichment) return;
    state.enrichmentRequested = true;
    if (state.enrichmentTask) return;
    state.enrichmentTask = this.runEnrichment(fixtureId, state)
      .catch((error) => this.options.onEnrichmentError?.(error, fixtureId))
      .finally(() => {
        state.enrichmentTask = undefined;
        if (state.enrichmentRequested && this.fixtures.has(fixtureId)) {
          this.scheduleEnrichment(fixtureId, state);
        }
      });
  }

  private async runEnrichment(fixtureId: string, state: FixtureConsumerState): Promise<void> {
    const enrichment = this.options.enrichment;
    if (!enrichment) return;
    while (state.enrichmentRequested && this.fixtures.has(fixtureId)) {
      state.enrichmentRequested = false;
      const claim = await this.commentary.claimEnrichmentBatch(
        fixtureId,
        this.workerId,
        Math.max(1, this.options.enrichmentBatchSize ?? 4),
        this.options.enrichmentLeaseMs ?? 30_000,
      );
      if (!claim) {
        const delay = Math.min(
          this.options.enrichmentLeaseMs ?? 30_000,
          this.options.enrichmentRetryBaseMs ?? 1_000,
        );
        if (!state.retryTimer && this.fixtures.has(fixtureId)) {
          state.retryTimer = setTimeout(() => {
            state.retryTimer = undefined;
            this.scheduleEnrichment(fixtureId, state);
          }, delay);
        }
        return;
      }
      const entries = await this.commentary.listEntries(fixtureId);
      const pending = claim.entries;
      const pendingIds = new Set(pending.map((entry) => entry.id));
      const firstPending = pending[0];
      const previous = entries
        .filter((entry) => !pendingIds.has(entry.id))
        .filter((entry) => !firstPending || compareCommentaryEntries(entry, firstPending) < 0)
        .sort(compareCommentaryEntries);
      const requestCursor = claim.cursor;
      const leaseMs = this.options.enrichmentLeaseMs ?? 30_000;
      let leaseOwned = true;
      let renewalQueue = Promise.resolve();
      const queueRenewal = () => {
        renewalQueue = renewalQueue.then(async () => {
          if (leaseOwned) leaseOwned = await this.commentary.renewEnrichmentClaim(claim, leaseMs);
        });
      };
      const heartbeat = setInterval(queueRenewal, Math.max(5, Math.floor(leaseMs / 3)));
      let result: Awaited<ReturnType<MatchPulseEnrichmentService['enrichCommentaryEntries']>> | undefined;
      let processingError: unknown;
      try {
        result = await enrichment.enrichCommentaryEntries(
          commentaryGroundingContext(state.teams, entries), pending, previous,
        );
      } catch (error) {
        processingError = error;
      } finally {
        clearInterval(heartbeat);
        await renewalQueue;
      }
      if (leaseOwned) leaseOwned = await this.commentary.renewEnrichmentClaim(claim, leaseMs);
      if (!leaseOwned) {
        state.enrichmentRequested = true;
        continue;
      }
      if (processingError !== undefined) {
        const terminal = claim.attempt >= (this.options.enrichmentMaxAttempts ?? 3);
        const delay = (this.options.enrichmentRetryBaseMs ?? 1_000) * (2 ** Math.max(0, claim.attempt - 1));
        await this.commentary.releaseEnrichmentClaim(
          claim, terminal ? 'terminal' : 'retry', Date.now() + delay,
        );
        this.options.onEnrichmentError?.(processingError, fixtureId);
        if (!terminal && this.fixtures.has(fixtureId)) {
          state.retryTimer = setTimeout(() => {
            state.retryTimer = undefined;
            this.scheduleEnrichment(fixtureId, state);
          }, delay);
        }
        return;
      }
      if (!result) return;
      if (result.entries.length === 0) {
        await this.commentary.releaseEnrichmentClaim(claim, 'terminal');
        return;
      }
      const resultGeneration = pending[0]?.projectionGeneration;
      if (resultGeneration !== undefined) {
        const commit = await this.commentary.commitEngineProjection(
          fixtureId,
          resultGeneration,
          requestCursor.lastStateRevision,
          result.entries,
          { expectedCursor: requestCursor },
        );
        if (!commit.applied) {
          await this.commentary.releaseEnrichmentClaim(claim, 'retry', Date.now());
          state.enrichmentRequested = true;
          continue;
        }
      }
      await this.commentary.releaseEnrichmentClaim(
        claim,
        result.entries.some((entry) => entry.enrichmentStatus === 'failed') ? 'terminal' : 'complete',
      );
      state.enrichmentRequested = true;
    }
  }
}

export function commentaryEntryFromBeat(
  beat: CommentaryBeat,
  phase: MatchEnginePhase,
  teams: readonly MatchEngineTeam[] = [],
): MatchPulseCommentaryEntry {
  const team = teams.find((candidate) =>
    (beat.teamId !== undefined && String(candidate.teamId) === String(beat.teamId))
      || (beat.participant !== undefined && candidate.participant === beat.participant));
  const opponent = team && teams.find((candidate) => candidate.participant !== team.participant);
  const clockSeconds = beat.matchClockSeconds;
  const scoreCue = beat.simulationCues.find((cue) => cue.kind === 'score_commit');
  const score = scoreCue?.value;

  return {
    id: beat.id,
    fixtureId: String(beat.fixtureId),
    batchId: `engine:${beat.projectionGeneration}:${beat.fromSeq}-${beat.toSeq}`,
    fromSeq: beat.fromSeq,
    toSeq: beat.toSeq,
    period: toProductPhase(phase, clockSeconds),
    clock: {
      ...(typeof clockSeconds === 'number' ? {
        seconds: clockSeconds,
        minute: Math.floor(clockSeconds / 60) + 1,
      } : {}),
      label: typeof clockSeconds === 'number' ? `${Math.floor(clockSeconds / 60) + 1}'` : phaseLabel(phase),
    },
    sortSeq: beat.toSeq,
    kind: entryKind(beat),
    ...(team ? { team: teamRef(team) } : beat.teamId !== undefined ? { team: { id: String(beat.teamId) } } : {}),
    ...(opponent ? { opponent: teamRef(opponent) } : {}),
    ...(typeof score?.participant1 === 'number' && typeof score.participant2 === 'number'
      ? { scoreAtMoment: { home: score.participant1, away: score.participant2 } }
      : {}),
    sourceEvents: beat.sources.flatMap((source) => {
      const mapped = source.cues.map(({ cueId, action }) => {
        const cue = beat.simulationCues.find((candidate) => candidate.id === cueId);
        return {
          kind: 'system' as const,
          id: source.frameId,
          fixtureId: String(beat.fixtureId),
          seq: source.seq,
          action,
          label: cue?.kind ?? action,
          ...(cue?.participant ? { participant: cue.participant } : {}),
          ...(cue?.teamId !== undefined ? { teamId: String(cue.teamId) } : {}),
          ...(cue?.lifecycle ? { confirmed: cue.lifecycle === 'confirmed' } : {}),
        };
      });
      return mapped.length > 0 ? mapped : [{
        kind: 'system' as const,
        id: source.frameId,
        fixtureId: String(beat.fixtureId),
        seq: source.seq,
        action: 'commentary',
        label: 'match update',
      }];
    }),
    commentary: beat.fallbackCommentary,
    voiceLine: beat.fallbackCommentary,
    intensity: beat.kind === 'major' ? 'major' : beat.kind === 'pressure' ? 'danger' : 'building',
    momentumSide: team?.isHome === true ? 'home' : team?.isHome === false ? 'away' : 'unknown',
    confidence: beat.kind === 'pressure' ? 'inferred' : 'source_backed',
    generation: 'rule_based',
    fallbackCommentary: beat.fallbackCommentary,
    enrichmentStatus: 'pending',
    projectionGeneration: beat.projectionGeneration,
    commentaryBeatKind: beat.kind,
    mustCover: beat.mustCover,
    sourceFrameIds: beat.sourceFrameIds,
    factIds: beat.factIds,
    cueIds: beat.cueIds,
    groundedFacts: beat.simulationCues.map((cue) => ({
      id: cue.id,
      kind: cue.kind,
      ...(typeof cue.value.action === 'string' ? { action: cue.value.action } : {}),
      lifecycle: cue.lifecycle,
      basis: cue.basis,
      ...(cue.participant !== undefined ? { participant: cue.participant } : {}),
      ...(cue.teamId !== undefined ? { teamId: String(cue.teamId) } : {}),
      ...(cue.player
        ? { playerName: cue.player.displayName ?? cue.player.sourcePreferredName }
        : {}),
      ...(cue.pressure ? { pressure: cue.pressure } : {}),
      ...(cue.probableZone ? { probableZone: cue.probableZone } : {}),
      value: beat.restartContext && cue.kind === 'restart'
        ? { ...cue.value, context: beat.restartContext }
        : cue.value,
      sourceSeqs: cue.sourceSeqs,
    })),
  };
}

function entryKind(beat: CommentaryBeat): MatchPulseCommentaryEntryKind {
  const cue = beat.simulationCues[0];
  if (beat.kind === 'pressure') return 'pressure';
  if (!cue) return 'commentary';
  if (cue.kind === 'goal_confirmed') return 'goal';
  if (cue.kind === 'card') return 'card';
  if (cue.kind === 'shot_attempt' || cue.kind === 'shot_outcome') return 'shot';
  if (cue.kind === 'substitution') return 'substitution';
  if (cue.kind === 'injury') return 'injury';
  if (cue.kind === 'var') return 'var';
  if (cue.kind === 'phase_change') return 'phase_change';
  if (cue.kind === 'possession_pressure') return 'danger';
  if (cue.kind === 'set_piece') {
    if (cue.value.action === 'corner') return 'corner';
    if (cue.value.action === 'free_kick') return 'free_kick';
    return 'set_piece';
  }
  return 'commentary';
}

function teamRef(team: MatchEngineTeam) {
  return {
    id: String(team.teamId),
    name: team.name,
    side: team.isHome === true ? 'home' as const : team.isHome === false ? 'away' as const : undefined,
  };
}

function toProductPhase(phase: MatchEnginePhase, seconds?: number) {
  if (phase === 'finalised' || phase === 'full_time_pending') return 'full_time' as const;
  if (phase === 'half_time') return 'half_time' as const;
  if (phase === 'second_half' || phase === 'second_half_ready') return 'second_half' as const;
  if (phase === 'first_half' || phase === 'first_half_ready') return 'first_half' as const;
  if (typeof seconds === 'number' && seconds >= 45 * 60) return 'second_half' as const;
  return 'pre_match' as const;
}

function phaseLabel(phase: MatchEnginePhase): string {
  if (phase === 'finalised') return 'FT';
  if (phase === 'half_time') return 'HT';
  return 'Pre-match';
}

function phasesByFrame(frames: readonly SemanticFrame[]): Map<string, MatchEnginePhase> {
  const result = new Map<string, MatchEnginePhase>();
  let phase: MatchEnginePhase = 'pre_match';
  for (const frame of [...frames].sort((left, right) =>
    left.stateRevision - right.stateRevision || left.seq - right.seq)) {
    const phaseValue = frame.facts.find((fact) => fact.kind === 'phase')?.value.phase
      ?? frame.simulationCues.find((cue) => cue.kind === 'phase_change')?.value.phase;
    if (isEnginePhase(phaseValue)) phase = phaseValue;
    result.set(frame.id, phase);
  }
  return result;
}

function isEnginePhase(value: unknown): value is MatchEnginePhase {
  return typeof value === 'string' && [
    'pre_match', 'first_half_ready', 'first_half', 'half_time',
    'second_half_ready', 'second_half', 'full_time_pending', 'finalised',
  ].includes(value);
}

function commentaryGroundingContext(
  teams: readonly MatchEngineTeam[],
  entries: readonly MatchPulseCommentaryEntry[],
): MatchPulseCommentaryGroundingContext {
  const home = teams.find((team) => team.isHome) ?? teams.find((team) => team.participant === 1);
  const away = teams.find((team) => team.isHome === false) ?? teams.find((team) => team.participant === 2);
  return {
    homeTeam: { id: String(home?.teamId ?? 'home'), name: home?.name ?? 'Home team' },
    awayTeam: { id: String(away?.teamId ?? 'away'), name: away?.name ?? 'Away team' },
    allowedSourceFrameIds: entries.flatMap((entry) => entry.sourceFrameIds ?? []),
  };
}

function compareCommentaryEntries(
  left: MatchPulseCommentaryEntry,
  right: MatchPulseCommentaryEntry,
): number {
  return (left.sortSeq ?? 0) - (right.sortSeq ?? 0) || left.id.localeCompare(right.id);
}
