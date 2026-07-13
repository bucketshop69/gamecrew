import type { MatchPulseCommentaryEntry } from '@gamecrew/core';

interface PulseData {
  entries: readonly MatchPulseCommentaryEntry[];
  fixtureId: string;
  projectionGeneration?: number;
}

export type PulseLoadState =
  | ({ status: 'loading' } & PulseData)
  | ({ status: 'ready' } & PulseData)
  | ({ status: 'error'; message: string } & PulseData);

export function getVisiblePulseLoadState(
  state: PulseLoadState,
  fixtureId: string,
): PulseLoadState {
  return state.fixtureId === fixtureId
    ? state
    : { status: 'loading', entries: [], fixtureId };
}
