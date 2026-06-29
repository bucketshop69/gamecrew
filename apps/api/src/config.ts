import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface ApiConfig {
  host: string;
  port: number;
  txlineApiToken: string;
  txlineBaseUrl: string;
}

export function loadConfig(): ApiConfig {
  const env = loadEnvFile(findEnvFile());
  const txlineApiToken = process.env.TXLINE_API_TOKEN ?? env.TXLINE_API_TOKEN;

  if (!txlineApiToken) {
    throw new Error('TXLINE_API_TOKEN is missing. Add it to .env.local before starting the API.');
  }

  return {
    host: process.env.HOST ?? env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? env.PORT ?? 8787),
    txlineApiToken,
    txlineBaseUrl: process.env.TXLINE_BASE_URL ?? env.TXLINE_BASE_URL ?? 'https://txline.txodds.com',
  };
}

function findEnvFile(): string {
  if (process.env.TXLINE_ENV_PATH) {
    return process.env.TXLINE_ENV_PATH;
  }

  let directory = resolve(process.cwd());
  while (true) {
    const envPath = join(directory, '.env.local');
    if (existsSync(envPath)) {
      return envPath;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return resolve(process.cwd(), '.env.local');
    }

    directory = parent;
  }
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
