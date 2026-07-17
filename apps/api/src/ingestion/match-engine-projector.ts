import { createHash } from 'node:crypto';
import {
  replayMatchEngine,
  type CanonicalMatchState,
  type MatchEngineContext,
  type MatchEngineReplayResult,
  type SemanticFrame,
  type TxlineMatchEngineRecord,
} from '@gamecrew/core';

export interface PersistedRawCandidate {
  record?: TxlineMatchEngineRecord;
  payload?: TxlineMatchEngineRecord;
  payloadJson?: string;
  source?: string;
}

export interface MatchEngineProjectionCheckpoint {
  fixtureId: string;
  lastAppliedSeq: number;
  stateRevision: number;
  engineVersion: string;
  stateHash: string;
  conflictHash: string;
  projectionGeneration: number;
  phase: CanonicalMatchState['phase'];
  finalisedAt?: string;
  state: CanonicalMatchState;
  updatedAt: string;
}

export interface CommitProjectionInput {
  checkpoint: MatchEngineProjectionCheckpoint;
  frames: readonly SemanticFrame[];
  replaceFrames?: boolean;
  expectedCheckpoint?: Pick<
    MatchEngineProjectionCheckpoint,
    'stateRevision' | 'stateHash' | 'projectionGeneration'
  >;
}

/**
 * The persistence boundary required by the projector. `commitProjection` must
 * atomically save the checkpoint and frames, and return only frames inserted by
 * that transaction. Returning only inserted frames prevents restart or retry
 * paths from publishing the same frame twice.
 */
export interface ProjectorStore {
  listRawCandidates(fixtureId: string): Promise<readonly PersistedRawCandidate[]>;
  getCheckpoint(
    fixtureId: string,
    engineVersion?: string,
  ): Promise<MatchEngineProjectionCheckpoint | undefined>;
  commitProjection(input: CommitProjectionInput): Promise<void | readonly SemanticFrame[]>;
  listFramesAfter(
    fixtureId: string,
    afterRevision: number,
    engineVersion?: string,
  ): Promise<readonly (SemanticFrame | { frame: SemanticFrame })[]>;
}

export interface ProjectedFramePublisher {
  publish(
    fixtureId: string,
    frames: readonly SemanticFrame[],
    options?: { replaceExisting?: boolean; projectionGeneration?: number },
  ): void;
}

export interface MatchEngineProjectionResult {
  replay: MatchEngineReplayResult;
  checkpoint: MatchEngineProjectionCheckpoint;
  committedFrames: readonly SemanticFrame[];
  idempotent: boolean;
}

export interface MatchEngineProjectorOptions {
  engineVersion?: string;
  now?: () => Date;
  publisher?: ProjectedFramePublisher;
}

export interface ProjectMatchOptions {
  throughSeq?: number;
  forceReplace?: boolean;
}

export class MatchEngineProjector {
  private readonly engineVersion: string;
  private readonly now: () => Date;
  private readonly publisher?: ProjectedFramePublisher;
  private readonly fixtureRuns = new Map<string, Promise<void>>();

  constructor(
    private readonly store: ProjectorStore,
    options: MatchEngineProjectorOptions = {},
  ) {
    // Bump whenever canonical frame semantics change so durable fixtures are
    // rebuilt from their raw TxLINE ledger instead of serving stale frames.
    this.engineVersion = options.engineVersion ?? 'match-engine-v2';
    this.now = options.now ?? (() => new Date());
    this.publisher = options.publisher;
  }

