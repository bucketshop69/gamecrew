import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

export type MatchPulseMaterializationStatus =
  | 'running'
  | 'prepared'
  | 'ready'
  | 'ready_with_fallback'
  | 'failed';

export interface MatchPulseMaterializationSnapshot {
  fixtureId: string;
  status: MatchPulseMaterializationStatus;
  attempt: number;
  projectionGeneration?: number;
  stateRevision?: number;
  entryCount: number;
  completeCount: number;
  fallbackCount: number;
  failedCount: number;
  pendingCount: number;
  notNeededCount: number;
  enrichmentAttempted: number;
  enrichmentCompleted: number;
  enrichmentFailed: number;
  providerCalls: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  model?: string;
  promptVersion?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
  lastError?: string;
  runId?: string;
  leaseUntil?: number;
}

export interface CompleteMatchPulseMaterializationInput {
  fixtureId: string;
  status: Extract<MatchPulseMaterializationStatus, 'prepared' | 'ready' | 'ready_with_fallback'>;
  projectionGeneration: number;
  stateRevision: number;
  entryCount: number;
  completeCount: number;
  fallbackCount: number;
  failedCount: number;
  pendingCount: number;
  notNeededCount: number;
  model?: string;
  promptVersion?: string;
  completedAt: string;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface MaterializationRow {
  fixture_id: string;
  status: MatchPulseMaterializationStatus;
  attempt: number;
  projection_generation: number | null;
  state_revision: number | null;
  entry_count: number;
  complete_count: number;
  fallback_count: number;
  failed_count: number;
  pending_count: number;
  not_needed_count: number;
  enrichment_attempted: number;
  enrichment_completed: number;
  enrichment_failed: number;
  provider_calls: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  model: string | null;
  prompt_version: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  last_error: string | null;
  run_id: string | null;
  lease_until: number | null;
}

export class MatchPulseMaterializationStore {
  private readonly db: SqliteDatabase;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (databasePath: string) => SqliteDatabase;
    };
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS match_pulse_materializations (
        fixture_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        projection_generation INTEGER,
        state_revision INTEGER,
        entry_count INTEGER NOT NULL DEFAULT 0,
        complete_count INTEGER NOT NULL DEFAULT 0,
        fallback_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        pending_count INTEGER NOT NULL DEFAULT 0,
        not_needed_count INTEGER NOT NULL DEFAULT 0,
        enrichment_attempted INTEGER NOT NULL DEFAULT 0,
        enrichment_completed INTEGER NOT NULL DEFAULT 0,
        enrichment_failed INTEGER NOT NULL DEFAULT 0,
        provider_calls INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        model TEXT,
        prompt_version TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        run_id TEXT,
        lease_until INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_match_pulse_materializations_status
        ON match_pulse_materializations (status, updated_at DESC);
    `);
    this.ensureColumn('not_needed_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('enrichment_attempted', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('enrichment_completed', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('enrichment_failed', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('run_id', 'TEXT');
    this.ensureColumn('lease_until', 'INTEGER');
  }

  async get(fixtureId: string): Promise<MatchPulseMaterializationSnapshot | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM match_pulse_materializations WHERE fixture_id = ?
    `).get(fixtureId) as MaterializationRow | undefined;
    return row ? snapshotFromRow(row) : undefined;
  }

  async list(): Promise<readonly MatchPulseMaterializationSnapshot[]> {
    const rows = this.db.prepare(`
      SELECT * FROM match_pulse_materializations ORDER BY updated_at DESC, fixture_id ASC
    `).all() as MaterializationRow[];
    return rows.map(snapshotFromRow);
  }

  async start(
    fixtureId: string,
    runId: string,
    startedAt: string,
    leaseUntil: number,
    model: string,
    promptVersion: string,
    now = Date.now(),
  ): Promise<MatchPulseMaterializationSnapshot> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`
        SELECT status, run_id, lease_until, model, prompt_version, provider_calls, enrichment_attempted
        FROM match_pulse_materializations
        WHERE fixture_id = ?
      `).get(fixtureId) as Pick<
        MaterializationRow,
        'status' | 'run_id' | 'lease_until' | 'model' | 'prompt_version' | 'provider_calls' | 'enrichment_attempted'
      > | undefined;
      if (
        existing?.status === 'running'
        && existing.run_id
        && existing.run_id !== runId
        && (existing.lease_until ?? 0) > now
      ) {
        throw new Error(`Fixture ${fixtureId} is already owned by another materialization run.`);
      }
      if (
        existing
        && (existing.provider_calls > 0 || existing.enrichment_attempted > 0)
        && (existing.model !== model || existing.prompt_version !== promptVersion)
      ) {
        throw new Error(`Fixture ${fixtureId} has partial enrichment from a different model or prompt.`);
      }
      this.db.prepare(`
        INSERT INTO match_pulse_materializations (
          fixture_id, status, attempt, started_at, updated_at, run_id, lease_until, model, prompt_version
        ) VALUES (?, 'running', 1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fixture_id) DO UPDATE SET
          status = 'running',
          attempt = match_pulse_materializations.attempt + 1,
          started_at = excluded.started_at,
          completed_at = NULL,
          updated_at = excluded.updated_at,
          last_error = NULL,
          run_id = excluded.run_id,
          lease_until = excluded.lease_until,
          model = excluded.model,
          prompt_version = excluded.prompt_version
      `).run(fixtureId, startedAt, startedAt, runId, leaseUntil, model, promptVersion);
      this.db.exec('COMMIT');
      return (await this.get(fixtureId))!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async renew(fixtureId: string, runId: string, leaseUntil: number, updatedAt: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE match_pulse_materializations
      SET lease_until = ?, updated_at = ?
      WHERE fixture_id = ? AND status = 'running' AND run_id = ?
    `).run(leaseUntil, updatedAt, fixtureId, runId) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  async recordUsage(
    fixtureId: string,
    usage: {
      attempted: number;
      completed: number;
      failed: number;
      providerCalls: number;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    },
  ): Promise<void> {
    this.db.prepare(`
      UPDATE match_pulse_materializations
      SET enrichment_attempted = enrichment_attempted + ?,
          enrichment_completed = enrichment_completed + ?,
          enrichment_failed = enrichment_failed + ?,
          provider_calls = provider_calls + ?,
          prompt_tokens = CASE WHEN ? IS NULL THEN prompt_tokens ELSE COALESCE(prompt_tokens, 0) + ? END,
          completion_tokens = CASE WHEN ? IS NULL THEN completion_tokens ELSE COALESCE(completion_tokens, 0) + ? END,
          total_tokens = CASE WHEN ? IS NULL THEN total_tokens ELSE COALESCE(total_tokens, 0) + ? END
      WHERE fixture_id = ? AND status = 'running'
    `).run(
      usage.attempted,
      usage.completed,
      usage.failed,
      usage.providerCalls,
      usage.promptTokens ?? null,
      usage.promptTokens ?? null,
      usage.completionTokens ?? null,
      usage.completionTokens ?? null,
      usage.totalTokens ?? null,
      usage.totalTokens ?? null,
      fixtureId,
    );
  }

  async complete(input: CompleteMatchPulseMaterializationInput, runId: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE match_pulse_materializations
      SET status = ?,
          projection_generation = ?,
          state_revision = ?,
          entry_count = ?,
          complete_count = ?,
          fallback_count = ?,
          failed_count = ?,
          pending_count = ?,
          not_needed_count = ?,
          model = ?,
          prompt_version = ?,
          completed_at = ?,
          updated_at = ?,
          last_error = NULL,
          lease_until = NULL
      WHERE fixture_id = ? AND status = 'running' AND run_id = ?
    `).run(
      input.status,
      input.projectionGeneration,
      input.stateRevision,
      input.entryCount,
      input.completeCount,
      input.fallbackCount,
      input.failedCount,
      input.pendingCount,
      input.notNeededCount,
      input.model ?? null,
      input.promptVersion ?? null,
      input.completedAt,
      input.completedAt,
      input.fixtureId,
      runId,
    ) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  async fail(fixtureId: string, runId: string, error: unknown, failedAt: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE match_pulse_materializations
      SET status = 'failed',
          completed_at = ?,
          updated_at = ?,
          last_error = ?,
          lease_until = NULL
      WHERE fixture_id = ? AND status = 'running' AND run_id = ?
    `).run(
      failedAt,
      failedAt,
      error instanceof Error ? error.message : String(error),
      fixtureId,
      runId,
    ) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  close(): void {
    this.db.close();
  }

  private ensureColumn(name: string, definition: string): void {
    const columns = this.db.prepare('PRAGMA table_info(match_pulse_materializations)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE match_pulse_materializations ADD COLUMN ${name} ${definition}`);
    }
  }
}

