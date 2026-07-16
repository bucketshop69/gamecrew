import type { GameViewScene } from '@gamecrew/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';

import type { BoardDirection, BoardTeamInfo } from '../game-view/game-view-board-logic';
import {
  STICK_FIGURE_SIZE_PX,
  resolveHoldBootstrapPlan,
  resolveClusterPlan,
  resolveClusterTransition,
  type ClusterFigure,
  type ClusterPlan,
  type GoalBeatKind,
  type StagedKeyframe,
} from './cluster-choreography-logic';
import { GameViewBall } from './game-view-ball';
import { GameViewStickPlayer, STICK_WIDTH_RATIO } from './game-view-stick-player';
import type { PlayerPose } from './player-pose-logic';


/**
 * The action cluster renderer (work item R4 of
 * docs/issues/game-view-realism-experiment.md): plays whatever
 * `resolveClusterPlan` staged for the current scene -- the ambient knot with
 * its pressure-paced passing, corner swings, shots, the
 * celebrate-before-confirmation goal run, and kickoff lineups. All staging
 * decisions live in cluster-choreography-logic.ts; this component only
 * animates between the arrangements it is handed.
 *
 * Motion language (Disney principles via the motion-designer pass):
 * - anticipation: the passer flicks to the strike pose a beat before the
 *   ball leaves; the corner taker winds up before the swing.
 * - arcs: lofted deliveries (corner swings) rise -- the ball scales up
 *   mid-flight and settles back down -- rather than sliding flat.
 * - follow-through: figures arrive after the ball on turnovers (the ball
 *   leads, bodies catch up), and poses settle to idle after the action.
 * - slow in/out: every relocation eases out; nothing moves linearly except
 *   a struck shot, which is deliberately fast and direct.
 *
 * Reduce-motion: no loops, no travel -- arrangements snap, and a staged plan
 * shows its final (most informative) keyframe, matching the takeovers'
 * reduce-motion treatment.
 */
