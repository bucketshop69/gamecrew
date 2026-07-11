import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

interface LiveTestOptions {
  away: string;
  debugPath: string;
  dryRun: boolean;
  fixtureId?: string;
  home: string;
  logPath: string;
  maxTicks?: number;
  noEnrich: boolean;
  once: boolean;
  pollSeconds: number;
  preStartPollSeconds: number;
  reset: boolean;
  statePath: string;
  stopAfterFinal: boolean;
}

interface LiveTestState {
  fixture?: LiveFixtureSummary;
  lastProcessedSeq: number;
  lastProcessedTimestamp?: number;
  startedAt: string;
  tickCount: number;
  updatedAt: string;
}

interface LiveFixtureSummary {
  fixtureId: string;
  kickoffUtc: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
  participant1Id: number;
  participant2Id: number;
  participant1IsHome: boolean;
}

interface LiveTickSummary {
  tick: number;
  at: string;
  mode: 'waiting_for_fixture' | 'waiting_for_kickoff' | 'polling_live' | 'final';
  fixture?: LiveFixtureSummary;
  kickoffInSeconds?: number;
  status?: {
    statusId?: number;
    gameState?: string;
    clockRunning?: boolean;
    clockSeconds?: number;
  };
  source: {
    snapshotRows: number;
    updateRows: number;
    newRows: number;
    confirmedNewRows: number;
    maxSeq: number;
  };
  entriesBuilt: number;
  persistence: MatchPulseCommentaryUpsertResult;
  enrichment: {
    attempted: number;
    completed: number;
    failed: number;
    skippedReason?: string;
  };
  savedEntryCount: number;
  counts: Record<string, number>;
  entries: readonly LiveDebugEntry[];
  lastEntries: readonly LiveDebugEntry[];
  error?: string;
}

interface LiveDebugEntry {
  id: string;
  sortSeq?: number;
  clock: string;
  kind: string;
  generation: string;
  enrichmentStatus: string;
  commentary: string;
  fallbackCommentary: string;
  voiceLine?: string;
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  close(): void;
  prepare(sql: string): SqliteStatement;
}

const defaultFixtureId = '18209181';
const defaultHome = 'France';
const defaultAway = 'Morocco';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const sqlitePath = resolve(config.matchPulseSqlitePath);
  const store = createMatchPulseCommentaryStore({
    driver: 'sqlite',
    filePath: config.matchPulseStorePath,
    sqlitePath,
  });
  const session = new TxlineSession(config);
  const state = await loadState(options.statePath) ?? {
    lastProcessedSeq: -1,
    startedAt: new Date().toISOString(),
    tickCount: 0,
    updatedAt: new Date().toISOString(),
  };

  let resetDone = false;
  let finalPolls = 0;
  let lastTick: LiveTickSummary | undefined;

  await ensureParentDirectory(options.debugPath);
  await ensureParentDirectory(options.logPath);

  logLine({
    event: 'live_test_started',
    fixtureId: options.fixtureId ?? defaultFixtureId,
    home: options.home,
    away: options.away,
    sqlitePath,
    debugPath: resolve(options.debugPath),
    logPath: resolve(options.logPath),
    statePath: resolve(options.statePath),
    llmEnabled: config.llmEnabled && Boolean(config.llmBaseUrl) && !options.noEnrich,
    llmModel: config.llmModel,
    llmBatchSize: config.llmBatchSize,
    dryRun: options.dryRun,
  });

  while (true) {
    const tickStartedAt = Date.now();
    state.tickCount += 1;

    try {
      const tick = await runTick({
        config,
        options,
        resetDone,
        session,
        sqlitePath,
        state,
        store,
      });
      resetDone = resetDone || Boolean(tick.fixture && options.reset && !options.dryRun);
      lastTick = tick;

      if (!options.dryRun) {
        await saveState(options.statePath, state);
      }
      await writeDebug(options.debugPath, state, tick);
      await appendNdjson(options.logPath, tick);
      logTick(tick);

      if (tick.mode === 'final') {
        finalPolls += 1;
      } else {
        finalPolls = 0;
      }

      if (options.once || (options.maxTicks && state.tickCount >= options.maxTicks)) {
        break;
      }

      if (options.stopAfterFinal && finalPolls >= 6) {
        logLine({ event: 'live_test_finished_after_final', finalPolls });
        break;
      }

      await sleep(getNextDelayMs(tick, options, tickStartedAt));
    } catch (error) {
      const tick: LiveTickSummary = {
        tick: state.tickCount,
        at: new Date().toISOString(),
        mode: lastTick?.mode ?? 'waiting_for_fixture',
        fixture: state.fixture,
        source: {
          snapshotRows: 0,
          updateRows: 0,
          newRows: 0,
          confirmedNewRows: 0,
          maxSeq: state.lastProcessedSeq,
        },
        entriesBuilt: 0,
        persistence: { inserted: 0, updated: 0, unchanged: 0 },
        enrichment: { attempted: 0, completed: 0, failed: 0, skippedReason: 'tick_error' },
        savedEntryCount: 0,
        counts: {},
        entries: [],
        lastEntries: [],
        error: error instanceof Error ? error.message : String(error),
      };
      await writeDebug(options.debugPath, state, tick);
      await appendNdjson(options.logPath, tick);
      logTick(tick);

      if (options.once || (options.maxTicks && state.tickCount >= options.maxTicks)) {
        break;
      }

      await sleep(options.pollSeconds * 1000);
    }
  }

  closeStoreIfSupported(store);
}

