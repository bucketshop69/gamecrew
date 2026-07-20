import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  fetchMatchPulseCommentary,
  isAbortError,
  matchRefreshIntervalMs,
  resolvePollBackoffDelayMs,
} from '../api/gamecrew';
import { getVisiblePulseLoadState, type PulseLoadState } from './match-pulse-state';

export type { PulseLoadState } from './match-pulse-state';

export function useMatchPulse(fixtureId: string, isLive: boolean) {
  const [pulseLoadState, setPulseLoadState] = useState<PulseLoadState>({
    status: 'loading',
    entries: [],
    fixtureId,
  });
  const activeRequestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const consecutiveFailuresRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadPulse = useCallback(
    (showLoading = false) => {
      activeRequestRef.current?.abort();

      const controller = new AbortController();
      activeRequestRef.current = controller;

      setPulseLoadState((current) =>
        current.fixtureId !== fixtureId
          ? {
              status: 'loading',
              entries: [],
              fixtureId,
            }
          : showLoading && current.entries.length === 0
          ? {
              status: 'loading',
              entries: current.entries,
              fixtureId,
              projectionGeneration: current.projectionGeneration,
            }
          : current,
      );

      fetchMatchPulseCommentary(fixtureId, { signal: controller.signal })
        .then((result) => {
          if (mountedRef.current && activeRequestRef.current === controller) {
            consecutiveFailuresRef.current = 0;
            setPulseLoadState({
              status: 'ready',
              entries: result.entries,
              fixtureId,
              projectionGeneration: result.projectionGeneration,
            });
          }
        })
        .catch((error: unknown) => {
          if (!mountedRef.current || activeRequestRef.current !== controller || isAbortError(error)) {
            return;
          }

          consecutiveFailuresRef.current += 1;
          setPulseLoadState((current) => ({
            status: 'error',
            entries: current.entries,
            fixtureId,
            projectionGeneration: current.projectionGeneration,
            message: error instanceof Error ? error.message : 'Match Pulse is unavailable.',
          }));
        })
        .finally(() => {
          if (activeRequestRef.current === controller) {
            activeRequestRef.current = null;
          }
        });
    },
    [fixtureId],
  );

  useEffect(() => {
    mountedRef.current = true;

    // As with use-gamecrew-matches.ts: pause polling while backgrounded and
    // refresh immediately on return, and back off on consecutive failures
    // instead of retrying at a fixed 10s cadence forever.
    const scheduleNext = () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      if (!isLive || AppState.currentState !== 'active') return;

      const delayMs = resolvePollBackoffDelayMs(matchRefreshIntervalMs, consecutiveFailuresRef.current);
      timerRef.current = setTimeout(() => {
        loadPulse(false);
        scheduleNext();
      }, delayMs);
    };

    loadPulse(true);
    scheduleNext();

    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        consecutiveFailuresRef.current = 0;
        if (isLive) loadPulse(false);
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
  }, [isLive, loadPulse]);

  const visiblePulseLoadState = getVisiblePulseLoadState(pulseLoadState, fixtureId);

  return { pulseLoadState: visiblePulseLoadState, reload: () => loadPulse(true) };
}
