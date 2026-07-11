import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
  buildTxlineMatchPulseCommentaryEntries,
  buildTxlineMatchPulseSourceContext,
  TxlineApiClient,
  type MatchPulseCommentaryEntry,
  type TxlineFixture,
  type TxlineScore,
} from '@gamecrew/core';
import { loadConfig, type ApiConfig } from './config.js';
import {
  createMatchPulseCommentaryStore,
  type MatchPulseCommentaryStore,
  type MatchPulseCommentaryUpsertResult,
} from './match-pulse-commentary-store.js';
import { createMatchPulseEnrichmentService } from './match-pulse-llm.js';

interface ReplayCliOptions {
  awayTeam?: string;
  competition?: string;
  debugPath: string;
  fixtureId: string;
  homeTeam?: string;
  noEnrich: boolean;
  reset: boolean;
  reviewPath?: string;
  resumeWindows: number;
  tickSeconds: number;
  windowSeconds: number;
}

interface ReplayCursor {
  fixtureId: string;
  lastProcessedSeq: number;
  lastReplayElapsedSeconds: number;
  lastReplayTimestamp: number;
  selectedStartTime: number;
  updatedAt: string;
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

interface ReplayWindowSummary {
  label: string;
  fromReplayElapsedSeconds: number;
  toReplayElapsedSeconds: number;
  fromSeqExclusive: number;
  tickSeconds: number;
  rowsInWindow: number;
  confirmedRowsInWindow: number;
  commentaryEntriesBuilt: number;
  persistence: MatchPulseCommentaryUpsertResult;
  idempotency: MatchPulseCommentaryUpsertResult;
  enrichment?: {
    attempted: number;
    completed: number;
    failed: number;
    skippedReason?: string;
  };
  cursor: ReplayCursor;
  ticks: ReplayTickSummary[];
}

interface ReplayTickSummary {
  fromReplayElapsedSeconds: number;
  toReplayElapsedSeconds: number;
  fromSeqExclusive: number;
  rowsInTick: number;
  confirmedRowsInTick: number;
  commentaryEntriesBuilt: number;
  persistence: MatchPulseCommentaryUpsertResult;
  idempotency: MatchPulseCommentaryUpsertResult;
  cursor: ReplayCursor;
  sampleRows: ReplayScoreSample[];
}

interface ReplayScoreSample {
  seq: number;
  id?: string;
  action?: string;
  confirmed?: boolean;
  elapsedSeconds: number;
  timestampIso?: string;
  clockSeconds?: number;
  clockLabel?: string;
}

const defaultFixtureId = '18179759';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const sqlitePath = resolve(config.matchPulseSqlitePath);
  const store = createMatchPulseCommentaryStore({
    driver: 'sqlite',
    filePath: config.matchPulseStorePath,
    sqlitePath,
  });
  const cursorStore = new ReplayCursorStore(sqlitePath);

  if (options.reset) {
    cursorStore.resetFixture(options.fixtureId);
  }

  const fetched = await fetchReplayData(config, options.fixtureId);
  const selectedStart = selectMajorityStartTime(fetched.scores, fetched.fixture?.StartTime);
  const fixture = buildReplayFixture(options.fixtureId, selectedStart, fetched.fixture, fetched.scores, options);
  const initialCursor = cursorStore.getCursor(options.fixtureId) ?? {
    fixtureId: options.fixtureId,
    lastProcessedSeq: -1,
    lastReplayElapsedSeconds: 0,
    lastReplayTimestamp: selectedStart,
    selectedStartTime: selectedStart,
    updatedAt: new Date().toISOString(),
  };

  const summaries: ReplayWindowSummary[] = [];
  let cursor = initialCursor;
  const totalWindows = Math.max(1, options.resumeWindows + 1);
  for (let index = 0; index < totalWindows; index += 1) {
    const label = index === 0 ? 'initial' : `resume-${index}`;
    const summary = await processReplayWindow({
      config,
      cursor,
      cursorStore,
      fixture,
      label,
      options,
      scores: fetched.scores,
      store,
    });
    summaries.push(summary);
    cursor = summary.cursor;
  }

