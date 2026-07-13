import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { MatchPulseCommentaryEntry } from '@gamecrew/core';
import { loadConfig, type ApiConfig } from './config.js';
import { createIngestionRuntime, type IngestionRuntime } from './ingestion/ingestion-runtime.js';
import {
  MatchPulseMaterializationStore,
  isPublishedMaterializationStatus,
  type MatchPulseMaterializationStatus,
} from './match-pulse-materialization-store.js';
import {
  COMMENTARY_PROMPT_VERSION,
  COMMENTARY_REFLECTION_PROMPT_VERSION,
} from './match-pulse-llm.js';

export const COMMENTARY_PROMPT_BUNDLE = [
  COMMENTARY_PROMPT_VERSION,
  COMMENTARY_REFLECTION_PROMPT_VERSION,
].sort().join(',');

export interface MaterializeMatchPulseOptions {
  fixtureIds: readonly string[];
  databasePath?: string;
  prepareOnly: boolean;
  timeoutMs: number;
  pollMs: number;
}

interface MaterializationReadiness {
  fixtureId: string;
  timelineComplete: boolean;
  finalised: boolean;
  projectionAligned: boolean;
  projectionGeneration?: number;
  stateRevision?: number;
  entryCount: number;
  completeCount: number;
  fallbackCount: number;
  failedCount: number;
  pendingCount: number;
  notNeededCount: number;
  promptVersion: string;
}

interface FixtureMaterializationResult extends MaterializationReadiness {
  status: MatchPulseMaterializationStatus | 'skipped';
  attempted: number;
  providerCalls: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  error?: string;
}

export function parseMaterializeArgs(args: readonly string[]): MaterializeMatchPulseOptions {
  const values = args.filter((argument) => argument !== '--');
  const unknown = values.find((value) => (
    !/^\d+$/.test(value)
    && value !== '--prepare-only'
    && !value.startsWith('--fixtures=')
    && !value.startsWith('--database=')
    && !value.startsWith('--timeout-ms=')
    && !value.startsWith('--poll-ms=')
  ));
  if (unknown) throw new Error(`Unknown materialization argument: ${unknown}`);
  const explicit = values.filter((value) => /^\d+$/.test(value));
  const rawFixtureOption = values.find((value) => value.startsWith('--fixtures='))
    ?.slice('--fixtures='.length);
  const fixtureOption = rawFixtureOption?.split(',') ?? [];
  if (fixtureOption.some((value) => !/^\d+$/.test(value))) {
    throw new Error('--fixtures must contain only comma-separated numeric fixture IDs.');
  }
  const fixtureIds = [...new Set([...explicit, ...fixtureOption])];
  if (fixtureIds.length === 0) {
    throw new Error('Provide at least one explicit fixture ID or --fixtures=id,id.');
  }
  const databasePath = values.find((value) => value.startsWith('--database='))
    ?.slice('--database='.length);
  const timeoutMs = parsePositiveNumber(values, '--timeout-ms=', 60 * 60_000);
  const pollMs = parsePositiveNumber(values, '--poll-ms=', 250);
  return {
    fixtureIds,
    ...(databasePath ? { databasePath } : {}),
    prepareOnly: values.includes('--prepare-only'),
    timeoutMs,
    pollMs,
  };
}

