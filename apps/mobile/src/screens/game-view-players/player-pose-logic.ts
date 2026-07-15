/**
 * Pure pose data for Game View's stylized player silhouettes (work item R2
 * of docs/issues/game-view-realism-experiment.md). Each pose is a fixed set
 * of limb transforms -- rotation in degrees plus a small translate offset --
 * expressed as fractions of the player's own size so the same pose scales
 * cleanly from a 24px gallery swatch up to whatever size the action cluster
 * (R4) ends up using. No component/View code lives here: this module is
 * pose-in, transforms-out so it can be unit-tested without React Native.
 *
 * Ported/refined from the retired scripted demo's `TacticalPlayer` (see
 * git history, `match-preview-screen.tsx` at commit 19d6eff^, deleted at
 * 19d6eff): that component hardcoded one arm/leg configuration per boolean
 * flag (celebrating/running/striking/diving) inline in JSX styles. Here the
 * same visual ideas -- raised arms for celebration, splayed legs for a
 * stride, a driven-through kicking leg, a rotated-sprite dive -- are
 * generalized into a `pose -> limb transform` table so every pose in the
 * work item's list (not just the demo's four) is representable, and so pose
 * selection is a pure function callers (and tests) can reason about without
 * mounting anything.
 */

export type PlayerPose =
  | 'idle'
  | 'run_a'
  | 'run_b'
  | 'strike'
  | 'header'
  | 'keeper_dive_left'
  | 'keeper_dive_right'
  | 'celebrate'
  | 'wall_stance';

export type PlayerFacing = 'up' | 'down' | 'left' | 'right';

/** Degrees to rotate a limb, plus a small translate offset expressed as a fraction of player width/height (0..1). */
export interface LimbTransform {
  rotateDeg: number;
  translateXFraction: number;
  translateYFraction: number;
}

export interface PlayerLimbSet {
  leftArm: LimbTransform;
  rightArm: LimbTransform;
  leftLeg: LimbTransform;
  rightLeg: LimbTransform;
  /** Whole-sprite rotation (degrees) layered on top of individual limbs -- used by the keeper dive poses. */
  bodyRotateDeg: number;
  /** Whole-sprite vertical lean (degrees) -- used by strike/header to suggest weight shift. */
  bodyLeanDeg: number;
}

const NEUTRAL_LIMB: LimbTransform = { rotateDeg: 0, translateXFraction: 0, translateYFraction: 0 };

const NEUTRAL_LIMB_SET: PlayerLimbSet = {
  leftArm: NEUTRAL_LIMB,
  rightArm: NEUTRAL_LIMB,
  leftLeg: NEUTRAL_LIMB,
  rightLeg: NEUTRAL_LIMB,
  bodyRotateDeg: 0,
  bodyLeanDeg: 0,
};

/**
 * The pose table. Every entry must supply all four limbs (broadcast
 * pictograms read as weighted, not skeletal, so an "unposed" limb still gets
 * a resting angle rather than a bare 0) -- `poseLimbSet` below is the only
 * place that should read this table, and its test asserts every `PlayerPose`
 * has a complete, finite entry.
 */
