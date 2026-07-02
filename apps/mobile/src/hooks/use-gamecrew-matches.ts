import type { GameCrewMatch } from '@gamecrew/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchGameCrewMatches, isAbortError, matchRefreshIntervalMs } from '../api/gamecrew';

export type MatchesLoadState =
  | { status: 'loading'; matches: readonly GameCrewMatch[] }
  | { status: 'ready'; matches: readonly GameCrewMatch[] }
  | { status: 'error'; matches: readonly GameCrewMatch[]; message: string };

export function useGameCrewMatches() {
  const [loadState, setLoadState] = useState<MatchesLoadState>({
    status: 'loading',
    matches: [],
  });
  const activeRequestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);

  const loadMatches = useCallback((showLoading = false) => {
    activeRequestRef.current?.abort();

    const controller = new AbortController();
    activeRequestRef.current = controller;

    setLoadState((current) =>
      showLoading || current.matches.length === 0 ? { status: 'loading', matches: current.matches } : current,
    );

    fetchGameCrewMatches({ signal: controller.signal })
      .then((matches) => {
        if (mountedRef.current && activeRequestRef.current === controller) {
          setLoadState({ status: 'ready', matches });
        }
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeRequestRef.current !== controller || isAbortError(error)) {
          return;
        }

        setLoadState((current) => ({
          status: 'error',
          matches: current.matches,
          message: error instanceof Error ? error.message : 'GameCrew API is unavailable.',
        }));
      })
      .finally(() => {
        if (activeRequestRef.current === controller) {
          activeRequestRef.current = null;
        }
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadMatches(true);

    const intervalId = setInterval(() => loadMatches(false), matchRefreshIntervalMs);

    return () => {
      mountedRef.current = false;
      clearInterval(intervalId);
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [loadMatches]);

  return { loadState, reload: () => loadMatches(true) };
}
