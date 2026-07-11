import type { MatchScore } from '../match';
import type { TxlineFixture, TxlineScore } from './types';

export function getScoreTimestamp(score: TxlineScore): number {
  return score.Ts ?? score.ts ?? 0;
}

export function getScoreSeq(score: TxlineScore): number {
  return score.Seq ?? score.seq ?? getScoreTimestamp(score);
}

export function getScoreClockSeconds(score: TxlineScore): number | undefined {
  return typeof score.Clock?.Seconds === 'number' ? score.Clock.Seconds : undefined;
}

export function getScoreId(score?: TxlineScore): string | undefined {
  const id = score?.id ?? score?.Id;
  return id === undefined ? undefined : String(id);
}

export function getGameState(score?: TxlineScore): string | undefined {
  return score?.GameState ?? score?.gameState;
}

export function getLatestScore(scores: readonly TxlineScore[]): TxlineScore | undefined {
  return [...scores].sort((left, right) => getScoreTimestamp(right) - getScoreTimestamp(left))[0];
}

export function getLatestClockScore(scores: readonly TxlineScore[]): TxlineScore | undefined {
  return [...scores]
    .filter((score) => typeof score.Clock?.Seconds === 'number')
    .sort((left, right) => getScoreTimestamp(right) - getScoreTimestamp(left))[0];
}

export function getLatestStatsScore(scores: readonly TxlineScore[]): TxlineScore | undefined {
  return [...scores]
    .filter((score) => score.Stats && typeof score.Stats['1'] === 'number' && typeof score.Stats['2'] === 'number')
    .sort((left, right) => getScoreTimestamp(right) - getScoreTimestamp(left))[0];
}

export function getFixtureMatchScore(fixture: TxlineFixture, score?: TxlineScore): MatchScore | undefined {
  const participantScores = getParticipantScores(score);
  if (!participantScores) {
    return undefined;
  }

  return fixture.Participant1IsHome
    ? {
        home: participantScores.participant1,
        away: participantScores.participant2,
      }
    : {
        home: participantScores.participant2,
        away: participantScores.participant1,
      };
}

function getParticipantScores(score?: TxlineScore): { participant1: number; participant2: number } | undefined {
  if (!score) {
    return undefined;
  }

  const home = score.homeScore ?? score.participant1Score ?? score.score1 ?? score.Stats?.['1'];
  const away = score.awayScore ?? score.participant2Score ?? score.score2 ?? score.Stats?.['2'];

  if (typeof home !== 'number' || typeof away !== 'number') {
    return undefined;
  }

  return {
    participant1: home,
    participant2: away,
  };
}
