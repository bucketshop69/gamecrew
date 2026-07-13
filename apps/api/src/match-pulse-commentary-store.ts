import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { MatchPulseCommentaryEntry } from '@gamecrew/core';

export type MatchPulseCommentaryStoreDriver = 'file' | 'sqlite';

export interface MatchPulseCommentaryStore {
  listEntries(fixtureId: string): Promise<readonly MatchPulseCommentaryEntry[]>;
  getProjectionSnapshot(fixtureId: string): Promise<MatchPulseCommentaryProjectionSnapshot>;
  upsertEntries(entries: readonly MatchPulseCommentaryEntry[]): Promise<MatchPulseCommentaryUpsertResult>;
  getProjectionCursor(fixtureId: string): Promise<MatchPulseCommentaryProjectionCursor | undefined>;
  commitEngineProjection(
    fixtureId: string,
    projectionGeneration: number,
    lastStateRevision: number,
    entries: readonly MatchPulseCommentaryEntry[],
    options?: {
      replace?: boolean;
      expectedCursor?: Pick<MatchPulseCommentaryProjectionCursor, 'projectionGeneration' | 'lastStateRevision'>;
    },
  ): Promise<MatchPulseCommentaryCommitResult>;
  claimEnrichmentBatch(
    fixtureId: string,
    owner: string,
    limit: number,
    leaseMs: number,
    now?: number,
  ): Promise<MatchPulseCommentaryEnrichmentClaim | undefined>;
  renewEnrichmentClaim(
    claim: MatchPulseCommentaryEnrichmentClaim,
    leaseMs: number,
    now?: number,
  ): Promise<boolean>;
  releaseEnrichmentClaim(
    claim: MatchPulseCommentaryEnrichmentClaim,
    outcome: 'complete' | 'terminal' | 'retry',
    retryAt?: number,
  ): Promise<void>;
}

export interface MatchPulseCommentaryEnrichmentClaim {
  fixtureId: string;
  owner: string;
  entries: readonly MatchPulseCommentaryEntry[];
  cursor: MatchPulseCommentaryProjectionCursor;
  attempt: number;
}

export interface MatchPulseCommentaryProjectionCursor {
  fixtureId: string;
  projectionGeneration: number;
  lastStateRevision: number;
}

export interface MatchPulseCommentaryProjectionSnapshot {
  entries: readonly MatchPulseCommentaryEntry[];
  cursor?: MatchPulseCommentaryProjectionCursor;
}

export interface MatchPulseCommentaryUpsertResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface MatchPulseCommentaryCommitResult extends MatchPulseCommentaryUpsertResult {
  /** False when cursor CAS/staleness rejected the projection without mutation. */
  applied: boolean;
}

interface PersistedCommentaryStore {
  entries: readonly MatchPulseCommentaryEntry[];
  projectionCursors?: readonly MatchPulseCommentaryProjectionCursor[];
  enrichmentJobs?: readonly PersistedEnrichmentJob[];
}

interface PersistedEnrichmentJob {
  entryId: string;
  status: 'pending' | 'in_progress' | 'terminal';
  owner?: string;
  leaseUntil?: number;
  attempts: number;
  nextAttemptAt: number;
}

export interface CreateMatchPulseCommentaryStoreOptions {
  driver: MatchPulseCommentaryStoreDriver;
  filePath: string;
  sqlitePath: string;
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

export class FileMatchPulseCommentaryStore implements MatchPulseCommentaryStore {
  private loaded = false;
  private loadPromise?: Promise<void>;
  private readonly entriesById = new Map<string, MatchPulseCommentaryEntry>();
  private writeQueue: Promise<void> = Promise.resolve();
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly projectionCursors = new Map<string, MatchPulseCommentaryProjectionCursor>();
  private readonly enrichmentJobs = new Map<string, PersistedEnrichmentJob>();

  constructor(private readonly path: string) {}

