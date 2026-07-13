import type { MatchPulseCommentaryEntry } from '@gamecrew/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchMatchPulseCommentary,
  isAbortError,
  matchRefreshIntervalMs,
} from '../api/gamecrew';

interface PulseData {
  entries: readonly MatchPulseCommentaryEntry[];
  projectionGeneration?: number;
}

export type PulseLoadState =
  | ({ status: 'loading' } & PulseData)
  | ({ status: 'ready' } & PulseData)
  | ({ status: 'error'; message: string } & PulseData);

export function useMatchPulse(fixtureId: string, isLive: boolean) {
  const [pulseLoadState, setPulseLoadState] = useState<PulseLoadState>({
    status: 'loading',
    entries: [],
  });
  const activeRequestRef = useRef<AbortController | null>(null);
  const activeFixtureIdRef = useRef(fixtureId);
  const mountedRef = useRef(false);

  const loadPulse = useCallback(
    (showLoading = false) => {
      activeRequestRef.current?.abort();

      const controller = new AbortController();
      activeRequestRef.current = controller;

      setPulseLoadState((current) =>
        showLoading && current.entries.length === 0
          ? {
              status: 'loading',
              entries: current.entries,
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

    if (activeFixtureIdRef.current !== fixtureId) {
      activeFixtureIdRef.current = fixtureId;
      setPulseLoadState({ status: 'loading', entries: [] });
    }

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

  return { pulseLoadState, reload: () => loadPulse(true) };
}