  const savedEntries = await store.listEntries(options.fixtureId);
  const debug = {
    fixtureId: options.fixtureId,
    sqlitePath,
    selectedStartTime: selectedStart,
    selectedStartTimeIso: new Date(selectedStart).toISOString(),
    fetched: {
      fixtureFound: Boolean(fetched.fixture),
      historyRows: fetched.historyScores.length,
      updateRows: fetched.updateScores.length,
      replayRows: fetched.scores.length,
      confirmedReplayRows: fetched.scores.filter((score) => score.Confirmed === true).length,
    },
    initialCursor,
    windows: summaries,
    finalCursor: cursor,
    nextResume: {
      fromSeqExclusive: cursor.lastProcessedSeq,
      fromReplayElapsedSeconds: cursor.lastReplayElapsedSeconds,
      toReplayElapsedSeconds: cursor.lastReplayElapsedSeconds + options.windowSeconds,
    },
    savedEntries: savedEntries.map(toDebugEntry),
  };

  const review = {
    fixture: {
      fixtureId: options.fixtureId,
      competition: fixture.Competition,
      home: fixture.Participant1IsHome ? fixture.Participant1 : fixture.Participant2,
      away: fixture.Participant1IsHome ? fixture.Participant2 : fixture.Participant1,
    },
    entries: [...savedEntries]
      .sort(compareEntriesOldestFirst)
      .map(toCommentaryReviewEntry),
  };

  await Promise.all([
    writeDebugJson(options.debugPath, debug),
    ...(options.reviewPath ? [writeDebugJson(options.reviewPath, review)] : []),
  ]);
  closeStoreIfSupported(store);
  cursorStore.close();

  console.log(JSON.stringify({
    fixtureId: options.fixtureId,
    sqlitePath,
    debugPath: resolve(options.debugPath),
    reviewPath: options.reviewPath ? resolve(options.reviewPath) : undefined,
    selectedStartTimeIso: debug.selectedStartTimeIso,
    fetched: debug.fetched,
    windows: summaries.map((summary) => ({
      label: summary.label,
      fromReplayElapsedSeconds: summary.fromReplayElapsedSeconds,
      toReplayElapsedSeconds: summary.toReplayElapsedSeconds,
      tickSeconds: summary.tickSeconds,
      rowsInWindow: summary.rowsInWindow,
      confirmedRowsInWindow: summary.confirmedRowsInWindow,
      commentaryEntriesBuilt: summary.commentaryEntriesBuilt,
      persistence: summary.persistence,
      idempotency: summary.idempotency,
      enrichment: summary.enrichment,
      cursor: {
        lastProcessedSeq: summary.cursor.lastProcessedSeq,
        lastReplayElapsedSeconds: summary.cursor.lastReplayElapsedSeconds,
        lastReplayTimestamp: summary.cursor.lastReplayTimestamp,
      },
      sampleRows: summary.ticks.flatMap((tick) => tick.sampleRows).slice(0, 8),
    })),
    savedEntryCount: savedEntries.length,
  finalCursor: {
    lastProcessedSeq: cursor.lastProcessedSeq,
    lastReplayElapsedSeconds: cursor.lastReplayElapsedSeconds,
    lastReplayTimestamp: cursor.lastReplayTimestamp,
  },
    nextResume: debug.nextResume,
  }, null, 2));
}

async function fetchReplayData(config: ApiConfig, fixtureId: string) {
  const client = new TxlineApiClient({
    apiToken: config.txlineApiToken,
    baseUrl: config.txlineBaseUrl,
  });
  const { jwt } = await client.startGuestSession();
  const [fixtures, historyScores, updateScores] = await Promise.all([
    client.listFixtures(jwt).catch(() => []),
    client.listScoreHistory(fixtureId, jwt).catch(() => []),
    client.listScoreUpdates(fixtureId, jwt).catch(() => []),
  ]);
  const fixture = fixtures.find((candidate) => String(candidate.FixtureId) === fixtureId);
  const scores = historyScores.length > 0 ? historyScores : updateScores;

  return {
    fixture,
    fixtures,
    historyScores,
    updateScores,
    scores: sortScores(scores),
  };
}

