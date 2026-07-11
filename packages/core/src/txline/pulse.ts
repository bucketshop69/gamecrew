import type { MatchPulse, MatchPulseEvent, MatchPulseEventAction, MatchPulseIntensity, MatchTeam } from '../match';
import { getPulseEventClock } from './clock';
import { getScoreClockSeconds, getScoreSeq, getScoreTimestamp } from './score';
import type { TxlineScore } from './types';

export function mapTxlineScoresToMatchPulseEvents(
  fixtureId: string,
  scores: readonly TxlineScore[],
): readonly MatchPulseEvent[] {
  const sortedScores = [...scores].sort((left, right) => getScoreSeq(left) - getScoreSeq(right));
  const deduped = new Map<string, TxlineScore>();

  for (const score of sortedScores) {
    const action = normalizeScorePulseAction(score);
    if (!action || !usefulPulseActions.has(action)) {
      continue;
    }

    const dedupeKey = `${action}:${getScoreClockSeconds(score) ?? 'none'}:${score.Participant ?? 'none'}`;
    const existing = deduped.get(dedupeKey);
    if (!existing || (!existing.Confirmed && score.Confirmed)) {
      deduped.set(dedupeKey, score);
    }
  }

  return [...deduped.values()]
    .sort((left, right) => getScoreSeq(left) - getScoreSeq(right))
    .map((score, index) => {
      const action = normalizeScorePulseAction(score) ?? 'kickoff';
      const participant = getPulseParticipant(score.Participant);
      const clockSeconds = getScoreClockSeconds(score);

      return {
        id: `${fixtureId}-${getScoreSeq(score)}-${action}-${index}`,
        fixtureId,
        seq: getScoreSeq(score),
        action,
        label: getPulseEventLabel(action, participant),
        intensity: getPulseIntensity(action),
        clock: getPulseEventClock(clockSeconds),
        participant,
        confirmed: score.Confirmed,
        updatedAt: score.Ts ? new Date(score.Ts).toISOString() : undefined,
      };
    });
}

export function getLatestPulseScore(scores: readonly TxlineScore[]): TxlineScore | undefined {
  return [...scores]
    .filter(isPulseEvent)
    .sort((left, right) => getScoreTimestamp(right) - getScoreTimestamp(left))[0];
}

export function getMatchPulse(
  score: TxlineScore | undefined,
  homeTeam: MatchTeam,
  awayTeam: MatchTeam,
): MatchPulse | undefined {
  const action = score?.Action ?? score?.action;
  if (!score || !action) {
    return undefined;
  }

  const team = score.Participant === 1 ? homeTeam : score.Participant === 2 ? awayTeam : undefined;
  const readableAction = getReadableAction(action, score.PossessionType);

  return {
    action,
    label: team ? `${team.shortName}: ${readableAction}` : readableAction,
    intensity: getPulseIntensity(action, score.PossessionType),
    verified: score.Confirmed,
    teamId: team?.id,
    updatedAt: score.Ts ? new Date(score.Ts).toISOString() : undefined,
  };
}

export function normalizeScorePulseAction(score: TxlineScore): MatchPulseEventAction | undefined {
  return normalizePulseAction(score.Action ?? score.action, score.PossessionType);
}

export function normalizePulseAction(
  action: string | undefined,
  possessionType?: string,
): MatchPulseEventAction | undefined {
  const normalizedAction = toSnakeCase(action);
  const normalizedPossessionType = toSnakeCase(possessionType);

  if (
    normalizedAction === 'possession' &&
    (normalizedPossessionType === 'danger_possession' ||
      normalizedPossessionType === 'high_danger_possession')
  ) {
    return normalizedPossessionType;
  }

  if (usefulPulseActions.has(normalizedAction as MatchPulseEventAction)) {
    return normalizedAction as MatchPulseEventAction;
  }

  return undefined;
}

export function getPulseParticipant(participant: number | undefined): 1 | 2 | undefined {
  return participant === 1 || participant === 2 ? participant : undefined;
}

export function getReadableAction(action: string, possessionType?: string): string {
  if (possessionType === 'HighDangerPossession') {
    return 'high danger attack';
  }

  if (possessionType === 'DangerPossession') {
    return 'danger attack';
  }

  return action
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

export function getPulseIntensity(action: string, possessionType?: string): MatchPulseIntensity {
  if (action === 'goal' || action === 'penalty' || action === 'red_card') {
    return 'major';
  }

  if (
    action === 'shot' ||
    action === 'corner' ||
    action === 'danger_possession' ||
    action === 'high_danger_possession' ||
    possessionType === 'DangerPossession' ||
    possessionType === 'HighDangerPossession'
  ) {
    return 'danger';
  }

  if (action === 'attack_possession' || action === 'free_kick' || action === 'yellow_card' || action === 'injury') {
    return 'building';
  }

  return 'quiet';
}

function isPulseEvent(score: TxlineScore): boolean {
  const action = score.Action ?? score.action;
  if (!action) {
    return false;
  }

  return !ignoredPulseActions.has(toSnakeCase(action));
}

function getPulseEventLabel(action: MatchPulseEventAction, participant?: 1 | 2): string {
  const label = getReadableAction(action);
  if (!participant) {
    return label;
  }

  return `${participant === 1 ? 'Home' : 'Away'}: ${label}`;
}

function toSnakeCase(value: string | undefined): string {
  if (!value) {
    return '';
  }

  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}

const ignoredPulseActions = new Set([
  'comment',
  'connected',
  'coverage_update',
  'disconnected',
  'jersey',
  'lineups',
  'pitch',
  'standby',
  'status',
  'weather',
]);

const usefulPulseActions = new Set<MatchPulseEventAction>([
  'kickoff',
  'goal',
  'shot',
  'corner',
  'free_kick',
  'throw_in',
  'danger_possession',
  'high_danger_possession',
  'yellow_card',
  'red_card',
  'substitution',
  'injury',
  'var',
  'game_finalised',
]);
