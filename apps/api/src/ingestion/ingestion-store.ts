import type {
  AppendRawCandidatesResult,
  EngineCheckpoint,
  FixtureContextSnapshot,
  IngestionCursor,
  ProjectionCommit,
  RawLedgerCandidate,
  RawLedgerCandidateInput,
  StoredSemanticFrame,
} from './ingestion-types.js';

export interface IngestionStore {
  appendRawCandidates(
    candidates: readonly RawLedgerCandidateInput[],
  ): Promise<AppendRawCandidatesResult>;
  listRawCandidates(fixtureId: string, afterSeq?: number): Promise<readonly RawLedgerCandidate[]>;
  listFixtureIds(): Promise<readonly string[]>;
  getFixtureContext(fixtureId: string): Promise<FixtureContextSnapshot | undefined>;
  saveFixtureContext(context: FixtureContextSnapshot): Promise<void>;
  getCursor(fixtureId: string): Promise<IngestionCursor | undefined>;
  listCursors(): Promise<readonly IngestionCursor[]>;
  saveCursor(cursor: IngestionCursor): Promise<void>;
  promoteToCompleteTimeline(
    fixtureId: string,
    updatedAt: string,
    historical: readonly RawLedgerCandidateInput[],
  ): Promise<void>;
  clearCursorEventId(fixtureId: string): Promise<void>;
  getCheckpoint(fixtureId: string, engineVersion?: string): Promise<EngineCheckpoint | undefined>;
  commitProjection(commit: ProjectionCommit): Promise<void>;
  listFramesAfter(
    fixtureId: string,
    stateRevision: number,
    engineVersion?: string,
  ): Promise<readonly StoredSemanticFrame[]>;
  close(): void;
}

export type {
  AppendRawCandidatesResult,
  EngineCheckpoint,
  FixtureContextSnapshot,
  IngestionCursor,
  ProjectionCommit,
  RawLedgerCandidate,
  RawLedgerCandidateInput,
  StoredSemanticFrame,
} from './ingestion-types.js';