export function GameViewActionCluster({
  awayTeam,
  bootstrapScene,
  goalBeat,
  homeTeam,
  participant1Direction,
  reduceMotion,
  scene,
  sceneWindowKey,
}: {
  awayTeam: BoardTeamInfo;
  /** Nearest prior scene with a grounded 22-figure plan, used only when a hold mounts cold. */
  bootstrapScene?: GameViewScene;
  goalBeat?: GoalBeatKind;
  homeTeam: BoardTeamInfo;
  participant1Direction: BoardDirection;
  reduceMotion: boolean;
  scene: GameViewScene | null;
  sceneWindowKey?: string;
}) {
  const plan = useMemo(
    () => resolveClusterPlan(scene, homeTeam, awayTeam, participant1Direction, goalBeat),
    [awayTeam, goalBeat, homeTeam, participant1Direction, scene],
  );
  const holdBootstrapPlan = useMemo(
    () => plan.kind === 'hold'
      ? resolveHoldBootstrapPlan(
          bootstrapScene,
          homeTeam,
          awayTeam,
          participant1Direction,
        )
      : undefined,
    [awayTeam, bootstrapScene, homeTeam, participant1Direction, plan.kind],
  );
  const initialHoldFrameRef = useRef<StagedKeyframe | undefined>(
    holdBootstrapPlan
      ? { offsetMs: 0, figures: holdBootstrapPlan.figures, ball: holdBootstrapPlan.ball }
      : undefined,
  );
  const initialHoldFrame = initialHoldFrameRef.current;

  const [figures, setFigures] = useState<readonly ClusterFigure[]>(
    () => initialHoldFrame?.figures ?? [],
  );
  const [poses, setPoses] = useState<Record<string, PlayerPose>>(
    () => posesForFigures(initialHoldFrame?.figures ?? []),
  );
  const [movingKeys, setMovingKeys] = useState<ReadonlySet<string>>(new Set());

  const animsRef = useRef(createSnappedFigureAnims(initialHoldFrame?.figures ?? []));
  const ballAnim = useRef({
    x: new Animated.Value(initialHoldFrame?.ball.x ?? 0.5),
    y: new Animated.Value(initialHoldFrame?.ball.y ?? 0.5),
    scale: new Animated.Value(1),
    opacity: new Animated.Value(
      initialHoldFrame ? (initialHoldFrame.ball.visible === false ? 0 : 1) : 0,
    ),
  }).current;
  const holderRef = useRef<string | undefined>(initialHoldFrame?.ball.holderKey);
  const prevSceneRef = useRef<GameViewScene | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // One effect owns the whole choreography lifecycle for the current plan:
  // clear the previous scene's timers, move (or snap) into the new
  // arrangement, then run the plan's own life (pass loop / staged
  // keyframes) until the next scene replaces it.
  useEffect(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    const windowStartedAtMs = Date.now();
    const sceneDurationMs = Math.max(0, scene?.durationHint.minMs ?? 0);
    const remainingMs = () => sceneDurationMs > 0
      ? Math.max(0, sceneDurationMs - (Date.now() - windowStartedAtMs))
      : Number.POSITIVE_INFINITY;
    const schedule = (delayMs: number, run: () => void) => {
      const safeDelayMs = Math.max(0, delayMs);
      if (safeDelayMs >= remainingMs()) return;
      timersRef.current.push(setTimeout(run, safeDelayMs));
    };

    const previousScene = prevSceneRef.current;
    prevSceneRef.current = scene;

    if (plan.kind === 'none') {
      setFigures([]);
      holderRef.current = undefined;
      // stopAnimation before setValue: on the JS driver a running timing is
      // NOT cancelled by setValue and would keep driving the value each
      // frame, silently overriding the snap (same rule everywhere below).
      ballAnim.opacity.stopAnimation();
      ballAnim.opacity.setValue(0);
      for (const anim of animsRef.current.values()) {
        anim.x.stopAnimation();
        anim.y.stopAnimation();
        anim.opacity.stopAnimation();
      }
      return undefined;
    }

    if (plan.kind === 'hold') {
      // Dead-ball freeze: everyone stays where they are (players don't
      // leave the pitch for a throw-in or a card); passes and run cycles
      // stop, poses settle. On a cold mount there is nothing to freeze, so
      // snap in the prior grounded frame (or honesty-safe neutral fallback)
      // before holding it. The badge/banner above names the event.
      if (animsRef.current.size === 0 && holdBootstrapPlan) {
        applyFrame(
          {
            offsetMs: 0,
            figures: holdBootstrapPlan.figures,
            ball: holdBootstrapPlan.ball,
          },
          'cut',
          {
            anims: animsRef.current,
            ball: ballAnim,
            holderRef,
            reduceMotion: true,
            sceneDurationMs,
            remainingMs,
            schedule,
            setFigures,
            setMovingKeys,
            setPoses,
          },
        );
      }
      setPoses((previous) => {
        const settled: Record<string, PlayerPose> = {};
        for (const key of Object.keys(previous)) settled[key] = 'idle';
        return settled;
      });
      setMovingKeys(new Set());
      for (const anim of animsRef.current.values()) {
        anim.x.stopAnimation();
        anim.y.stopAnimation();
        anim.opacity.stopAnimation();
      }
      stopBall(ballAnim);
      return cleanupMotion(timersRef, animsRef.current, ballAnim);
    }

    let transition = reduceMotion ? 'cut' : resolveClusterTransition(previousScene, scene);
    // A 'cut' exists for entering with no one on the pitch (first scene,
    // post-clear). With 22 figures already standing there, an instant snap
    // reads as teleportation -- dead-ball repositioning is players walking
    // into place, so upgrade to a flow.
    if (transition === 'cut' && !reduceMotion && animsRef.current.size > 0) {
      transition = 'flow';
    }
    const openingFrame: StagedKeyframe = plan.kind === 'ambient'
      ? { offsetMs: 0, figures: plan.figures, ball: plan.ball }
      : (reduceMotion ? plan.keyframes[plan.keyframes.length - 1]! : plan.keyframes[0]!);

    applyFrame(openingFrame, transition, {
      anims: animsRef.current,
      ball: ballAnim,
      holderRef,
      reduceMotion,
      sceneDurationMs,
      remainingMs,
      schedule,
      setFigures,
      setMovingKeys,
      setPoses,
    });

    // No floating possession label: the wandering team name read as noise
    // over 22 figures (product feedback 2026-07-15) -- who has the ball is
    // visible from the ball itself, and the commentary layer narrates.

    if (reduceMotion) return cleanupMotion(timersRef, animsRef.current, ballAnim);

    if (plan.kind === 'ambient') {
      runPassLoop(plan, {
        anims: animsRef.current,
        ball: ballAnim,
        holderRef,
        remainingMs,
        schedule,
        setPoses,
      });
    } else {
      runStagedKeyframes(plan, {
        anims: animsRef.current,
        ball: ballAnim,
        holderRef,
        remainingMs,
        sceneDurationMs,
        schedule,
        setFigures,
        setMovingKeys,
        setPoses,
      });
    }

    return cleanupMotion(timersRef, animsRef.current, ballAnim);
    // The plan is derived from these inputs via useMemo above; keying the
    // effect on the plan object itself would re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene?.id, bootstrapScene?.id, goalBeat, reduceMotion, plan.kind, sceneWindowKey]);

  if (plan.kind === 'none' || figures.length === 0) return null;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.layer}
    >
      {figures.map((figure) => {
        const anim = animsRef.current.get(figure.key);
        if (!anim) return null;
        return (
          <Animated.View
            key={figure.key}
            style={[
              styles.slot,
              {
                opacity: anim.opacity,
                transform: [
                  { translateX: anim.x.interpolate(PCT) },
                  { translateY: anim.y.interpolate(PCT) },
                ],
              },
            ]}
          >
            <View style={styles.figureContent}>
              <GameViewStickPlayer
                animateRunCycle={movingKeys.has(figure.key)}
                facing={figure.facing}
                pose={poses[figure.key] ?? figure.pose}
                reduceMotion={reduceMotion}
                size={STICK_FIGURE_SIZE_PX}
                teamColor={figure.color}
              />
            </View>
          </Animated.View>
        );
      })}

      <Animated.View
        style={[
          styles.slot,
          styles.ballSlot,
          {
            opacity: ballAnim.opacity,
            transform: [
              { translateX: ballAnim.x.interpolate(PCT) },
              { translateY: ballAnim.y.interpolate(PCT) },
            ],
          },
        ]}
      >
        <Animated.View style={[styles.ballContent, { transform: [{ scale: ballAnim.scale }] }]}>
          <GameViewBall size={12} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Animation plumbing
// ---------------------------------------------------------------------------

interface FigureAnim {
  x: Animated.Value;
  y: Animated.Value;
  opacity: Animated.Value;
}

function posesForFigures(figures: readonly ClusterFigure[]): Record<string, PlayerPose> {
  const poses: Record<string, PlayerPose> = {};
  for (const figure of figures) poses[figure.key] = figure.pose;
  return poses;
}

function createSnappedFigureAnims(figures: readonly ClusterFigure[]): Map<string, FigureAnim> {
  return new Map(figures.map((figure) => [
    figure.key,
    {
      x: new Animated.Value(figure.x),
      y: new Animated.Value(figure.y),
      opacity: new Animated.Value(1),
    },
  ]));
}

const PCT: Animated.InterpolationConfigType = { inputRange: [0, 1], outputRange: ['0%', '100%'] };
const NATIVE = Platform.OS !== 'web';

/** Relocation timing: flow reads as play traveling; turnover is snappier because the ball leads it. */
const FLOW_MOVE_MS = 640;
const TURNOVER_MOVE_MS = 500;
const KEYFRAME_MOVE_MS = 460;
/** Small per-figure delay so lines ripple rather than march -- kept tight because 22 figures share it. */
const MOVE_STAGGER_MS = 12;
/** Ground pass flight time -- constant regardless of tempo (fewer passes, never faster ones). */
const PASS_FLIGHT_MS = 360;
/** How long before the ball leaves that the passer winds up (anticipation). */
const PASS_WINDUP_MS = 150;

interface FrameContext {
  anims: Map<string, FigureAnim>;
  ball: { x: Animated.Value; y: Animated.Value; scale: Animated.Value; opacity: Animated.Value };
  holderRef: { current: string | undefined };
  reduceMotion?: boolean;
  sceneDurationMs: number;
  remainingMs: () => number;
  schedule: (delayMs: number, run: () => void) => void;
  setFigures: (figures: readonly ClusterFigure[]) => void;
  setMovingKeys: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  setPoses: React.Dispatch<React.SetStateAction<Record<string, PlayerPose>>>;
}

/** Keep the final pose settled just before the engine advances the scene. */
const MOTION_SETTLE_BUFFER_MS = 24;

function cappedMotionMs(preferredMs: number, availableMs: number): number {
  if (!Number.isFinite(availableMs)) return preferredMs;
  return Math.max(0, Math.min(preferredMs, availableMs - MOTION_SETTLE_BUFFER_MS));
}

function figureMoveTiming(
  index: number,
  figureCount: number,
  motionBudgetMs: number,
): { delayMs: number; durationMs: number } {
  if (motionBudgetMs <= 0) return { delayMs: 0, durationMs: 0 };
  const maxStaggerMs = Math.min(
    Math.max(figureCount - 1, 0) * MOVE_STAGGER_MS,
    motionBudgetMs * 0.22,
  );
  const staggerStepMs = figureCount > 1 ? maxStaggerMs / (figureCount - 1) : 0;
  const delayMs = index * staggerStepMs;
  return { delayMs, durationMs: Math.max(0, motionBudgetMs - delayMs) };
}

/** Stops all in-flight ball animations so a subsequent setValue actually sticks (see the JS-driver note in applyFrame). */
function stopBall(ball: FrameContext['ball']): void {
  ball.x.stopAnimation();
  ball.y.stopAnimation();
  ball.scale.stopAnimation();
  ball.opacity.stopAnimation();
}

function ensureAnim(anims: Map<string, FigureAnim>, figure: ClusterFigure): { anim: FigureAnim; isNew: boolean } {
  const existing = anims.get(figure.key);
  if (existing) return { anim: existing, isNew: false };
  const created: FigureAnim = {
    x: new Animated.Value(figure.x),
    y: new Animated.Value(figure.y),
    opacity: new Animated.Value(0),
  };
  anims.set(figure.key, created);
  return { anim: created, isNew: true };
}

/**
 * Moves the cluster into `frame`. 'cut' snaps (dead-ball repositioning, or
 * reduce-motion); 'flow'/'turnover' travel there -- figures run (staggered,
 * eased out) and settle back into the frame's poses on arrival; on a
 * turnover the ball darts to its new owner first and the bodies follow.
 */
function applyFrame(
  frame: StagedKeyframe,
  transition: 'cut' | 'flow' | 'turnover',
  context: FrameContext,
): void {
  const {
    anims,
    ball,
    holderRef,
    sceneDurationMs,
    schedule,
    setFigures,
    setMovingKeys,
    setPoses,
  } = context;

  const frameKeys = new Set(frame.figures.map((figure) => figure.key));
  for (const key of anims.keys()) {
    if (!frameKeys.has(key)) anims.delete(key);
  }

  const settledPoses: Record<string, PlayerPose> = {};
  for (const figure of frame.figures) settledPoses[figure.key] = figure.pose;

  if (transition === 'cut') {
    for (const figure of frame.figures) {
      const { anim } = ensureAnim(anims, figure);
      // A previous scene's in-flight timing would override setValue every
      // frame on the JS driver -- stop before snapping.
      anim.x.stopAnimation();
      anim.y.stopAnimation();
      anim.x.setValue(figure.x);
      anim.y.setValue(figure.y);
      anim.opacity.stopAnimation();
      if (context.reduceMotion) {
        anim.opacity.setValue(1);
      } else {
        const fadeMs = cappedMotionMs(220, sceneDurationMs || Number.POSITIVE_INFINITY);
        if (fadeMs <= 0) {
          anim.opacity.setValue(1);
        } else {
          Animated.timing(anim.opacity, { toValue: 1, duration: fadeMs, easing: Easing.out(Easing.quad), isInteraction: false, useNativeDriver: NATIVE }).start();
        }
      }
    }
    stopBall(ball);
    ball.x.setValue(frame.ball.x);
    ball.y.setValue(frame.ball.y);
    ball.scale.setValue(1);
    ball.opacity.setValue(frame.ball.visible === false ? 0 : 1);
    holderRef.current = frame.ball.visible === false ? undefined : frame.ball.holderKey;
    setFigures(frame.figures);
    setPoses(settledPoses);
    setMovingKeys(new Set());
    return;
  }

  const preferredMoveMs = transition === 'turnover' ? TURNOVER_MOVE_MS : FLOW_MOVE_MS;
  const moveBudgetMs = cappedMotionMs(
    preferredMoveMs,
    sceneDurationMs || Number.POSITIVE_INFINITY,
  );
  const moving = new Set<string>();

  frame.figures.forEach((figure, index) => {
    const { anim, isNew } = ensureAnim(anims, figure);

    // Compressed replay churns ambient scenes quickly; a figure already in
    // (or virtually in) position must not flicker into a run cycle for a
    // zero-distance move. Snap it and leave it settled.
    // eslint-disable-next-line no-underscore-dangle
    const currentX = (anim.x as unknown as { __getValue?: () => number }).__getValue?.() ?? figure.x;
    // eslint-disable-next-line no-underscore-dangle
    const currentY = (anim.y as unknown as { __getValue?: () => number }).__getValue?.() ?? figure.y;
    const distance = Math.hypot(figure.x - currentX, figure.y - currentY);
    if (!isNew && distance < 0.015) {
      anim.x.stopAnimation();
      anim.y.stopAnimation();
      anim.opacity.stopAnimation();
      anim.x.setValue(figure.x);
      anim.y.setValue(figure.y);
      anim.opacity.setValue(1);
      return;
    }

    const { delayMs, durationMs } = figureMoveTiming(
      index,
      frame.figures.length,
      moveBudgetMs,
    );
    anim.x.stopAnimation();
    anim.y.stopAnimation();
    anim.opacity.stopAnimation();
    if (durationMs <= 0) {
      anim.x.setValue(figure.x);
      anim.y.setValue(figure.y);
      anim.opacity.setValue(1);
    } else {
      Animated.parallel([
        Animated.timing(anim.x, { toValue: figure.x, duration: durationMs, delay: delayMs, easing: Easing.out(Easing.cubic), isInteraction: false, useNativeDriver: NATIVE }),
        Animated.timing(anim.y, { toValue: figure.y, duration: durationMs, delay: delayMs, easing: Easing.out(Easing.cubic), isInteraction: false, useNativeDriver: NATIVE }),
        Animated.timing(anim.opacity, { toValue: 1, duration: Math.min(isNew ? 240 : durationMs, durationMs), delay: delayMs, easing: Easing.out(Easing.quad), isInteraction: false, useNativeDriver: NATIVE }),
      ]).start();
    }
    moving.add(figure.key);
    // Follow-through: bodies settle into the frame's pose once they arrive.
    schedule(delayMs + durationMs, () => {
      setMovingKeys((previous) => {
        const next = new Set(previous);
        next.delete(figure.key);
        return next;
      });
      setPoses((previous) => ({ ...previous, [figure.key]: figure.pose }));
    });
  });

  // The ball leads a turnover (the steal is the story); it travels with the
  // play on a flow.
  const ballMs = cappedMotionMs(
    transition === 'turnover' ? 300 : 480,
    sceneDurationMs || Number.POSITIVE_INFINITY,
  );
  stopBall(ball);
  ball.scale.setValue(1);
  const ballVisible = frame.ball.visible !== false;
  if (!ballVisible) {
    ball.x.setValue(frame.ball.x);
    ball.y.setValue(frame.ball.y);
    ball.opacity.setValue(0);
    holderRef.current = undefined;
  } else if (ballMs <= 0) {
    ball.x.setValue(frame.ball.x);
    ball.y.setValue(frame.ball.y);
    ball.opacity.setValue(1);
  } else {
    Animated.parallel([
      Animated.timing(ball.x, { toValue: frame.ball.x, duration: ballMs, easing: Easing.out(Easing.quad), isInteraction: false, useNativeDriver: NATIVE }),
      Animated.timing(ball.y, { toValue: frame.ball.y, duration: ballMs, easing: Easing.out(Easing.quad), isInteraction: false, useNativeDriver: NATIVE }),
      Animated.timing(ball.opacity, { toValue: 1, duration: Math.min(200, ballMs), isInteraction: false, useNativeDriver: NATIVE }),
    ]).start();
  }
  holderRef.current = ballVisible ? frame.ball.holderKey : undefined;

  setFigures(frame.figures);
  // Figures actually in transit run; ones already in position stay settled.
  const transitPoses: Record<string, PlayerPose> = {};
  for (const figure of frame.figures) {
    transitPoses[figure.key] = moving.has(figure.key) ? 'run_a' : figure.pose;
  }
  setPoses(transitPoses);
  setMovingKeys(moving);
}

/**
 * The ambient life: a pass every `passIntervalMs`, cycling through the
 * possessing team. Wind-up (anticipation) -> flight -> settle. The loop
 * reschedules itself until the scene's timers are cleared.
 */
function runPassLoop(
  plan: Extract<ClusterPlan, { kind: 'ambient' }>,
  context: Pick<FrameContext, 'anims' | 'ball' | 'holderRef' | 'remainingMs' | 'schedule' | 'setPoses'>,
): void {
  const { ball, holderRef, remainingMs, schedule, setPoses } = context;
  const cycle = plan.passCycleKeys;
  if (cycle.length < 2) return;

  const positionOf = (key: string | undefined): ClusterFigure | undefined =>
    plan.figures.find((figure) => figure.key === key);

  const passOnce = () => {
    // A pass is indivisible theater: if its wind-up + flight cannot finish
    // before the engine advances, keep the truthful possession pose instead
    // of showing half a pass and snapping to the next semantic scene.
    if (remainingMs() < PASS_WINDUP_MS + PASS_FLIGHT_MS + MOTION_SETTLE_BUFFER_MS) return;

    const fromKey = holderRef.current && cycle.includes(holderRef.current) ? holderRef.current : cycle[0]!;
    const toKey = cycle[(cycle.indexOf(fromKey) + 1) % cycle.length]!;
    const receiver = positionOf(toKey);
    if (!receiver) return;

    setPoses((previous) => ({ ...previous, [fromKey]: 'strike' }));
    schedule(PASS_WINDUP_MS, () => {
      stopBall(ball);
      ball.opacity.setValue(1);
      ball.scale.setValue(1);
      Animated.parallel([
        Animated.timing(ball.x, { toValue: receiver.x, duration: PASS_FLIGHT_MS, easing: Easing.out(Easing.quad), isInteraction: false, useNativeDriver: NATIVE }),
        Animated.timing(ball.y, { toValue: receiver.y, duration: PASS_FLIGHT_MS, easing: Easing.out(Easing.quad), isInteraction: false, useNativeDriver: NATIVE }),
      ]).start();
      holderRef.current = toKey;
    });
    schedule(PASS_WINDUP_MS + PASS_FLIGHT_MS, () => {
      setPoses((previous) => ({ ...previous, [fromKey]: 'idle' }));
    });
    schedule(plan.passIntervalMs, passOnce);
  };

  // First touch arrives a little sooner than the steady tempo so the scene
  // doesn't open on a statue.
  const firstPassAtMs = Math.round(plan.passIntervalMs * 0.6);
  if (remainingMs() >= firstPassAtMs + PASS_WINDUP_MS + PASS_FLIGHT_MS + MOTION_SETTLE_BUFFER_MS) {
    schedule(firstPassAtMs, passOnce);
  }
}

/**
 * Plays a staged plan's keyframes at their offsets. Ball legs get
 * per-label physics: a corner swing is lofted (arc: the ball rises --
 * scales up -- mid-flight), a shot is flat and fast, everything else
 * travels like a firm pass.
 */
function runStagedKeyframes(
  plan: Extract<ClusterPlan, { kind: 'staged' }>,
  context: FrameContext,
): void {
  const { anims, ball, holderRef, schedule, setMovingKeys, setPoses } = context;

  plan.keyframes.slice(1).forEach((keyframe, stagedIndex) => {
    const keyframeIndex = stagedIndex + 1;
    const nextOffsetMs = plan.keyframes[keyframeIndex + 1]?.offsetMs ?? plan.durationMs;
    const legWindowMs = Math.max(0, nextOffsetMs - keyframe.offsetMs);
    const moveBudgetMs = cappedMotionMs(KEYFRAME_MOVE_MS, legWindowMs);

    schedule(keyframe.offsetMs, () => {
      keyframe.figures.forEach((figure, index) => {
        const { anim } = ensureAnim(anims, figure);
        const { delayMs, durationMs } = figureMoveTiming(
          index,
          keyframe.figures.length,
          moveBudgetMs,
        );
        anim.x.stopAnimation();
        anim.y.stopAnimation();
        if (durationMs <= 0) {
          anim.x.setValue(figure.x);
          anim.y.setValue(figure.y);
        } else {
          Animated.parallel([
            Animated.timing(anim.x, { toValue: figure.x, duration: durationMs, delay: delayMs, easing: Easing.out(Easing.cubic), isInteraction: false, useNativeDriver: NATIVE }),
            Animated.timing(anim.y, { toValue: figure.y, duration: durationMs, delay: delayMs, easing: Easing.out(Easing.cubic), isInteraction: false, useNativeDriver: NATIVE }),
          ]).start();
        }
      });

      const posesAtKeyframe: Record<string, PlayerPose> = {};
      for (const figure of keyframe.figures) posesAtKeyframe[figure.key] = figure.pose;
      setPoses(posesAtKeyframe);
      const runningKeys = new Set(keyframe.figures.filter((figure) => figure.pose === 'run_a' || figure.pose === 'run_b').map((figure) => figure.key));
      setMovingKeys(runningKeys);

      const leg = ballLegFor(plan.label);
      const ballMoveMs = cappedMotionMs(leg.durationMs, legWindowMs);
      stopBall(ball);
      ball.opacity.setValue(1);
      ball.scale.setValue(1);
      if (ballMoveMs <= 0) {
        ball.x.setValue(keyframe.ball.x);
        ball.y.setValue(keyframe.ball.y);
        ball.scale.setValue(1);
        holderRef.current = keyframe.ball.holderKey;
        return;
      }
      const moves = [
        Animated.timing(ball.x, { toValue: keyframe.ball.x, duration: ballMoveMs, easing: leg.easing, isInteraction: false, useNativeDriver: NATIVE }),
        Animated.timing(ball.y, { toValue: keyframe.ball.y, duration: ballMoveMs, easing: leg.easing, isInteraction: false, useNativeDriver: NATIVE }),
      ];
      if (leg.loft) {
        moves.push(Animated.sequence([
          Animated.timing(ball.scale, { toValue: 1.45, duration: ballMoveMs * 0.5, easing: Easing.out(Easing.quad), isInteraction: false, useNativeDriver: NATIVE }),
          Animated.timing(ball.scale, { toValue: 1, duration: ballMoveMs * 0.5, easing: Easing.in(Easing.quad), isInteraction: false, useNativeDriver: NATIVE }),
        ]));
      }
      Animated.parallel(moves).start();
      holderRef.current = keyframe.ball.holderKey;
    });
  });
}

function ballLegFor(label: Extract<ClusterPlan, { kind: 'staged' }>['label']): {
  durationMs: number;
  easing: (value: number) => number;
  loft: boolean;
} {
  switch (label) {
    case 'corner':
      // Lofted delivery: unhurried, rising then dropping.
      return { durationMs: 680, easing: Easing.inOut(Easing.quad), loft: true };
    case 'shot':
      // A strike is fast and direct -- the one deliberately linear move.
      return { durationMs: 230, easing: Easing.linear, loft: false };
    default:
      return { durationMs: 420, easing: Easing.out(Easing.quad), loft: false };
  }
}

function cleanupMotion(
  timersRef: { current: ReturnType<typeof setTimeout>[] },
  anims: Map<string, FigureAnim>,
  ball: FrameContext['ball'],
): () => void {
  return () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    for (const anim of anims.values()) {
      anim.x.stopAnimation();
      anim.y.stopAnimation();
      anim.opacity.stopAnimation();
    }
    stopBall(ball);
  };
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFill,
    zIndex: 5,
  },
  // Full-board anchor translated by board-fraction percentages (same trick
  // as the possession presence): the child content then centers itself on
  // that point via negative margins.
  slot: {
    ...StyleSheet.absoluteFill,
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
  },
  figureContent: {
    marginLeft: -(STICK_FIGURE_SIZE_PX * STICK_WIDTH_RATIO) / 2,
    marginTop: -STICK_FIGURE_SIZE_PX / 2,
  },
  ballSlot: {
    zIndex: 6,
  },
  ballContent: {
    marginLeft: -6,
    marginTop: -6,
  },
});