export function isPublishedMaterializationStatus(status: MatchPulseMaterializationStatus): boolean {
  return status === 'ready' || status === 'ready_with_fallback';
}

export function isMaterializationAvailable(status?: MatchPulseMaterializationStatus): boolean {
  return status === undefined || isPublishedMaterializationStatus(status);
}

function snapshotFromRow(row: MaterializationRow): MatchPulseMaterializationSnapshot {
  return {
    fixtureId: row.fixture_id,
    status: row.status,
    attempt: row.attempt,
    ...(row.projection_generation === null ? {} : { projectionGeneration: row.projection_generation }),
    ...(row.state_revision === null ? {} : { stateRevision: row.state_revision }),
    entryCount: row.entry_count,
    completeCount: row.complete_count,
    fallbackCount: row.fallback_count,
    failedCount: row.failed_count,
    pendingCount: row.pending_count,
    notNeededCount: row.not_needed_count,
    enrichmentAttempted: row.enrichment_attempted,
    enrichmentCompleted: row.enrichment_completed,
    enrichmentFailed: row.enrichment_failed,
    providerCalls: row.provider_calls,
    ...(row.prompt_tokens === null ? {} : { promptTokens: row.prompt_tokens }),
    ...(row.completion_tokens === null ? {} : { completionTokens: row.completion_tokens }),
    ...(row.total_tokens === null ? {} : { totalTokens: row.total_tokens }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.prompt_version === null ? {} : { promptVersion: row.prompt_version }),
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    updatedAt: row.updated_at,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
  };
}