const POSE_TABLE: Record<PlayerPose, PlayerLimbSet> = {
  idle: {
    leftArm: { rotateDeg: 12, translateXFraction: 0, translateYFraction: 0 },
    rightArm: { rotateDeg: -12, translateXFraction: 0, translateYFraction: 0 },
    leftLeg: { rotateDeg: -4, translateXFraction: -0.02, translateYFraction: 0 },
    rightLeg: { rotateDeg: 4, translateXFraction: 0.02, translateYFraction: 0 },
    bodyRotateDeg: 0,
    bodyLeanDeg: 0,
  },
  run_a: {
    leftArm: { rotateDeg: -46, translateXFraction: 0, translateYFraction: -0.02 },
    rightArm: { rotateDeg: 46, translateXFraction: 0, translateYFraction: 0.02 },
    leftLeg: { rotateDeg: 30, translateXFraction: -0.05, translateYFraction: 0 },
    rightLeg: { rotateDeg: -34, translateXFraction: 0.06, translateYFraction: -0.03 },
    bodyRotateDeg: 0,
    bodyLeanDeg: 6,
  },
  run_b: {
    leftArm: { rotateDeg: 46, translateXFraction: 0, translateYFraction: 0.02 },
    rightArm: { rotateDeg: -46, translateXFraction: 0, translateYFraction: -0.02 },
    leftLeg: { rotateDeg: -34, translateXFraction: 0.06, translateYFraction: -0.03 },
    rightLeg: { rotateDeg: 30, translateXFraction: -0.05, translateYFraction: 0 },
    bodyRotateDeg: 0,
    bodyLeanDeg: 6,
  },
  strike: {
    leftArm: { rotateDeg: -60, translateXFraction: -0.02, translateYFraction: -0.03 },
    rightArm: { rotateDeg: 24, translateXFraction: 0, translateYFraction: 0 },
    leftLeg: { rotateDeg: -18, translateXFraction: -0.03, translateYFraction: 0 },
    rightLeg: { rotateDeg: -58, translateXFraction: 0.08, translateYFraction: -0.08 },
    bodyRotateDeg: 0,
    bodyLeanDeg: -10,
  },
  header: {
    leftArm: { rotateDeg: -50, translateXFraction: -0.03, translateYFraction: -0.04 },
    rightArm: { rotateDeg: 50, translateXFraction: 0.03, translateYFraction: -0.04 },
    leftLeg: { rotateDeg: 12, translateXFraction: -0.02, translateYFraction: 0.02 },
    rightLeg: { rotateDeg: -20, translateXFraction: 0.04, translateYFraction: -0.02 },
    bodyRotateDeg: 0,
    bodyLeanDeg: -16,
  },
  keeper_dive_left: {
    leftArm: { rotateDeg: -78, translateXFraction: -0.1, translateYFraction: -0.06 },
    rightArm: { rotateDeg: -30, translateXFraction: -0.06, translateYFraction: 0 },
    leftLeg: { rotateDeg: 20, translateXFraction: -0.02, translateYFraction: 0.04 },
    rightLeg: { rotateDeg: 46, translateXFraction: 0.06, translateYFraction: 0.02 },
    bodyRotateDeg: -68,
    bodyLeanDeg: 0,
  },
  keeper_dive_right: {
    leftArm: { rotateDeg: 30, translateXFraction: 0.06, translateYFraction: 0 },
    rightArm: { rotateDeg: 78, translateXFraction: 0.1, translateYFraction: -0.06 },
    leftLeg: { rotateDeg: -46, translateXFraction: -0.06, translateYFraction: 0.02 },
    rightLeg: { rotateDeg: -20, translateXFraction: 0.02, translateYFraction: 0.04 },
    bodyRotateDeg: 68,
    bodyLeanDeg: 0,
  },
  celebrate: {
    leftArm: { rotateDeg: -164, translateXFraction: -0.02, translateYFraction: -0.1 },
    rightArm: { rotateDeg: 164, translateXFraction: 0.02, translateYFraction: -0.1 },
    leftLeg: { rotateDeg: -10, translateXFraction: -0.03, translateYFraction: 0 },
    rightLeg: { rotateDeg: 10, translateXFraction: 0.03, translateYFraction: 0 },
    bodyRotateDeg: 0,
    bodyLeanDeg: -4,
  },
  wall_stance: {
    leftArm: { rotateDeg: -110, translateXFraction: -0.03, translateYFraction: -0.08 },
    rightArm: { rotateDeg: 110, translateXFraction: 0.03, translateYFraction: -0.08 },
    leftLeg: { rotateDeg: -6, translateXFraction: -0.02, translateYFraction: 0 },
    rightLeg: { rotateDeg: 6, translateXFraction: 0.02, translateYFraction: 0 },
    bodyRotateDeg: 0,
    bodyLeanDeg: 0,
  },
};