  async listEntries(fixtureId: string): Promise<readonly MatchPulseCommentaryEntry[]> {
    await this.load();
    return [...this.entriesById.values()]
      .filter((entry) => entry.fixtureId === fixtureId)
      .sort(compareEntriesNewestFirst);
  }

  async getProjectionSnapshot(fixtureId: string): Promise<MatchPulseCommentaryProjectionSnapshot> {
    await this.load();
    return this.withMutation(async () => ({
      entries: [...this.entriesById.values()]
        .filter((entry) => entry.fixtureId === fixtureId)
        .sort(compareEntriesNewestFirst),
      cursor: this.projectionCursors.get(fixtureId),
    }));
  }

  async upsertEntries(entries: readonly MatchPulseCommentaryEntry[]): Promise<MatchPulseCommentaryUpsertResult> {
    await this.load();
    return this.withMutation(async () => {
      const result = this.applyUpserts(entries);
      if (result.inserted > 0 || result.updated > 0) await this.persist();
      return result;
    });
  }

  private applyUpserts(entries: readonly MatchPulseCommentaryEntry[]): MatchPulseCommentaryUpsertResult {
    const result: MatchPulseCommentaryUpsertResult = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
    };

    for (const entry of entries) {
      const activeProjection = this.projectionCursors.get(entry.fixtureId);
      if (
        entry.projectionGeneration !== undefined
        && activeProjection
        && entry.projectionGeneration !== activeProjection.projectionGeneration
      ) {
        result.unchanged += 1;
        continue;
      }
      const existing = this.entriesById.get(entry.id);
      if (!existing) {
        this.entriesById.set(entry.id, entry);
        result.inserted += 1;
        continue;
      }

      if (JSON.stringify(existing) === JSON.stringify(entry)) {
        result.unchanged += 1;
        continue;
      }

      const merged = mergeEntry(existing, entry);
      if (JSON.stringify(existing) === JSON.stringify(merged)) {
        result.unchanged += 1;
        continue;
      }

      this.entriesById.set(entry.id, merged);
      result.updated += 1;
    }

    return result;
  }

  async getProjectionCursor(fixtureId: string): Promise<MatchPulseCommentaryProjectionCursor | undefined> {
    await this.load();
    return this.projectionCursors.get(fixtureId);
  }

  async commitEngineProjection(
    fixtureId: string,
    projectionGeneration: number,
    lastStateRevision: number,
    entries: readonly MatchPulseCommentaryEntry[],
    options: {
      replace?: boolean;
      expectedCursor?: Pick<MatchPulseCommentaryProjectionCursor, 'projectionGeneration' | 'lastStateRevision'>;
    } = {},
  ): Promise<MatchPulseCommentaryCommitResult> {
    await this.load();
    return this.withMutation(async () => {
      const current = this.projectionCursors.get(fixtureId);
      if (
        options.expectedCursor
        && (
          current?.projectionGeneration !== options.expectedCursor.projectionGeneration
          || current?.lastStateRevision !== options.expectedCursor.lastStateRevision
        )
      ) {
        return { inserted: 0, updated: 0, unchanged: entries.length, applied: false };
      }
      if (current && (
        projectionGeneration < current.projectionGeneration
        || (projectionGeneration === current.projectionGeneration && lastStateRevision < current.lastStateRevision)
      )) {
        return { inserted: 0, updated: 0, unchanged: entries.length, applied: false };
      }
      const replacing = Boolean(options.replace || (current && projectionGeneration > current.projectionGeneration));
      if (replacing) {
        const incomingIds = new Set(entries.map((entry) => entry.id));
        for (const [id, entry] of this.entriesById) {
          if (entry.fixtureId === fixtureId && !incomingIds.has(id)) this.entriesById.delete(id);
        }
      }
      this.projectionCursors.set(fixtureId, {
        fixtureId,
        projectionGeneration,
        lastStateRevision: current?.projectionGeneration === projectionGeneration
          ? Math.max(current.lastStateRevision, lastStateRevision)
          : lastStateRevision,
      });
      const result = this.applyUpserts(entries);
      this.syncEnrichmentJobs(fixtureId, entries, replacing);
      await this.persist();
      return { ...result, applied: true };
    });
  }

