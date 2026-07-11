import type { MatchPulseSourceEventRef } from '../match';
import { getMatchClock, getMatchStatus, getPulseEventClock } from './clock';
import {
  getFixtureMatchScore,
  getGameState,
  getLatestClockScore,
  getLatestScore,
  getLatestStatsScore,
  getScoreClockSeconds,
  getScoreId,
  getScoreSeq,
  getScoreTimestamp,
} from './score';
import { getFixtureTeams, type TxlineFixtureTeams } from './teams';
import {
  getPulseIntensity,
  getPulseParticipant,
  getReadableAction,
  normalizeScorePulseAction,
} from './pulse';
import type {
  BuildTxlineMatchPulseSourceContextOptions,
  TxlineFixture,
  TxlineMatchPulseEventTeam,
  TxlineMatchPulseFreshness,
  TxlineMatchPulseSource,
  TxlineMatchPulseSourceContext,
  TxlineMatchPulseSourceEvent,
  TxlineScore,
} from './types';

export function buildTxlineMatchPulseSourceContext({
  fixture,
  snapshotScores = [],
  historyScores = [],
  updateScores = [],
  nowMs = Date.now(),
  staleAfterMs = 30_000,
}: BuildTxlineMatchPulseSourceContextOptions): TxlineMatchPulseSourceContext {
  const snapshotLatest = getLatestScore(snapshotScores);
  const allScores = [...snapshotScores, ...historyScores, ...updateScores];
  const latestScore = snapshotLatest ?? getLatestScore(allScores);
  const latestClock = getLatestClockScore(snapshotScores) ?? getLatestClockScore(allScores) ?? latestScore;
  const latestStats = getLatestStatsScore(snapshotScores) ?? getLatestStatsScore(allScores) ?? latestScore;
  const teams = getFixtureTeams(fixture);
  const status = getMatchStatus(fixture.StartTime, latestClock);
  const clock = getMatchClock(fixture.StartTime, status, latestClock);
  const snapshotEvents = mapTxlineSourceEvents({
    source: 'snapshot',
    fixture,
    fixtureId: String(fixture.FixtureId),
    scores: snapshotScores,
    teams,
  });
  const historyEvents = mapTxlineSourceEvents({
    source: 'history',
    fixture,
    fixtureId: String(fixture.FixtureId),
    scores: historyScores,
    teams,
  });
  const updateEvents = mapTxlineSourceEvents({
    source: 'update',
    fixture,
    fixtureId: String(fixture.FixtureId),
    scores: updateScores,
    teams,
  });
  const sourceEvents = [...snapshotEvents, ...historyEvents, ...updateEvents].sort(compareSourceEvents);

  return {
    fixture: {
      fixtureId: String(fixture.FixtureId),
      competition: fixture.Competition,
      competitionId: String(fixture.CompetitionId),
      fixtureGroupId: String(fixture.FixtureGroupId),
      kickoffUtc: new Date(fixture.StartTime).toISOString(),
    },
    homeTeam: teams.homeTeam,
    awayTeam: teams.awayTeam,
    status,
    score: getFixtureMatchScore(fixture, latestStats),
    clock,
    phase: clock.phase,
    snapshotScoreId: getScoreId(latestStats),
    sourceCounts: {
      snapshot: snapshotScores.length,
      history: historyScores.length,
      update: updateScores.length,
    },
    freshness: getSourceFreshness(allScores, nowMs, staleAfterMs),
    sourceEvents,
    snapshotEvents,
    historyEvents,
    updateEvents,
  };
}