async function processReplayWindow({
  config,
  cursor,
  cursorStore,
  fixture,
  label,
  options,
  scores,
  store,
}: {
  config: ApiConfig;
  cursor: ReplayCursor;
  cursorStore: ReplayCursorStore;
  fixture: TxlineFixture;
  label: string;
  options: ReplayCliOptions;
  scores: readonly TxlineScore[];
  store: MatchPulseCommentaryStore;
}): Promise<ReplayWindowSummary> {
  const fromReplayElapsedSeconds = cursor.lastReplayElapsedSeconds;
  const toReplayElapsedSeconds = fromReplayElapsedSeconds + options.windowSeconds;
  let tickCursor = cursor;
  const ticks: ReplayTickSummary[] = [];

  for (
    let tickStart = fromReplayElapsedSeconds;
    tickStart < toReplayElapsedSeconds;
    tickStart += options.tickSeconds
  ) {
    const tickEnd = Math.min(tickStart + options.tickSeconds, toReplayElapsedSeconds);
    const tickScores = scores.filter((score) => {
      const elapsedSeconds = getReplayElapsedSeconds(score, fixture.StartTime);
      if (typeof elapsedSeconds !== 'number') {
        return false;
      }

      const afterElapsed = tickStart === 0 ? elapsedSeconds >= 0 : elapsedSeconds > tickStart;
      return afterElapsed && elapsedSeconds <= tickEnd;
    });
    const maxSeq = tickScores.reduce(
      (current, score) => Math.max(current, getScoreSeq(score)),
      tickCursor.lastProcessedSeq,
    );
    const maxTimestamp = tickScores.reduce(
      (current, score) => Math.max(current, getScoreTimestamp(score)),
      tickCursor.lastReplayTimestamp,
    );
    const context = buildTxlineMatchPulseSourceContext({
      fixture,
      updateScores: tickScores,
      nowMs: fixture.StartTime + tickEnd * 1000,
    });
    const entries = buildTxlineMatchPulseCommentaryEntries(context);
    const persistence = await store.upsertEntries(entries);
    const idempotency = await store.upsertEntries(entries);
    const nextCursor: ReplayCursor = {
      fixtureId: String(fixture.FixtureId),
      lastProcessedSeq: maxSeq,
      lastReplayElapsedSeconds: tickEnd,
      lastReplayTimestamp: maxTimestamp,
      selectedStartTime: fixture.StartTime,
      updatedAt: new Date().toISOString(),
    };
    cursorStore.saveCursor(nextCursor);

    ticks.push({
      fromReplayElapsedSeconds: tickStart,
      toReplayElapsedSeconds: tickEnd,
      fromSeqExclusive: tickCursor.lastProcessedSeq,
      rowsInTick: tickScores.length,
      confirmedRowsInTick: tickScores.filter((score) => score.Confirmed === true).length,
      commentaryEntriesBuilt: entries.length,
      persistence,
      idempotency,
      cursor: nextCursor,
      sampleRows: tickScores.slice(0, 8).map((score) => toReplayScoreSample(score, fixture.StartTime)),
    });
    tickCursor = nextCursor;
  }

  const enrichment = await enrichPendingEntries({
    config,
    fixture,
    noEnrich: options.noEnrich,
    scores: scores.filter((score) => {
      const elapsedSeconds = getReplayElapsedSeconds(score, fixture.StartTime);
      return typeof elapsedSeconds === 'number' && elapsedSeconds <= toReplayElapsedSeconds;
    }),
    store,
  });

  return {
    label,
    fromReplayElapsedSeconds,
    toReplayElapsedSeconds,
    fromSeqExclusive: cursor.lastProcessedSeq,
    tickSeconds: options.tickSeconds,
    rowsInWindow: ticks.reduce((count, tick) => count + tick.rowsInTick, 0),
    confirmedRowsInWindow: ticks.reduce((count, tick) => count + tick.confirmedRowsInTick, 0),
    commentaryEntriesBuilt: ticks.reduce((count, tick) => count + tick.commentaryEntriesBuilt, 0),
    persistence: combineUpsertResults(ticks.map((tick) => tick.persistence)),
    idempotency: combineUpsertResults(ticks.map((tick) => tick.idempotency)),
    enrichment,
    cursor: tickCursor,
    ticks,
  };
}

