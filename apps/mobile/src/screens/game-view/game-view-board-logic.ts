import type {
  GameViewScene,
  GameViewZone,
  MatchEngineParticipant,
} from '@gamecrew/core';

/**
 * Pure logic for the Game View ambient board renderer (work item B1 of
 * docs/issues/game-view-board-and-presentation.md). Extracted from the
 * rendering component so zone->layout, pressure->intensity, direction/flip,
 * and accessibility-label logic can be tested without exercising React
 * Native rendering. See docs/prds/game_view.md ("Ambient scene semantics",
 * "Visual Direction") for the product rules this encodes.
 *
 * Honesty Rule reminder (see PRD): a zone is a semantic band for animation,
 * never an asserted pitch coordinate. `zoneToBandPosition` returns a
 * presentation position along the pitch's attacking axis, not a claim about
 * where the ball actually is.
 */

/** Ordered defensive -> attacking progression the board lays zones out on. */
const ZONE_ORDER: readonly GameViewZone[] = ['safe', 'neutral', 'attack', 'danger', 'high_danger'];

/**
 * Normalized position (0 = the owning team's own goal line, 1 = the
 * opponent's goal line) along the attacking axis for each zone band. Values
 * are spaced so `danger`/`high_danger` sit visibly close to goal without
 * touching the line, matching "zones are subtle structure, not loud chrome."
 */
const ZONE_BAND_POSITION: Record<GameViewZone, number> = {
  safe: 0.16,
  neutral: 0.5,
  attack: 0.68,
  danger: 0.84,
  high_danger: 0.94,
};

/** Human-readable zone labels for pitch band chrome and accessibility copy. */
export const ZONE_LABELS: Record<GameViewZone, string> = {
  safe: 'Defensive third',
  neutral: 'Midfield',
  attack: 'Attacking third',
  danger: 'Danger zone',
  high_danger: 'High danger',
};

export type BoardDirection = 'up' | 'down';

/**
 * Which visual direction (up the board toward the top edge, or down toward
 * the bottom edge) participant 1 attacks. Participant 2 always attacks the
 * opposite edge. This is presentation-only: it lets home/away flip sides
 * consistently as possession changes without the renderer inventing new
 * state, matching "possession changes flip the presence to the other team's
 * color and direction."
 */
export function directionForParticipant(
  participant: MatchEngineParticipant | undefined,
  participant1Direction: BoardDirection = 'up',
): BoardDirection | undefined {
  if (participant === undefined) return undefined;
  if (participant === 1) return participant1Direction;
  return participant1Direction === 'up' ? 'down' : 'up';
}

/**
 * Maps a semantic zone band + attacking direction to a normalized (0..1)
 * position along the board's vertical axis, where 0 is the board's top edge
 * and 1 is its bottom edge. Drift/pulse presentation is layered on top of
 * this by the renderer; this function only returns the settled band
 * position. Returns the neutral (midfield) position for an unknown zone so
 * the presence never disappears when the scene doesn't specify a zone.
 */
export function zoneToBandPosition(
  zone: GameViewZone | undefined,
  direction: BoardDirection,
): number {
  const bandProgress = ZONE_BAND_POSITION[zone ?? 'neutral'] ?? ZONE_BAND_POSITION.neutral;
  // bandProgress is "distance from own goal toward opponent's goal" for the
  // attacking team. When attacking "up", progress 0 sits at the bottom edge
  // (their own goal) and 1 sits at the top edge (opponent's goal).
  return direction === 'up' ? 1 - bandProgress : bandProgress;
}

/** Clamps a pressure/intensity-like value to the 0..1 range used throughout this module. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Maps a semantic zone to a 0..1 pressure intensity baseline, used when a
 * scene carries a zone but no separate pressure reading (pressure and zone
 * are often the same engine band, see `GameViewZone = MatchEnginePressure`).
 */
const ZONE_BASE_INTENSITY: Record<GameViewZone, number> = {
  safe: 0.22,
  neutral: 0.32,
  attack: 0.5,
  danger: 0.72,
  high_danger: 0.92,
};

export interface PresenceIntensity {
  /** 0..1 overall visual intensity driving size/opacity of the possession presence. */
  intensity: number;
  /** Relative scale multiplier for the presence's outer ring, >= 1. */
  scale: number;
  /** Opacity for the presence's outer (widest) ring. */
  outerOpacity: number;
  /** Opacity for the presence's inner (core) ring. */
  innerOpacity: number;
  /** Pulse cycle duration in ms; lower = faster/more urgent pulse. */
  pulseDurationMs: number;
}

const MIN_PULSE_DURATION_MS = 900;
const MAX_PULSE_DURATION_MS = 2200;

