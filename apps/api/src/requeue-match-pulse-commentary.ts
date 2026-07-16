import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';

/**
 * Controlled requeue for commentary enrichment.
 *
 * Flips entries of the requested statuses back to 'pending', restores their
 * grounded fallback commentary (so no stale LLM text survives the requeue),
 * resets their enrichment job rows, and optionally clears the fixture's
 * materialization record so materialize-match-pulse can re-run under a new
 * prompt version.
 *
 * Usage:
 *   tsx src/requeue-match-pulse-commentary.ts 18237038 \
 *     [--statuses=failed,complete] [--database=path] [--reset-materialization]
 *
 * Defaults: --statuses=failed. Match truth is untouched: only presentation
 * fields (commentary, voiceLine, generation, enrichmentStatus, coverage
 * audit fields) are reset; grounding, cue alignment, and ordering never move.
 */

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

const REQUEUEABLE_STATUSES = new Set(['failed', 'complete', 'fallback', 'pending']);

export interface RequeueOptions {
  fixtureIds: readonly string[];
  databasePath: string;
  statuses: readonly string[];
  resetMaterialization: boolean;
}

export function parseRequeueArgs(
  args: readonly string[],
  defaultDatabasePath: string,
): RequeueOptions {
  const values = args.filter((argument) => argument !== '--');
  const fixtureIds = values.filter((value) => /^\d+$/.test(value));
  if (fixtureIds.length === 0) {
    throw new Error('Provide at least one numeric fixture ID to requeue.');
  }
  const unknown = values.find((value) => (
    !/^\d+$/.test(value)
    && value !== '--reset-materialization'
    && !value.startsWith('--statuses=')
    && !value.startsWith('--database=')
  ));
  if (unknown) throw new Error(`Unknown requeue argument: ${unknown}`);
  const statuses = values.find((value) => value.startsWith('--statuses='))
    ?.slice('--statuses='.length)
    .split(',')
    .map((status) => status.trim())
    .filter(Boolean)
    ?? ['failed'];
  const invalid = statuses.find((status) => !REQUEUEABLE_STATUSES.has(status));
  if (invalid) {
    throw new Error(`--statuses may only contain ${[...REQUEUEABLE_STATUSES].join(', ')}; got "${invalid}".`);
  }
  return {
    fixtureIds,
    databasePath: values.find((value) => value.startsWith('--database='))
      ?.slice('--database='.length)
      ?? defaultDatabasePath,
    statuses,
    resetMaterialization: values.includes('--reset-materialization'),
  };
}

export function requeueFixtureCommentary(
  db: SqliteDatabase,
  fixtureId: string,
  statuses: readonly string[],
  resetMaterialization: boolean,
): Record<string, unknown> {
  const countByStatus = () => Object.fromEntries(
    (db.prepare(`
      SELECT enrichment_status AS status, COUNT(*) AS count
      FROM match_pulse_commentary_entries
      WHERE fixture_id = ?
      GROUP BY enrichment_status
    `).all(fixtureId) as Array<{ status: string; count: number }>)
      .map(({ status, count }) => [status, count]),
  );
  const before = countByStatus();
  const placeholders = statuses.map(() => '?').join(', ');

  db.exec('BEGIN IMMEDIATE');
  try {
    const requeued = db.prepare(`
      UPDATE match_pulse_commentary_entries
      SET enrichment_status = 'pending',
          generation = 'rule_based',
          entry_json = json_remove(
            json_set(
              entry_json,
              '$.enrichmentStatus', 'pending',
              '$.generation', 'rule_based',
              '$.commentary', COALESCE(json_extract(entry_json, '$.fallbackCommentary'), json_extract(entry_json, '$.commentary')),
              '$.voiceLine', COALESCE(json_extract(entry_json, '$.fallbackCommentary'), json_extract(entry_json, '$.commentary'))
            ),
            '$.coveredFrameIds',
            '$.enrichmentPromptVersion'
          ),
          updated_at = datetime('now')
      WHERE fixture_id = ? AND enrichment_status IN (${placeholders})
    `).run(fixtureId, ...statuses);

    // The claim query joins through the jobs table, so every pending entry
    // needs a claimable job row with a clean attempt counter.
    db.prepare(`
      DELETE FROM match_pulse_commentary_enrichment_jobs
      WHERE fixture_id = ?
        AND entry_id IN (
          SELECT id FROM match_pulse_commentary_entries
          WHERE fixture_id = ? AND enrichment_status = 'pending'
        )
    `).run(fixtureId, fixtureId);
    const jobsReset = db.prepare(`
      INSERT INTO match_pulse_commentary_enrichment_jobs (
        entry_id, fixture_id, status, attempts, next_attempt_at
      )
      SELECT id, fixture_id, 'pending', 0, 0
      FROM match_pulse_commentary_entries
      WHERE fixture_id = ? AND enrichment_status = 'pending'
    `).run(fixtureId);

    let materializationCleared = false;
    if (resetMaterialization) {
      const cleared = db.prepare(
        'DELETE FROM match_pulse_materializations WHERE fixture_id = ?',
      ).run(fixtureId);
      materializationCleared = Number(cleared.changes) > 0;
    }

    db.exec('COMMIT');
    return {
      fixtureId,
      requeuedStatuses: statuses,
      entriesRequeued: Number(requeued.changes),
      jobsReset: Number(jobsReset.changes),
      materializationCleared,
      before,
      after: countByStatus(),
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseRequeueArgs(process.argv.slice(2), loadConfig().matchPulseSqlitePath);
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const db = new DatabaseSync(options.databasePath);
  db.exec('PRAGMA busy_timeout = 5000;');
  try {
    const results = options.fixtureIds.map((fixtureId) =>
      requeueFixtureCommentary(db, fixtureId, options.statuses, options.resetMaterialization));
    console.log(JSON.stringify({ databasePath: options.databasePath, results }, null, 2));
  } finally {
    db.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
