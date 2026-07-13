import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchMatchPulseCommentary,
  isAbortError,
  matchRefreshIntervalMs,
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

    loadPulse(true);

    const intervalId = isLive
      ? setInterval(() => loadPulse(false), matchRefreshIntervalMs)
      : undefined;

    return () => {
      mountedRef.current = false;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
      }
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [isLive, loadPulse]);

  const visiblePulseLoadState = getVisiblePulseLoadState(pulseLoadState, fixtureId);

  return { pulseLoadState: visiblePulseLoadState, reload: () => loadPulse(true) };
}
