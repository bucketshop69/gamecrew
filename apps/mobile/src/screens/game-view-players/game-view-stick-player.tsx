import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import {
  mirrorLimbTransform,
  poseLimbSet,
  resolveMirrored,
  runCycleFrame,
  type LimbTransform,
  type PlayerFacing,
  type PlayerPose,
} from './player-pose-logic';

/**
 * Thin stickman silhouette for the 22-player formation view (the realism
 * experiment's revised direction, approved from a mockup 2026-07-15): a
 * head dot plus line torso and limbs, readable at ~20px, replacing the
 * chunky broadcast token on the board. Reuses the same pose table
 * (player-pose-logic.ts) as `GameViewPlayer` so every pose -- run cycle,
 * strike, keeper dives, celebrate -- works on both figure styles; only the
 * geometry differs (thin bars instead of weighted shapes).
 *
 * Width relative to height is wider than the chunky token because limbs
 * splay from a line body: see STICK_WIDTH_RATIO.
 */
export const STICK_WIDTH_RATIO = 0.72;

export interface GameViewStickPlayerProps {
  pose: PlayerPose;
  teamColor: string;
  /** Rendered height in px; every part derives from it. */
  size: number;
  facing: PlayerFacing;
  mirrored?: boolean;
  animateRunCycle?: boolean;
  reduceMotion?: boolean;
}

const RUN_CYCLE_FRAME_MS = 220;
const FIGURE_KEYLINE_COLOR = 'rgba(235, 242, 233, 0.72)';

export function GameViewStickPlayer({
  animateRunCycle = false,
  facing,
  mirrored,
  pose,
  reduceMotion = false,
  size,
  teamColor,
}: GameViewStickPlayerProps) {
  const width = size * STICK_WIDTH_RATIO;
  const isRunPose = pose === 'run_a' || pose === 'run_b';
  const cycling = isRunPose && animateRunCycle && !reduceMotion;
  const runFrame = useStickRunFrame(cycling, pose);
  const effectivePose = cycling ? runFrame : pose;

  const limbs = poseLimbSet(effectivePose);
  const shouldMirror = resolveMirrored(facing, mirrored);
  const leftArm = shouldMirror ? mirrorLimbTransform(limbs.leftArm) : limbs.leftArm;
  const rightArm = shouldMirror ? mirrorLimbTransform(limbs.rightArm) : limbs.rightArm;
  const leftLeg = shouldMirror ? mirrorLimbTransform(limbs.leftLeg) : limbs.leftLeg;
  const rightLeg = shouldMirror ? mirrorLimbTransform(limbs.rightLeg) : limbs.rightLeg;
  const bodyRotate = shouldMirror ? -limbs.bodyRotateDeg : limbs.bodyRotateDeg;
  // Figures always stand upright on the top-down board (product feedback
  // 2026-07-15: the 180-degree "facing down" rotation read as upside-down
  // players). Direction is carried by position and movement; a lateral
  // facing just leans the body a touch, like a player mid-stride.
  const facingLean = facing === 'left' ? -9 : facing === 'right' ? 9 : 0;

  const headSize = Math.max(4, size * 0.26);
  const torsoLength = size * 0.32;
  const limbLength = size * 0.3;
  const lineThickness = Math.max(1.5, size * 0.09);
  const keylineDelta = Math.max(0.7, size * 0.045);
  const shadowWidth = size * 0.4;
  const shadowHeight = Math.max(1.5, size * 0.1);

  return (
    <View style={{ height: size, width }}>
      <View
        style={[
          styles.contactShadow,
          {
            borderRadius: shadowHeight / 2,
            bottom: size * 0.02,
            height: shadowHeight,
            left: (width - shadowWidth) / 2,
            width: shadowWidth,
          },
        ]}
      />
      <View
        style={[
          styles.sprite,
          {
            height: size,
            transform: [
              { rotate: `${facingLean}deg` },
              { rotate: `${bodyRotate}deg` },
              { rotate: `${limbs.bodyLeanDeg}deg` },
            ],
            width,
          },
        ]}
      >
        <StickFigureLayer
          color={FIGURE_KEYLINE_COLOR}
          headSize={headSize + keylineDelta}
          headSizeDelta={keylineDelta}
          leftArm={leftArm}
          leftLeg={leftLeg}
          limbLength={limbLength}
          lineThickness={lineThickness + keylineDelta}
          rightArm={rightArm}
          rightLeg={rightLeg}
          size={size}
          torsoLength={torsoLength}
          width={width}
        />
        <StickFigureLayer
          color={teamColor}
          headSize={headSize}
          headSizeDelta={0}
          leftArm={leftArm}
          leftLeg={leftLeg}
          limbLength={limbLength}
          lineThickness={lineThickness}
          rightArm={rightArm}
          rightLeg={rightLeg}
          size={size}
          torsoLength={torsoLength}
          width={width}
        />
      </View>
    </View>
  );
}