  async claimEnrichmentBatch(
    fixtureId: string, owner: string, limit: number, leaseMs: number, now = Date.now(),
  ): Promise<MatchPulseCommentaryEnrichmentClaim | undefined> {
    await this.load();
    return this.withMutation(async () => {
      const cursor = this.projectionCursors.get(fixtureId);
      if (!cursor) return undefined;
      const eligible = [...this.entriesById.values()]
        .filter((entry) => entry.fixtureId === fixtureId && entry.enrichmentStatus === 'pending')
        .sort(compareEntriesOldestFirst)
        .filter((entry) => {
          const job = this.enrichmentJobs.get(entry.id);
          return !job || (job.status === 'pending' && job.nextAttemptAt <= now)
            || (job.status === 'in_progress' && (job.leaseUntil ?? 0) <= now);
        })
        .slice(0, Math.max(1, limit));
      if (eligible.length === 0) return undefined;
      let attempt = 0;
      for (const entry of eligible) {
        const job = this.enrichmentJobs.get(entry.id);
        attempt = Math.max(attempt, (job?.attempts ?? 0) + 1);
        this.enrichmentJobs.set(entry.id, {
          entryId: entry.id, status: 'in_progress', owner,
          leaseUntil: now + leaseMs, attempts: (job?.attempts ?? 0) + 1,
          nextAttemptAt: job?.nextAttemptAt ?? 0,
        });
      }
      await this.persist();
      return { fixtureId, owner, entries: eligible, cursor, attempt };
    });
  }

  async releaseEnrichmentClaim(
    claim: MatchPulseCommentaryEnrichmentClaim,
    outcome: 'complete' | 'terminal' | 'retry',
    retryAt = Date.now(),
  ): Promise<void> {
    await this.load();
    await this.withMutation(async () => {
      for (const entry of claim.entries) {
        const job = this.enrichmentJobs.get(entry.id);
        if (job?.owner !== claim.owner || job.status !== 'in_progress') continue;
        if (outcome === 'complete') this.enrichmentJobs.delete(entry.id);
        else this.enrichmentJobs.set(entry.id, {
          ...job, status: outcome === 'terminal' ? 'terminal' : 'pending',
          owner: undefined, leaseUntil: undefined,
          nextAttemptAt: outcome === 'retry' ? retryAt : Number.MAX_SAFE_INTEGER,
        });
      }
      await this.persist();
    });
  }

  async renewEnrichmentClaim(
    claim: MatchPulseCommentaryEnrichmentClaim,
    leaseMs: number,
    now = Date.now(),
  ): Promise<boolean> {
    await this.load();
    return this.withMutation(async () => {
      const jobs = claim.entries.map((entry) => this.enrichmentJobs.get(entry.id));
      if (jobs.some((job) => job?.owner !== claim.owner || job.status !== 'in_progress')) return false;
      for (const [index, entry] of claim.entries.entries()) {
        this.enrichmentJobs.set(entry.id, { ...jobs[index]!, leaseUntil: now + leaseMs });
      }
      await this.persist();
      return true;
    });
  }

