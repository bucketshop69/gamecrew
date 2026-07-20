import type { GameCrewMatch } from '@gamecrew/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  fetchGameCrewMatches,
  isAbortError,
  matchRefreshIntervalMs,
  resolvePollBackoffDelayMs,
} from '../api/gamecrew';

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
  const consecutiveFailuresRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
          consecutiveFailuresRef.current = 0;
          setLoadState({ status: 'ready', matches });
        }
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeRequestRef.current !== controller || isAbortError(error)) {
          return;
        }

        consecutiveFailuresRef.current += 1;
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

    // Backgrounded pollers should not keep hammering the API at a fixed
    // 10s cadence (or hot-looping on a failure backoff) while the user
    // isn't looking; pause while inactive and refresh immediately on return.
    const scheduleNext = () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      if (AppState.currentState !== 'active') return;

      const delayMs = resolvePollBackoffDelayMs(matchRefreshIntervalMs, consecutiveFailuresRef.current);
      timerRef.current = setTimeout(() => {
        loadMatches(false);
        scheduleNext();
      }, delayMs);
    };

    loadMatches(true);
    scheduleNext();

    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        consecutiveFailuresRef.current = 0;
        loadMatches(false);
        scheduleNext();
      } else if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    });

    return () => {
      mountedRef.current = false;
      appStateSubscription.remove();
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [loadMatches]);

  return { loadState, reload: () => loadMatches(true) };
}
