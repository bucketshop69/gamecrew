import type { GameCrewMatch, MatchPulseCommentaryEntry } from '@gamecrew/core';

const gameCrewApiUrl = process.env.EXPO_PUBLIC_GAMECREW_API_URL ?? 'http://localhost:8787';

export const matchRefreshIntervalMs = 10_000;

interface MatchesResponse {
  source: 'txline' | 'engine' | 'combined' | 'sample' | 'sample-fallback';
  matches: readonly GameCrewMatch[];
}

export interface MatchPulseCommentaryResponse {
  fixtureId?: string;
  projectionGeneration?: number;
  entries: readonly MatchPulseCommentaryEntry[];
  source: 'engine' | 'txline';
  persistence: {
    inserted: number;
    updated: number;
    unchanged: number;
    store: string;
  };
}

export async function fetchGameCrewMatches({
  signal,
}: {
  signal?: AbortSignal;
} = {}): Promise<readonly GameCrewMatch[]> {
  const response = await fetch(`${gameCrewApiUrl}/matches`, { signal });
  const parsed = await readGameCrewResponse<MatchesResponse>(response);

  return parsed.matches;
}

export async function fetchMatchPulseCommentary(
  fixtureId: string,
  {
    signal,
  }: {
    signal?: AbortSignal;
  } = {},
): Promise<MatchPulseCommentaryResponse> {
  const response = await fetch(
    `${gameCrewApiUrl}/matches/${encodeURIComponent(fixtureId)}/pulse/commentary`,
    { signal },
  );
  const parsed = await readGameCrewResponse<MatchPulseCommentaryResponse>(response);

  return parsed;
}

async function readGameCrewResponse<T>(response: Response): Promise<T> {
  const body = await response.text();

  if (!response.ok) {
    throw new Error(body || `GameCrew API failed with ${response.status}`);
  }

  return JSON.parse(body) as T;
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}
