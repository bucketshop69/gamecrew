import type { GameCrewMatch } from '@gamecrew/core';

interface MatchListState {
  status: 'loading' | 'ready' | 'error';
  matches: readonly GameCrewMatch[];
}

export type MatchDetailResolution =
  | { status: 'loading' | 'error' | 'not_found' }
  | { status: 'ready'; match: GameCrewMatch };

export function resolveMatchDetail(
  state: MatchListState,
  fixtureId?: string,
): MatchDetailResolution {
  const match = fixtureId
    ? state.matches.find((candidate) => candidate.txline.fixtureId === fixtureId)
    : undefined;

  if (match) return { status: 'ready', match };
  if (state.status === 'ready') return { status: 'not_found' };
  return { status: state.status };
}