async function enrichPendingEntries({
  config,
  fixture,
  noEnrich,
  scores,
  store,
}: {
  config: ApiConfig;
  fixture: TxlineFixture;
  noEnrich: boolean;
  scores: readonly TxlineScore[];
  store: MatchPulseCommentaryStore;
}): Promise<ReplayWindowSummary['enrichment']> {
  if (noEnrich) {
    return {
      attempted: 0,
      completed: 0,
      failed: 0,
      skippedReason: 'disabled_by_cli',
    };
  }

  if (!config.llmEnabled || !config.llmBaseUrl) {
    return {
      attempted: 0,
      completed: 0,
      failed: 0,
      skippedReason: 'llm_disabled',
    };
  }

  const context = buildTxlineMatchPulseSourceContext({
    fixture,
    updateScores: scores,
  });
  const entries = await store.listEntries(String(fixture.FixtureId));
  const pendingEntries = entries
    .filter((entry) => entry.enrichmentStatus === 'pending')
    .sort(compareEntriesOldestFirst)
    .slice(0, config.llmBatchSize);
  if (pendingEntries.length === 0) {
    return {
      attempted: 0,
      completed: 0,
      failed: 0,
      skippedReason: 'no_pending_entries',
    };
  }

  const pendingIds = new Set(pendingEntries.map((entry) => entry.id));
  const previousEntries = entries
    .filter((entry) => !pendingIds.has(entry.id))
    .sort(compareEntriesOldestFirst);
  const enrichment = createMatchPulseEnrichmentService(config);
  const result = await enrichment.enrichCommentaryEntries(context, pendingEntries, previousEntries);
  await store.upsertEntries(result.entries);

  return {
    attempted: result.attempted,
    completed: result.completed,
    failed: result.failed,
  };
}

class ReplayCursorStore {
  private readonly db: SqliteDatabase;
  private readonly hasLegacyLastClockSeconds: boolean;

  constructor(private readonly path: string) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS match_pulse_replay_cursors (
        fixture_id TEXT PRIMARY KEY,
        last_processed_seq INTEGER NOT NULL,
        last_replay_elapsed_seconds INTEGER NOT NULL,
        last_replay_timestamp INTEGER NOT NULL,
        selected_start_time INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureCursorColumns();
    this.hasLegacyLastClockSeconds = this.hasCursorColumn('last_clock_seconds');
  }

  getCursor(fixtureId: string): ReplayCursor | undefined {
    const row = this.db.prepare(`
      SELECT
        fixture_id,
        last_processed_seq,
        last_replay_elapsed_seconds,
        last_replay_timestamp,
        selected_start_time,
        updated_at
      FROM match_pulse_replay_cursors
      WHERE fixture_id = ?
    `).get(fixtureId) as {
      fixture_id: string;
      last_processed_seq: number;
      last_replay_elapsed_seconds: number;
      last_replay_timestamp: number;
      selected_start_time: number;
      updated_at: string;
    } | undefined;
    if (!row) {
      return undefined;
    }

    return {
      fixtureId: row.fixture_id,
      lastProcessedSeq: row.last_processed_seq,
      lastReplayElapsedSeconds: row.last_replay_elapsed_seconds,
      lastReplayTimestamp: row.last_replay_timestamp,
      selectedStartTime: row.selected_start_time,
      updatedAt: row.updated_at,
    };
  }

  saveCursor(cursor: ReplayCursor): void {
    if (this.hasLegacyLastClockSeconds) {
      this.db.prepare(`
        INSERT INTO match_pulse_replay_cursors (
          fixture_id,
          last_processed_seq,
          last_clock_seconds,
          last_replay_elapsed_seconds,
          last_replay_timestamp,
          selected_start_time,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fixture_id) DO UPDATE SET
          last_processed_seq = excluded.last_processed_seq,
          last_clock_seconds = excluded.last_clock_seconds,
          last_replay_elapsed_seconds = excluded.last_replay_elapsed_seconds,
          last_replay_timestamp = excluded.last_replay_timestamp,
          selected_start_time = excluded.selected_start_time,
          updated_at = excluded.updated_at
      `).run(
        cursor.fixtureId,
        cursor.lastProcessedSeq,
        cursor.lastReplayElapsedSeconds,
        cursor.lastReplayElapsedSeconds,
        cursor.lastReplayTimestamp,
        cursor.selectedStartTime,
        cursor.updatedAt,
      );
      return;
    }

    this.db.prepare(`
      INSERT INTO match_pulse_replay_cursors (
        fixture_id,
        last_processed_seq,
        last_replay_elapsed_seconds,
        last_replay_timestamp,
        selected_start_time,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(fixture_id) DO UPDATE SET
        last_processed_seq = excluded.last_processed_seq,
        last_replay_elapsed_seconds = excluded.last_replay_elapsed_seconds,
        last_replay_timestamp = excluded.last_replay_timestamp,
        selected_start_time = excluded.selected_start_time,
        updated_at = excluded.updated_at
    `).run(
      cursor.fixtureId,
      cursor.lastProcessedSeq,
      cursor.lastReplayElapsedSeconds,
      cursor.lastReplayTimestamp,
      cursor.selectedStartTime,
      cursor.updatedAt,
    );
  }

