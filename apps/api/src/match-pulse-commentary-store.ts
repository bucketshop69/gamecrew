import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { MatchPulseCommentaryEntry } from '@gamecrew/core';

export type MatchPulseCommentaryStoreDriver = 'file' | 'sqlite';

export interface MatchPulseCommentaryStore {
  listEntries(fixtureId: string): Promise<readonly MatchPulseCommentaryEntry[]>;
  upsertEntries(entries: readonly MatchPulseCommentaryEntry[]): Promise<MatchPulseCommentaryUpsertResult>;
}

export interface MatchPulseCommentaryUpsertResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

interface PersistedCommentaryStore {
  entries: readonly MatchPulseCommentaryEntry[];
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
  private readonly entriesById = new Map<string, MatchPulseCommentaryEntry>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async listEntries(fixtureId: string): Promise<readonly MatchPulseCommentaryEntry[]> {
    await this.load();
    return [...this.entriesById.values()]
      .filter((entry) => entry.fixtureId === fixtureId)
      .sort(compareEntriesNewestFirst);
  }

  async upsertEntries(entries: readonly MatchPulseCommentaryEntry[]): Promise<MatchPulseCommentaryUpsertResult> {
    await this.load();
    const result: MatchPulseCommentaryUpsertResult = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
    };

    for (const entry of entries) {
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

    if (result.inserted > 0 || result.updated > 0) {
      await this.persist();
    }

    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const payload = JSON.parse(await readFile(this.path, 'utf8')) as Partial<PersistedCommentaryStore>;
      for (const entry of payload.entries ?? []) {
        this.entriesById.set(entry.id, entry);
      }
    } catch {
      // Missing or invalid local store should not block live fallback generation.
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const payload: PersistedCommentaryStore = {
      entries: [...this.entriesById.values()].sort(compareEntriesOldestFirst),
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
    `);
  }

  async listEntries(fixtureId: string): Promise<readonly MatchPulseCommentaryEntry[]> {
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
