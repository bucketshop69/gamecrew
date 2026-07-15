import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';

import {
  darkenColor,
  facingRotationDeg,
  mirrorLimbTransform,
  type LimbTransform,
  PLAYER_ASPECT_RATIO,
  type PlayerFacing,
  type PlayerPose,
  poseLimbSet,
  resolveMirrored,
  runCycleFrame,
} from './player-pose-logic';

export { PLAYER_ASPECT_RATIO } from './player-pose-logic';

/**
 * Stylized minimal football silhouette (work item R2 of
 * docs/issues/game-view-realism-experiment.md): head + torso + four limbs
 * composed from plain Views, no images/SVG. Visually a broadcast pictogram
 * rather than a stick figure -- torso and limbs carry width/rounding so they
 * read as weighted shapes at 24-40px, matching the retired demo's
 * `TacticalPlayer` look (see git history, `match-preview-screen.tsx` at
 * commit 19d6eff^) but generalized to the full pose set via
 * `player-pose-logic.ts` instead of ad hoc boolean flags.
 *
 * Sizing: `size` is the player's rendered height in px; width and every
 * limb/head dimension derive from it so the silhouette scales as one unit
 * (see `PLAYER_ASPECT_RATIO` below) instead of drifting at extreme sizes.
 */
export interface GameViewPlayerProps {
  pose: PlayerPose;
  teamColor: string;
  size: number;
  facing: PlayerFacing;
  mirrored?: boolean;
  /** Runs the built-in two-frame run cycle via Animated when the pose is 'run_a'/'run_b' and reduceMotion is false. Ignored for non-run poses. */
  animateRunCycle?: boolean;
  reduceMotion?: boolean;
  /** Optional shirt number rendered on the torso; omitted entirely when undefined (gallery keeps swatches clean). */
  number?: number;
}

const RUN_CYCLE_FRAME_MS = 220;

export function GameViewPlayer({
  animateRunCycle = false,
  facing,
  mirrored,
  number,
  pose,
  reduceMotion = false,
  size,
  teamColor,
}: GameViewPlayerProps) {
  const width = size / PLAYER_ASPECT_RATIO;
  const isRunPose = pose === 'run_a' || pose === 'run_b';
  const runFrame = useRunCycleFrame(isRunPose && animateRunCycle && !reduceMotion, pose);
  const effectivePose = isRunPose && animateRunCycle && !reduceMotion ? runFrame : pose;

  const limbs = poseLimbSet(effectivePose);
  const shouldMirror = resolveMirrored(facing, mirrored);
  const leftArm = shouldMirror ? mirrorLimbTransform(limbs.leftArm) : limbs.leftArm;
  const rightArm = shouldMirror ? mirrorLimbTransform(limbs.rightArm) : limbs.rightArm;
  const leftLeg = shouldMirror ? mirrorLimbTransform(limbs.leftLeg) : limbs.leftLeg;
  const rightLeg = shouldMirror ? mirrorLimbTransform(limbs.rightLeg) : limbs.rightLeg;
  const bodyRotate = shouldMirror ? -limbs.bodyRotateDeg : limbs.bodyRotateDeg;
  const facingRotate = facingRotationDeg(facing);
  const outlineColor = darkenColor(teamColor, 0.55);
  const shadowColor = darkenColor(teamColor, 0.7);

  const headSize = size * 0.24;
  const torsoWidth = width * 0.62;
  const torsoHeight = size * 0.36;
  const limbLength = size * 0.34;
  const limbThickness = Math.max(2, size * 0.11);

  return (
    <View style={{ height: size, width }}>
      <View
        style={[
          styles.sprite,
          {
            height: size,
            transform: [
              { rotate: `${facingRotate}deg` },
              { rotate: `${bodyRotate}deg` },
              { rotate: `${limbs.bodyLeanDeg}deg` },
            ],
            width,
          },
        ]}
      >
        <View
          style={[
            styles.shadow,
            { backgroundColor: shadowColor, bottom: -size * 0.04, width: width * 0.9 },
          ]}
        />

        <Limb
          color={teamColor}
          length={limbLength}
          side="left"
          slot="arm"
          thickness={limbThickness}
          transform={leftArm}
        />
        <Limb
          color={teamColor}
          length={limbLength}
          side="right"
          slot="arm"
          thickness={limbThickness}
          transform={rightArm}
        />

        <View
          style={[
            styles.torso,
            {
              backgroundColor: teamColor,
              borderColor: outlineColor,
              borderRadius: torsoWidth * 0.28,
              height: torsoHeight,
              width: torsoWidth,
            },
          ]}
        >
          {number !== undefined ? (
            <Text style={[styles.number, { color: outlineColor, fontSize: torsoHeight * 0.5 }]}>
              {number}
            </Text>
          ) : null}
        </View>

        <View
          style={[
            styles.head,
            {
              backgroundColor: outlineColor,
              borderRadius: headSize / 2,
              height: headSize,
              width: headSize,
            },
          ]}
        />

        <View style={[styles.legRow, { marginTop: -size * 0.02 }]}>
          <Limb
            color={teamColor}
            length={limbLength}
            side="left"
            slot="leg"
            thickness={limbThickness}
            transform={leftLeg}
          />
          <Limb
            color={teamColor}
            length={limbLength}
            side="right"
            slot="leg"
            thickness={limbThickness}
            transform={rightLeg}
          />
        </View>
      </View>
    </View>
  );
}

function Limb({
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
  const sideStyle = slot === 'arm'
    ? (side === 'left' ? styles.armSlotLeft : styles.armSlotRight)
    : undefined;

  return (
    <View
      style={[
        slot === 'arm' ? [styles.armSlot, sideStyle] : styles.legSlot,
        {
          backgroundColor: color,
          borderRadius: thickness / 2,
          height: length,
          transform: [
            { translateX: transform.translateXFraction * length },
            { translateY: transform.translateYFraction * length },
            { rotate: `${transform.rotateDeg}deg` },
          ],
          width: thickness,
        },
      ]}
    />
  );
}

/**
 * Drives the built-in two-frame run cycle with a repeating Animated loop
 * (native driver where available), reading `runCycleFrame` from the pose
 * logic module at each tick so the visual alternation matches the pure
 * function under test. Falls back to the static `pose` prop whenever
 * `enabled` is false (reduce-motion or the caller opted out).
 */
function useRunCycleFrame(enabled: boolean, fallbackPose: PlayerPose): PlayerPose {
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
  },
  shadow: {
    borderRadius: 6,
    height: 4,
    opacity: 0.3,
    position: 'absolute',
    transform: [{ scaleX: 1.3 }],
  },
  head: {
    zIndex: 3,
  },
  torso: {
    alignItems: 'center',
    borderWidth: Platform.OS === 'web' ? 1 : StyleSheet.hairlineWidth * 2,
    justifyContent: 'center',
    marginTop: -2,
    zIndex: 2,
  },
  number: {
    fontWeight: '900',
  },
  armSlot: {
    position: 'absolute',
    top: '18%',
    zIndex: 1,
  },
  armSlotLeft: {
    left: '4%',
  },
  armSlotRight: {
    right: '4%',
  },
  legRow: {
    flexDirection: 'row',
    gap: 3,
    zIndex: 1,
  },
  legSlot: {},
});