  private syncEnrichmentJobs(
    fixtureId: string, entries: readonly MatchPulseCommentaryEntry[], pruneMissing = false,
  ): void {
    const ids = new Set(entries.map((entry) => entry.id));
    if (pruneMissing) for (const [id, job] of this.enrichmentJobs) {
      const entry = this.entriesById.get(id);
      if (!entry || (entry.fixtureId === fixtureId && !ids.has(id))) this.enrichmentJobs.delete(job.entryId);
    }
    for (const entry of entries) {
      if (entry.enrichmentStatus === 'pending' && !this.enrichmentJobs.has(entry.id)) {
        this.enrichmentJobs.set(entry.id, { entryId: entry.id, status: 'pending', attempts: 0, nextAttemptAt: 0 });
      } else if (entry.enrichmentStatus !== 'pending') this.enrichmentJobs.delete(entry.id);
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutationQueue = this.mutationQueue.catch(() => undefined).then(async () => {
      try {
        resolveResult(await operation());
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.loadOnce();
    await this.loadPromise;
  }

  private async loadOnce(): Promise<void> {
    try {
      const payload = JSON.parse(await readFile(this.path, 'utf8')) as Partial<PersistedCommentaryStore>;
      for (const entry of payload.entries ?? []) {
        this.entriesById.set(entry.id, entry);
      }
      for (const cursor of payload.projectionCursors ?? []) {
        this.projectionCursors.set(cursor.fixtureId, cursor);
      }
      for (const job of payload.enrichmentJobs ?? []) this.enrichmentJobs.set(job.entryId, job);
      let repairedTerminalEntry = false;
      for (const job of this.enrichmentJobs.values()) {
        const entry = this.entriesById.get(job.entryId);
        if (job.status === 'terminal' && entry?.enrichmentStatus === 'pending') {
          this.entriesById.set(entry.id, { ...entry, enrichmentStatus: 'failed' });
          repairedTerminalEntry = true;
        }
      }
      if (repairedTerminalEntry) await this.persist();
    } catch {
      // Missing or invalid local store should not block live fallback generation.
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const payload: PersistedCommentaryStore = {
      entries: [...this.entriesById.values()].sort(compareEntriesOldestFirst),
      projectionCursors: [...this.projectionCursors.values()],
      enrichmentJobs: [...this.enrichmentJobs.values()],
    };
    const targetPath = resolve(this.path);
    const tempPath = `${targetPath}.tmp`;

    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
      await rename(tempPath, targetPath);
    });

    await this.writeQueue;
  }
}

interface CommentaryEntryRow {
  entry_json: string;
  attempts?: number;
}

export class SqliteMatchPulseCommentaryStore implements MatchPulseCommentaryStore {
  private readonly db: SqliteDatabase;

  constructor(private readonly path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    }

    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS match_pulse_commentary_entries (
        id TEXT PRIMARY KEY,
        fixture_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        from_seq INTEGER,
        to_seq INTEGER,
        sort_seq INTEGER,
        sort_timestamp TEXT,
        clock_seconds INTEGER,
        clock_label TEXT,
        kind TEXT NOT NULL,
        team_id TEXT,
        generation TEXT NOT NULL,
        enrichment_status TEXT NOT NULL,
        source_event_count INTEGER NOT NULL,
        entry_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_match_pulse_commentary_fixture_order
        ON match_pulse_commentary_entries (
          fixture_id,
          sort_seq DESC,
          sort_timestamp DESC,
          clock_seconds DESC
        );

      CREATE INDEX IF NOT EXISTS idx_match_pulse_commentary_fixture_batch
        ON match_pulse_commentary_entries (fixture_id, batch_id);

      CREATE INDEX IF NOT EXISTS idx_match_pulse_commentary_enrichment
        ON match_pulse_commentary_entries (fixture_id, enrichment_status);

      CREATE TABLE IF NOT EXISTS match_pulse_commentary_projections (
        fixture_id TEXT PRIMARY KEY,
        projection_generation INTEGER NOT NULL,
        last_state_revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS match_pulse_commentary_enrichment_jobs (
        entry_id TEXT PRIMARY KEY,
        fixture_id TEXT NOT NULL,
        status TEXT NOT NULL,
        owner TEXT,
        lease_until INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(entry_id) REFERENCES match_pulse_commentary_entries(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_commentary_enrichment_claim
        ON match_pulse_commentary_enrichment_jobs (fixture_id, status, next_attempt_at, lease_until);
    `);
    this.db.exec(`
      UPDATE match_pulse_commentary_entries
      SET enrichment_status = 'failed',
          entry_json = json_set(entry_json, '$.enrichmentStatus', 'failed'),
          updated_at = datetime('now')
      WHERE enrichment_status = 'pending'
        AND id IN (
          SELECT entry_id
          FROM match_pulse_commentary_enrichment_jobs
          WHERE status = 'terminal'
        );
    `);
  }

  async listEntries(fixtureId: string): Promise<readonly MatchPulseCommentaryEntry[]> {
    return this.listEntriesSync(fixtureId);
  }

  async getProjectionSnapshot(fixtureId: string): Promise<MatchPulseCommentaryProjectionSnapshot> {
    this.db.exec('BEGIN');
    try {
      const snapshot = {
        entries: this.listEntriesSync(fixtureId),
        cursor: this.getProjectionCursorSync(fixtureId),
      };
      this.db.exec('COMMIT');
      return snapshot;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private listEntriesSync(fixtureId: string): readonly MatchPulseCommentaryEntry[] {
    const rows = this.db.prepare(`
      SELECT entry_json
      FROM match_pulse_commentary_entries
      WHERE fixture_id = ?
      ORDER BY
        sort_seq DESC,
        sort_timestamp DESC,
        clock_seconds DESC,
        id DESC
    `).all(fixtureId) as CommentaryEntryRow[];

    return rows.map((row) => parseEntryJson(row.entry_json));
  }

  async upsertEntries(entries: readonly MatchPulseCommentaryEntry[]): Promise<MatchPulseCommentaryUpsertResult> {
    const result: MatchPulseCommentaryUpsertResult = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
    };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        const activeProjection = this.getProjectionCursorSync(entry.fixtureId);
        if (
          entry.projectionGeneration !== undefined
          && activeProjection
          && entry.projectionGeneration !== activeProjection.projectionGeneration
        ) {
          result.unchanged += 1;
          continue;
        }
        const existing = this.getEntry(entry.id);
        if (!existing) {
          this.insertEntry(entry, new Date().toISOString());
          result.inserted += 1;
          continue;
        }

        if (JSON.stringify(existing) === JSON.stringify(entry)) {
          result.unchanged += 1;
          continue;
        }

        const merged = mergeEntry(existing, entry);
        if (JSON.stringify(existing) === JSON.stringify(merged)) {
          result.unchanged += 1;
          continue;
        }

        this.updateEntry(merged, new Date().toISOString());
        result.updated += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return result;
  }

  async claimEnrichmentBatch(
    fixtureId: string, owner: string, limit: number, leaseMs: number, now = Date.now(),
  ): Promise<MatchPulseCommentaryEnrichmentClaim | undefined> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cursor = this.getProjectionCursorSync(fixtureId);
      if (!cursor) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const rows = this.db.prepare(`
        SELECT e.entry_json, j.attempts
        FROM match_pulse_commentary_enrichment_jobs j
        JOIN match_pulse_commentary_entries e ON e.id = j.entry_id
        WHERE j.fixture_id = ?
          AND ((j.status = 'pending' AND j.next_attempt_at <= ?)
            OR (j.status = 'in_progress' AND j.lease_until <= ?))
        ORDER BY e.sort_seq, e.sort_timestamp, e.clock_seconds, e.id
        LIMIT ?
      `).all(fixtureId, now, now, Math.max(1, limit)) as CommentaryEntryRow[];
      const entries = rows.map((row) => parseEntryJson(row.entry_json));
      const attempt = rows.reduce((highest, row) => Math.max(highest, (row.attempts ?? 0) + 1), 1);
      const claim = this.db.prepare(`
        UPDATE match_pulse_commentary_enrichment_jobs
        SET status = 'in_progress', owner = ?, lease_until = ?, attempts = attempts + 1
        WHERE entry_id = ?
      `);
      for (const entry of entries) claim.run(owner, now + leaseMs, entry.id);
      this.db.exec('COMMIT');
      return entries.length > 0 ? { fixtureId, owner, entries, cursor, attempt } : undefined;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async releaseEnrichmentClaim(
    claim: MatchPulseCommentaryEnrichmentClaim,
    outcome: 'complete' | 'terminal' | 'retry',
    retryAt = Date.now(),
  ): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (outcome === 'complete') {
        const remove = this.db.prepare(`
          DELETE FROM match_pulse_commentary_enrichment_jobs
          WHERE entry_id = ? AND owner = ? AND status = 'in_progress'
        `);
        for (const entry of claim.entries) remove.run(entry.id, claim.owner);
      } else {
        const release = this.db.prepare(`
          UPDATE match_pulse_commentary_enrichment_jobs
          SET status = ?, owner = NULL, lease_until = NULL, next_attempt_at = ?
          WHERE entry_id = ? AND owner = ? AND status = 'in_progress'
        `);
        for (const entry of claim.entries) {
          release.run(outcome === 'terminal' ? 'terminal' : 'pending',
            outcome === 'terminal' ? Number.MAX_SAFE_INTEGER : retryAt, entry.id, claim.owner);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async renewEnrichmentClaim(
    claim: MatchPulseCommentaryEnrichmentClaim,
    leaseMs: number,
    now = Date.now(),
  ): Promise<boolean> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const getJob = this.db.prepare(`
        SELECT owner, status
        FROM match_pulse_commentary_enrichment_jobs
        WHERE entry_id = ?
      `);
      const owned = claim.entries.every((entry) => {
        const job = getJob.get(entry.id) as { owner?: string; status?: string } | undefined;
        return job?.owner === claim.owner && job.status === 'in_progress';
      });
      if (!owned) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const renew = this.db.prepare(`
        UPDATE match_pulse_commentary_enrichment_jobs
        SET lease_until = ?
        WHERE entry_id = ? AND owner = ? AND status = 'in_progress'
      `);
      for (const entry of claim.entries) renew.run(now + leaseMs, entry.id, claim.owner);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async getProjectionCursor(fixtureId: string): Promise<MatchPulseCommentaryProjectionCursor | undefined> {
    return this.getProjectionCursorSync(fixtureId);
  }

  private getProjectionCursorSync(fixtureId: string): MatchPulseCommentaryProjectionCursor | undefined {
    const row = this.db.prepare(`
      SELECT fixture_id, projection_generation, last_state_revision
      FROM match_pulse_commentary_projections
      WHERE fixture_id = ?
    `).get(fixtureId) as {
      fixture_id: string;
      projection_generation: number;
      last_state_revision: number;
    } | undefined;
    return row ? {
      fixtureId: row.fixture_id,
      projectionGeneration: row.projection_generation,
      lastStateRevision: row.last_state_revision,
    } : undefined;
  }

  async commitEngineProjection(
    fixtureId: string,
    projectionGeneration: number,
    lastStateRevision: number,
    entries: readonly MatchPulseCommentaryEntry[],
    options: {
      replace?: boolean;
      expectedCursor?: Pick<MatchPulseCommentaryProjectionCursor, 'projectionGeneration' | 'lastStateRevision'>;
    } = {},
  ): Promise<MatchPulseCommentaryCommitResult> {
    const result = { inserted: 0, updated: 0, unchanged: 0 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getProjectionCursorSync(fixtureId);
      if (
        options.expectedCursor
        && (
          current?.projectionGeneration !== options.expectedCursor.projectionGeneration
          || current?.lastStateRevision !== options.expectedCursor.lastStateRevision
        )
      ) {
        this.db.exec('ROLLBACK');
        return { ...result, unchanged: entries.length, applied: false };
      }
      if (current && (
        projectionGeneration < current.projectionGeneration
        || (projectionGeneration === current.projectionGeneration && lastStateRevision < current.lastStateRevision)
      )) {
        this.db.exec('ROLLBACK');
        return { ...result, unchanged: entries.length, applied: false };
      }
      const replacing = Boolean(options.replace || (current && projectionGeneration > current.projectionGeneration));
      if (replacing) {
        if (entries.length === 0) {
          this.db.prepare('DELETE FROM match_pulse_commentary_entries WHERE fixture_id = ?').run(fixtureId);
        } else {
          const incomingIds = new Set(entries.map((entry) => entry.id));
          const existingIds = this.db.prepare(
            'SELECT id FROM match_pulse_commentary_entries WHERE fixture_id = ?',
          ).all(fixtureId) as Array<{ id: string }>;
          const deleteEntry = this.db.prepare('DELETE FROM match_pulse_commentary_entries WHERE id = ?');
          for (const { id } of existingIds) {
            if (!incomingIds.has(id)) deleteEntry.run(id);
          }
        }
      }
      for (const entry of entries) {
        const existing = this.getEntry(entry.id);
        if (!existing) {
          this.insertEntry(entry, new Date().toISOString());
          result.inserted += 1;
        } else {
          const merged = mergeEntry(existing, entry);
          if (JSON.stringify(existing) === JSON.stringify(merged)) result.unchanged += 1;
          else {
            this.updateEntry(merged, new Date().toISOString());
            result.updated += 1;
          }
        }
      }
      this.db.prepare(`
        INSERT INTO match_pulse_commentary_projections (
          fixture_id, projection_generation, last_state_revision, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(fixture_id) DO UPDATE SET
          last_state_revision = CASE
            WHEN excluded.projection_generation > projection_generation
              THEN excluded.last_state_revision
            ELSE MAX(last_state_revision, excluded.last_state_revision)
          END,
          projection_generation = excluded.projection_generation,
          updated_at = excluded.updated_at
      `).run(fixtureId, projectionGeneration, lastStateRevision, new Date().toISOString());
      this.syncEnrichmentJobs(fixtureId, entries, replacing);
      this.db.exec('COMMIT');
      return { ...result, applied: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private getEntry(id: string): MatchPulseCommentaryEntry | undefined {
    const row = this.db.prepare(`
      SELECT entry_json
      FROM match_pulse_commentary_entries
      WHERE id = ?
    `).get(id) as CommentaryEntryRow | undefined;

    return row ? parseEntryJson(row.entry_json) : undefined;
  }

  private insertEntry(entry: MatchPulseCommentaryEntry, now: string): void {
    const row = entryToSqliteRow(entry);
    this.db.prepare(`
      INSERT INTO match_pulse_commentary_entries (
        id,
        fixture_id,
        batch_id,
        from_seq,
        to_seq,
        sort_seq,
        sort_timestamp,
        clock_seconds,
        clock_label,
        kind,
        team_id,
        generation,
        enrichment_status,
        source_event_count,
        entry_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.fixtureId,
      row.batchId,
      row.fromSeq,
      row.toSeq,
      row.sortSeq,
      row.sortTimestamp,
      row.clockSeconds,
      row.clockLabel,
      row.kind,
      row.teamId,
      row.generation,
      row.enrichmentStatus,
      row.sourceEventCount,
      row.entryJson,
      now,
      now,
    );
  }

  private updateEntry(entry: MatchPulseCommentaryEntry, now: string): void {
    const row = entryToSqliteRow(entry);
    this.db.prepare(`
      UPDATE match_pulse_commentary_entries
      SET
        fixture_id = ?,
        batch_id = ?,
        from_seq = ?,
        to_seq = ?,
        sort_seq = ?,
        sort_timestamp = ?,
        clock_seconds = ?,
        clock_label = ?,
        kind = ?,
        team_id = ?,
        generation = ?,
        enrichment_status = ?,
        source_event_count = ?,
        entry_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      row.fixtureId,
      row.batchId,
      row.fromSeq,
      row.toSeq,
      row.sortSeq,
      row.sortTimestamp,
      row.clockSeconds,
      row.clockLabel,
      row.kind,
      row.teamId,
      row.generation,
      row.enrichmentStatus,
      row.sourceEventCount,
      row.entryJson,
      now,
      row.id,
    );
  }

  private syncEnrichmentJobs(
    fixtureId: string, entries: readonly MatchPulseCommentaryEntry[], pruneMissing = false,
  ): void {
    const incomingIds = new Set(entries.map((entry) => entry.id));
    const jobs = this.db.prepare(
      'SELECT entry_id FROM match_pulse_commentary_enrichment_jobs WHERE fixture_id = ?',
    ).all(fixtureId) as Array<{ entry_id: string }>;
    const remove = this.db.prepare('DELETE FROM match_pulse_commentary_enrichment_jobs WHERE entry_id = ?');
    if (pruneMissing) for (const job of jobs) if (!incomingIds.has(job.entry_id)) remove.run(job.entry_id);
    const add = this.db.prepare(`
      INSERT INTO match_pulse_commentary_enrichment_jobs (
        entry_id, fixture_id, status, attempts, next_attempt_at
      ) VALUES (?, ?, 'pending', 0, 0)
      ON CONFLICT(entry_id) DO NOTHING
    `);
    for (const entry of entries) {
      if (entry.enrichmentStatus === 'pending') add.run(entry.id, fixtureId);
      else remove.run(entry.id);
    }
  }
}

export function createMatchPulseCommentaryStore(
  options: CreateMatchPulseCommentaryStoreOptions,
): MatchPulseCommentaryStore {
  if (options.driver === 'file') {
    return new FileMatchPulseCommentaryStore(options.filePath);
  }

  return new SqliteMatchPulseCommentaryStore(options.sqlitePath);
}

function mergeEntry(
  existing: MatchPulseCommentaryEntry,
  incoming: MatchPulseCommentaryEntry,
): MatchPulseCommentaryEntry {
  if (incoming.generation !== 'llm' && existing.enrichmentStatus !== 'pending') {
    return {
      ...incoming,
      commentary: existing.commentary,
      voiceLine: existing.voiceLine,
      confidence: existing.confidence,
      boardHint: existing.boardHint ?? incoming.boardHint,
      generation: existing.generation,
      enrichmentStatus: existing.enrichmentStatus,
      coveredFrameIds: existing.coveredFrameIds,
      enrichmentPromptVersion: existing.enrichmentPromptVersion,
    };
  }

  return incoming;
}

function entryToSqliteRow(entry: MatchPulseCommentaryEntry) {
  return {
    id: entry.id,
    fixtureId: entry.fixtureId,
    batchId: entry.batchId,
    fromSeq: entry.fromSeq ?? null,
    toSeq: entry.toSeq ?? null,
    sortSeq: entry.sortSeq ?? null,
    sortTimestamp: entry.sortTimestamp ?? null,
    clockSeconds: entry.clock.seconds ?? null,
    clockLabel: entry.clock.label,
    kind: entry.kind,
    teamId: entry.team?.id ?? null,
    generation: entry.generation,
    enrichmentStatus: entry.enrichmentStatus,
    sourceEventCount: entry.sourceEvents.length,
    entryJson: JSON.stringify(entry),
  };
}

function parseEntryJson(json: string): MatchPulseCommentaryEntry {
  return JSON.parse(json) as MatchPulseCommentaryEntry;
}

function compareEntriesNewestFirst(left: MatchPulseCommentaryEntry, right: MatchPulseCommentaryEntry): number {
  return compareEntriesOldestFirst(right, left);
}

function compareEntriesOldestFirst(left: MatchPulseCommentaryEntry, right: MatchPulseCommentaryEntry): number {
  return (
    (left.sortSeq ?? 0) - (right.sortSeq ?? 0) ||
    (Date.parse(left.sortTimestamp ?? '') || 0) - (Date.parse(right.sortTimestamp ?? '') || 0) ||
    getClockSeconds(left) - getClockSeconds(right)
  );
}

function getClockSeconds(entry: MatchPulseCommentaryEntry): number {
  return typeof entry.clock.seconds === 'number' ? entry.clock.seconds : -1;
}