/**
 * Converts a semantic zone/pressure pair into concrete presence visuals.
 * "Rising pressure moves the presence toward goal and increases visual
 * intensity" (PRD): higher intensity means a larger, more opaque presence
 * pulsing faster. `pressure` (when present) takes precedence over the zone
 * baseline because pressure is the more specific signal; the zone baseline
 * is the fallback so the presence still reacts when a scene only carries a
 * zone.
 */
export function pressureToIntensity(
  zone: GameViewZone | undefined,
  pressure: GameViewZone | undefined,
): PresenceIntensity {
  const source = pressure ?? zone ?? 'neutral';
  const intensity = clamp01(ZONE_BASE_INTENSITY[source] ?? ZONE_BASE_INTENSITY.neutral);

  return {
    intensity,
    scale: 1 + intensity * 0.55,
    outerOpacity: 0.14 + intensity * 0.26,
    innerOpacity: 0.32 + intensity * 0.5,
    pulseDurationMs: Math.round(
      MAX_PULSE_DURATION_MS - intensity * (MAX_PULSE_DURATION_MS - MIN_PULSE_DURATION_MS),
    ),
  };
}

export interface BoardTeamInfo {
  name: string;
  color: string;
  participant: MatchEngineParticipant;
}

export interface BoardPresenceState {
  position: number;
  direction: BoardDirection;
  color: string;
  teamName: string;
  zoneLabel: string;
  intensity: PresenceIntensity;
}

/**
 * Resolves everything the renderer needs to draw the possession presence for
 * an `ambient` scene: which team owns it, where it sits, and how intense it
 * looks. Returns undefined when the scene doesn't identify an owning
 * participant (the board should render idle in that case) or isn't an
 * ambient scene at all.
 */
export function resolveAmbientPresence(
  scene: GameViewScene | null | undefined,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  participant1Direction: BoardDirection = 'up',
): BoardPresenceState | undefined {
  if (!scene || scene.kind !== 'ambient' || scene.participant === undefined) return undefined;

  const team = scene.participant === homeTeam.participant ? homeTeam : awayTeam;
  const direction = directionForParticipant(scene.participant, participant1Direction) ?? participant1Direction;
  const zone = scene.zone ?? scene.pressure;

  return {
    position: zoneToBandPosition(zone, direction),
    direction,
    color: team.color,
    teamName: team.name,
    zoneLabel: ZONE_LABELS[zone ?? 'neutral'] ?? ZONE_LABELS.neutral,
    intensity: pressureToIntensity(scene.zone, scene.pressure),
  };
}

/**
 * Builds the board's summary accessibilityLabel, e.g. "Mexico pressing in
 * the danger zone" (per the B3 spec). Falls back to a quiet, generic label
 * when there's no active possession presence to describe.
 */
export function buildBoardAccessibilityLabel(
  presence: BoardPresenceState | undefined,
): string {
  if (!presence) return 'Game View board. No active possession to show.';

  const intensityWord = intensityToVerb(presence.intensity.intensity);
  return `${presence.teamName} ${intensityWord} in the ${presence.zoneLabel.toLowerCase()}.`;
}

function intensityToVerb(intensity: number): string {
  if (intensity >= 0.8) return 'pressing hard';
  if (intensity >= 0.55) return 'pressing';
  if (intensity >= 0.35) return 'building play';
  return 'in possession';
}

export type GameViewLoadStatus = 'loading' | 'empty' | 'error' | 'ready';

export interface StatePanelCopy {
  title: string;
  body?: string;
  actionLabel?: string;
}

/**
 * Copy for the B3 view-state panels, exact strings from
 * docs/prds/game_view.md ("Visual States"). Kept as a pure lookup so tests
 * can assert on the exact product copy without rendering the panel.
 */
export const GAME_VIEW_STATE_COPY: Record<'loading' | 'empty' | 'error' | 'stale', StatePanelCopy> = {
  loading: {
    title: 'Building Game View.',
  },
  empty: {
    title: 'Game View will appear when TxLINE has enough match signal.',
  },
  error: {
    title: 'Game View is unavailable.',
    actionLabel: 'Retry',
  },
  stale: {
    title: 'Waiting for the next match update.',
  },
};

/**
 * Selects which state panel (if any) should be shown given the current load
 * status. Returns undefined for 'ready', meaning the board itself should
 * render (the stale banner is layered separately via `isStale`, since stale
 * is "shown as a quiet banner over the board, not replacing it").
 */
export function selectStatePanelCopy(
  status: GameViewLoadStatus,
): StatePanelCopy | undefined {
  if (status === 'ready') return undefined;
  return GAME_VIEW_STATE_COPY[status];
}
