import type {
  GameViewScene,
  GameViewZone,
  MatchEngineParticipant,
  MatchEnginePhase,
} from '@gamecrew/core';

import type { BoardDirection, BoardTeamInfo } from '../game-view/game-view-board-logic';
import type { PlayerFacing, PlayerPose } from './player-pose-logic';

/**
 * Pure choreography for the Game View 22-player formation board (the
 * realism experiment's revised direction, docs/issues/
 * game-view-realism-experiment.md): maps a director scene to a full
 * top-down tactical arrangement -- two 11-figure formation blocks plus a
 * ball -- in the spirit of Football Manager's classic 2D view. No React/RN
 * here; the renderer (game-view-action-cluster.tsx) animates between
 * whatever this module returns, so every staging decision is testable with
 * plain node:test assertions.
 *
 * Honesty grammar (amended PRD, "The Honesty Rule"): every figure position
 * is theater staged around true facts. The formation shapes are cosmetic
 * defaults (never claimed lineups); the blocks slide and compress with the
 * REAL possession/zone/pressure; the ball never crosses a zone boundary
 * without a real cue; no real player identity ever attaches to a figure.
 * Invented movement may never contradict a known fact.
 *
 * Determinism: replays must stage identically every run. Formation
 * placement is pure arithmetic; the only "random" variation (corner side,
 * shot target post, delivery jitter) derives from `hashUnit(scene.id)` --
 * never Math.random().
 *
 * No runtime import of game-view-board-logic: this module is imported
 * directly by unit tests under the mobile package's plain
 * `node --experimental-strip-types` runner, which requires fully-resolvable
 * runtime import graphs (see state/match-session.ts's header comment for
 * the same constraint). The three tiny shared helpers (`zoneBandPosition`,
 * `zoneIntensity`, `participantDirection`) mirror their board-logic
 * originals, and tests/game-view-cluster-choreography-logic.test.mjs
 * asserts output equality against the originals so the copies can never
 * drift.
 */

// ---------------------------------------------------------------------------
// Mirrored board-logic helpers (sync-tested, see header comment)
// ---------------------------------------------------------------------------

/** Mirrors game-view-board-logic's ZONE_BAND_POSITION. Progress from own goal (0) toward the opponent's (1). */
const ZONE_BAND_POSITION: Record<GameViewZone, number> = {
  safe: 0.16,
  neutral: 0.5,
  attack: 0.68,
  danger: 0.84,
  high_danger: 0.94,
};

/** Mirrors game-view-board-logic's ZONE_BASE_INTENSITY. */
const ZONE_BASE_INTENSITY: Record<GameViewZone, number> = {
  safe: 0.22,
  neutral: 0.32,
  attack: 0.5,
  danger: 0.72,
  high_danger: 0.92,
};

/** Mirrors game-view-board-logic's zoneToBandPosition (sync-tested). */
export function zoneBandPosition(zone: GameViewZone | undefined, direction: BoardDirection): number {
  const bandProgress = ZONE_BAND_POSITION[zone ?? 'neutral'] ?? ZONE_BAND_POSITION.neutral;
  return direction === 'up' ? 1 - bandProgress : bandProgress;
}

/** Mirrors game-view-board-logic's pressureToIntensity().intensity (sync-tested). */
export function zoneIntensity(zone: GameViewZone | undefined, pressure: GameViewZone | undefined): number {
  const source = pressure ?? zone ?? 'neutral';
  return Math.min(1, Math.max(0, ZONE_BASE_INTENSITY[source] ?? ZONE_BASE_INTENSITY.neutral));
}

/** Mirrors game-view-board-logic's directionForParticipant (sync-tested). */
export function participantDirection(
  participant: MatchEngineParticipant | undefined,
  participant1Direction: BoardDirection,
): BoardDirection | undefined {
  if (participant === undefined) return undefined;
  if (participant === 1) return participant1Direction;
  return participant1Direction === 'up' ? 'down' : 'up';
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type ClusterRole = 'attacker' | 'defender' | 'keeper';

export interface ClusterFigure {
  /** Stable formation-slot key, e.g. 'p1-cm1' -- the same slot key across every scene so figures move continuously. */
  key: string;
  role: ClusterRole;
  participant: MatchEngineParticipant;
  color: string;
  shirtColor?: string;
  shortsColor?: string;
  trimColor?: string;
  /** The small action knot stays foregrounded; formation context deliberately recedes. */
  focus: 'engaged' | 'formation';
  /** Board-fraction position: x across width, y down height, 0..1 with top-left origin (same space as the presence anchor). */
  x: number;
  y: number;
  pose: PlayerPose;
  facing: PlayerFacing;
}

export interface ClusterBallState {
  x: number;
  y: number;
  /** Key of the figure currently "on the ball", when one is. */
  holderKey?: string;
  /** False only for an honesty-safe neutral bootstrap with no grounded ball location. */
  visible?: boolean;
}

/**
 * Open-ended ambient staging: both formation blocks placed for the true
 * possession/zone state, with the figures nearest the ball engaged in a
 * pass cycle. "Calm, busier when dangerous": the pass interval is
 * pressure-driven, so tempo on screen always follows real match tension,
 * and a compressed replay scene simply fits fewer passes, never faster
 * ones.
 */
export interface AmbientClusterPlan {
  kind: 'ambient';
  figures: ClusterFigure[];
  ball: ClusterBallState;
  passCycleKeys: string[];
  passIntervalMs: number;
  teamName: string;
  teamColor: string;
  /** Where the possession label sits: just behind the engaged knot. */
  labelAnchor: { x: number; y: number };
}

export interface StagedKeyframe {
  offsetMs: number;
  /** Same keys in every keyframe of a plan; only position/pose/facing change. */
  figures: ClusterFigure[];
  ball: ClusterBallState;
}

export type StagedClusterLabel =
  | 'corner'
  | 'shot'
  | 'shot_on_target'
  | 'shot_off_target'
  | 'shot_blocked'
  | 'shot_woodwork'
  | 'goal_celebration'
  | 'kickoff'
  | 'walk_off'
  | 'throw_in'
  | 'goal_kick';

/** Fixed-beat staging for event scenes: the renderer tweens between keyframes. */
export interface StagedClusterPlan {
  kind: 'staged';
  label: StagedClusterLabel;
  /** Concrete presentation window; every keyframe and tween must finish inside it. */
  durationMs: number;
  keyframes: StagedKeyframe[];
  teamName?: string;
  teamColor?: string;
}

/** Static first-paint arrangement used only when a stoppage mounts before the renderer has figures to freeze. */
export interface HoldBootstrapPlan {
  source: 'prior_scene' | 'neutral';
  figures: ClusterFigure[];
  ball: ClusterBallState;
}

/**
 * 'hold': the players stay exactly where they are -- dead-ball moments
 * (throw-ins, free kicks, cards, VAR) freeze the formation instead of
 * clearing it, because real players don't leave the pitch for a throw-in
 * (product feedback 2026-07-15: "we are losing all the eleven players").
 * The event itself is named by a compact banner/badge; details belong to
 * the commentary layer. 'none' clears the board and is reserved for
 * having no scene at all.
 */
export type ClusterPlan =
  | AmbientClusterPlan
  | StagedClusterPlan
  | { kind: 'hold' }
  | { kind: 'none' };

// ---------------------------------------------------------------------------
// Deterministic variation
// ---------------------------------------------------------------------------

/**
 * djb2 string hash normalized to [0, 1). The variation source for everything
 * that should differ between scenes but be identical across replays of the
 * same scene (corner side, delivery jitter, shot target post).
 */
export function hashUnit(seed: string): number {
  let hash = 5381;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) + hash + seed.charCodeAt(index)) | 0;
  }
  return (hash >>> 0) / 4294967296;
}