async function runTick({
  config,
  options,
  resetDone,
  session,
  sqlitePath,
  state,
  store,
}: {
  config: ApiConfig;
  options: LiveTestOptions;
  resetDone: boolean;
  session: TxlineSession;
  sqlitePath: string;
  state: LiveTestState;
  store: MatchPulseCommentaryStore;
}): Promise<LiveTickSummary> {
  const jwt = await session.getJwt();
  const fixtures = await session.request((token) => session.client.listFixtures(token));
  const fixture = findFixture(fixtures, options, state.fixture?.fixtureId);

  if (!fixture) {
    return buildTickSummary({
      mode: 'waiting_for_fixture',
      options,
      state,
      source: { snapshotRows: 0, updateRows: 0, newRows: 0, confirmedNewRows: 0, maxSeq: state.lastProcessedSeq },
      persistence: { inserted: 0, updated: 0, unchanged: 0 },
      entriesBuilt: 0,
      enrichment: { attempted: 0, completed: 0, failed: 0, skippedReason: 'fixture_not_found' },
      entries: [],
    });
  }

  state.fixture = summarizeFixture(fixture);

  if (options.reset && !resetDone && !options.dryRun) {
    await resetLiveTest({
      fixtureId: String(fixture.FixtureId),
      options,
      sqlitePath,
      state,
    });
  }

  const [snapshotScores, updateScores] = await Promise.all([
    session.request((token) => session.client.listScoreSnapshot(fixture.FixtureId, token).catch(() => [])),
    session.request((token) => session.client.listScoreUpdates(fixture.FixtureId, token).catch(() => [])),
  ]);
  const latestScore = getLatestScore([...snapshotScores, ...updateScores]);
  const kickoffInSeconds = Math.ceil((fixture.StartTime - Date.now()) / 1000);
  const isLive = isFixtureLive(fixture, latestScore);
  const isFinal = isFixtureFinal(latestScore);
  const newScores = updateScores
    .filter((score) => getScoreSeq(score) > state.lastProcessedSeq)
    .sort(compareScores);
  const maxSeq = newScores.reduce((current, score) => Math.max(current, getScoreSeq(score)), state.lastProcessedSeq);
  const maxTimestamp = newScores.reduce(
    (current, score) => Math.max(current, getScoreTimestamp(score)),
    state.lastProcessedTimestamp ?? 0,
  );
  const context = buildTxlineMatchPulseSourceContext({
    fixture,
    snapshotScores,
    updateScores: newScores,
  });
  const entries = buildTxlineMatchPulseCommentaryEntries(context);
  const persistence = options.dryRun ? { inserted: 0, updated: 0, unchanged: 0 } : await store.upsertEntries(entries);

  if (!options.dryRun && maxSeq > state.lastProcessedSeq) {
    state.lastProcessedSeq = maxSeq;
    state.lastProcessedTimestamp = maxTimestamp || state.lastProcessedTimestamp;
    state.updatedAt = new Date().toISOString();
  }

  const enrichment = await enrichPendingEntries({
    config,
    context,
    fixtureId: String(fixture.FixtureId),
    noEnrich: options.noEnrich || options.dryRun,
    store,
  });
  const savedEntries = options.dryRun ? [] : await store.listEntries(String(fixture.FixtureId));
  const source = {
    snapshotRows: snapshotScores.length,
    updateRows: updateScores.length,
    newRows: newScores.length,
    confirmedNewRows: newScores.filter((score) => score.Confirmed === true).length,
    maxSeq,
  };

  return buildTickSummary({
    mode: isFinal ? 'final' : isLive ? 'polling_live' : 'waiting_for_kickoff',
    options,
    state,
    fixture,
    kickoffInSeconds,
    status: {
      statusId: latestScore?.StatusId,
      gameState: latestScore?.GameState ?? latestScore?.gameState,
      clockRunning: latestScore?.Clock?.Running,
      clockSeconds: latestScore?.Clock?.Seconds,
    },
    source,
    persistence,
    entriesBuilt: entries.length,
    enrichment,
    entries: savedEntries,
  });

  void jwt;
}

