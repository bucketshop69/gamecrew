import type {
  GameViewScene,
  GameViewZone,
  MatchEngineParticipant,
} from '@gamecrew/core';

import type { GameViewTeamKit } from './game-view-team-kits';

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
 * Direction-relative zone labels: the same semantic band reads differently
 * depending which edge the ball is moving toward, so the board's static
 * chrome (fix #1, "zone labels acquire meaning") can label each row as
 * "toward <edge>" rather than a direction-agnostic "Attacking third" that
 * doesn't say which way. `edge` is a short board-edge descriptor (e.g. a
 * team name or "top"/"bottom"); callers decide what that descriptor is.
 */
export function zoneLabelForDirection(zone: GameViewZone, direction: BoardDirection): string {
  const towardTopEdge = direction === 'up';
  switch (zone) {
    case 'high_danger':
    case 'danger':
      return towardTopEdge ? `Danger ↑` : `Danger ↓`;
    case 'attack':
      return towardTopEdge ? `Attacking ↑` : `Attacking ↓`;
    case 'neutral':
      return 'Midfield';
    case 'safe':
    default:
      return towardTopEdge ? `Own third ↓` : `Own third ↑`;
  }
}

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

export interface GoalEndTeams<Team> {
  /** The team whose goal sits at the board's top edge. */
  top: Team;
  /** The team whose goal sits at the board's bottom edge. */
  bottom: Team;
}

/**
 * Resolves which team's goal sits at each pitch end. Replaces the old
 * "FRANCE GOAL" text labels (fix #1) with a language-free affordance: the
 * renderer paints each goal mouth in the defending team's color, so the
 * ends read as "whose goal" without words (product direction 2026-07-15).
 * Participant 1's own attacking edge (`participant1Direction`) is where
 * participant 2's goal sits, and vice versa.
 */