/**
 * One complete silhouette layer. Rendering a slightly thicker neutral layer
 * beneath the team-color layer creates a platform-consistent keyline without
 * relying on shadow APIs that render differently on Android and web.
 */
function StickFigureLayer({
  color,
  headSize,
  headSizeDelta,
  leftArm,
  leftLeg,
  limbLength,
  lineThickness,
  rightArm,
  rightLeg,
  size,
  torsoLength,
  width,
}: {
  color: string;
  headSize: number;
  headSizeDelta: number;
  leftArm: LimbTransform;
  leftLeg: LimbTransform;
  limbLength: number;
  lineThickness: number;
  rightArm: LimbTransform;
  rightLeg: LimbTransform;
  size: number;
  torsoLength: number;
  width: number;
}) {
  return (
    <View style={[styles.figureLayer, { height: size, width }]}>
      <View
        style={{
          backgroundColor: color,
          borderRadius: headSize / 2,
          height: headSize,
          width: headSize,
        }}
      />
      <View
        style={{
          backgroundColor: color,
          height: torsoLength,
          marginTop: -1 - headSizeDelta,
          width: lineThickness,
        }}
      >
        <StickLimb color={color} length={limbLength} slot="arm" side="left" thickness={lineThickness} transform={leftArm} />
        <StickLimb color={color} length={limbLength} slot="arm" side="right" thickness={lineThickness} transform={rightArm} />
      </View>
      <View style={styles.legRow}>
        <StickLimb color={color} length={limbLength} slot="leg" side="left" thickness={lineThickness} transform={leftLeg} />
        <StickLimb color={color} length={limbLength} slot="leg" side="right" thickness={lineThickness} transform={rightLeg} />
      </View>
    </View>
  );
}

/**
 * One thin limb bar. Arms hang from the shoulder point (absolute inside the
 * torso bar); legs sit in a row below it. Rotation pivots near the top of
 * the bar via a translate-rotate-translate sandwich so limbs swing from the
 * joint instead of their center -- at stickman thinness a center pivot
 * visibly detaches the limb from the body.
 */
function StickLimb({
  color,
  length,
  side,
  slot,
  thickness,
  transform,
}: {
  color: string;
  length: number;
  side: 'left' | 'right';
  slot: 'arm' | 'leg';
  thickness: number;
  transform: LimbTransform;
}) {
  const half = length / 2;
  return (
    <View
      style={[
        slot === 'arm'
          ? [styles.armSlot, side === 'left' ? styles.armLeft : styles.armRight]
          : undefined,
        {
          backgroundColor: color,
          borderRadius: thickness / 2,
          height: length,
          transform: [
            { translateX: transform.translateXFraction * length },
            { translateY: -half + transform.translateYFraction * length },
            { rotate: `${transform.rotateDeg}deg` },
            { translateY: half },
          ],
          width: thickness,
        },
      ]}
    />
  );
}

/** Same two-frame run alternation as GameViewPlayer's, kept private to avoid coupling the two figure styles. */
function useStickRunFrame(enabled: boolean, fallbackPose: PlayerPose): PlayerPose {
  const clock = useRef(new Animated.Value(0)).current;
  const frameRef = useRef<PlayerPose>(fallbackPose);
  const listenerFrameRef = useRef<PlayerPose>(fallbackPose);

  useEffect(() => {
    if (!enabled) return undefined;

    const listenerId = clock.addListener(({ value }) => {
      listenerFrameRef.current = runCycleFrame(value, RUN_CYCLE_FRAME_MS);
    });
    const loop = Animated.loop(
      Animated.timing(clock, {
        duration: RUN_CYCLE_FRAME_MS * 2,
        easing: Easing.linear,
        isInteraction: false,
        toValue: RUN_CYCLE_FRAME_MS * 2,
        useNativeDriver: false,
      }),
    );
    loop.start();

    return () => {
      loop.stop();
      clock.removeListener(listenerId);
      clock.setValue(0);
    };
  }, [clock, enabled]);

  if (!enabled) return fallbackPose;
  frameRef.current = listenerFrameRef.current;
  return frameRef.current;
}

const styles = StyleSheet.create({
  sprite: {
    alignItems: 'center',
    position: 'relative',
    zIndex: 1,
  },
  figureLayer: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    top: 0,
  },
  contactShadow: {
    backgroundColor: 'rgba(0, 0, 0, 0.34)',
    position: 'absolute',
  },
  legRow: {
    flexDirection: 'row',
    gap: 2,
    marginTop: -1,
  },
  armSlot: {
    position: 'absolute',
    top: 1,
    zIndex: 1,
  },
  armLeft: {
    left: -1,
  },
  armRight: {
    right: -1,
  },
});