  project(
    fixtureId: string | number,
    context: MatchEngineContext,
    options: ProjectMatchOptions = {},
  ): Promise<MatchEngineProjectionResult> {
    const key = String(fixtureId);
    if (String(context.fixtureId) !== key) {
      return Promise.reject(new Error(
        `Match-engine context fixture ${context.fixtureId} does not match projector fixture ${key}.`,
      ));
    }

    const previousRun = this.fixtureRuns.get(key) ?? Promise.resolve();
    const run = previousRun.then(
      () => this.projectFixture(key, context, options),
      () => this.projectFixture(key, context, options),
    );
    this.fixtureRuns.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  private async projectFixture(
    fixtureId: string,
    context: MatchEngineContext,
    options: ProjectMatchOptions,
  ): Promise<MatchEngineProjectionResult> {
    const [candidates, previousCheckpoint, latestCheckpoint] = await Promise.all([
      this.store.listRawCandidates(fixtureId),
      this.store.getCheckpoint(fixtureId, this.engineVersion),
      this.store.getCheckpoint(fixtureId),
    ]);
    const timelineCandidates = candidates.filter((candidate) => candidate.source !== 'snapshot');
    const records = timelineCandidates
      .map(toRecord)
      .filter((record) => context.sequenceBefore === undefined || record.Seq > context.sequenceBefore)
      .filter((record) => options.throughSeq === undefined || record.Seq <= options.throughSeq)
      .sort(compareRecordsDeterministically);
    const replay = replayMatchEngine(records, context);

    if (previousCheckpoint && previousCheckpoint.stateRevision > replay.state.stateRevision) {
      throw new Error(
        `Persisted ledger for fixture ${fixtureId} is behind checkpoint revision ${previousCheckpoint.stateRevision}.`,
      );
    }

    const stateHash = hashState(replay.state);
    const sequenceCounts = new Map<number, number>();
    for (const record of records) sequenceCounts.set(record.Seq, (sequenceCounts.get(record.Seq) ?? 0) + 1);
    const conflictingRecords = records.filter((record) => (sequenceCounts.get(record.Seq) ?? 0) > 1);
    const conflictHash = createHash('sha256').update(stable(conflictingRecords)).digest('hex');
    const legacyEmptyConflictHash = previousCheckpoint?.conflictHash === ''
      && conflictingRecords.length === 0;
    const conflictChanged = previousCheckpoint?.conflictHash !== undefined
      && !legacyEmptyConflictHash
      && previousCheckpoint.conflictHash !== conflictHash;
    const replacesEarlierConflict = Boolean(previousCheckpoint && [...sequenceCounts].some(
      ([seq, count]) => count > 1 && seq <= previousCheckpoint.lastAppliedSeq,
    ) && conflictChanged);
    const replacesEngineVersion = Boolean(
      !previousCheckpoint
      && latestCheckpoint
      && latestCheckpoint.engineVersion !== this.engineVersion,
    );
    const replacesEarlierProjection = replacesEngineVersion || Boolean(previousCheckpoint && (
      replacesEarlierConflict || options.forceReplace
    ));
    const projectionGeneration = replacesEngineVersion
      ? latestCheckpoint!.projectionGeneration + 1
      : (previousCheckpoint?.projectionGeneration ?? 0) + (replacesEarlierProjection ? 1 : 0);
    const checkpoint: MatchEngineProjectionCheckpoint = {
      fixtureId,
      lastAppliedSeq: replay.state.lastAppliedSeq,
      stateRevision: replay.state.stateRevision,
      engineVersion: this.engineVersion,
      stateHash,
      conflictHash,
      projectionGeneration,
      phase: replay.state.phase,
      ...(replay.state.phase === 'finalised'
        ? {
            finalisedAt: previousCheckpoint?.finalisedAt
              ?? (replacesEngineVersion ? latestCheckpoint?.finalisedAt : undefined)
              ?? this.now().toISOString(),
          }
        : {}),
      state: replay.state,
      updatedAt: this.now().toISOString(),
    };
    const afterRevision = previousCheckpoint?.stateRevision ?? 0;
    const newFrames = replacesEarlierProjection
      ? replay.frames
      : replay.frames.filter((frame) => frame.stateRevision > afterRevision);
    const unchanged = Boolean(
      previousCheckpoint &&
      !replacesEarlierProjection &&
      previousCheckpoint.engineVersion === this.engineVersion &&
      previousCheckpoint.stateRevision === checkpoint.stateRevision &&
      previousCheckpoint.stateHash === checkpoint.stateHash &&
      newFrames.length === 0,
    );

    if (unchanged) {
      return {
        replay,
        checkpoint: previousCheckpoint!,
        committedFrames: [],
        idempotent: true,
      };
    }

    const commitResult = await this.store.commitProjection({
      checkpoint,
      frames: newFrames,
      replaceFrames: replacesEarlierProjection,
      ...(previousCheckpoint ? {
        expectedCheckpoint: {
          stateRevision: previousCheckpoint.stateRevision,
          stateHash: previousCheckpoint.stateHash,
          projectionGeneration: previousCheckpoint.projectionGeneration,
        },
      } : {}),
    });
    const committedFrames = replacesEarlierProjection
      ? newFrames
      : commitResult ?? (await this.store.listFramesAfter(
          fixtureId,
          afterRevision,
          this.engineVersion,
        )).map(unwrapFrame);
    const generationChanged = replacesEngineVersion || Boolean(
      previousCheckpoint
      && previousCheckpoint.projectionGeneration !== checkpoint.projectionGeneration,
    );
    if (committedFrames.length > 0 || generationChanged) {
      this.publisher?.publish(fixtureId, committedFrames, {
        replaceExisting: replacesEarlierProjection,
        projectionGeneration: checkpoint.projectionGeneration,
      });
    }

    return {
      replay,
      checkpoint,
      committedFrames,
      idempotent: committedFrames.length === 0 && newFrames.length === 0,
    };
  }
}

function unwrapFrame(value: SemanticFrame | { frame: SemanticFrame }): SemanticFrame {
  return 'frame' in value ? value.frame : value;
}

function toRecord(candidate: PersistedRawCandidate): TxlineMatchEngineRecord {
  if (candidate.record) return candidate.record;
  if (candidate.payload) return candidate.payload;
  if (typeof candidate.payloadJson === 'string') {
    return JSON.parse(candidate.payloadJson) as TxlineMatchEngineRecord;
  }
  if ('FixtureId' in candidate && 'Seq' in candidate && 'Id' in candidate && 'Action' in candidate) {
    return candidate as unknown as TxlineMatchEngineRecord;
  }
  throw new Error('Persisted raw candidate does not contain a TxLINE match-engine record.');
}

function compareRecordsDeterministically(
  left: TxlineMatchEngineRecord,
  right: TxlineMatchEngineRecord,
): number {
  return left.Seq - right.Seq || stable(left).localeCompare(stable(right));
}

function hashState(state: CanonicalMatchState): string {
  return createHash('sha256').update(stable(state)).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}