async function enrichPendingEntries({
  config,
  context,
  fixtureId,
  noEnrich,
  store,
}: {
  config: ApiConfig;
  context: ReturnType<typeof buildTxlineMatchPulseSourceContext>;
  fixtureId: string;
  noEnrich: boolean;
  store: MatchPulseCommentaryStore;
}): Promise<LiveTickSummary['enrichment']> {
  if (noEnrich) {
    return { attempted: 0, completed: 0, failed: 0, skippedReason: 'disabled' };
  }

  if (!config.llmEnabled || !config.llmBaseUrl) {
    return { attempted: 0, completed: 0, failed: 0, skippedReason: 'llm_disabled' };
  }

  const entries = await store.listEntries(fixtureId);
  const pendingEntries = entries
    .filter((entry) => entry.enrichmentStatus === 'pending')
    .sort(compareEntriesOldestFirst)
    .slice(0, config.llmBatchSize);
  if (pendingEntries.length === 0) {
    return { attempted: 0, completed: 0, failed: 0, skippedReason: 'no_pending_entries' };
  }

  const pendingIds = new Set(pendingEntries.map((entry) => entry.id));
  const previousEntries = entries
    .filter((entry) => !pendingIds.has(entry.id))
    .sort(compareEntriesOldestFirst);
  const enrichment = createMatchPulseEnrichmentService(config);
  const result = await enrichment.enrichCommentaryEntries(context, pendingEntries, previousEntries);
  if (result.entries.length > 0) {
    await store.upsertEntries(result.entries);
  }

  return {
    attempted: result.attempted,
    completed: result.completed,
    failed: result.failed,
  };
}

function findFixture(
  fixtures: readonly TxlineFixture[],
  options: LiveTestOptions,
  previousFixtureId?: string,
): TxlineFixture | undefined {
  const fixtureId = options.fixtureId ?? previousFixtureId ?? defaultFixtureId;
  const byId = fixtures.find((fixture) => String(fixture.FixtureId) === fixtureId);
  if (byId) {
    return byId;
  }

  const home = options.home.toLowerCase();
  const away = options.away.toLowerCase();
  return fixtures.find((fixture) => {
    const first = fixture.Participant1.toLowerCase();
    const second = fixture.Participant2.toLowerCase();
    return (first.includes(home) && second.includes(away)) ||
      (first.includes(away) && second.includes(home));
  });
}

function summarizeFixture(fixture: TxlineFixture): LiveFixtureSummary {
  const homeTeam = fixture.Participant1IsHome ? fixture.Participant1 : fixture.Participant2;
  const awayTeam = fixture.Participant1IsHome ? fixture.Participant2 : fixture.Participant1;
  return {
    fixtureId: String(fixture.FixtureId),
    kickoffUtc: new Date(fixture.StartTime).toISOString(),
    competition: fixture.Competition,
    homeTeam,
    awayTeam,
    participant1Id: fixture.Participant1Id,
    participant2Id: fixture.Participant2Id,
    participant1IsHome: fixture.Participant1IsHome,
  };
}

function buildTickSummary({
  mode,
  options,
  state,
  fixture,
  kickoffInSeconds,
  status,
  source,
  persistence,
  entriesBuilt,
  enrichment,
  entries,
}: {
  mode: LiveTickSummary['mode'];
  options: LiveTestOptions;
  state: LiveTestState;
  fixture?: TxlineFixture;
  kickoffInSeconds?: number;
  status?: LiveTickSummary['status'];
  source: LiveTickSummary['source'];
  persistence: MatchPulseCommentaryUpsertResult;
  entriesBuilt: number;
  enrichment: LiveTickSummary['enrichment'];
  entries: readonly MatchPulseCommentaryEntry[];
}): LiveTickSummary {
  const orderedEntries = [...entries].sort(compareEntriesOldestFirst);
  const debugEntries = orderedEntries.map(toDebugEntry);
  return {
    tick: state.tickCount,
    at: new Date().toISOString(),
    mode,
    fixture: fixture ? summarizeFixture(fixture) : state.fixture,
    kickoffInSeconds,
    status,
    source,
    entriesBuilt,
    persistence,
    enrichment,
    savedEntryCount: entries.length,
    counts: countEntries(entries),
    entries: debugEntries,
    lastEntries: debugEntries.slice(-6),
  };

  void options;
}

