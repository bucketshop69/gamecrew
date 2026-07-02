import type { MatchPulseEvent } from '@gamecrew/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchMatchPulse, isAbortError, matchRefreshIntervalMs } from '../api/gamecrew';

export type PulseLoadState =
  | { status: 'loading'; events: readonly MatchPulseEvent[] }
  | { status: 'ready'; events: readonly MatchPulseEvent[] }
  | { status: 'error'; events: readonly MatchPulseEvent[]; message: string };

export function useMatchPulse(fixtureId: string) {
  const [pulseLoadState, setPulseLoadState] = useState<PulseLoadState>({
    status: 'loading',
    events: [],
  });
  const activeRequestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);

  const loadPulse = useCallback(
    (showLoading = false) => {
      activeRequestRef.current?.abort();

      const controller = new AbortController();
      activeRequestRef.current = controller;

      setPulseLoadState((current) =>
        showLoading || current.events.length === 0
          ? { status: 'loading', events: current.events }
          : current,
      );

      fetchMatchPulse(fixtureId, { signal: controller.signal })
        .then((events) => {
          if (mountedRef.current && activeRequestRef.current === controller) {
            setPulseLoadState({ status: 'ready', events });
          }
        })
        .catch((error: unknown) => {
          if (!mountedRef.current || activeRequestRef.current !== controller || isAbortError(error)) {
            return;
          }

          setPulseLoadState((current) => {
            if (!showLoading && current.events.length > 0) {
              return current;
            }

            return {
              status: 'error',
              events: current.events,
              message: error instanceof Error ? error.message : 'Match Pulse is unavailable.',
            };
          });
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

    const intervalId = setInterval(() => loadPulse(false), matchRefreshIntervalMs);

    return () => {
      mountedRef.current = false;
      clearInterval(intervalId);
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [loadPulse]);

  return { pulseLoadState, reload: () => loadPulse(true) };
}