  resetFixture(fixtureId: string): void {
    this.db.prepare('DELETE FROM match_pulse_commentary_entries WHERE fixture_id = ?').run(fixtureId);
    this.db.prepare('DELETE FROM match_pulse_replay_cursors WHERE fixture_id = ?').run(fixtureId);
  }

  close(): void {
    this.db.close();
  }

  private ensureCursorColumns(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(match_pulse_replay_cursors)').all() as { name: string }[])
        .map((column) => column.name),
    );

    if (!columns.has('last_replay_elapsed_seconds')) {
      this.db.exec('ALTER TABLE match_pulse_replay_cursors ADD COLUMN last_replay_elapsed_seconds INTEGER NOT NULL DEFAULT 0');
      if (columns.has('last_clock_seconds')) {
        this.db.exec('UPDATE match_pulse_replay_cursors SET last_replay_elapsed_seconds = last_clock_seconds');
      }
    }

    if (!columns.has('last_replay_timestamp')) {
      this.db.exec('ALTER TABLE match_pulse_replay_cursors ADD COLUMN last_replay_timestamp INTEGER NOT NULL DEFAULT 0');
      this.db.exec(`
        UPDATE match_pulse_replay_cursors
        SET last_replay_timestamp = selected_start_time + last_replay_elapsed_seconds * 1000
        WHERE last_replay_timestamp = 0
      `);
    }
  }

  private hasCursorColumn(name: string): boolean {
    return (this.db.prepare('PRAGMA table_info(match_pulse_replay_cursors)').all() as { name: string }[])
      .some((column) => column.name === name);
  }
}

function selectMajorityStartTime(scores: readonly TxlineScore[], fallback?: number): number {
  const counts = new Map<number, { count: number; maxSeq: number; maxTimestamp: number }>();
  for (const score of scores) {
    if (typeof score.StartTime !== 'number') {
      continue;
    }

    const existing = counts.get(score.StartTime) ?? {
      count: 0,
      maxSeq: -1,
      maxTimestamp: 0,
    };
    existing.count += 1;
    existing.maxSeq = Math.max(existing.maxSeq, getScoreSeq(score));
    existing.maxTimestamp = Math.max(existing.maxTimestamp, getScoreTimestamp(score));
    counts.set(score.StartTime, existing);
  }

  const selected = [...counts.entries()].sort((left, right) =>
    right[1].count - left[1].count ||
    right[1].maxSeq - left[1].maxSeq ||
    right[1].maxTimestamp - left[1].maxTimestamp ||
    right[0] - left[0]
  )[0];

  if (selected) {
    return selected[0];
  }

  if (typeof fallback === 'number') {
    return fallback;
  }

  throw new Error('Unable to determine fixture StartTime from TxLINE scores.');
}