function toDebugEntry(entry: MatchPulseCommentaryEntry): LiveDebugEntry {
  return {
    id: entry.id,
    sortSeq: entry.sortSeq,
    clock: entry.clock.label,
    kind: entry.kind,
    generation: entry.generation,
    enrichmentStatus: entry.enrichmentStatus,
    commentary: entry.commentary,
    fallbackCommentary: entry.fallbackCommentary,
    voiceLine: entry.voiceLine,
  };
}

function countEntries(entries: readonly MatchPulseCommentaryEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const key = `${entry.generation}:${entry.enrichmentStatus}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

async function resetLiveTest({
  fixtureId,
  options,
  sqlitePath,
  state,
}: {
  fixtureId: string;
  options: LiveTestOptions;
  sqlitePath: string;
  state: LiveTestState;
}): Promise<void> {
  deleteFixtureEntries(sqlitePath, fixtureId);
  await rm(options.statePath, { force: true });
  state.lastProcessedSeq = -1;
  state.lastProcessedTimestamp = undefined;
  state.startedAt = new Date().toISOString();
  state.updatedAt = state.startedAt;
  await appendNdjson(options.logPath, {
    event: 'reset_fixture',
    at: new Date().toISOString(),
    fixtureId,
    sqlitePath,
  });
}

function deleteFixtureEntries(sqlitePath: string, fixtureId: string): void {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const db = new DatabaseSync(sqlitePath);
  try {
    db.prepare('DELETE FROM match_pulse_commentary_entries WHERE fixture_id = ?').run(fixtureId);
  } finally {
    db.close();
  }
}

class TxlineSession {
  readonly client: TxlineApiClient;
  private jwt?: string;

  constructor(config: ApiConfig) {
    this.client = new TxlineApiClient({
      apiToken: config.txlineApiToken,
      baseUrl: config.txlineBaseUrl,
    });
  }

  async getJwt(): Promise<string> {
    if (!this.jwt) {
      const session = await this.client.startGuestSession();
      this.jwt = session.jwt;
    }

    return this.jwt;
  }

  async request<T>(fn: (jwt: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.getJwt());
    } catch (error) {
      this.jwt = undefined;
      try {
        return await fn(await this.getJwt());
      } catch {
        throw error;
      }
    }
  }
}

function isFixtureLive(fixture: TxlineFixture, latestScore?: TxlineScore): boolean {
  return Boolean(
    latestScore?.StatusId === 2 ||
      latestScore?.Clock?.Running ||
      (latestScore?.Action ?? latestScore?.action) === 'kickoff' ||
      Date.now() >= fixture.StartTime,
  );
}

function isFixtureFinal(latestScore?: TxlineScore): boolean {
  return latestScore?.StatusId === 5 ||
    latestScore?.GameState === 'ended' ||
    latestScore?.gameState === 'ended' ||
    latestScore?.GameState === 'finished' ||
    latestScore?.gameState === 'finished';
}

function getLatestScore(scores: readonly TxlineScore[]): TxlineScore | undefined {
  return [...scores].sort((left, right) =>
    getScoreTimestamp(right) - getScoreTimestamp(left) ||
    getScoreSeq(right) - getScoreSeq(left)
  )[0];
}

function compareScores(left: TxlineScore, right: TxlineScore): number {
  return getScoreSeq(left) - getScoreSeq(right) ||
    getScoreTimestamp(left) - getScoreTimestamp(right) ||
    (left.Clock?.Seconds ?? -1) - (right.Clock?.Seconds ?? -1);
}

function getScoreSeq(score: TxlineScore): number {
  return score.Seq ?? score.seq ?? getScoreTimestamp(score);
}

function getScoreTimestamp(score: TxlineScore): number {
  return score.Ts ?? score.ts ?? 0;
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

async function loadState(path: string): Promise<LiveTestState | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LiveTestState;
  } catch {
    return undefined;
  }
}

async function saveState(path: string, state: LiveTestState): Promise<void> {
  await ensureParentDirectory(path);
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function writeDebug(path: string, state: LiveTestState, lastTick: LiveTickSummary): Promise<void> {
  await ensureParentDirectory(path);
  await writeFile(path, `${JSON.stringify({
    state,
    lastTick,
  }, null, 2)}\n`);
}

async function appendNdjson(path: string, value: unknown): Promise<void> {
  await ensureParentDirectory(path);
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
}

function logTick(tick: LiveTickSummary): void {
  logLine({
    event: 'tick',
    tick: tick.tick,
    mode: tick.mode,
    fixtureId: tick.fixture?.fixtureId,
    kickoffInSeconds: tick.kickoffInSeconds,
    status: tick.status,
    source: tick.source,
    entriesBuilt: tick.entriesBuilt,
    persistence: tick.persistence,
    enrichment: tick.enrichment,
    savedEntryCount: tick.savedEntryCount,
    counts: tick.counts,
    lastCommentary: tick.lastEntries.at(-1)?.commentary,
    error: tick.error,
  });
}

function logLine(value: unknown): void {
  console.log(JSON.stringify(value));
}

function getNextDelayMs(tick: LiveTickSummary, options: LiveTestOptions, tickStartedAt: number): number {
  const baseSeconds = tick.mode === 'waiting_for_kickoff' && (tick.kickoffInSeconds ?? 0) > 900
    ? options.preStartPollSeconds
    : options.pollSeconds;
  const elapsedMs = Date.now() - tickStartedAt;
  return Math.max(1_000, baseSeconds * 1000 - elapsedMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseArgs(args: readonly string[]): LiveTestOptions {
  const cwd = process.cwd();
  const options: LiveTestOptions = {
    away: defaultAway,
    debugPath: resolve(cwd, '.data/live-france-morocco-match-pulse.json'),
    dryRun: false,
    fixtureId: defaultFixtureId,
    home: defaultHome,
    logPath: resolve(cwd, '.data/live-france-morocco-match-pulse.ndjson'),
    noEnrich: false,
    once: false,
    pollSeconds: 10,
    preStartPollSeconds: 60,
    reset: false,
    statePath: resolve(cwd, '.data/live-france-morocco-match-pulse-state.json'),
    stopAfterFinal: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    }

    const [name, inlineValue] = arg.split('=', 2);
    const nextValue = () => inlineValue ?? args[++index];

    if (name === '--fixture-id' || name === '--fixture') {
      options.fixtureId = String(nextValue());
      continue;
    }

    if (name === '--auto-fixture') {
      options.fixtureId = undefined;
      continue;
    }

    if (name === '--home') {
      options.home = String(nextValue());
      continue;
    }

    if (name === '--away') {
      options.away = String(nextValue());
      continue;
    }

    if (name === '--poll-seconds') {
      options.pollSeconds = Number(nextValue());
      continue;
    }

    if (name === '--prestart-poll-seconds') {
      options.preStartPollSeconds = Number(nextValue());
      continue;
    }

    if (name === '--max-ticks') {
      options.maxTicks = Number(nextValue());
      continue;
    }

    if (name === '--debug-path') {
      options.debugPath = resolve(String(nextValue()));
      continue;
    }

    if (name === '--log-path') {
      options.logPath = resolve(String(nextValue()));
      continue;
    }

    if (name === '--state-path') {
      options.statePath = resolve(String(nextValue()));
      continue;
    }

    if (arg === '--reset') {
      options.reset = true;
      continue;
    }

    if (arg === '--once') {
      options.once = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--no-enrich') {
      options.noEnrich = true;
      continue;
    }

    if (arg === '--stay-open-after-final') {
      options.stopAfterFinal = false;
      continue;
    }

    throw new Error(`Unknown live test option: ${arg}`);
  }

  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds <= 0) {
    throw new Error('--poll-seconds must be a positive number.');
  }

  if (!Number.isFinite(options.preStartPollSeconds) || options.preStartPollSeconds <= 0) {
    throw new Error('--prestart-poll-seconds must be a positive number.');
  }

  if (options.maxTicks !== undefined && (!Number.isFinite(options.maxTicks) || options.maxTicks <= 0)) {
    throw new Error('--max-ticks must be a positive number.');
  }

  return options;
}

function closeStoreIfSupported(store: MatchPulseCommentaryStore): void {
  const maybeClose = store as MatchPulseCommentaryStore & { close?: () => void };
  maybeClose.close?.();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
