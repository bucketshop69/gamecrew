import type { GameCrewMatchFilter, GameCrewMatchStatus, MatchClock, MatchPulseEvent } from '../match';
import type { TxlineScore } from './types';
import { getGameState, getScoreClockSeconds } from './score';

export function getMatchStatus(startTimeMs: number, latestScore?: TxlineScore): GameCrewMatchStatus {
  const now = Date.now();
  const liveWindowEnd = startTimeMs + 2.5 * 60 * 60 * 1000;
  const statusId = latestScore?.StatusId;
  const gameState = getGameState(latestScore);

  if (
    statusId === 5 ||
    statusId === 10 ||
    statusId === 13 ||
    (gameState && /final|ended|complete|full/i.test(gameState))
  ) {
    return 'replayable';
  }

  if (
    latestScore?.Clock?.Running ||
    statusId === 2 ||
    statusId === 3 ||
    statusId === 4 ||
    statusId === 7 ||
    statusId === 8 ||
    statusId === 9 ||
    statusId === 12 ||
    (now >= startTimeMs && now <= liveWindowEnd)
  ) {
    return 'live';
  }

  if (now > liveWindowEnd) {
    return 'replayable';
  }

  return 'upcoming';
}

export function getFilterForStatus(status: GameCrewMatchStatus): GameCrewMatchFilter {
  if (status === 'replayable' || status === 'finished') {
    return 'replay';
  }

  if (status === 'hosted') {
    return 'hosted';
  }

  return status;
}

export function getMatchClock(
  startTimeMs: number,
  status: GameCrewMatchStatus,
  latestScore?: TxlineScore,
): MatchClock {
  if (status === 'live') {
    const statusId = latestScore?.StatusId;
    if (statusId === 3 || statusId === 8) {
      return {
        label: 'Half time',
        phase: 'half_time',
      };
    }

    if (statusId === 6) {
      return {
        label: 'Extra time pending',
        phase: 'extra_time',
      };
    }

    const minute =
      latestScore?.minute ??
      latestScore?.matchMinute ??
      getClockMinute(latestScore) ??
      Math.max(1, Math.floor((Date.now() - startTimeMs) / 60000));
    return {
      minute,
      label: `Live ${minute}'`,
      phase: getClockPhase(statusId, minute),
    };
  }

  if (status === 'replayable') {
    return {
      label: getReplayClockLabel(latestScore),
      phase: 'replay_ready',
    };
  }

  return {
    label: formatKickoffLabel(startTimeMs),
    phase: 'pre_match',
  };
}

export function getPulseEventClock(seconds?: number): MatchPulseEvent['clock'] {
  if (typeof seconds !== 'number') {
    return {
      label: 'Match',
    };
  }

  const minute = Math.max(1, Math.floor(seconds / 60) + 1);
  return {
    seconds,
    minute,
    label: `${minute}'`,
  };
}

function getClockMinute(score?: TxlineScore): number | undefined {
  const seconds = score ? getScoreClockSeconds(score) : undefined;
  if (typeof seconds !== 'number') {
    return undefined;
  }

  return Math.max(1, Math.floor(seconds / 60) + 1);
}

function getClockPhase(statusId: number | undefined, minute: number): MatchClock['phase'] {
  if (statusId === 4) {
    return 'second_half';
  }

  if (statusId === 7 || statusId === 9 || minute > 90) {
    return 'extra_time';
  }

  return minute <= 45 ? 'first_half' : 'second_half';
}

function getReplayClockLabel(score?: TxlineScore): string {
  const gameState = getGameState(score);
  if (gameState && !/^scheduled$/i.test(gameState)) {
    return gameState;
  }

  return 'Full time';
}

function formatKickoffLabel(startTimeMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(startTimeMs));
}