function buildReplayFixture(
  fixtureId: string,
  selectedStartTime: number,
  fixture: TxlineFixture | undefined,
  scores: readonly TxlineScore[],
  options: Pick<ReplayCliOptions, 'awayTeam' | 'competition' | 'homeTeam'>,
): TxlineFixture {
  const score = scores.find((candidate) => (
    candidate.Participant1Id &&
    candidate.Participant2Id &&
    candidate.CompetitionId &&
    candidate.FixtureGroupId
  )) ?? scores[0];

  const participant1IsHome = fixture?.Participant1IsHome ?? score?.Participant1IsHome ?? true;
  const participant1Override = options.homeTeam && options.awayTeam
    ? (participant1IsHome ? options.homeTeam : options.awayTeam)
    : undefined;
  const participant2Override = options.homeTeam && options.awayTeam
    ? (participant1IsHome ? options.awayTeam : options.homeTeam)
    : undefined;

  return {
    Ts: fixture?.Ts ?? score?.Ts ?? Date.now(),
    StartTime: selectedStartTime,
    Competition: options.competition ?? fixture?.Competition ?? (
      score?.CompetitionId ? `Competition ${score.CompetitionId}` : 'Competition unknown'
    ),
    CompetitionId: fixture?.CompetitionId ?? score?.CompetitionId ?? 0,
    FixtureGroupId: fixture?.FixtureGroupId ?? score?.FixtureGroupId ?? 0,
    Participant1Id: fixture?.Participant1Id ?? score?.Participant1Id ?? 1,
    Participant1: participant1Override ?? fixture?.Participant1 ?? score?.Participant1 ??
      `Participant ${score?.Participant1Id ?? 1}`,
    Participant2Id: fixture?.Participant2Id ?? score?.Participant2Id ?? 2,
    Participant2: participant2Override ?? fixture?.Participant2 ?? score?.Participant2 ??
      `Participant ${score?.Participant2Id ?? 2}`,
    FixtureId: Number(fixtureId),
    Participant1IsHome: participant1IsHome,
  };
}

function combineUpsertResults(results: readonly MatchPulseCommentaryUpsertResult[]): MatchPulseCommentaryUpsertResult {
  return results.reduce<MatchPulseCommentaryUpsertResult>(
    (combined, result) => ({
      inserted: combined.inserted + result.inserted,
      updated: combined.updated + result.updated,
      unchanged: combined.unchanged + result.unchanged,
    }),
    { inserted: 0, updated: 0, unchanged: 0 },
  );
}

function sortScores(scores: readonly TxlineScore[]): readonly TxlineScore[] {
  return [...scores].sort((left, right) =>
    getScoreSeq(left) - getScoreSeq(right) ||
    getScoreTimestamp(left) - getScoreTimestamp(right) ||
    (getScoreClockSeconds(left) ?? -1) - (getScoreClockSeconds(right) ?? -1)
  );
}

function getScoreSeq(score: TxlineScore): number {
  return score.Seq ?? score.seq ?? getScoreTimestamp(score);
}

function getScoreTimestamp(score: TxlineScore): number {
  return score.Ts ?? score.ts ?? 0;
}

function getReplayElapsedSeconds(score: TxlineScore, selectedStartTime: number): number | undefined {
  const timestamp = getScoreTimestamp(score);
  if (!timestamp) {
    return undefined;
  }

  return Math.floor((timestamp - selectedStartTime) / 1000);
}

function getScoreClockSeconds(score: TxlineScore): number | undefined {
  return typeof score.Clock?.Seconds === 'number' ? score.Clock.Seconds : undefined;
}

function toReplayScoreSample(score: TxlineScore, selectedStartTime: number): ReplayScoreSample {
  const timestamp = getScoreTimestamp(score);
  const clockSeconds = getScoreClockSeconds(score);

  return {
    seq: getScoreSeq(score),
    id: getScoreId(score),
    action: score.Action ?? score.action,
    confirmed: score.Confirmed,
    elapsedSeconds: getReplayElapsedSeconds(score, selectedStartTime) ?? 0,
    timestampIso: timestamp ? new Date(timestamp).toISOString() : undefined,
    clockSeconds,
    clockLabel: typeof clockSeconds === 'number' ? `${Math.max(0, Math.ceil(clockSeconds / 60))}'` : undefined,
  };
}

function getScoreId(score: TxlineScore): string | undefined {
  const id = score.Id ?? score.id;
  return id === undefined ? undefined : String(id);
}

function toDebugEntry(entry: MatchPulseCommentaryEntry) {
  return {
    id: entry.id,
    batchId: entry.batchId,
    fromSeq: entry.fromSeq,
    toSeq: entry.toSeq,
    clock: entry.clock,
    kind: entry.kind,
    team: entry.team,
    scoreAtMoment: entry.scoreAtMoment,
    sourceEvents: entry.sourceEvents,
    commentary: entry.commentary,
    fallbackCommentary: entry.fallbackCommentary,
    generation: entry.generation,
    enrichmentStatus: entry.enrichmentStatus,
    confidence: entry.confidence,
    intensity: entry.intensity,
    boardHint: entry.boardHint,
  };
}

