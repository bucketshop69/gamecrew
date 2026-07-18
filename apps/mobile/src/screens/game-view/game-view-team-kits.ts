import type { TeamColorSet } from '@gamecrew/core';

import type { ClusterRole } from '../game-view-players/cluster-choreography-logic';

export interface GameViewKitColors {
  shirt: string;
  shorts: string;
  trim: string;
}

export interface GameViewTeamKit {
  outfield: GameViewKitColors;
  keeper: GameViewKitColors;
  source: 'dictionary' | 'fallback';
  variant: 'home' | 'away' | 'fallback';
}

export interface GameViewKitTeamInput {
  name: string;
  countryCode?: string;
  colors: TeamColorSet;
  flagBands?: readonly string[];
}

interface KnownTeamKits {
  home: GameViewKitColors;
  away: GameViewKitColors;
  keeper: GameViewKitColors;
}

const KNOWN_TEAM_KITS: Readonly<Record<string, KnownTeamKits>> = {
  AR: kits('#75AADB', '#F7F7F7', '#FFFFFF', '#202B46', '#F5F5F5', '#75AADB', '#3A7D44'),
  AU: kits('#F5C400', '#135C35', '#135C35', '#172A46', '#F2F4E8', '#F5C400', '#D5463F'),
  BE: kits('#C91B2B', '#11131A', '#F3C300', '#F4E9D8', '#11131A', '#C91B2B', '#2B8C6F'),
  BR: kits('#F5D328', '#2456A6', '#17894C', '#2456A6', '#F4F0D5', '#F5D328', '#D94C3D'),
  CO: kits('#F4D126', '#223A70', '#C62935', '#223A70', '#F4F1DE', '#F4D126', '#28A37A'),
  CD: kits('#2461B2', '#D3323D', '#F4D126', '#F4F1DE', '#2461B2', '#D3323D', '#E67E22'),
  'GB-ENG': kits('#F4F4F2', '#24304D', '#C51F32', '#24304D', '#F4F4F2', '#5D78B5', '#F0C441'),
  FR: kits('#1B3F8B', '#F4F5F7', '#D72B3F', '#F3F1EA', '#1B3F8B', '#D72B3F', '#F0C53A'),
  DE: kits('#F4F3EE', '#17191E', '#D1A626', '#17191E', '#F4F3EE', '#C92F3A', '#3C9A6B'),
  JP: kits('#224D9B', '#203460', '#D3364A', '#F1EEE7', '#224D9B', '#D3364A', '#E0B33A'),
  MX: kits('#166B45', '#F2F0E9', '#B72D35', '#F2F0E9', '#7B1824', '#166B45', '#E0B43E'),
  MA: kits('#C1272D', '#B61E2A', '#087A4C', '#F4F2EC', '#F4F2EC', '#087A4C', '#68459B'),
  NL: kits('#E86A1C', '#242C48', '#F3E7D2', '#F1EEE6', '#242C48', '#E86A1C', '#3B8D6D'),
  PT: kits('#B51F31', '#176B45', '#E0B43E', '#F2F0E8', '#176B45', '#B51F31', '#4D62A5'),
  SN: kits('#F3F0E4', '#F3F0E4', '#16834F', '#16834F', '#F1E6C8', '#D33A3F', '#6B4DA0'),
  ES: kits('#C60B1E', '#24304D', '#F1BF00', '#D9E8EE', '#D9E8EE', '#C60B1E', '#35A7A0'),
  CH: kits('#D62C36', '#D62C36', '#F2F1EA', '#F2F1EA', '#D62C36', '#D62C36', '#E1B43A'),
  US: kits('#F2F1ED', '#25355B', '#B72234', '#25355B', '#F2F1ED', '#B72234', '#E6B83A'),
};

function kits(
  homeShirt: string,
  homeShorts: string,
  homeTrim: string,
  awayShirt: string,
  awayShorts: string,
  awayTrim: string,
  keeperShirt: string,
): KnownTeamKits {
  return {
    home: { shirt: homeShirt, shorts: homeShorts, trim: homeTrim },
    away: { shirt: awayShirt, shorts: awayShorts, trim: awayTrim },
    keeper: { shirt: keeperShirt, shorts: '#17191E', trim: '#F4F1E8' },
  };
}

export function resolveGameViewTeamKits(
  homeTeam: GameViewKitTeamInput,
  awayTeam: GameViewKitTeamInput,
): { home: GameViewTeamKit; away: GameViewTeamKit } {
  const home = resolveKnownOrFallback(homeTeam, 'home');
  const awayHome = resolveKnownOrFallback(awayTeam, 'home');
  if (!shirtsClash(home.outfield.shirt, awayHome.outfield.shirt)) {
    return { home, away: awayHome };
  }

  const knownAway = lookupKnown(awayTeam);
  if (knownAway) {
    return {
      home,
      away: {
        outfield: knownAway.away,
        keeper: knownAway.keeper,
        source: 'dictionary',
        variant: 'away',
      },
    };
  }

  const alternate = fallbackColors(awayTeam, true);
  return {
    home,
    away: { outfield: alternate.outfield, keeper: alternate.keeper, source: 'fallback', variant: 'fallback' },
  };
}

export function resolveFigureKitColors(
  kit: GameViewTeamKit,
  role: ClusterRole,
): GameViewKitColors {
  return role === 'keeper' ? kit.keeper : kit.outfield;
}

function resolveKnownOrFallback(team: GameViewKitTeamInput, variant: 'home' | 'away'): GameViewTeamKit {
  const known = lookupKnown(team);
  if (known) {
    return {
      outfield: known[variant],
      keeper: known.keeper,
      source: 'dictionary',
      variant,
    };
  }
  const fallback = fallbackColors(team, false);
  return { ...fallback, source: 'fallback', variant: 'fallback' };
}

function lookupKnown(team: GameViewKitTeamInput): KnownTeamKits | undefined {
  const code = team.countryCode?.toUpperCase();
  return code ? KNOWN_TEAM_KITS[code] : undefined;
}

function fallbackColors(team: GameViewKitTeamInput, alternate: boolean): Pick<GameViewTeamKit, 'outfield' | 'keeper'> {
  const candidates = [
    ...(team.flagBands ?? []),
    team.colors.primary,
    team.colors.secondary,
    team.colors.accent,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const shirt = (alternate ? candidates[1] : candidates[0]) ?? '#4C5D73';
  const shorts = candidates.find((candidate) => colorDistance(candidate, shirt) > 90) ?? '#F1F1ED';
  const trim = candidates.find((candidate) => candidate !== shirt && candidate !== shorts) ?? shorts;
  const keeperShirt = candidates.find((candidate) => colorDistance(candidate, shirt) > 150)
    ?? (brightness(shirt) > 145 ? '#263A67' : '#E2B83F');
  return {
    outfield: { shirt, shorts, trim },
    keeper: { shirt: keeperShirt, shorts: '#17191E', trim: '#F4F1E8' },
  };
}

function shirtsClash(left: string, right: string): boolean {
  return colorDistance(left, right) < 105;
}

function colorDistance(left: string, right: string): number {
  const l = channels(left);
  const r = channels(right);
  if (!l || !r) return Number.POSITIVE_INFINITY;
  return Math.hypot(l[0] - r[0], l[1] - r[1], l[2] - r[2]);
}

function brightness(color: string): number {
  const rgb = channels(color);
  return rgb ? (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 : 128;
}

function channels(color: string): [number, number, number] | undefined {
  const value = color.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return undefined;
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
}
