/**
 * Team-color derivation for Game View's board/takeover renderers, which need
 * one representative color per team (not a full flag). Ported from the
 * retired scripted demo (`match-preview-screen.tsx`'s `getTeamColor`), which
 * derived a single readable accent from a team's flag color bands -- the
 * only per-team color source `GameCrewMatch`/`MatchTeam` carries today (see
 * `packages/core/src/match.ts`'s `FlagVisual`). Kept as its own pure module
 * so both the takeover-variant screen wiring and its tests can reuse it
 * without pulling in the deleted demo file.
 */

/**
 * Picks a representative color from a team's flag bands: prefers a band
 * that's neither near-black nor near-white (so it reads against the black
 * shell and against team-colored possession presence), and when `avoidColor`
 * is supplied (the other team's chosen color), prefers whichever readable
 * candidate is most different from it so home/away never collide.
 */
export function getTeamColor(
  bands: readonly string[],
  fallback: string,
  avoidColor?: string,
): string {
  const candidates = bands.filter((band) => {
    const channels = getColorChannels(band);
    if (!channels) return false;
    const brightness = (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 1_000;
    return brightness > 28 && brightness < 235;
  });

  if (!avoidColor || candidates.length < 2) {
    return candidates[0] ?? bands[0] ?? fallback;
  }

  return [...candidates].sort(
    (left, right) => colorDistance(right, avoidColor) - colorDistance(left, avoidColor),
  )[0] ?? fallback;
}

function colorDistance(left: string, right: string): number {
  const leftChannels = getColorChannels(left);
  const rightChannels = getColorChannels(right);
  if (!leftChannels || !rightChannels) return 0;

  return Math.hypot(
    leftChannels[0] - rightChannels[0],
    leftChannels[1] - rightChannels[1],
    leftChannels[2] - rightChannels[2],
  );
}

function getColorChannels(color: string): [number, number, number] | undefined {
  const normalized = color.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return undefined;
  return [0, 2, 4].map(
    (offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16),
  ) as [number, number, number];
}

/** Default home/away accent fallbacks, matching the retired demo's constants. */
export const DEFAULT_HOME_COLOR = '#2D6CDF';
export const DEFAULT_AWAY_COLOR = '#E23546';