export async function materializeMatchPulseArchive(
  config: ApiConfig,
  options: MaterializeMatchPulseOptions,
): Promise<{ databasePath: string; results: readonly FixtureMaterializationResult[] }> {
  if (!options.prepareOnly && (!config.llmEnabled || !config.llmBaseUrl)) {
    throw new Error(
      'Durable LLM materialization requires MATCH_PULSE_LLM_ENABLED=1 and MATCH_PULSE_LLM_BASE_URL.',
    );
  }
  const databasePath = options.databasePath ?? config.matchPulseSqlitePath;
  const runtimeConfig = {
    ...config,
    matchPulseSqlitePath: databasePath,
    matchPulseStoreDriver: 'sqlite' as const,
    ...(options.prepareOnly ? { llmEnabled: false } : {}),
  };
  const runtime = createIngestionRuntime(runtimeConfig);
  const materializations = new MatchPulseMaterializationStore(databasePath);
  const results: FixtureMaterializationResult[] = [];

  try {
    for (const fixtureId of options.fixtureIds) {
      const existing = await materializations.get(fixtureId);
      const before = await inspectMaterialization(runtime, fixtureId);
      if (
        existing
        && isPublishedMaterializationStatus(existing.status)
        && before.timelineComplete
        && before.finalised
        && before.projectionAligned
        && before.pendingCount === 0
        && existing.projectionGeneration === before.projectionGeneration
        && existing.stateRevision === before.stateRevision
        && existing.model === config.llmModel
        && existing.promptVersion === before.promptVersion
      ) {
        results.push({
          ...before,
          status: 'skipped',
          attempted: 0,
          providerCalls: 0,
        });
        continue;
      }

      if (publishedMaterializationNeedsReenrichment(
        existing,
        config.llmModel,
        before.promptVersion,
        before.completeCount > 0,
      )) {
        throw new Error(
          `Fixture ${fixtureId} was published with model=${existing?.model ?? 'unknown'} and `
          + `prompt=${existing?.promptVersion ?? 'unknown'}; explicit re-enrichment is required before `
          + `recording model=${config.llmModel} and prompt=${before.promptVersion}.`,
        );
      }

      const runId = randomUUID();
      const leaseMs = 30_000;
      const startedAt = new Date().toISOString();
      await materializations.start(
        fixtureId,
        runId,
        startedAt,
        Date.now() + leaseMs,
        config.llmModel,
        before.promptVersion,
      );
      let leaseOwned = true;
      let renewalQueue = Promise.resolve();
      const renewLease = () => {
        renewalQueue = renewalQueue.then(async () => {
          if (!leaseOwned) return;
          leaseOwned = await materializations.renew(
            fixtureId,
            runId,
            Date.now() + leaseMs,
            new Date().toISOString(),
          );
        });
      };
      const heartbeat = setInterval(renewLease, Math.floor(leaseMs / 3));
      try {
        await runtime.ensureFixture(fixtureId);
        const readiness = await waitForMaterialization(runtime, fixtureId, options);
        clearInterval(heartbeat);
        await renewalQueue;
        if (!leaseOwned) throw new Error(`Fixture ${fixtureId} materialization lease was lost.`);
        const status = options.prepareOnly
          ? 'prepared'
          : readiness.fallbackCount === 0 && readiness.failedCount === 0
            ? 'ready'
            : 'ready_with_fallback';
        const completedAt = new Date().toISOString();
        const completed = await materializations.complete({
          fixtureId,
          status,
          projectionGeneration: readiness.projectionGeneration!,
          stateRevision: readiness.stateRevision!,
          entryCount: readiness.entryCount,
          completeCount: readiness.completeCount,
          fallbackCount: readiness.fallbackCount,
          failedCount: readiness.failedCount,
          pendingCount: readiness.pendingCount,
          notNeededCount: readiness.notNeededCount,
          model: config.llmModel,
          promptVersion: readiness.promptVersion,
          completedAt,
        }, runId);
        if (!completed) throw new Error(`Fixture ${fixtureId} materialization ownership changed before publish.`);
        const persisted = await materializations.get(fixtureId);
        results.push({
          ...readiness,
          status,
          attempted: persisted?.enrichmentAttempted ?? 0,
          providerCalls: persisted?.providerCalls ?? 0,
          ...(persisted?.promptTokens === undefined ? {} : { promptTokens: persisted.promptTokens }),
          ...(persisted?.completionTokens === undefined ? {} : { completionTokens: persisted.completionTokens }),
          ...(persisted?.totalTokens === undefined ? {} : { totalTokens: persisted.totalTokens }),
        });
      } catch (error) {
        clearInterval(heartbeat);
        await renewalQueue;
        await materializations.fail(fixtureId, runId, error, new Date().toISOString());
        const readiness = await inspectMaterialization(runtime, fixtureId);
        const persisted = await materializations.get(fixtureId);
        results.push({
          ...readiness,
          status: 'failed',
          attempted: persisted?.enrichmentAttempted ?? 0,
          providerCalls: persisted?.providerCalls ?? 0,
          ...(persisted?.promptTokens === undefined ? {} : { promptTokens: persisted.promptTokens }),
          ...(persisted?.completionTokens === undefined ? {} : { completionTokens: persisted.completionTokens }),
          ...(persisted?.totalTokens === undefined ? {} : { totalTokens: persisted.totalTokens }),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await runtime.close();
    materializations.close();
  }

  return { databasePath, results };
}

export function publishedMaterializationNeedsReenrichment(
  existing: Awaited<ReturnType<MatchPulseMaterializationStore['get']>>,
  model: string,
  promptVersion: string,
  hasCompletedEntries = false,
): boolean {
  return Boolean(
    existing
    && (
      isPublishedMaterializationStatus(existing.status)
      || hasCompletedEntries
      || existing.enrichmentAttempted > 0
      || existing.providerCalls > 0
    )
    && (existing.model !== model || existing.promptVersion !== promptVersion),
  );
}

export async function inspectMaterialization(
  runtime: Pick<
    IngestionRuntime,
    'getCheckpoint' | 'getIngestionCursor' | 'getCommentaryProjection'
  >,
  fixtureId: string,
): Promise<MaterializationReadiness> {
  const [checkpoint, cursor, projection] = await Promise.all([
    runtime.getCheckpoint(fixtureId),
    runtime.getIngestionCursor(fixtureId),
    runtime.getCommentaryProjection(fixtureId),
  ]);
  const counts = countEntries(projection.entries);
  const stateRevision = checkpoint?.stateRevision;
  const projectionAligned = Boolean(
    checkpoint
    && projection.cursor
    && projection.cursor.projectionGeneration === checkpoint.projectionGeneration
    && projection.cursor.lastStateRevision === stateRevision,
  );
  return {
    fixtureId,
    timelineComplete: cursor?.timelineComplete === true,
    finalised: checkpoint?.phase === 'finalised',
    projectionAligned,
    ...(checkpoint ? { projectionGeneration: checkpoint.projectionGeneration, stateRevision } : {}),
    ...counts,
    promptVersion: COMMENTARY_PROMPT_BUNDLE,
  };
}

async function waitForMaterialization(
  runtime: Pick<
    IngestionRuntime,
    'getCheckpoint' | 'getIngestionCursor' | 'getCommentaryProjection'
  >,
  fixtureId: string,
  options: Pick<MaterializeMatchPulseOptions, 'prepareOnly' | 'timeoutMs' | 'pollMs'>,
): Promise<MaterializationReadiness> {
  const deadline = Date.now() + options.timeoutMs;
  let latest = await inspectMaterialization(runtime, fixtureId);
  while (Date.now() <= deadline) {
    const projectionReady = latest.timelineComplete
      && latest.finalised
      && latest.projectionAligned
      && latest.entryCount > 0;
    if (projectionReady && (options.prepareOnly || latest.pendingCount === 0)) return latest;
    await delay(options.pollMs);
    latest = await inspectMaterialization(runtime, fixtureId);
  }
  throw new Error(
    `Fixture ${fixtureId} materialization timed out: timelineComplete=${latest.timelineComplete}, `
    + `finalised=${latest.finalised}, projectionAligned=${latest.projectionAligned}, `
    + `entries=${latest.entryCount}, pending=${latest.pendingCount}.`,
  );
}

function countEntries(entries: readonly MatchPulseCommentaryEntry[]) {
  return {
    entryCount: entries.length,
    completeCount: entries.filter((entry) => entry.enrichmentStatus === 'complete').length,
    fallbackCount: entries.filter((entry) => (
      entry.enrichmentStatus === 'fallback'
    )).length,
    notNeededCount: entries.filter((entry) => entry.enrichmentStatus === 'not_needed').length,
    failedCount: entries.filter((entry) => entry.enrichmentStatus === 'failed').length,
    pendingCount: entries.filter((entry) => entry.enrichmentStatus === 'pending').length,
  };
}

function parsePositiveNumber(values: readonly string[], prefix: string, fallback: number): number {
  const raw = values.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${prefix.slice(0, -1)} must be positive.`);
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function main(): Promise<void> {
  const options = parseMaterializeArgs(process.argv.slice(2));
  const config = loadConfig();
  const report = await materializeMatchPulseArchive(config, options);
  console.log(JSON.stringify(report, null, 2));
  if (report.results.some((result) => result.status === 'failed')) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
