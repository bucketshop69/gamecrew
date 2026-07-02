import type { GameCrewMatch, MatchPulseEvent } from '@gamecrew/core';

const gameCrewApiUrl = process.env.EXPO_PUBLIC_GAMECREW_API_URL ?? 'http://localhost:8787';

export const matchRefreshIntervalMs = 10_000;

interface MatchesResponse {
  source: 'txline' | 'sample' | 'sample-fallback';
  matches: readonly GameCrewMatch[];
}

interface MatchPulseResponse {
  source: 'txline';
  events: readonly MatchPulseEvent[];
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

export async function fetchMatchPulse(
  fixtureId: string,
  {
    signal,
  }: {
    signal?: AbortSignal;
  } = {},
): Promise<readonly MatchPulseEvent[]> {
  const response = await fetch(`${gameCrewApiUrl}/matches/${encodeURIComponent(fixtureId)}/pulse`, {
    signal,
  });
  const parsed = await readGameCrewResponse<MatchPulseResponse>(response);

  return parsed.events;
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
