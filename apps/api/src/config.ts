import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface ApiConfig {
  host: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmEnabled: boolean;
  llmBatchSize: number;
  llmModel: string;
  llmTimeoutMs: number;
  matchPulseStoreDriver: 'file' | 'sqlite';
  matchPulseStorePath: string;
  matchPulseSqlitePath: string;
  port: number;
  txlineApiToken: string;
  txlineBaseUrl: string;
  txlineFinalisationCorrectionMs: number;
}

export function loadConfig(): ApiConfig {
  const env = loadEnvFiles(findEnvFiles());
  const txlineApiToken = process.env.TXLINE_API_TOKEN ?? env.TXLINE_API_TOKEN;

  if (!txlineApiToken) {
    throw new Error('TXLINE_API_TOKEN is missing. Add it to .env.local before starting the API.');
  }

  return {
    host: process.env.HOST ?? env.HOST ?? '0.0.0.0',
    llmApiKey: process.env.MATCH_PULSE_LLM_API_KEY ?? env.MATCH_PULSE_LLM_API_KEY,
    llmBaseUrl: normalizeOptionalUrl(process.env.MATCH_PULSE_LLM_BASE_URL ?? env.MATCH_PULSE_LLM_BASE_URL),
    llmEnabled: parseBoolean(process.env.MATCH_PULSE_LLM_ENABLED ?? env.MATCH_PULSE_LLM_ENABLED),
    llmBatchSize: Number(process.env.MATCH_PULSE_LLM_BATCH_SIZE ?? env.MATCH_PULSE_LLM_BATCH_SIZE ?? 16),
    llmModel: process.env.MATCH_PULSE_LLM_MODEL ?? env.MATCH_PULSE_LLM_MODEL ?? 'gemma-4-12b-it',
    llmTimeoutMs: Number(process.env.MATCH_PULSE_LLM_TIMEOUT_MS ?? env.MATCH_PULSE_LLM_TIMEOUT_MS ?? 20_000),
    matchPulseStoreDriver: parseMatchPulseStoreDriver(
      process.env.MATCH_PULSE_STORE_DRIVER ?? env.MATCH_PULSE_STORE_DRIVER,
    ),
    matchPulseStorePath: process.env.MATCH_PULSE_STORE_PATH ??
      env.MATCH_PULSE_STORE_PATH ??
      resolve(process.cwd(), '.data/match-pulse-commentary.json'),
    matchPulseSqlitePath: process.env.MATCH_PULSE_SQLITE_PATH ??
      env.MATCH_PULSE_SQLITE_PATH ??
      resolve(process.cwd(), '.data/match-pulse.sqlite'),
    port: Number(process.env.PORT ?? env.PORT ?? 8787),
    txlineApiToken,
    txlineBaseUrl: process.env.TXLINE_BASE_URL ?? env.TXLINE_BASE_URL ?? 'https://txline.txodds.com',
    txlineFinalisationCorrectionMs: parseNonNegativeNumber(
      process.env.TXLINE_FINALISATION_CORRECTION_MS
        ?? env.TXLINE_FINALISATION_CORRECTION_MS,
      15 * 60_000,
    ),
  };
}

function parseBoolean(value?: string): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeOptionalUrl(value?: string): string | undefined {
  return value ? value.replace(/\/$/, '') : undefined;
}

function parseMatchPulseStoreDriver(value?: string): ApiConfig['matchPulseStoreDriver'] {
  if (value === 'file' || value === 'sqlite') {
    return value;
  }

  return 'sqlite';
}

function findEnvFiles(): readonly string[] {
  if (process.env.TXLINE_ENV_PATH) {
    return [process.env.TXLINE_ENV_PATH];
  }

  let directory = resolve(process.cwd());
  while (true) {
    const envPath = join(directory, '.env.local');
    if (existsSync(envPath)) {
      const coreEnvPath = join(directory, 'packages/core/.env');
      return existsSync(coreEnvPath) ? [coreEnvPath, envPath] : [envPath];
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return [resolve(process.cwd(), '.env.local')];
    }

    directory = parent;
  }
}

function loadEnvFiles(paths: readonly string[]): Record<string, string> {
  return Object.assign({}, ...paths.map(loadEnvFile));
}

function loadEnvFile(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } catch {
    return {};
  }
}
