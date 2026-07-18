import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/**
 * Persistence for generated commentary text-to-speech audio (see
 * docs/qa/commentary-tts-backend-test-cases.md, "STORE"). One row per
 * `MatchPulseCommentaryEntry.id`; overwritten in place when the voiced text
 * or voice changes so re-running the generator never accumulates stale
 * duplicates.
 *
 * Mirrors the `SqliteEconomyStore` / `SqliteMatchPulseCommentaryStore`
 * pattern: `node:sqlite` DatabaseSync, idempotent `CREATE TABLE IF NOT
 * EXISTS`, and prepared statements.
 */

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

export interface UpsertCommentaryAudioInput {
  entryId: string;
  fixtureId: string;
  voiceId: string;
  speed: number;
  textHash: string;
  sourceText: string;
  codec: string;
  sampleRate: number;
  bitRate: number;
  byteLength: number;
  audio: Uint8Array;
}

export interface CommentaryAudioRecord {
  entryId: string;
  fixtureId: string;
  voiceId: string;
  speed: number;
  textHash: string;
  sourceText: string;
  codec: string;
  sampleRate: number;
  bitRate: number;
  byteLength: number;
  audio: Uint8Array;
  createdAt: string;
  updatedAt: string;
}

export type CommentaryAudioManifestEntry = Omit<CommentaryAudioRecord, 'audio'>;

interface CommentaryAudioRow {
  entry_id: string;
  fixture_id: string;
  voice_id: string;
  speed: number;
  text_hash: string;
  source_text: string;
  codec: string;
  sample_rate: number;
  bit_rate: number;
  byte_length: number;
  audio: Uint8Array;
  created_at: string;
  updated_at: string;
}

type CommentaryAudioManifestRow = Omit<CommentaryAudioRow, 'audio'>;

export class SqliteCommentaryAudioStore {
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
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS match_pulse_commentary_audio (
        entry_id TEXT PRIMARY KEY,
        fixture_id TEXT NOT NULL,
        voice_id TEXT NOT NULL,
        speed REAL NOT NULL,
        text_hash TEXT NOT NULL,
        source_text TEXT NOT NULL,
        codec TEXT NOT NULL,
        sample_rate INTEGER NOT NULL,
        bit_rate INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        audio BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_match_pulse_commentary_audio_fixture
        ON match_pulse_commentary_audio (fixture_id);
    `);
  }

  /** Overwrites any existing row for `entryId` in place; never appends a duplicate. */
  upsertAudio(input: UpsertCommentaryAudioInput): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO match_pulse_commentary_audio (
        entry_id, fixture_id, voice_id, speed, text_hash, source_text,
        codec, sample_rate, bit_rate, byte_length, audio, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        fixture_id = excluded.fixture_id,
        voice_id = excluded.voice_id,
        speed = excluded.speed,
        text_hash = excluded.text_hash,
        source_text = excluded.source_text,
        codec = excluded.codec,
        sample_rate = excluded.sample_rate,
        bit_rate = excluded.bit_rate,
        byte_length = excluded.byte_length,
        audio = excluded.audio,
        updated_at = excluded.updated_at
    `).run(
      input.entryId,
      input.fixtureId,
      input.voiceId,
      input.speed,
      input.textHash,
      input.sourceText,
      input.codec,
      input.sampleRate,
      input.bitRate,
      input.byteLength,
      input.audio,
      now,
      now,
    );
  }

  getAudio(entryId: string): CommentaryAudioRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM match_pulse_commentary_audio WHERE entry_id = ?
    `).get(entryId) as CommentaryAudioRow | undefined;
    return row ? recordFromRow(row) : undefined;
  }

  /**
   * Manifest rows never include the audio blob (STORE-005). Ordering matches
   * the caller-supplied commentary replay order (STORE-007): callers pass
   * the fixture's `MatchPulseCommentaryEntry[]` (already in replay/sortSeq
   * order) and this method re-orders the audio rows to match it rather than
   * relying on insertion or entryId order.
   */
  listManifest(
    fixtureId: string,
    entryOrder?: readonly string[],
  ): readonly CommentaryAudioManifestEntry[] {
    const rows = this.db.prepare(`
      SELECT entry_id, fixture_id, voice_id, speed, text_hash, source_text,
             codec, sample_rate, bit_rate, byte_length, created_at, updated_at
      FROM match_pulse_commentary_audio
      WHERE fixture_id = ?
    `).all(fixtureId) as CommentaryAudioManifestRow[];

    if (!entryOrder) return rows.map(manifestFromRow);

    const byId = new Map(rows.map((row) => [row.entry_id, row]));
    const ordered: CommentaryAudioManifestEntry[] = [];
    for (const entryId of entryOrder) {
      const row = byId.get(entryId);
      if (row) {
        ordered.push(manifestFromRow(row));
        byId.delete(entryId);
      }
    }
    // Any audio rows whose entryId wasn't present in entryOrder (e.g. stale
    // audio for an entry the commentary store no longer knows about) are
    // appended after the ordered set so nothing silently disappears.
    for (const row of byId.values()) ordered.push(manifestFromRow(row));
    return ordered;
  }

  hasCurrentAudio(entryId: string, textHash: string, voiceId: string, speed: number): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM match_pulse_commentary_audio
      WHERE entry_id = ? AND text_hash = ? AND voice_id = ? AND speed = ?
    `).get(entryId, textHash, voiceId, speed);
    return row !== undefined;
  }

  close(): void {
    this.db.close();
  }
}

function recordFromRow(row: CommentaryAudioRow): CommentaryAudioRecord {
  return {
    entryId: row.entry_id,
    fixtureId: row.fixture_id,
    voiceId: row.voice_id,
    speed: row.speed,
    textHash: row.text_hash,
    sourceText: row.source_text,
    codec: row.codec,
    sampleRate: row.sample_rate,
    bitRate: row.bit_rate,
    byteLength: row.byte_length,
    audio: new Uint8Array(row.audio),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function manifestFromRow(row: CommentaryAudioManifestRow): CommentaryAudioManifestEntry {
  return {
    entryId: row.entry_id,
    fixtureId: row.fixture_id,
    voiceId: row.voice_id,
    speed: row.speed,
    textHash: row.text_hash,
    sourceText: row.source_text,
    codec: row.codec,
    sampleRate: row.sample_rate,
    bitRate: row.bit_rate,
    byteLength: row.byte_length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
