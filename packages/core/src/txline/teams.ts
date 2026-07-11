import type { MatchTeam, TeamColorSet } from '../match';
import type { TxlineFixture } from './types';
import { countryVisuals, fallbackVisuals } from './visuals';

export interface TxlineFixtureTeams {
  participant1Team: MatchTeam;
  participant2Team: MatchTeam;
  homeTeam: MatchTeam;
  awayTeam: MatchTeam;
}

export function buildTeam({ id, name }: { id: number; name: string }): MatchTeam {
  const visual = countryVisuals[name] ?? getFallbackVisual(id);

  return {
    id: `txline-team-${id}`,
    name,
    shortName: getShortName(name),
    countryCode: visual.code ?? getShortName(name),
    colors: visual.colors,
    flag: {
      code: visual.code ?? getShortName(name),
      bands: visual.bands,
    },
  };
}

export function getFixtureTeams(fixture: TxlineFixture): TxlineFixtureTeams {
  const participant1Team = buildTeam({
    id: fixture.Participant1Id,
    name: fixture.Participant1,
  });
  const participant2Team = buildTeam({
    id: fixture.Participant2Id,
    name: fixture.Participant2,
  });

  return {
    participant1Team,
    participant2Team,
    homeTeam: fixture.Participant1IsHome ? participant1Team : participant2Team,
    awayTeam: fixture.Participant1IsHome ? participant2Team : participant1Team,
  };
}

function getFallbackVisual(id: number): { code?: string; bands: readonly string[]; colors: TeamColorSet } {
  return fallbackVisuals[Math.abs(id) % fallbackVisuals.length] ?? fallbackVisuals[0];
}

function getShortName(name: string): string {
  const compact = name.replace(/[^a-z]/gi, '');
  return compact.slice(0, 3).toUpperCase() || 'TBD';
}