function mapTxlineSourceEvents({
  source,
  fixture,
  fixtureId,
  scores,
  teams,
}: {
  source: TxlineMatchPulseSource;
  fixture: TxlineFixture;
  fixtureId: string;
  scores: readonly TxlineScore[];
  teams: TxlineFixtureTeams;
}): readonly TxlineMatchPulseSourceEvent[] {
  return [...scores].sort(compareScores).map((score) => {
    const rawAction = score.Action ?? score.action;
    const normalizedAction = normalizeScorePulseAction(score);
    const participant = getPulseParticipant(score.Participant);
    const team = getSourceEventTeam(participant, teams);
    const clockSeconds = getScoreClockSeconds(score);
    const clock = getPulseEventClock(clockSeconds);
    const timestamp = getScoreTimestamp(score) || undefined;
    const updatedAt = timestamp ? new Date(timestamp).toISOString() : undefined;
    const label = rawAction ? getReadableAction(rawAction, score.PossessionType) : undefined;
    const sourceRef: MatchPulseSourceEventRef = {
      kind: getSourceRefKind(source),
      id: getScoreId(score),
      fixtureId,
      seq: getScoreSeq(score),
      action: rawAction ?? normalizedAction,
      label,
      clock,
      participant,
      teamId: team?.id,
      teamName: team?.name,
      confirmed: score.Confirmed,
      scoreSnapshotId: source === 'snapshot' ? getScoreId(score) : undefined,
      historicalSnapshotId: source === 'history' ? getScoreId(score) : undefined,
      updatedAt,
    };

    return {
      source,
      sourceRef,
      fixtureId,
      seq: getScoreSeq(score),
      timestamp,
      updatedAt,
      rawAction,
      normalizedAction,
      label,
      intensity: getPulseIntensity(normalizedAction ?? rawAction ?? '', score.PossessionType),
      clock,
      clockSeconds,
      participant,
      team,
      confirmed: score.Confirmed,
      score: getFixtureMatchScore(fixture, score),
      gameState: getGameState(score),
      statusId: score.StatusId,
      possessionType: score.PossessionType,
    };
  });
}

function compareSourceEvents(left: TxlineMatchPulseSourceEvent, right: TxlineMatchPulseSourceEvent): number {
  return (
    left.seq - right.seq ||
    (left.timestamp ?? 0) - (right.timestamp ?? 0) ||
    (left.clockSeconds ?? -1) - (right.clockSeconds ?? -1)
  );
}

function compareScores(left: TxlineScore, right: TxlineScore): number {
  return (
    getScoreSeq(left) - getScoreSeq(right) ||
    getScoreTimestamp(left) - getScoreTimestamp(right) ||
    (getScoreClockSeconds(left) ?? -1) - (getScoreClockSeconds(right) ?? -1)
  );
}

function getSourceEventTeam(
  participant: 1 | 2 | undefined,
  teams: TxlineFixtureTeams,
): TxlineMatchPulseEventTeam | undefined {
  if (participant === 1) {
    const side = teams.participant1Team.id === teams.homeTeam.id ? 'home' : 'away';
    return {
      id: teams.participant1Team.id,
      name: teams.participant1Team.name,
      shortName: teams.participant1Team.shortName,
      side,
    };
  }

  if (participant === 2) {
    const side = teams.participant2Team.id === teams.homeTeam.id ? 'home' : 'away';
    return {
      id: teams.participant2Team.id,
      name: teams.participant2Team.name,
      shortName: teams.participant2Team.shortName,
      side,
    };
  }

  return undefined;
}

function getSourceRefKind(source: TxlineMatchPulseSource): MatchPulseSourceEventRef['kind'] {
  if (source === 'snapshot') {
    return 'txline_snapshot';
  }

  if (source === 'history') {
    return 'txline_history';
  }

  return 'txline_update';
}

function getSourceFreshness(
  scores: readonly TxlineScore[],
  nowMs: number,
  staleAfterMs: number,
): TxlineMatchPulseFreshness {
  const latestTimestamp = scores.reduce((latest, score) => Math.max(latest, getScoreTimestamp(score)), 0);
  if (!latestTimestamp) {
    return {
      status: 'empty',
      staleAfterMs,
    };
  }

  const ageMs = Math.max(0, nowMs - latestTimestamp);
  return {
    status: ageMs <= staleAfterMs ? 'fresh' : 'stale',
    latestTimestamp,
    updatedAt: new Date(latestTimestamp).toISOString(),
    ageMs,
    staleAfterMs,
  };
}
