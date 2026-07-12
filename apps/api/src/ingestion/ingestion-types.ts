import type {
  CanonicalMatchState,
  MatchEnginePhase,
  SemanticFrame,
} from '@gamecrew/core';

export type RawIngestionSource =
  | 'snapshot'
  | 'updates'
  | 'historical'
  | 'interval'
  | 'stream';

export interface RawLedgerCandidateInput {
  fixtureId: string;
  seq: number;
  payloadHash: string;
  source: RawIngestionSource;
  eventId?: string;
  sourceTimestamp?: number;
  receivedAt: string;
  payloadJson: string;
}

export interface RawLedgerCandidate extends RawLedgerCandidateInput {}

export interface AppendRawCandidatesResult {
  inserted: number;
  unchanged: number;
  conflictingSequences: number[];
}

export interface IngestionCursor {
  fixtureId: string;
  lastSeenSeq: number;
  lastEventId?: string;
  lastBackfilledInterval?: string;
  timelineStartSeq?: number;
  timelineComplete?: boolean;
  sessionStatus?: string;
  lastError?: string;
  updatedAt: string;
}

export interface EngineCheckpoint {
  fixtureId: string;
  engineVersion: string;
  lastAppliedSeq: number;
  stateRevision: number;
  stateHash: string;
  conflictHash: string;
  projectionGeneration: number;
  phase: MatchEnginePhase;
  finalisedAt?: string;
  state: CanonicalMatchState;
  updatedAt: string;
}

export interface ProjectionCommit {
  checkpoint: EngineCheckpoint;
  frames: readonly SemanticFrame[];
  replaceFrames?: boolean;
  committedAt?: string;
  expectedCheckpoint?: Pick<
    EngineCheckpoint,
    'stateRevision' | 'stateHash' | 'projectionGeneration'
  >;
}

export interface StoredSemanticFrame {
  fixtureId: string;
  engineVersion: string;
  seq: number;
  stateRevision: number;
  frame: SemanticFrame;
  createdAt: string;
}
