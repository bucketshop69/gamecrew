import type { GameCrewMatch } from '../match';
import { getFilterForStatus, getMatchClock, getMatchStatus } from './clock';
import { getLatestClockScore, getLatestScore, getLatestStatsScore, getScoreId, getFixtureMatchScore } from './score';
import { getFixtureTeams } from './teams';
import { getLatestPulseScore, getMatchPulse } from './pulse';
import type { TxlineFixture, TxlineMatchQuery, TxlineScore } from './types';

export function mapTxlineFixtureToGameCrewMatch(
  fixture: TxlineFixture,
  scores: readonly TxlineScore[] = [],
): GameCrewMatch {
  const latestScore = getLatestScore(scores);
  const latestClock = getLatestClockScore(scores) ?? latestScore;
  const latestStats = getLatestStatsScore(scores) ?? latestScore;
  const latestPulse = getLatestPulseScore(scores);
  const kickoffUtc = new Date(fixture.StartTime).toISOString();
  const status = getMatchStatus(fixture.StartTime, latestClock);
  const filter = getFilterForStatus(status);
  const clock = getMatchClock(fixture.StartTime, status, latestClock);
  const teams = getFixtureTeams(fixture);

  return {
    id: `txline-${fixture.FixtureId}`,
    txline: {
      fixtureId: String(fixture.FixtureId),
      scoreSnapshotId: getScoreId(latestStats),
      source: 'live',
    },
    filter,
    status,
    competition: fixture.Competition,
    round: getRoundLabel(fixture.FixtureGroupId),
    kickoffUtc,
    homeTeam: teams.homeTeam,
    awayTeam: teams.awayTeam,
    score: getFixtureMatchScore(fixture, latestStats),
    clock,
    pulse: status === 'live'
      ? getMatchPulse(latestPulse, teams.participant1Team, teams.participant2Team)
      : undefined,
    replay: status === 'replayable' ? { available: true, label: 'Replay ready' } : undefined,
  };
}

export function applyMatchQuery(
  matches: readonly GameCrewMatch[],
  query: TxlineMatchQuery = {},
): readonly GameCrewMatch[] {
  const filteredMatches = query.filter
    ? matches.filter((match) => match.filter === query.filter)
    : matches;

  return typeof query.limit === 'number' ? filteredMatches.slice(0, query.limit) : filteredMatches;
}

function getRoundLabel(fixtureGroupId: number): string {
  return fixtureGroupId === 10115677 ? 'World Cup' : `Fixture group ${fixtureGroupId}`;
}