/** Deterministic left/right pick, e.g. which corner flag a celebration runs to. */
export function pickSide(seed: string): 'left' | 'right' {
  return hashUnit(seed) < 0.5 ? 'left' : 'right';
}

/** Small deterministic jitter in [-half, +half]. */
function jitter(seed: string, span: number): number {
  return (hashUnit(seed) - 0.5) * span;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Figure sizing for the stickman formation view: ~20px reads cleanly for a
 * thin line figure (approved from the 2026-07-15 mockup). The old 32px
 * floor was a finding about the retired chunky token style.
 */
export const STICK_FIGURE_SIZE_PX = 20;

/** Keeps figures clear of the goal-end labels and the chalk boundary. */
const EDGE_CLAMP_X = 0.05;
const EDGE_CLAMP_Y = 0.045;

function clampX(value: number): number {
  return Math.min(1 - EDGE_CLAMP_X, Math.max(EDGE_CLAMP_X, value));
}

function clampY(value: number): number {
  return Math.min(1 - EDGE_CLAMP_Y, Math.max(EDGE_CLAMP_Y, value));
}

/**
 * Converts an "attack-space" offset (dGoal = toward the attacked goal,
 * positive means closer to it) into a board-space y delta for the given
 * direction. Attacking 'up' means toward the top edge, i.e. smaller y.
 */
function towardGoal(direction: BoardDirection, dGoal: number): number {
  return direction === 'up' ? -dGoal : dGoal;
}

/** The y band just in front of a goal mouth at the attacked end. */
function goalMouthY(direction: BoardDirection): number {
  return direction === 'up' ? 0.045 : 0.955;
}

/** The y band of the penalty-box area at the attacked end (where corners drop, shots resolve). */
function boxY(direction: BoardDirection): number {
  return direction === 'up' ? 0.13 : 0.87;
}

function facingAttack(direction: BoardDirection): PlayerFacing {
  return direction;
}

// ---------------------------------------------------------------------------
// Formations
// ---------------------------------------------------------------------------

/**
 * A formation slot in team space: `x` across the pitch width (from the
 * team's own attacking perspective), `depth` from the team's own goal line
 * (0) toward the opponent's (1). Depth here is the slot's SHAPE position;
 * the live depth window (below) decides where the block actually stands.
 */
interface FormationSlot {
  key: string;
  x: number;
  depth: number;
}

/** Cosmetic default shapes -- never claimed lineups (see honesty grammar above). */
const FORMATION_433: readonly FormationSlot[] = [
  { key: 'gk', x: 0.5, depth: 0 },
  { key: 'lb', x: 0.16, depth: 0.24 },
  { key: 'cb1', x: 0.38, depth: 0.16 },
  { key: 'cb2', x: 0.62, depth: 0.16 },
  { key: 'rb', x: 0.84, depth: 0.24 },
  { key: 'cm1', x: 0.3, depth: 0.52 },
  { key: 'cdm', x: 0.5, depth: 0.42 },
  { key: 'cm2', x: 0.7, depth: 0.52 },
  { key: 'lw', x: 0.15, depth: 0.86 },
  { key: 'st', x: 0.5, depth: 1 },
  { key: 'rw', x: 0.85, depth: 0.86 },
];

const FORMATION_442: readonly FormationSlot[] = [
  { key: 'gk', x: 0.5, depth: 0 },
  { key: 'lb', x: 0.16, depth: 0.26 },
  { key: 'cb1', x: 0.38, depth: 0.18 },
  { key: 'cb2', x: 0.62, depth: 0.18 },
  { key: 'rb', x: 0.84, depth: 0.26 },
  { key: 'lm', x: 0.15, depth: 0.62 },
  { key: 'cm1', x: 0.4, depth: 0.54 },
  { key: 'cm2', x: 0.6, depth: 0.54 },
  { key: 'rm', x: 0.85, depth: 0.62 },
  { key: 'st1', x: 0.4, depth: 0.96 },
  { key: 'st2', x: 0.6, depth: 1 },
];

/** Home lines up 4-3-3, away 4-4-2 -- purely for visual variety between the two blocks. */
function formationForParticipant(participant: MatchEngineParticipant): readonly FormationSlot[] {
  return participant === 1 ? FORMATION_433 : FORMATION_442;
}

/**
 * The live depth window a formation block occupies, derived from the ball's
 * true progress `p` (0 = possession team's own goal line, 1 = the goal they
 * attack). The possession block pushes up so its front line reaches the
 * ball; the defending block sits goal-side of the ball and stretches back
 * toward its own goal. Both are clamped so a block never fully leaves its
 * believable range.
 */
export function possessionWindow(p: number): { back: number; front: number } {
  return {
    back: Math.max(0.08, p - 0.55),
    front: Math.min(0.93, p + 0.04),
  };
}

export function defendingWindow(p: number): { back: number; front: number } {
  const q = 1 - p;
  return {
    back: Math.max(0.05, q - 0.1),
    front: Math.min(0.85, q + 0.42),
  };
}

/** GK depth is pinned near the goal line regardless of the block window. */
const KEEPER_DEPTH = 0.035;

/**
 * Places one team's 11 slots on the board for a depth window. Slot depth
 * (shape) lerps across the window; x mirrors when attacking down so both
 * teams' shapes read correctly from the fixed camera.
 */
function placeTeam(
  team: BoardTeamInfo,
  direction: BoardDirection,
  window: { back: number; front: number },
  count = 11,
): ClusterFigure[] {
  const slots = formationForParticipant(team.participant).slice(0, Math.min(11, Math.max(7, count)));
  return slots.map((slot) => {
    const depth = slot.key === 'gk'
      ? KEEPER_DEPTH
      : window.back + slot.depth * (window.front - window.back);
    const boardY = direction === 'up' ? 1 - depth : depth;
    const boardX = direction === 'up' ? slot.x : 1 - slot.x;
    const role: ClusterRole = slot.key === 'gk'
      ? 'keeper'
      : /^(lb|rb|cb)/.test(slot.key) ? 'defender' : 'attacker';
    const kit = role === 'keeper' ? team.kit?.keeper : team.kit?.outfield;
    return {
      key: `p${team.participant}-${slot.key}`,
      role,
      participant: team.participant,
      color: kit?.shirt ?? team.color,
      ...(kit ? { shirtColor: kit.shirt, shortsColor: kit.shorts, trimColor: kit.trim } : {}),
      focus: 'formation' as const,
      x: clampX(boardX),
      y: clampY(boardY),
      pose: 'idle' as const,
      facing: facingAttack(direction),
    };
  });
}

/** Both formations for a possession state: the true progress p drives both windows. */
function placeFormations(
  possessionTeam: BoardTeamInfo,
  defendingTeam: BoardTeamInfo,
  possessionDirection: BoardDirection,
  p: number,
  playerCounts?: GameViewScene['playerCounts'],
): { possession: ClusterFigure[]; defending: ClusterFigure[] } {
  const defendingDirection: BoardDirection = possessionDirection === 'up' ? 'down' : 'up';
  return {
    possession: placeTeam(
      possessionTeam,
      possessionDirection,
      possessionWindow(p),
      countForParticipant(playerCounts, possessionTeam.participant),
    ),
    defending: placeTeam(
      defendingTeam,
      defendingDirection,
      defendingWindow(p),
      countForParticipant(playerCounts, defendingTeam.participant),
    ),
  };
}

function countForParticipant(
  counts: GameViewScene['playerCounts'],
  participant: MatchEngineParticipant,
): number {
  return participant === 1 ? counts?.participant1 ?? 11 : counts?.participant2 ?? 11;
}

/** Distance-sorted non-keeper figures, deterministic tie-break on key. */
function nearestOutfield(figures: readonly ClusterFigure[], x: number, y: number): ClusterFigure[] {
  return figures
    .filter((figure) => figure.role !== 'keeper')
    .slice()
    .sort((a, b) => {
      const da = Math.hypot(a.x - x, a.y - y);
      const db = Math.hypot(b.x - x, b.y - y);
      return da === db ? a.key.localeCompare(b.key) : da - db;
    });
}

/** Applies a position/pose override to one figure of a placed team, by key. */
function override(
  figures: ClusterFigure[],
  key: string,
  changes: Partial<Pick<ClusterFigure, 'x' | 'y' | 'pose' | 'facing' | 'focus'>>,
): void {
  const index = figures.findIndex((figure) => figure.key === key);
  if (index === -1) return;
  figures[index] = { ...figures[index]!, ...changes };
}

// ---------------------------------------------------------------------------
// Ambient staging
// ---------------------------------------------------------------------------

/**
 * Pass tempo: "calm, busier when dangerous". At the lowest intensity a pass
 * roughly every 2.6s; at the highest, every 1.3s. Travel time stays
 * constant -- a compressed scene gets fewer passes, never faster ones.
 */
export function passIntervalMsForIntensity(intensity: number): number {
  const clamped = Math.min(1, Math.max(0, intensity));
  return Math.round(2600 - clamped * 1300);
}

/** Engaged possession figures: 2 in calm possession, 3 once play is genuinely building. */
export function attackerCountForIntensity(intensity: number): number {
  return intensity >= 0.5 ? 3 : 2;
}

/** Engaged pressers: a second one arrives only under real danger. */
export function defenderCountForIntensity(intensity: number): number {
  return intensity >= 0.7 ? 2 : 1;
}

/**
 * Attack-space offsets for the engaged knot around the ball anchor: a
 * loose triangle for the possession figures, pressers goal-side. Fixed (not
 * jittered per scene) so compressed-replay scene churn with unchanged true
 * state produces zero phantom movement.
 */
const KNOT_POSSESSION_OFFSETS: readonly { dx: number; dGoal: number }[] = [
  { dx: -0.115, dGoal: 0.022 },
  { dx: 0.098, dGoal: -0.014 },
  { dx: -0.008, dGoal: -0.092 },
];

const KNOT_PRESSER_OFFSETS: readonly { dx: number; dGoal: number }[] = [
  { dx: 0.052, dGoal: 0.082 },
  { dx: -0.078, dGoal: 0.118 },
];

function resolveAmbientPlan(
  scene: GameViewScene,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  participant1Direction: BoardDirection,
): ClusterPlan {
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  // No owning participant: nothing new to stage, so the players hold.
  if (!team) return { kind: 'hold' };

  const opponent = opponentOf(team, homeTeam, awayTeam);
  const direction = participantDirection(scene.participant, participant1Direction) ?? participant1Direction;
  const zone = scene.zone ?? scene.pressure;
  const p = ZONE_BAND_POSITION[zone ?? 'neutral'] ?? ZONE_BAND_POSITION.neutral;
  const intensity = zoneIntensity(scene.zone, scene.pressure);

  const { possession, defending } = placeFormations(team, opponent, direction, p, scene.playerCounts);

  // The ball anchor: the true zone band, at a width keyed to team + zone
  // (real facts) so consecutive scenes with the same true state stage
  // identically and rapid scene churn produces no phantom movement.
  const anchorY = zoneBandPosition(zone, direction);
  const anchorX = 0.38 + hashUnit(`${String(scene.participant)}-${String(zone)}`) * 0.24;

  // Engage the formation slots nearest the ball: they leave their shape
  // position and form the knot. Everyone else holds formation.
  const engagedPossession = nearestOutfield(possession, anchorX, anchorY).slice(0, attackerCountForIntensity(intensity));
  engagedPossession.forEach((figure, index) => {
    const offset = KNOT_POSSESSION_OFFSETS[index]!;
    override(possession, figure.key, {
      x: clampX(anchorX + offset.dx),
      y: clampY(anchorY + towardGoal(direction, offset.dGoal)),
      focus: 'engaged',
    });
  });

  const engagedPressers = nearestOutfield(defending, anchorX, anchorY).slice(0, defenderCountForIntensity(intensity));
  engagedPressers.forEach((figure, index) => {
    const offset = KNOT_PRESSER_OFFSETS[index]!;
    override(defending, figure.key, {
      x: clampX(anchorX + offset.dx),
      y: clampY(anchorY + towardGoal(direction, offset.dGoal)),
      ...(index === 0 ? { focus: 'engaged' as const } : {}),
    });
  });

  const figures = [...possession, ...defending];
  const holderKey = engagedPossession[0]?.key;
  const holder = figures.find((figure) => figure.key === holderKey);

  return {
    kind: 'ambient',
    figures,
    ball: holder
      ? { x: holder.x, y: holder.y, holderKey: holder.key }
      : { x: anchorX, y: anchorY },
    passCycleKeys: engagedPossession.map((figure) => figure.key),
    passIntervalMs: passIntervalMsForIntensity(intensity),
    teamName: team.name,
    teamColor: team.color,
    labelAnchor: {
      x: anchorX,
      y: clampY(anchorY + towardGoal(direction, -0.13)),
    },
  };
}

// ---------------------------------------------------------------------------
// Team resolution
// ---------------------------------------------------------------------------

function teamForParticipant(
  participant: MatchEngineParticipant | undefined,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
): BoardTeamInfo | undefined {
  if (participant === undefined) return undefined;
  return participant === homeTeam.participant ? homeTeam : awayTeam;
}

function opponentOf(team: BoardTeamInfo, homeTeam: BoardTeamInfo, awayTeam: BoardTeamInfo): BoardTeamInfo {
  return team.participant === homeTeam.participant ? awayTeam : homeTeam;
}

// ---------------------------------------------------------------------------
// Corner staging
// ---------------------------------------------------------------------------

/**
 * `GameViewScreen` replaces the director hint with PlaybackEngine's active
 * window before asking for choreography. Do not add a second minimum here:
 * that would make keyframes outlive the authoritative scene clock.
 */
function stagedDurationMs(scene: GameViewScene): number {
  return Math.max(0, scene.durationHint.minMs);
}

function resolveCornerPlan(
  scene: GameViewScene,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  participant1Direction: BoardDirection,
): ClusterPlan {
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  if (!team) return { kind: 'hold' };

  const opponent = opponentOf(team, homeTeam, awayTeam);
  const direction = participantDirection(scene.participant, participant1Direction) ?? participant1Direction;
  const side = pickSide(scene.id);
  const totalMs = stagedDurationMs(scene);

  const cornerX = side === 'left' ? EDGE_CLAMP_X : 1 - EDGE_CLAMP_X;
  const cornerY = direction === 'up' ? EDGE_CLAMP_Y : 1 - EDGE_CLAMP_Y;
  const dropX = clampX(0.5 + (side === 'left' ? -0.04 : 0.04) + jitter(`${scene.id}-drop`, 0.1));
  const dropY = boxY(direction);

  // A corner loads the box: attacking block pushed all the way up,
  // defending block camped at its own goal.
  const { possession, defending } = placeFormations(team, opponent, direction, 0.94, scene.playerCounts);

  const attackersByFlag = nearestOutfield(possession, cornerX, cornerY);
  const taker = attackersByFlag[0]!;
  override(possession, taker.key, { x: cornerX, y: cornerY, focus: 'engaged' });

  const runners = nearestOutfield(
    possession.filter((figure) => figure.key !== taker.key),
    dropX,
    dropY,
  ).slice(0, 2);
  runners.forEach((figure, index) => {
    override(possession, figure.key, {
      x: clampX(dropX + (index === 0 ? -0.09 : 0.1)),
      y: clampY(dropY + towardGoal(direction, index === 0 ? -0.03 : -0.055)),
      focus: 'engaged',
    });
  });

  const marker = nearestOutfield(defending, dropX, dropY)[0];
  if (marker) {
    override(defending, marker.key, {
      x: clampX(dropX + 0.015),
      y: clampY(dropY + towardGoal(direction, 0.045)),
      focus: 'engaged',
    });
  }

  const setupFigures = [...possession, ...defending];

  const swingFigures = setupFigures.map((figure) => {
    if (figure.key === taker.key) return { ...figure, pose: 'strike' as const };
    if (figure.key === runners[0]?.key) return { ...figure, x: clampX(dropX - 0.02), y: clampY(dropY), pose: 'header' as const };
    if (figure.key === marker?.key) return { ...figure, x: clampX(dropX + 0.04), y: clampY(dropY + towardGoal(direction, 0.02)), pose: 'run_a' as const };
    if (figure.role === 'keeper' && figure.participant === opponent.participant) {
      return { ...figure, x: clampX(0.5 + (side === 'left' ? -0.05 : 0.05)), focus: 'engaged' as const };
    }
    return figure;
  });

  const settleFigures = swingFigures.map((figure) => {
    if (figure.key === taker.key) {
      return { ...figure, x: clampX(cornerX + (side === 'left' ? 0.05 : -0.05)), y: clampY(cornerY + towardGoal(direction, -0.04)), pose: 'idle' as const };
    }
    if (figure.pose !== 'idle') return { ...figure, pose: 'idle' as const };
    return figure;
  });

  return {
    kind: 'staged',
    label: 'corner',
    durationMs: totalMs,
    teamName: team.name,
    teamColor: team.color,
    keyframes: [
      { offsetMs: 0, figures: setupFigures, ball: { x: cornerX, y: cornerY, holderKey: taker.key } },
      { offsetMs: Math.round(totalMs * 0.45), figures: swingFigures, ball: { x: dropX, y: dropY } },
      { offsetMs: Math.round(totalMs * 0.8), figures: settleFigures, ball: { x: clampX(dropX + jitter(`${scene.id}-loose`, 0.08)), y: clampY(dropY + towardGoal(direction, -0.02)) } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Throw-in staging
// ---------------------------------------------------------------------------

/**
 * A throw-in happens at a touchline, so the play visibly leans there
 * (product feedback 2026-07-15: "can't we move the players to that side a
 * little bit?"). The pitch HEIGHT of the throw comes from the scene's true
 * zone band (carried by the director when the source supplies one); which
 * touchline is presentation, picked deterministically per scene -- the
 * source doesn't say left or right, and neither claim contradicts it.
 */
const THROW_IN_BLOCK_LEAN = 0.06;

function resolveThrowInPlan(
  scene: GameViewScene,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  participant1Direction: BoardDirection,
): ClusterPlan {
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  if (!team) return { kind: 'hold' };

  const opponent = opponentOf(team, homeTeam, awayTeam);
  const direction = participantDirection(scene.participant, participant1Direction) ?? participant1Direction;
  const side = pickSide(scene.id);
  const totalMs = stagedDurationMs(scene);

  const zone = scene.zone ?? scene.pressure;
  const p = ZONE_BAND_POSITION[zone ?? 'neutral'] ?? ZONE_BAND_POSITION.neutral;
  const lineX = side === 'left' ? EDGE_CLAMP_X : 1 - EDGE_CLAMP_X;
  const lineY = clampY(zoneBandPosition(zone, direction));
  const inward = side === 'left' ? 1 : -1;
  const lean = THROW_IN_BLOCK_LEAN * (side === 'left' ? -1 : 1);

  const { possession, defending } = placeFormations(team, opponent, direction, p, scene.playerCounts);

  // Both blocks lean toward the touchline the ball went out on.
  for (const figure of [...possession, ...defending]) {
    figure.x = clampX(figure.x + lean);
  }

  // The thrower stands on the line, arms up; two teammates come short to
  // offer options, the nearest opponent marks the space between them.
  const thrower = nearestOutfield(possession, lineX, lineY)[0]!;
  override(possession, thrower.key, {
    x: lineX,
    y: lineY,
    pose: 'wall_stance',
    facing: side === 'left' ? 'right' : 'left',
    focus: 'engaged',
  });

  const options = nearestOutfield(
    possession.filter((figure) => figure.key !== thrower.key),
    lineX,
    lineY,
  ).slice(0, 2);
  options.forEach((figure, index) => {
    override(possession, figure.key, {
      x: clampX(lineX + inward * (0.09 + index * 0.06)),
      y: clampY(lineY + (index === 0 ? -0.045 : 0.05)),
      focus: 'engaged',
    });
  });

  const marker = nearestOutfield(defending, lineX, lineY)[0];
  if (marker) {
    override(defending, marker.key, {
      x: clampX(lineX + inward * 0.12),
      y: clampY(lineY + 0.005),
      focus: 'engaged',
    });
  }

  const setupFigures = [...possession, ...defending];
  const receiver = options[0];

  // The throw itself: ball travels from the line to the near option and
  // the thrower's arms come down.
  const throwFigures = setupFigures.map((figure) => {
    if (figure.key === thrower.key) return { ...figure, pose: 'idle' as const };
    return figure;
  });

  return {
    kind: 'staged',
    label: 'throw_in',
    durationMs: totalMs,
    teamName: team.name,
    teamColor: team.color,
    keyframes: [
      { offsetMs: 0, figures: setupFigures, ball: { x: lineX, y: lineY, holderKey: thrower.key } },
      {
        offsetMs: Math.round(totalMs * 0.55),
        figures: throwFigures,
        ball: receiver
          ? { x: clampX(lineX + inward * 0.09), y: clampY(lineY - 0.045), holderKey: receiver.key }
          : { x: clampX(lineX + inward * 0.09), y: lineY },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Goal-kick staging
// ---------------------------------------------------------------------------

function resolveGoalKickPlan(
  scene: GameViewScene,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  participant1Direction: BoardDirection,
): ClusterPlan {
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  if (!team) return { kind: 'hold' };

  const opponent = opponentOf(team, homeTeam, awayTeam);
  const direction = participantDirection(scene.participant, participant1Direction) ?? participant1Direction;
  const totalMs = stagedDurationMs(scene);
  const { possession, defending } = placeFormations(team, opponent, direction, 0.16, scene.playerCounts);
  const keeperKey = `p${team.participant}-gk`;
  const keeper = possession.find((figure) => figure.key === keeperKey);
  if (!keeper) return { kind: 'hold' };

  const receiver = nearestOutfield(possession, keeper.x, keeper.y)[0];
  override(possession, keeper.key, { pose: 'idle', focus: 'engaged' });
  if (receiver) override(possession, receiver.key, { focus: 'engaged' });
  const setupFigures = [...possession, ...defending];
  const releaseFigures = setupFigures.map((figure) => (
    figure.key === keeper.key ? { ...figure, pose: 'strike' as const } : figure
  ));

  return {
    kind: 'staged',
    label: 'goal_kick',
    durationMs: totalMs,
    teamName: team.name,
    teamColor: team.color,
    keyframes: [
      { offsetMs: 0, figures: setupFigures, ball: { x: keeper.x, y: keeper.y, holderKey: keeper.key } },
      {
        offsetMs: Math.round(totalMs * 0.55),
        figures: releaseFigures,
        ball: receiver
          ? { x: receiver.x, y: receiver.y, holderKey: receiver.key }
          : { x: 0.5, y: direction === 'up' ? 0.75 : 0.25 },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Shot staging
// ---------------------------------------------------------------------------

function resolveShotPlan(
  scene: GameViewScene,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  participant1Direction: BoardDirection,
): ClusterPlan {
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  if (!team) return { kind: 'hold' };

  const opponent = opponentOf(team, homeTeam, awayTeam);
  const direction = participantDirection(scene.participant, participant1Direction) ?? participant1Direction;
  const totalMs = stagedDurationMs(scene);

  const zone = (scene.zone ?? scene.pressure ?? 'danger') as GameViewZone;
  const p = ZONE_BAND_POSITION[zone] ?? ZONE_BAND_POSITION.danger;
  const shooterY = zoneBandPosition(zone, direction);
  const shooterX = clampX(0.42 + hashUnit(scene.id) * 0.16);
  const outcome = scene.sourceOutcome?.toLowerCase();
  const targetSide = pickSide(`${scene.id}-post`);
  const targetX = outcome === 'offtarget'
    ? targetSide === 'left' ? 0.3 : 0.7
    : outcome === 'woodwork'
      ? targetSide === 'left' ? 0.38 : 0.62
      : targetSide === 'left' ? 0.43 : 0.57;
  const targetY = goalMouthY(direction) + towardGoal(direction, -0.025);
  const keeperDive: PlayerPose = targetX < 0.5 ? 'keeper_dive_left' : 'keeper_dive_right';

  const { possession, defending } = placeFormations(team, opponent, direction, p, scene.playerCounts);

  const shooter = nearestOutfield(possession, shooterX, shooterY)[0]!;
  override(possession, shooter.key, { x: shooterX, y: clampY(shooterY), focus: 'engaged' });

  const closer = nearestOutfield(defending, shooterX, shooterY)[0];
  if (closer) {
    override(defending, closer.key, {
      x: clampX(shooterX - 0.06),
      y: clampY(shooterY + towardGoal(direction, 0.06)),
      pose: 'run_a',
      focus: 'engaged',
    });
  }

  const keeperKey = `p${opponent.participant}-gk`;
  const setupFigures = [...possession, ...defending];

  const strikeFigures = setupFigures.map((figure) => {
    if (figure.key === shooter.key) return { ...figure, pose: 'strike' as const };
    if (figure.key === keeperKey && outcome !== 'offtarget' && outcome !== 'blocked') {
      return { ...figure, pose: keeperDive, x: clampX(targetX), focus: 'engaged' as const };
    }
    return figure;
  });

  const settleFigures = strikeFigures.map((figure) => {
    if (figure.pose !== 'idle') return { ...figure, pose: 'idle' as const };
    return figure;
  });

  return {
    kind: 'staged',
    label: outcome === 'ontarget'
      ? 'shot_on_target'
      : outcome === 'offtarget'
        ? 'shot_off_target'
        : outcome === 'blocked'
          ? 'shot_blocked'
          : outcome === 'woodwork'
            ? 'shot_woodwork'
            : 'shot',
    durationMs: totalMs,
    teamName: team.name,
    teamColor: team.color,
    keyframes: [
      { offsetMs: 0, figures: setupFigures, ball: { x: shooterX, y: clampY(shooterY), holderKey: shooter.key } },
      {
        offsetMs: Math.round(totalMs * 0.4),
        figures: strikeFigures,
        ball: outcome === 'blocked' && closer
          ? { x: closer.x, y: closer.y }
          : { x: clampX(targetX), y: clampY(targetY) },
      },
      {
        offsetMs: Math.round(totalMs * 0.78),
        figures: settleFigures,
        ball: outcome === 'blocked' && closer
          ? { x: clampX(closer.x + jitter(`${scene.id}-block`, 0.04)), y: clampY(closer.y + towardGoal(direction, -0.02)) }
          : { x: clampX(targetX + jitter(`${scene.id}-settle`, 0.04)), y: clampY(targetY + towardGoal(direction, -0.03)) },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Goal celebration staging (tension beat)
// ---------------------------------------------------------------------------

/**
 * The product's celebrate-before-confirmation choreography (amended PRD,
 * "Goal sequence choreography"): the moment the goal goes provisional the
 * scorers sprint for a corner flag -- like real players, before the referee
 * confirms -- while the checking banner plays. The corner is picked
 * deterministically per goal. Scoreline is untouched here; that's the
 * takeover's job on confirmation.
 */
function resolveGoalCelebrationPlan(
  scene: GameViewScene,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  participant1Direction: BoardDirection,
): ClusterPlan {
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  if (!team) return { kind: 'hold' };

  const opponent = opponentOf(team, homeTeam, awayTeam);
  const direction = participantDirection(scene.participant, participant1Direction) ?? participant1Direction;
  const side = pickSide(scene.id);
  const totalMs = stagedDurationMs(scene);

  const flagX = side === 'left' ? EDGE_CLAMP_X + 0.02 : 1 - EDGE_CLAMP_X - 0.02;
  const flagY = direction === 'up' ? EDGE_CLAMP_Y + 0.02 : 1 - EDGE_CLAMP_Y - 0.02;
  const goalY = goalMouthY(direction);

  // The goal just went in at the attacked end: scoring block is fully up,
  // beaten side camped deep.
  const { possession, defending } = placeFormations(team, opponent, direction, 0.94, scene.playerCounts);

  const celebrants = nearestOutfield(possession, 0.5, goalY).slice(0, 3);
  const startFigures = [...possession, ...defending].map((figure) => {
    const rank = celebrants.findIndex((c) => c.key === figure.key);
    if (rank === -1) return figure;
    return {
      ...figure,
      x: clampX(0.5 + (rank - 1) * 0.13),
      y: clampY(goalY + towardGoal(direction, -(0.07 + rank * 0.03))),
      pose: rank === 0 ? 'celebrate' as const : 'run_a' as const,
      focus: 'engaged' as const,
    };
  });

  const sprintFacing: PlayerFacing = side === 'left' ? 'left' : 'right';
  const sprintFigures = startFigures.map((figure) => {
    const rank = celebrants.findIndex((c) => c.key === figure.key);
    if (rank === -1) return figure;
    return {
      ...figure,
      x: clampX(flagX + (side === 'left' ? 1 : -1) * (0.05 + rank * 0.07)),
      y: clampY(flagY + towardGoal(direction, -(0.03 + rank * 0.045))),
      pose: 'run_a' as const,
      facing: sprintFacing,
    };
  });

  const gatherFigures = sprintFigures.map((figure) => {
    const rank = celebrants.findIndex((c) => c.key === figure.key);
    if (rank === -1) return figure;
    return {
      ...figure,
      x: clampX(flagX + (side === 'left' ? 1 : -1) * (0.02 + rank * 0.045)),
      y: clampY(flagY + towardGoal(direction, -(0.01 + rank * 0.03))),
      pose: 'celebrate' as const,
    };
  });

  return {
    kind: 'staged',
    label: 'goal_celebration',
    durationMs: totalMs,
    teamName: team.name,
    teamColor: team.color,
    keyframes: [
      { offsetMs: 0, figures: startFigures, ball: { x: 0.5, y: goalY } },
      { offsetMs: Math.round(totalMs * 0.5), figures: sprintFigures, ball: { x: 0.5, y: goalY } },
      { offsetMs: Math.round(totalMs * 0.85), figures: gatherFigures, ball: { x: 0.5, y: goalY } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Kickoff staging
// ---------------------------------------------------------------------------

/**
 * Both full elevens line up in their own halves and the ball returns to the
 * spot -- the reset beat after a confirmed goal (and any other restart).
 */
function resolveKickoffPlan(
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  participant1Direction: BoardDirection,
  durationMs: number,
  playerCounts?: GameViewScene['playerCounts'],
): ClusterPlan {
  const kickoffWindow = { back: 0.08, front: 0.44 };
  const homeDirection = participantDirection(homeTeam.participant, participant1Direction) ?? participant1Direction;
  const awayDirection: BoardDirection = homeDirection === 'up' ? 'down' : 'up';

  const figures = [
    ...placeTeam(homeTeam, homeDirection, kickoffWindow, countForParticipant(playerCounts, homeTeam.participant)),
    ...placeTeam(awayTeam, awayDirection, kickoffWindow, countForParticipant(playerCounts, awayTeam.participant)),
  ];

  return {
    kind: 'staged',
    label: 'kickoff',
    durationMs,
    keyframes: [
      { offsetMs: 0, figures, ball: { x: 0.5, y: 0.5 } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Phase break staging
// ---------------------------------------------------------------------------

/**
 * What the players do at a phase change (product direction 2026-07-15: no
 * full-screen break cards -- the board itself tells the story, and the
 * commentary lower-third will carry the words):
 *
 * - 'assemble': a half is starting -- both elevens walk into their kickoff
 *   lineup and settle.
 * - 'walk_off': the half ended -- both teams leave to their benches at the
 *   touchlines.
 * - 'hold' for anything unrecognized.
 *
 * A phase_break scene carries the NEW phase it transitions into (see
 * core's handlePhaseChange), so 'first_half' here means kicking off, not
 * mid-half.
 */
const ASSEMBLE_PHASES: ReadonlySet<MatchEnginePhase> = new Set([
  'pre_match',
  'first_half_ready',
  'first_half',
  'second_half_ready',
  'second_half',
]);

const WALK_OFF_PHASES: ReadonlySet<MatchEnginePhase> = new Set([
  'half_time',
  'full_time_pending',
  'finalised',
]);

/**
 * Both teams gathered at their touchline benches -- home left, away right
 * (cosmetic, like the formation shapes). Loose two-column huddles at
 * midfield height; the ball stays on the spot with the referee.
 */
function resolveWalkOffPlan(
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  durationMs: number,
  playerCounts?: GameViewScene['playerCounts'],
): ClusterPlan {
  const figures: ClusterFigure[] = [];

  for (const team of [homeTeam, awayTeam]) {
    const isHome = team.participant === homeTeam.participant;
    const benchX = isHome ? 0.075 : 0.925;
    const inward = isHome ? 1 : -1;
    const slots = formationForParticipant(team.participant).slice(
      0,
      countForParticipant(playerCounts, team.participant),
    );
    slots.forEach((slot, index) => {
      const role: ClusterRole = slot.key === 'gk'
        ? 'keeper'
        : /^(lb|rb|cb)/.test(slot.key) ? 'defender' : 'attacker';
      const kit = role === 'keeper' ? team.kit?.keeper : team.kit?.outfield;
      figures.push({
        key: `p${team.participant}-${slot.key}`,
        role,
        participant: team.participant,
        color: kit?.shirt ?? team.color,
        ...(kit ? { shirtColor: kit.shirt, shortsColor: kit.shorts, trimColor: kit.trim } : {}),
        focus: 'engaged',
        x: clampX(benchX + (index % 2) * 0.035 * inward),
        y: clampY(0.36 + Math.floor(index / 2) * 0.045),
        pose: 'idle',
        facing: isHome ? 'right' : 'left',
      });
    });
  }

  return {
    kind: 'staged',
    label: 'walk_off',
    durationMs,
    keyframes: [
      { offsetMs: 0, figures, ball: { x: 0.5, y: 0.5 } },
    ],
  };
}

function resolvePhaseBreakPlan(
  scene: GameViewScene,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  participant1Direction: BoardDirection,
): ClusterPlan {
  if (scene.phase && ASSEMBLE_PHASES.has(scene.phase)) {
    return resolveKickoffPlan(homeTeam, awayTeam, participant1Direction, stagedDurationMs(scene), scene.playerCounts);
  }
  if (scene.phase && WALK_OFF_PHASES.has(scene.phase)) {
    return resolveWalkOffPlan(homeTeam, awayTeam, stagedDurationMs(scene), scene.playerCounts);
  }
  return { kind: 'hold' };
}

// ---------------------------------------------------------------------------
// Entry point + transitions
// ---------------------------------------------------------------------------

/** The goal_sequence beat the screen says is currently playing (see useGoalSequenceScoreHold). */
export type GoalBeatKind = 'tension' | 'celebration';

/**
 * Maps the current scene to the staging the board should play. Scenes with
 * true state to dramatize get a full arrangement; every other scene HOLDS
 * the previous arrangement (players never leave the pitch for a stoppage --
 * the badge/banner/takeover layered on top names the event). 'none' only
 * when there is no scene at all.
 */
export function resolveClusterPlan(
  scene: GameViewScene | null | undefined,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  participant1Direction: BoardDirection = 'up',
  goalBeat?: GoalBeatKind,
): ClusterPlan {
  if (!scene) return { kind: 'none' };

  switch (scene.kind) {
    case 'ambient':
      return resolveAmbientPlan(scene, homeTeam, awayTeam, participant1Direction);
    case 'set_piece':
      // Corners and throw-ins stage on the board (the restart is the
      // picture); free kicks and penalties freeze the formation under
      // their badge/vignette -- the players wait out the dead ball.
      if (scene.sourceAction === 'corner') {
        return resolveCornerPlan(scene, homeTeam, awayTeam, participant1Direction);
      }
      if (scene.sourceAction === 'throw_in') {
        return resolveThrowInPlan(scene, homeTeam, awayTeam, participant1Direction);
      }
      if (scene.sourceAction === 'goal_kick') {
        return resolveGoalKickPlan(scene, homeTeam, awayTeam, participant1Direction);
      }
      return { kind: 'hold' };
    case 'shot':
      return resolveShotPlan(scene, homeTeam, awayTeam, participant1Direction);
    case 'goal_sequence':
      // Players celebrate while the goal is still being checked; during the
      // confirmation takeover the board holds beneath it.
      if (goalBeat === 'tension') {
        return resolveGoalCelebrationPlan(scene, homeTeam, awayTeam, participant1Direction);
      }
      return { kind: 'hold' };
    case 'restart':
      return resolveKickoffPlan(
        homeTeam,
        awayTeam,
        participant1Direction,
        stagedDurationMs(scene),
        scene.playerCounts,
      );
    case 'phase_break':
      // The break IS the picture: assemble for a kickoff, walk off to the
      // benches at half/full time. The commentary layer carries the words.
      return resolvePhaseBreakPlan(scene, homeTeam, awayTeam, participant1Direction);
    default:
      // Cards, VAR, substitutions, retractions, and ambient spells with no
      // owning participant: freeze in place.
      return { kind: 'hold' };
  }
}

/** Returns a complete source-count frame only for plans that actually stage both sides. */
function frameFromStageablePlan(plan: ClusterPlan): StagedKeyframe | undefined {
  if (plan.kind === 'ambient') {
    if (!hasBothTeamsAndKeepers(plan.figures)) return undefined;
    return { offsetMs: 0, figures: plan.figures, ball: plan.ball };
  }
  if (plan.kind === 'staged') {
    const frame = plan.keyframes[plan.keyframes.length - 1];
    if (!frame || !hasBothTeamsAndKeepers(frame.figures)) return undefined;
    return frame;
  }
  return undefined;
}

function hasBothTeamsAndKeepers(figures: readonly ClusterFigure[]): boolean {
  const participant1 = figures.filter((figure) => figure.participant === 1);
  const participant2 = figures.filter((figure) => figure.participant === 2);
  return participant1.length >= 7
    && participant2.length >= 7
    && participant1.some((figure) => figure.role === 'keeper')
    && participant2.some((figure) => figure.role === 'keeper');
}

/**
 * Finds the nearest earlier timeline scene whose resolved choreography owns
 * a complete formation. Holds are deliberately skipped: a card cannot seed
 * another card, and a malformed ambient scene with no participant cannot
 * smuggle in an invented possession state.
 */
export function findNearestPriorStageableScene(
  timeline: readonly GameViewScene[],
  currentScene: GameViewScene | null | undefined,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  participant1Direction: BoardDirection = 'up',
): GameViewScene | undefined {
  if (!currentScene) return undefined;

  let currentIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.id === currentScene.id) {
      currentIndex = index;
      break;
    }
  }
  if (currentIndex < 0) return undefined;

  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = timeline[index];
    if (!candidate) continue;
    const plan = resolveClusterPlan(
      candidate,
      homeTeam,
      awayTeam,
      participant1Direction,
    );
    if (frameFromStageablePlan(plan)) return candidate;
  }
  return undefined;
}

/**
 * Resolves the first frame beneath a freshly mounted stoppage. A grounded
 * prior scene contributes its final positions and ball location. Without
 * one, both cosmetic formation blocks line up neutrally in their own halves
 * and the ball stays hidden: this keeps 22 figures on the pitch without
 * inventing a participant, zone, or restart location.
 */
export function resolveHoldBootstrapPlan(
  seedScene: GameViewScene | null | undefined,
  homeTeam: BoardTeamInfo,
  awayTeam: BoardTeamInfo,
  participant1Direction: BoardDirection = 'up',
): HoldBootstrapPlan {
  const seedFrame = seedScene
    ? frameFromStageablePlan(resolveClusterPlan(
        seedScene,
        homeTeam,
        awayTeam,
        participant1Direction,
      ))
    : undefined;

  if (seedFrame) {
    return {
      source: 'prior_scene',
      figures: seedFrame.figures.map((figure) => ({ ...figure, pose: 'idle' })),
      ball: { ...seedFrame.ball, visible: seedFrame.ball.visible !== false },
    };
  }

  const neutralWindow = { back: 0.08, front: 0.44 };
  const homeDirection = participantDirection(homeTeam.participant, participant1Direction)
    ?? participant1Direction;
  const awayDirection = participantDirection(awayTeam.participant, participant1Direction)
    ?? (homeDirection === 'up' ? 'down' : 'up');

  return {
    source: 'neutral',
    figures: [
      ...placeTeam(
        homeTeam,
        homeDirection,
        neutralWindow,
        countForParticipant(seedScene?.playerCounts, homeTeam.participant),
      ),
      ...placeTeam(
        awayTeam,
        awayDirection,
        neutralWindow,
        countForParticipant(seedScene?.playerCounts, awayTeam.participant),
      ),
    ],
    ball: { x: 0.5, y: 0.5, visible: false },
  };
}

/**
 * How the renderer should move from the previous scene's staging to the new
 * one:
 *
 * - 'flow': same team still on the ball (ambient -> ambient/shot); figures
 *   travel to the new arrangement -- the play visibly moved, grounded by the
 *   real zone/pressure cue that produced the new scene.
 * - 'turnover': possession flipped between ambient scenes; staged as the
 *   other side stepping in and taking the ball (the interception is theater,
 *   the possession change is fact).
 * - 'cut': everything else (takeovers, dead-ball repositioning, first
 *   scene): snap to the new arrangement, no invented travel.
 */
export type ClusterTransition = 'flow' | 'turnover' | 'cut';

const FLOW_KINDS: ReadonlySet<GameViewScene['kind']> = new Set(['ambient', 'shot']);

export function resolveClusterTransition(
  previousScene: GameViewScene | null | undefined,
  nextScene: GameViewScene | null | undefined,
): ClusterTransition {
  if (!previousScene || !nextScene) return 'cut';
  if (!FLOW_KINDS.has(previousScene.kind) || !FLOW_KINDS.has(nextScene.kind)) return 'cut';
  if (previousScene.participant === undefined || nextScene.participant === undefined) return 'cut';
  if (previousScene.participant === nextScene.participant) return 'flow';
  return nextScene.kind === 'ambient' ? 'turnover' : 'cut';
}
