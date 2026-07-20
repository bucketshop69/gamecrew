import { AppState } from 'react-native';

import {
  engineFramesPollIntervalMs,
  fetchEngineFrames,
  pollBackoffCapMs,
  pollMaxBackoffAttempts,
} from '../api/gamecrew';
import type { MatchSessionDeps } from './match-session';

/**
 * Real (network + real timers) deps for `acquireMatchSession`. Kept in its
 * own module, separate from `match-session.ts`, so the session's core logic
 * has no runtime import of `../api/gamecrew` or `react-native` and can be
 * exercised directly by the mobile package's plain-Node test runner (see
 * match-session.ts's header comment). Only the React hook layer
 * (`use-playback-engine.ts`) imports this file.
 */
export function createMatchSessionDefaultDeps(isLive: () => boolean): MatchSessionDeps {
  return {
    fetchFrames: (fixtureId, options) => fetchEngineFrames(fixtureId, options),
    isLive,
    isAppActive: () => AppState.currentState === 'active',
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    pollIntervalMs: engineFramesPollIntervalMs,
    staleAfterMs: engineFramesPollIntervalMs * 3,
    pollBackoffCapMs,
    pollMaxBackoffAttempts,
  };
}
