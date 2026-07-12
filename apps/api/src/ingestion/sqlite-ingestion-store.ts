import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { SemanticFrame } from '@gamecrew/core';
import type { IngestionStore } from './ingestion-store.js';
import type {
  AppendRawCandidatesResult,
  EngineCheckpoint,
  IngestionCursor,
  ProjectionCommit,
  RawLedgerCandidate,
  RawLedgerCandidateInput,
  StoredSemanticFrame,
} from './ingestion-types.js';

interface SqliteRunResult {
  changes?: number | bigint;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): SqliteRunResult;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface RawCandidateRow {
  fixture_id: string;
  seq: number;
  payload_hash: string;
  source: RawLedgerCandidate['source'];
  event_id: string | null;
  source_timestamp: number | null;
  received_at: string;
  payload_json: string;
}

interface CursorRow {
  fixture_id: string;
  last_seen_seq: number;
  last_event_id: string | null;
  last_backfilled_interval: string | null;
  timeline_start_seq: number | null;
  timeline_complete: number | null;
  session_status: string | null;
  last_error: string | null;
  updated_at: string;
}

interface CheckpointRow {
  fixture_id: string;
  engine_version: string;
  last_applied_seq: number;
  state_revision: number;
  state_hash: string;
  conflict_hash: string;
  projection_generation: number;
  phase: EngineCheckpoint['phase'];
  finalised_at: string | null;
  state_json: string;
  updated_at: string;
}

interface FrameRow {
  fixture_id: string;
  engine_version: string;
  seq: number;
  state_revision: number;
  frame_json: string;
  created_at: string;
}