/** Every selectable pose, in the work item's product-facing display order (used by the dev gallery). */
export const PLAYER_POSES: readonly PlayerPose[] = [
  'idle',
  'run_a',
  'run_b',
  'strike',
  'header',
  'keeper_dive_left',
  'keeper_dive_right',
  'celebrate',
  'wall_stance',
];

/** Looks up a pose's limb transforms. Falls back to a neutral (all-zero) set for an unrecognized pose so a bad string never throws mid-render. */
export function poseLimbSet(pose: PlayerPose): PlayerLimbSet {
  return POSE_TABLE[pose] ?? NEUTRAL_LIMB_SET;
}

/**
 * Two-frame run cycle helper: given an elapsed-ms clock and a frame
 * duration, returns which of the two run poses should be showing. Pure so
 * the alternation math (and its boundary behavior at frame edges) can be
 * unit-tested without an Animated loop.
 */
export function runCycleFrame(elapsedMs: number, frameDurationMs: number): 'run_a' | 'run_b' {
  if (frameDurationMs <= 0) return 'run_a';
  const cycleIndex = Math.floor(Math.max(0, elapsedMs) / frameDurationMs);
  return cycleIndex % 2 === 0 ? 'run_a' : 'run_b';
}

/**
 * Facing -> base rotation in degrees for the whole sprite, plus whether the
 * sprite should be mirrored (flip left/right limb assignment) so a pose
 * authored for one direction reads correctly from any of the four facings.
 * 'down' (facing the viewer / attacking toward the bottom of the pitch) is
 * the pose table's authored orientation, so it's the identity case.
 */
export function facingRotationDeg(facing: PlayerFacing): number {
  switch (facing) {
    case 'down':
      return 0;
    case 'up':
      return 180;
    case 'left':
      return -90;
    case 'right':
      return 90;
    default:
      return 0;
  }
}

/**
 * Resolves whether a player sprite should be mirrored (negate horizontal
 * translate/rotate) given a facing and an explicit `mirrored` override. The
 * override always wins (callers use it for e.g. two attackers running the
 * same pose toward opposite wings); absent an override, 'left' facing
 * mirrors the authored (rightward-leaning) pose table by default so a
 * single pose table serves both horizontal directions without duplicate
 * entries.
 */
export function resolveMirrored(facing: PlayerFacing, mirrored?: boolean): boolean {
  if (mirrored !== undefined) return mirrored;
  return facing === 'left';
}

/**
 * Applies mirroring to a limb transform: negates rotation and horizontal
 * translate, leaves vertical translate untouched. Pure so the gallery and
 * any future cluster renderer share identical mirror math.
 */
export function mirrorLimbTransform(transform: LimbTransform): LimbTransform {
  return {
    rotateDeg: -transform.rotateDeg,
    translateXFraction: -transform.translateXFraction,
    translateYFraction: transform.translateYFraction,
  };
}

/** Player silhouette height:width ratio -- torso-forward proportions read better than a true 1:1 stick figure at small sizes. Lives here (not the component file) so it's importable from a plain-node test without pulling in react-native. */
export const PLAYER_ASPECT_RATIO = 32 / 22;

/**
 * Darkens a `#rrggbb` color by `amount` (0..1) toward black, used for a
 * player's outline/shadow tone so silhouettes pop on a near-black pitch
 * without a separate design token per team. Falls back to the input color
 * unchanged if it isn't a parseable hex. Pure color math, kept in the logic
 * module (not the component file) so it's unit-testable without react-native.
 */
export function darkenColor(color: string, amount: number): string {
  const normalized = color.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return color;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16));
  const darkened = channels.map((channel) => Math.round(channel * (1 - amount)));
  return `#${darkened.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}