export function resolveGoalEndTeams<Team>(
  homeTeam: Team,
  awayTeam: Team,
  participant1Direction: BoardDirection = 'up',
): GoalEndTeams<Team> {
  // Participant 1 attacks toward participant1Direction, i.e. that edge is
  // where participant 2 (away) defends its own goal.
  return participant1Direction === 'up'
    ? { top: awayTeam, bottom: homeTeam }
    : { top: homeTeam, bottom: awayTeam };
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
 * Visibility floors (fix #5): the walkthrough found the low-pressure
 * presence near-invisible against the #0b0b0b board. These are the lowest
 * opacity/scale values the presence may render at, regardless of intensity;
 * the gradient above the floor is unchanged, only the bottom is lifted so
 * every pressure level stays legible.
 */
const MIN_OUTER_OPACITY = 0.32;
const MIN_INNER_OPACITY = 0.55;
const MIN_SCALE = 1.08;

/**
 * Converts a semantic zone/pressure pair into concrete presence visuals.
 * "Rising pressure moves the presence toward goal and increases visual
 * intensity" (PRD): higher intensity means a larger, more opaque presence
 * pulsing faster. `pressure` (when present) takes precedence over the zone
 * baseline because pressure is the more specific signal; the zone baseline
 * is the fallback so the presence still reacts when a scene only carries a
 * zone. Opacity/scale are floored (see `MIN_*` above) so the presence is
 * always clearly visible, even at the lowest pressure reading.
 */
export function pressureToIntensity(
  zone: GameViewZone | undefined,
  pressure: GameViewZone | undefined,
): PresenceIntensity {
  const source = pressure ?? zone ?? 'neutral';
  const intensity = clamp01(ZONE_BASE_INTENSITY[source] ?? ZONE_BASE_INTENSITY.neutral);

  return {
    intensity,
    scale: Math.max(MIN_SCALE, 1 + intensity * 0.55),
    outerOpacity: Math.max(MIN_OUTER_OPACITY, 0.14 + intensity * 0.26),
    innerOpacity: Math.max(MIN_INNER_OPACITY, 0.32 + intensity * 0.5),
    pulseDurationMs: Math.round(
      MAX_PULSE_DURATION_MS - intensity * (MAX_PULSE_DURATION_MS - MIN_PULSE_DURATION_MS),
    ),
  };
}

/**
 * Dimmed, static treatment for a "last known position" or neutral-midfield
 * presence (fix #4): reduced opacity, minimum scale, and no pulse (an
 * effectively infinite pulse duration -- the renderer also disables the
 * pulse/drift loops outright when `isHeld` is true, this is a defensive
 * floor for anything that reads `pulseDurationMs` directly).
 */
const HELD_PRESENCE_INTENSITY: PresenceIntensity = {
  intensity: 0,
  scale: MIN_SCALE,
  outerOpacity: 0.16,
  innerOpacity: 0.26,
  pulseDurationMs: MAX_PULSE_DURATION_MS,
};

export interface BoardTeamInfo {
  name: string;
  color: string;
  participant: MatchEngineParticipant;
  kit?: GameViewTeamKit;
}

export interface BoardPresenceState {
  position: number;
  direction: BoardDirection;
  color: string;
  teamName: string;
  zoneLabel: string;
  intensity: PresenceIntensity;
  /**
   * True when this presence is not a live possession reading but a carried
   * "last known position" or the neutral match-start placement (fix #4).
   * The renderer uses this to suppress pulse/drift and apply the dimmed
   * treatment instead of treating it as an active possession state.
   */
  isHeld: boolean;
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
    isHeld: false,
  };
}

/**
 * Neutral, centered midfield presence shown at match start (or whenever no
 * prior presence exists to carry forward): no team owns it, so it renders in
 * a neutral gray rather than either team's color, per fix #4's "genuinely no
 * prior position" case.
 */
const NEUTRAL_PRESENCE_COLOR = '#5A5A5A';
const NEUTRAL_PRESENCE_LABEL = 'Kickoff';

/**
 * Resolves the presence the board should show when the current scene has no
 * possession presence of its own (ambient scene with no zone/participant, or
 * a non-ambient scene with the board visible underneath -- e.g. a minor set
 * piece badge, fix #2). Fix #4: instead of leaving the board dead/black,
 * carry forward the last known live presence, dimmed and static. Falls back
 * to a centered, neutral-colored placement when there is no prior presence
 * at all (match start). Pure carry logic: callers own the "last known
 * presence" ref/state and pass it in; this function never mutates it.
 */
export function resolveHeldPresence(
  lastPresence: BoardPresenceState | undefined,
): BoardPresenceState {
  if (lastPresence) {
    return {
      ...lastPresence,
      intensity: HELD_PRESENCE_INTENSITY,
      isHeld: true,
    };
  }

  return {
    position: zoneToBandPosition('neutral', 'up'),
    direction: 'up',
    color: NEUTRAL_PRESENCE_COLOR,
    teamName: NEUTRAL_PRESENCE_LABEL,
    zoneLabel: ZONE_LABELS.neutral,
    intensity: HELD_PRESENCE_INTENSITY,
    isHeld: true,
  };
}

/**
 * Decides what the board should actually render for a given scene, carrying
 * forward the last live presence when the scene doesn't supply its own (fix
 * #4). `lastLivePresence` should be the most recent non-held
 * `resolveAmbientPresence` result the caller has seen (renderer owns that
 * memory, e.g. a ref); this function is pure and makes no assumption about
 * how it's stored.
 */
export function resolveBoardPresence(
  scene: GameViewScene | null | undefined,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  lastLivePresence: BoardPresenceState | undefined,
  participant1Direction: BoardDirection = 'up',
): BoardPresenceState {
  const live = resolveAmbientPresence(scene, homeTeam, awayTeam, participant1Direction);
  if (live) return live;
  return resolveHeldPresence(lastLivePresence);
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
  if (presence.isHeld) {
    return presence.teamName === NEUTRAL_PRESENCE_LABEL
      ? 'Game View board. Waiting for kickoff.'
      : `Game View board. Last known play: ${presence.teamName} in the ${presence.zoneLabel.toLowerCase()}.`;
  }

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

/**
 * Pure layout proportions for the R1 broadcast-pitch chalk markings (work
 * item R1 of docs/issues/game-view-realism-experiment.md). Everything is
 * expressed as a percentage of the board's own box so the renderer can
 * derive concrete style values via flex/percentage layout and the pitch
 * scales cleanly across phone widths and the web max-width, without any
 * fixed pixel geometry here.
 *
 * Percentages follow roughly realistic pitch ratios (a standard penalty box
 * is ~44m of a ~68m-wide, ~105m-long pitch) rounded to numbers that read
 * cleanly on a small board:
 *  - penalty box: ~60% of pitch width, ~17% of half-length deep
 *  - six-yard box: ~30% of pitch width, ~6% of half-length deep
 *  - goal mouth: narrower than the six-yard box, sitting on the goal line
 */
export const PITCH_MARKINGS = {
  penaltyBox: {
    /** Width of the penalty box as a fraction of the pitch's full width. */
    widthPct: 0.6,
    /** Depth of the penalty box as a fraction of the pitch's half-length. */
    depthPct: 0.17,
  },
  sixYardBox: {
    widthPct: 0.3,
    depthPct: 0.06,
  },
  goalMouth: {
    widthPct: 0.16,
    /** How far the goal-mouth bracket extends outward past the goal line, as a fraction of pitch half-length. */
    depthPct: 0.025,
  },
  penaltySpot: {
    /** Distance of the penalty spot from the goal line, as a fraction of pitch half-length. */
    fromGoalLinePct: 0.11,
  },
  penaltyArc: {
    /** Radius of the penalty arc, as a fraction of pitch width, matching the penalty-spot-to-box-edge distance. */
    radiusPct: 0.088,
  },
  cornerArc: {
    /** Radius of the corner quarter-circle hint, as a fraction of pitch width. */
    radiusPct: 0.035,
  },
} as const;

export interface PitchBoxLayout {
  /** Left inset of the box, as a percentage string for style consumption. */
  leftPct: number;
  /** Width of the box, as a percentage of pitch width. */
  widthPct: number;
  /** Depth (height) of the box, as a percentage of pitch half-length. */
  depthPct: number;
}

/**
 * Resolves a centered box's left inset + width + depth from a width/depth
 * proportion pair (e.g. `PITCH_MARKINGS.penaltyBox`). Centers the box
 * horizontally: leftPct + widthPct + leftPct == 100.
 */
export function resolveCenteredBoxLayout(proportions: {
  widthPct: number;
  depthPct: number;
}): PitchBoxLayout {
  const widthPct = proportions.widthPct * 100;
  const leftPct = (100 - widthPct) / 2;
  return {
    leftPct,
    widthPct,
    depthPct: proportions.depthPct * 100,
  };
}