export class SqliteIngestionStore implements IngestionStore {
  private readonly db: SqliteDatabase;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    }

    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (databasePath: string) => SqliteDatabase;
    };
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS txline_raw_records (
        fixture_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        event_id TEXT,
        source_timestamp INTEGER,
        received_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (fixture_id, seq, payload_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_txline_raw_records_fixture_order
        ON txline_raw_records (fixture_id, seq, payload_hash);

      CREATE TABLE IF NOT EXISTS txline_ingestion_cursors (
        fixture_id TEXT PRIMARY KEY,
        last_seen_seq INTEGER NOT NULL,
        last_event_id TEXT,
        last_backfilled_interval TEXT,
        timeline_start_seq INTEGER,
        timeline_complete INTEGER,
        session_status TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS match_engine_checkpoints (
        fixture_id TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        last_applied_seq INTEGER NOT NULL,
        state_revision INTEGER NOT NULL,
        state_hash TEXT NOT NULL,
        conflict_hash TEXT NOT NULL DEFAULT '',
        projection_generation INTEGER NOT NULL DEFAULT 0,
        phase TEXT NOT NULL,
        finalised_at TEXT,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (fixture_id, engine_version)
      );

      CREATE INDEX IF NOT EXISTS idx_match_engine_checkpoints_latest
        ON match_engine_checkpoints (fixture_id, updated_at DESC, engine_version DESC);

      CREATE TABLE IF NOT EXISTS match_engine_frames (
        fixture_id TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        seq INTEGER NOT NULL,
        state_revision INTEGER NOT NULL,
        frame_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (fixture_id, engine_version, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_match_engine_frames_revision
        ON match_engine_frames (fixture_id, engine_version, state_revision, seq);
    `);
    try {
      this.db.exec("ALTER TABLE match_engine_checkpoints ADD COLUMN conflict_hash TEXT NOT NULL DEFAULT '';");
    } catch {}
    try {
      this.db.exec('ALTER TABLE match_engine_checkpoints ADD COLUMN projection_generation INTEGER NOT NULL DEFAULT 0;');
    } catch {}
    try {
      this.db.exec('ALTER TABLE txline_ingestion_cursors ADD COLUMN timeline_start_seq INTEGER;');
    } catch {}
    try {
      this.db.exec('ALTER TABLE txline_ingestion_cursors ADD COLUMN timeline_complete INTEGER;');
    } catch {}
  }

  async appendRawCandidates(
    candidates: readonly RawLedgerCandidateInput[],
  ): Promise<AppendRawCandidatesResult> {
    const result: AppendRawCandidatesResult = {
      inserted: 0,
      unchanged: 0,
      conflictingSequences: [],
    };
    if (candidates.length === 0) {
      return result;
    }

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO txline_raw_records (
        fixture_id,
        seq,
        payload_hash,
        source,
        event_id,
        source_timestamp,
        received_at,
        payload_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const promoteDuplicateSource = this.db.prepare(`
      UPDATE txline_raw_records
      SET source = ?,
          event_id = COALESCE(?, event_id),
          source_timestamp = COALESCE(?, source_timestamp),
          received_at = ?
      WHERE fixture_id = ? AND seq = ? AND payload_hash = ? AND source = 'snapshot'
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const candidate of candidates) {
        const inserted = insert.run(
          candidate.fixtureId,
          candidate.seq,
          candidate.payloadHash,
          candidate.source,
          candidate.eventId ?? null,
          candidate.sourceTimestamp ?? null,
          candidate.receivedAt,
          candidate.payloadJson,
        );
        if (Number(inserted.changes ?? 0) > 0) {
          result.inserted += 1;
        } else {
          result.unchanged += 1;
          if (candidate.source === 'historical') {
            promoteDuplicateSource.run(
              candidate.source,
              candidate.eventId ?? null,
              candidate.sourceTimestamp ?? null,
              candidate.receivedAt,
              candidate.fixtureId,
              candidate.seq,
              candidate.payloadHash,
            );
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const fixtureIds = [...new Set(candidates.map((candidate) => candidate.fixtureId))];
    const conflicts = new Set<number>();
    const selectConflicts = this.db.prepare(`
      SELECT seq
      FROM txline_raw_records
      WHERE fixture_id = ?
      GROUP BY seq
      HAVING COUNT(*) > 1
      ORDER BY seq ASC
    `);
    for (const fixtureId of fixtureIds) {
      for (const row of selectConflicts.all(fixtureId) as { seq: number }[]) {
        conflicts.add(row.seq);
      }
    }
    result.conflictingSequences = [...conflicts].sort((left, right) => left - right);
    return result;
  }

  async listRawCandidates(
    fixtureId: string,
    afterSeq = -1,
  ): Promise<readonly RawLedgerCandidate[]> {
    const rows = this.db.prepare(`
      SELECT
        fixture_id,
        seq,
        payload_hash,
        source,
        event_id,
        source_timestamp,
        received_at,
        payload_json
      FROM txline_raw_records
      WHERE fixture_id = ? AND seq > ?
      ORDER BY seq ASC, payload_hash ASC
    `).all(fixtureId, afterSeq) as RawCandidateRow[];

    return rows.map((row) => ({
      fixtureId: row.fixture_id,
      seq: row.seq,
      payloadHash: row.payload_hash,
      source: row.source,
      eventId: row.event_id ?? undefined,
      sourceTimestamp: row.source_timestamp ?? undefined,
      receivedAt: row.received_at,
      payloadJson: row.payload_json,
    }));
  }

  async listFixtureIds(): Promise<readonly string[]> {
    const rows = this.db.prepare(`
      SELECT fixture_id FROM txline_raw_records
      UNION
      SELECT fixture_id FROM txline_ingestion_cursors
      ORDER BY fixture_id ASC
    `).all() as { fixture_id: string }[];
    return rows.map((row) => row.fixture_id);
  }

  async getCursor(fixtureId: string): Promise<IngestionCursor | undefined> {
    const row = this.db.prepare(`
      SELECT
        fixture_id,
        last_seen_seq,
        last_event_id,
        last_backfilled_interval,
        timeline_start_seq,
        timeline_complete,
        session_status,
        last_error,
        updated_at
      FROM txline_ingestion_cursors
      WHERE fixture_id = ?
    `).get(fixtureId) as CursorRow | undefined;

    return row ? {
      fixtureId: row.fixture_id,
      lastSeenSeq: row.last_seen_seq,
      ...(row.last_event_id === null ? {} : { lastEventId: row.last_event_id }),
      ...(row.last_backfilled_interval === null
        ? {}
        : { lastBackfilledInterval: row.last_backfilled_interval }),
      ...(row.timeline_start_seq === null ? {} : { timelineStartSeq: row.timeline_start_seq }),
      ...(row.timeline_complete === null ? {} : { timelineComplete: row.timeline_complete === 1 }),
      ...(row.session_status === null ? {} : { sessionStatus: row.session_status }),
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      updatedAt: row.updated_at,
    } : undefined;
  }

  async listCursors(): Promise<readonly IngestionCursor[]> {
    const rows = this.db.prepare(`
      SELECT fixture_id, last_seen_seq, last_event_id, last_backfilled_interval,
        timeline_start_seq, timeline_complete,
        session_status, last_error, updated_at
      FROM txline_ingestion_cursors
      ORDER BY fixture_id ASC
    `).all() as CursorRow[];
    return rows.map((row) => ({
      fixtureId: row.fixture_id,
      lastSeenSeq: row.last_seen_seq,
      ...(row.last_event_id === null ? {} : { lastEventId: row.last_event_id }),
      ...(row.last_backfilled_interval === null ? {} : { lastBackfilledInterval: row.last_backfilled_interval }),
      ...(row.timeline_start_seq === null ? {} : { timelineStartSeq: row.timeline_start_seq }),
      ...(row.timeline_complete === null ? {} : { timelineComplete: row.timeline_complete === 1 }),
      ...(row.session_status === null ? {} : { sessionStatus: row.session_status }),
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      updatedAt: row.updated_at,
    }));
  }

  async saveCursor(cursor: IngestionCursor): Promise<void> {
    this.db.prepare(`
      INSERT INTO txline_ingestion_cursors (
        fixture_id,
        last_seen_seq,
        last_event_id,
        last_backfilled_interval,
        timeline_start_seq,
        timeline_complete,
        session_status,
        last_error,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fixture_id) DO UPDATE SET
        last_seen_seq = MAX(txline_ingestion_cursors.last_seen_seq, excluded.last_seen_seq),
        last_event_id = CASE
          WHEN excluded.last_seen_seq >= txline_ingestion_cursors.last_seen_seq
            THEN COALESCE(excluded.last_event_id, txline_ingestion_cursors.last_event_id)
          ELSE txline_ingestion_cursors.last_event_id
        END,
        last_backfilled_interval = COALESCE(
          excluded.last_backfilled_interval,
          txline_ingestion_cursors.last_backfilled_interval
        ),
        timeline_start_seq = COALESCE(
          excluded.timeline_start_seq,
          txline_ingestion_cursors.timeline_start_seq
        ),
        timeline_complete = COALESCE(
          excluded.timeline_complete,
          txline_ingestion_cursors.timeline_complete
        ),
        session_status = excluded.session_status,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      cursor.fixtureId,
      cursor.lastSeenSeq,
      cursor.lastEventId ?? null,
      cursor.lastBackfilledInterval ?? null,
      cursor.timelineStartSeq ?? null,
      cursor.timelineComplete === undefined ? null : Number(cursor.timelineComplete),
      cursor.sessionStatus ?? null,
      cursor.lastError ?? null,
      cursor.updatedAt,
    );
  }

  async clearCursorEventId(fixtureId: string): Promise<void> {
    this.db.prepare(`
      UPDATE txline_ingestion_cursors
      SET last_event_id = NULL
      WHERE fixture_id = ?
    `).run(fixtureId);
  }

  async promoteToCompleteTimeline(
    fixtureId: string,
    updatedAt: string,
    historical: readonly RawLedgerCandidateInput[],
  ): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO txline_raw_records (
          fixture_id, seq, payload_hash, source, event_id,
          source_timestamp, received_at, payload_json
        ) VALUES (?, ?, ?, 'historical', ?, ?, ?, ?)
      `);
      const promoteSnapshot = this.db.prepare(`
        UPDATE txline_raw_records
        SET source = 'historical',
            event_id = COALESCE(?, event_id),
            source_timestamp = COALESCE(?, source_timestamp),
            received_at = ?
        WHERE fixture_id = ? AND seq = ? AND payload_hash = ? AND source = 'snapshot'
      `);
      for (const candidate of historical) {
        insert.run(
          candidate.fixtureId,
          candidate.seq,
          candidate.payloadHash,
          candidate.eventId ?? null,
          candidate.sourceTimestamp ?? null,
          candidate.receivedAt,
          candidate.payloadJson,
        );
        promoteSnapshot.run(
          candidate.eventId ?? null,
          candidate.sourceTimestamp ?? null,
          candidate.receivedAt,
          candidate.fixtureId,
          candidate.seq,
          candidate.payloadHash,
        );
      }
      this.db.prepare(`
        UPDATE txline_ingestion_cursors
        SET last_seen_seq = -1,
            timeline_start_seq = 0,
            timeline_complete = 1,
            session_status = 'promotion_pending',
            last_error = NULL,
            updated_at = ?
        WHERE fixture_id = ?
      `).run(updatedAt, fixtureId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async getCheckpoint(
    fixtureId: string,
    engineVersion?: string,
  ): Promise<EngineCheckpoint | undefined> {
    const row = (engineVersion
      ? this.db.prepare(`
          SELECT *
          FROM match_engine_checkpoints
          WHERE fixture_id = ? AND engine_version = ?
        `).get(fixtureId, engineVersion)
      : this.db.prepare(`
          SELECT *
          FROM match_engine_checkpoints
          WHERE fixture_id = ?
          ORDER BY updated_at DESC, engine_version DESC
          LIMIT 1
        `).get(fixtureId)) as CheckpointRow | undefined;

    return row ? checkpointFromRow(row) : undefined;
  }

  async commitProjection(commit: ProjectionCommit): Promise<void> {
    const committedAt = commit.committedAt ?? commit.checkpoint.updatedAt;
    const checkpointJson = JSON.stringify(commit.checkpoint.state);
    const serializedFrames = commit.frames.map((frame) => ({
      frame,
      json: JSON.stringify(frame),
    }));
    const upsertFrame = this.db.prepare(`
      INSERT INTO match_engine_frames (
        fixture_id,
        engine_version,
        seq,
        state_revision,
        frame_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(fixture_id, engine_version, seq) DO UPDATE SET
        state_revision = excluded.state_revision,
        frame_json = excluded.frame_json,
        created_at = excluded.created_at
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const currentCheckpoint = this.db.prepare(`
        SELECT state_revision, state_hash, projection_generation
        FROM match_engine_checkpoints
        WHERE fixture_id = ? AND engine_version = ?
      `).get(
        commit.checkpoint.fixtureId,
        commit.checkpoint.engineVersion,
      ) as Pick<CheckpointRow, 'state_revision' | 'state_hash' | 'projection_generation'> | undefined;
      const expected = commit.expectedCheckpoint;
      const matchesExpected = expected
        ? currentCheckpoint?.state_revision === expected.stateRevision
          && currentCheckpoint.state_hash === expected.stateHash
          && currentCheckpoint.projection_generation === expected.projectionGeneration
        : currentCheckpoint === undefined;
      if (!matchesExpected) {
        throw new Error(
          `Stale match-engine projection for fixture ${commit.checkpoint.fixtureId}; checkpoint changed before commit.`,
        );
      }

      if (commit.replaceFrames) {
        this.db.prepare(`
          DELETE FROM match_engine_frames
          WHERE fixture_id = ? AND engine_version = ?
        `).run(commit.checkpoint.fixtureId, commit.checkpoint.engineVersion);
      }

      for (const serialized of serializedFrames) {
        upsertFrame.run(
          commit.checkpoint.fixtureId,
          commit.checkpoint.engineVersion,
          serialized.frame.seq,
          serialized.frame.stateRevision,
          serialized.json,
          committedAt,
        );
      }

      this.db.prepare(`
        INSERT INTO match_engine_checkpoints (
          fixture_id,
          engine_version,
          last_applied_seq,
          state_revision,
          state_hash,
          conflict_hash,
          projection_generation,
          phase,
          finalised_at,
          state_json,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fixture_id, engine_version) DO UPDATE SET
          last_applied_seq = excluded.last_applied_seq,
          state_revision = excluded.state_revision,
          state_hash = excluded.state_hash,
          conflict_hash = excluded.conflict_hash,
          projection_generation = excluded.projection_generation,
          phase = excluded.phase,
          finalised_at = excluded.finalised_at,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `).run(
        commit.checkpoint.fixtureId,
        commit.checkpoint.engineVersion,
        commit.checkpoint.lastAppliedSeq,
        commit.checkpoint.stateRevision,
        commit.checkpoint.stateHash,
        commit.checkpoint.conflictHash,
        commit.checkpoint.projectionGeneration,
        commit.checkpoint.phase,
        commit.checkpoint.finalisedAt ?? null,
        checkpointJson,
        commit.checkpoint.updatedAt,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async listFramesAfter(
    fixtureId: string,
    stateRevision: number,
    engineVersion?: string,
  ): Promise<readonly StoredSemanticFrame[]> {
    const selectedVersion = engineVersion ?? (await this.getCheckpoint(fixtureId))?.engineVersion;
    if (!selectedVersion) {
      return [];
    }

    const rows = this.db.prepare(`
      SELECT
        fixture_id,
        engine_version,
        seq,
        state_revision,
        frame_json,
        created_at
      FROM match_engine_frames
      WHERE fixture_id = ?
        AND engine_version = ?
        AND state_revision > ?
      ORDER BY state_revision ASC, seq ASC
    `).all(fixtureId, selectedVersion, stateRevision) as FrameRow[];

    return rows.map((row) => ({
      fixtureId: row.fixture_id,
      engineVersion: row.engine_version,
      seq: row.seq,
      stateRevision: row.state_revision,
      frame: JSON.parse(row.frame_json) as SemanticFrame,
      createdAt: row.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function checkpointFromRow(row: CheckpointRow): EngineCheckpoint {
  return {
    fixtureId: row.fixture_id,
    engineVersion: row.engine_version,
    lastAppliedSeq: row.last_applied_seq,
    stateRevision: row.state_revision,
    stateHash: row.state_hash,
    conflictHash: row.conflict_hash,
    projectionGeneration: row.projection_generation,
    phase: row.phase,
    ...(row.finalised_at === null ? {} : { finalisedAt: row.finalised_at }),
    state: JSON.parse(row.state_json) as EngineCheckpoint['state'],
    updatedAt: row.updated_at,
  };
}
