import type { GameCrewMatch } from '@gamecrew/core';

export type HomeSection = 'featured' | 'recent';

export interface HomeMatchSections {
  featuredMatches: GameCrewMatch[];
  recentMatches: GameCrewMatch[];
}

export const HOME_SECTION_HYSTERESIS = 32;

function compareRecentMatches(
  left: GameCrewMatch,
  right: GameCrewMatch,
): number {
  const kickoffOrder = Date.parse(right.kickoffUtc) - Date.parse(left.kickoffUtc);

  if (kickoffOrder !== 0) return kickoffOrder;

  return left.txline.fixtureId.localeCompare(right.txline.fixtureId);
}

/** Splits canonical matches into the two Home surfaces without mutating the API list. */
export function partitionHomeMatches(
  matches: readonly GameCrewMatch[],
): HomeMatchSections {
  const featuredMatches = matches.filter(
    (match) => match.status === 'live' || match.status === 'upcoming',
  );
  const recentMatches = matches
    .filter(
      (match) => match.status === 'finished' || match.status === 'replayable',
    )
    .sort(compareRecentMatches);

  return { featuredMatches, recentMatches };
}

/**
 * Resolves the contextual Home section while retaining the current section
 * inside a dead band around the recent-games boundary.
 */
export function resolveHomeSection(
  currentSection: HomeSection,
  scrollOffsetY: number,
  recentSectionBoundaryY: number,
  hysteresis = HOME_SECTION_HYSTERESIS,
): HomeSection {
  const deadBand = Math.max(0, hysteresis);

  if (
    currentSection === 'featured'
    && scrollOffsetY > recentSectionBoundaryY + deadBand
  ) {
    return 'recent';
  }

  if (
    currentSection === 'recent'
    && scrollOffsetY < recentSectionBoundaryY - deadBand
  ) {
    return 'featured';
  }

  return currentSection;
}