function toCommentaryReviewEntry(entry: MatchPulseCommentaryEntry) {
  return {
    current: {
      kind: entry.kind,
      clock: entry.clock.label,
      score: entry.scoreAtMoment ? `${entry.scoreAtMoment.home}-${entry.scoreAtMoment.away}` : undefined,
      team: entry.team?.name,
      events: [...entry.sourceEvents]
        .sort((left, right) => (left.seq ?? Number.MAX_SAFE_INTEGER) - (right.seq ?? Number.MAX_SAFE_INTEGER))
        .map((source) => ({
          seq: source.seq,
          action: source.action ?? source.label,
        })),
    },
    commentary: entry.commentary,
    enrichmentStatus: entry.enrichmentStatus,
  };
}

function compareEntriesOldestFirst(left: MatchPulseCommentaryEntry, right: MatchPulseCommentaryEntry): number {
  return (
    (left.sortSeq ?? 0) - (right.sortSeq ?? 0) ||
    (Date.parse(left.sortTimestamp ?? '') || 0) - (Date.parse(right.sortTimestamp ?? '') || 0) ||
    getEntryClockSeconds(left) - getEntryClockSeconds(right)
  );
}

function getEntryClockSeconds(entry: MatchPulseCommentaryEntry): number {
  return typeof entry.clock.seconds === 'number' ? entry.clock.seconds : -1;
}

async function writeDebugJson(path: string, value: unknown): Promise<void> {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

function closeStoreIfSupported(store: MatchPulseCommentaryStore): void {
  const maybeClose = store as MatchPulseCommentaryStore & { close?: () => void };
  maybeClose.close?.();
}

function parseArgs(args: readonly string[]): ReplayCliOptions {
  const options: ReplayCliOptions = {
    debugPath: resolve(process.cwd(), '.data/replay-18179759-debug.json'),
    fixtureId: defaultFixtureId,
    noEnrich: false,
    reset: false,
    resumeWindows: 1,
    tickSeconds: 60,
    windowSeconds: 300,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    }

    const [name, inlineValue] = arg.split('=', 2);
    const nextValue = () => inlineValue ?? args[++index];

    if (name === '--fixture' || name === '--fixture-id') {
      options.fixtureId = String(nextValue());
      continue;
    }

    if (name === '--debug-path') {
      options.debugPath = String(nextValue());
      continue;
    }

    if (name === '--review-path') {
      options.reviewPath = String(nextValue());
      continue;
    }

    if (name === '--home-team') {
      options.homeTeam = String(nextValue());
      continue;
    }

    if (name === '--away-team') {
      options.awayTeam = String(nextValue());
      continue;
    }

    if (name === '--competition') {
      options.competition = String(nextValue());
      continue;
    }

    if (name === '--window-seconds') {
      options.windowSeconds = Number(nextValue());
      continue;
    }

    if (name === '--tick-seconds') {
      options.tickSeconds = Number(nextValue());
      continue;
    }

    if (name === '--resume-windows') {
      options.resumeWindows = Number(nextValue());
      continue;
    }

    if (arg === '--reset') {
      options.reset = true;
      continue;
    }

    if (arg === '--no-enrich') {
      options.noEnrich = true;
      continue;
    }

    throw new Error(`Unknown replay option: ${arg}`);
  }

  if (!Number.isFinite(options.windowSeconds) || options.windowSeconds <= 0) {
    throw new Error('--window-seconds must be a positive number.');
  }

  if (!Number.isFinite(options.tickSeconds) || options.tickSeconds <= 0) {
    throw new Error('--tick-seconds must be a positive number.');
  }

  if (!Number.isFinite(options.resumeWindows) || options.resumeWindows < 0) {
    throw new Error('--resume-windows must be zero or greater.');
  }

  if (Boolean(options.homeTeam) !== Boolean(options.awayTeam)) {
    throw new Error('--home-team and --away-team must be provided together.');
  }

  return options;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
