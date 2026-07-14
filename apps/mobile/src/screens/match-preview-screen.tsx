import { type GameCrewMatch, gameCrewTokens } from '@gamecrew/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  type LayoutChangeEvent,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  type DemoActorTrack,
  type DemoBallEvent,
  type DemoBeat,
  type DemoBeatId,
  type DemoPose,
  GAME_VIEW_DEMO_DURATION_MS,
  GAME_VIEW_DEMO_SCORE_COMMIT_AT_MS,
  gameViewDemoActors,
  gameViewDemoBallEvents,
  gameViewDemoBeats,
  gameViewDemoCamera,
  gameViewDemoReducedMotionSnapshot,
  gameViewDemoTeamShapes,
  type NormalizedPoint,
} from './game-view-demo-timeline';

const tokens = gameCrewTokens;
const PITCH_INSET = 13;
const PLAYER_WIDTH = 22;
const PLAYER_HEIGHT = 32;
const BALL_SIZE = 14;
const DEMO_CLOCK_START_SECONDS = 67 * 60 + 8;

type TeamSide = 'home' | 'away';

interface PitchSize {
  width: number;
  height: number;
}

interface PlayerAnchor {
  id: string;
  number: number;
  side: TeamSide;
  goalkeeper?: boolean;
  x: number;
  y: number;
}

interface PositionTrack {
  atMs: readonly number[];
  points: readonly NormalizedPoint[];
}

interface AnimatedPosition {
  player: PlayerAnchor;
  translateX: Animated.AnimatedInterpolation<number>;
  translateY: Animated.AnimatedInterpolation<number>;
}

export interface GameViewPresentationState {
  clockLabel: string;
  phaseLabel: string;
  score: { home: number; away: number };
}

interface BeatCopy {
  label: string;
  status: (match: GameCrewMatch) => string;
  commentary: (match: GameCrewMatch) => string;
}

const homeAnchors: readonly PlayerAnchor[] = [
  { id: 'h1', number: 1, side: 'home', goalkeeper: true, x: 0.5, y: 0.94 },
  { id: 'h2', number: 2, side: 'home', x: 0.16, y: 0.8 },
  { id: 'h3', number: 4, side: 'home', x: 0.38, y: 0.82 },
  { id: 'h4', number: 5, side: 'home', x: 0.62, y: 0.82 },
  { id: 'h5', number: 3, side: 'home', x: 0.84, y: 0.8 },
  { id: 'h6', number: 6, side: 'home', x: 0.26, y: 0.65 },
  { id: 'h7', number: 8, side: 'home', x: 0.5, y: 0.67 },
  { id: 'h8', number: 10, side: 'home', x: 0.74, y: 0.65 },
  { id: 'h9', number: 7, side: 'home', x: 0.2, y: 0.51 },
  { id: 'h10', number: 9, side: 'home', x: 0.5, y: 0.48 },
  { id: 'h11', number: 11, side: 'home', x: 0.8, y: 0.51 },
];

const awayAnchors: readonly PlayerAnchor[] = homeAnchors.map((anchor, index) => ({
  ...anchor,
  id: `a${index + 1}`,
  number: [1, 2, 4, 5, 3, 6, 8, 10, 7, 9, 11][index],
  side: 'away',
  y: 1 - anchor.y,
}));

const playerAnchors = [...homeAnchors, ...awayAnchors];
const actorTracks = new Map(gameViewDemoActors.map((actor) => [actor.id, actor]));

const beatCopy: Record<DemoBeatId, BeatCopy> = {
  establish: {
    label: 'In possession',
    status: (match) => `${match.homeTeam.shortName} · Settled shape`,
    commentary: (match) => `${match.homeTeam.name} settle into their shape and start from the back.`,
  },
  build: {
    label: 'Building',
    status: (match) => `${match.homeTeam.shortName} · Building`,
    commentary: (match) => `A patient first pass brings ${match.homeTeam.name} into midfield.`,
  },
  advance: {
    label: 'Pushing forward',
    status: (match) => `${match.homeTeam.shortName} · Pushing forward`,
    commentary: (match) => `${match.homeTeam.name} find the right channel and move the block back.`,
  },
  pressure: {
    label: 'Under pressure',
    status: (match) => `${match.awayTeam.shortName} · Under pressure`,
    commentary: (match) => `${match.awayTeam.name} narrow the space as the pressure begins to build.`,
  },
  switch: {
    label: 'Switch of play',
    status: () => 'Switching the point of attack',
    commentary: (match) => `${match.homeTeam.name} recycle possession and pull the defence across.`,
  },
  opening: {
    label: 'Opening forming',
    status: () => 'An opening is forming',
    commentary: () => 'A quick combination opens the inside channel near the box.',
  },
  through_ball: {
    label: 'Through ball',
    status: () => 'Through ball',
    commentary: () => 'The final pass splits the line and releases the runner.',
  },
  shot: {
    label: 'Shot',
    status: () => 'Shot on goal',
    commentary: (match) => `${match.homeTeam.name} strike through the opening — the keeper dives.`,
  },
  goal: {
    label: 'Goal',
    status: (match) => `${match.homeTeam.shortName} · Goal`,
    commentary: (match) => `${match.homeTeam.name} finish the move. Goal!`,
  },
  celebration: {
    label: 'Celebration',
    status: (match) => `${match.homeTeam.shortName} · Celebrating`,
    commentary: () => 'The players race to the corner as the move reaches its finish.',
  },
};

export function MatchPreviewScreen({
  match,
  onPresentationChange,
}: {
  match: GameCrewMatch;
  onPresentationChange?: (state: GameViewPresentationState | null) => void;
}) {
  const [pitchSize, setPitchSize] = useState<PitchSize>({ width: 0, height: 0 });
  const reduceMotion = useReduceMotionPreference();
  const initialTime = reduceMotion ? gameViewDemoReducedMotionSnapshot.atMs : 0;
  const [elapsedMs, setElapsedMs] = useState(initialTime);
  const timelineMs = useRef(new Animated.Value(initialTime)).current;
  const runningAnimation = useRef<Animated.CompositeAnimation | null>(null);
  const commentaryEntrance = useRef(new Animated.Value(1)).current;
  const latestRenderBucket = useRef(-1);

  const homeColor = useMemo(
    () => getTeamColor(match.homeTeam.flag.bands, '#2D6CDF'),
    [match.homeTeam.flag.bands],
  );
  const awayColor = useMemo(
    () => getTeamColor(match.awayTeam.flag.bands, '#E23546', homeColor),
    [homeColor, match.awayTeam.flag.bands],
  );
  const demoScore = useMemo(() => getDemoScore(match), [match]);
  const activeBeatIndex = findActiveIndex(gameViewDemoBeats, elapsedMs);
  const activeBeat = gameViewDemoBeats[activeBeatIndex];
  const activeCopy = beatCopy[activeBeat.id];
  const activeSideColor = activeBeat.subjectSide === 'home' ? homeColor : awayColor;
  const currentBallEvent = findBallEvent(elapsedMs);
  const isBallInFlight = currentBallEvent.kind === 'pass' || currentBallEvent.kind === 'shot';
  const presentationSecond = Math.floor(elapsedMs / 1_000);
  const scoreCommitted = elapsedMs >= GAME_VIEW_DEMO_SCORE_COMMIT_AT_MS;
  const recentBeats = gameViewDemoBeats
    .slice(Math.max(0, activeBeatIndex - 2), activeBeatIndex + 1);

  useEffect(() => {
    const startAt = reduceMotion ? gameViewDemoReducedMotionSnapshot.atMs : 0;
    latestRenderBucket.current = Math.floor(startAt / 160);
    timelineMs.setValue(startAt);
    setElapsedMs(startAt);

    const listenerId = timelineMs.addListener(({ value }) => {
      const clampedValue = clamp(value, 0, GAME_VIEW_DEMO_DURATION_MS);
      const bucket = Math.floor(clampedValue / 160);
      if (bucket !== latestRenderBucket.current || clampedValue === GAME_VIEW_DEMO_DURATION_MS) {
        latestRenderBucket.current = bucket;
        setElapsedMs(clampedValue);
      }
    });

    if (!reduceMotion) {
      runningAnimation.current = Animated.timing(timelineMs, {
        toValue: GAME_VIEW_DEMO_DURATION_MS,
        duration: GAME_VIEW_DEMO_DURATION_MS,
        easing: Easing.linear,
        isInteraction: false,
        useNativeDriver: Platform.OS !== 'web',
      });
      runningAnimation.current.start();
    }

    return () => {
      runningAnimation.current?.stop();
      timelineMs.removeListener(listenerId);
    };
  }, [reduceMotion, timelineMs]);

  useEffect(() => {
    commentaryEntrance.stopAnimation();
    commentaryEntrance.setValue(0);
    Animated.timing(commentaryEntrance, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      isInteraction: false,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [activeBeatIndex, commentaryEntrance]);

  useEffect(() => {
    const clockSeconds = DEMO_CLOCK_START_SECONDS + presentationSecond;
    onPresentationChange?.({
      clockLabel: formatDemoClock(clockSeconds),
      phaseLabel: 'Live · In play',
      score: scoreCommitted ? demoScore.after : demoScore.before,
    });
  }, [demoScore, onPresentationChange, presentationSecond, scoreCommitted]);

  useEffect(() => () => onPresentationChange?.(null), [onPresentationChange]);

  const playerAnimations = useMemo<readonly AnimatedPosition[]>(() => {
    if (pitchSize.width === 0 || pitchSize.height === 0) return [];
    return playerAnchors.map((player) => {
      const track = createPlayerPositionTrack(player);
      return {
        player,
        translateX: interpolateTrack(
          timelineMs,
          track,
          'x',
          pitchSize.width,
          PLAYER_WIDTH,
        ),
        translateY: interpolateTrack(
          timelineMs,
          track,
          'y',
          pitchSize.height,
          PLAYER_HEIGHT,
        ),
      };
    });
  }, [pitchSize.height, pitchSize.width, timelineMs]);

  const ballAnimations = useMemo(() => {
    if (pitchSize.width === 0 || pitchSize.height === 0) return null;
    const mainTrack = createBallPositionTrack();
    const firstTrailTrack = offsetTrack(mainTrack, 90);
    const secondTrailTrack = offsetTrack(mainTrack, 180);
    return {
      mainX: interpolateTrack(timelineMs, mainTrack, 'x', pitchSize.width, BALL_SIZE),
      mainY: interpolateTrack(timelineMs, mainTrack, 'y', pitchSize.height, BALL_SIZE),
      trailOneX: interpolateTrack(timelineMs, firstTrailTrack, 'x', pitchSize.width, 8),
      trailOneY: interpolateTrack(timelineMs, firstTrailTrack, 'y', pitchSize.height, 8),
      trailTwoX: interpolateTrack(timelineMs, secondTrailTrack, 'x', pitchSize.width, 6),
      trailTwoY: interpolateTrack(timelineMs, secondTrailTrack, 'y', pitchSize.height, 6),
    };
  }, [pitchSize.height, pitchSize.width, timelineMs]);

  const visualAnimations = useMemo(() => ({
    cameraScale: timelineMs.interpolate({
      inputRange: gameViewDemoCamera.map((keyframe) => keyframe.atMs),
      outputRange: gameViewDemoCamera.map((keyframe) => keyframe.scale),
      extrapolate: 'clamp',
    }),
    cameraX: timelineMs.interpolate({
      inputRange: gameViewDemoCamera.map((keyframe) => keyframe.atMs),
      outputRange: gameViewDemoCamera.map((keyframe) => keyframe.offsetX * pitchSize.width),
      extrapolate: 'clamp',
    }),
    cameraY: timelineMs.interpolate({
      inputRange: gameViewDemoCamera.map((keyframe) => keyframe.atMs),
      outputRange: gameViewDemoCamera.map((keyframe) => keyframe.offsetY * pitchSize.height),
      extrapolate: 'clamp',
    }),
    pressureOpacity: timelineMs.interpolate({
      inputRange: gameViewDemoBeats.map((beat) => beat.atMs),
      outputRange: gameViewDemoBeats.map((beat) => 0.06 + beat.pressure * 0.36),
      extrapolate: 'clamp',
    }),
    pressureScale: timelineMs.interpolate({
      inputRange: gameViewDemoBeats.map((beat) => beat.atMs),
      outputRange: gameViewDemoBeats.map((beat) => 0.82 + beat.pressure * 0.3),
      extrapolate: 'clamp',
    }),
    goalImpactOpacity: timelineMs.interpolate({
      inputRange: [0, 32_850, 33_100, 34_500, GAME_VIEW_DEMO_DURATION_MS],
      outputRange: [0, 0, 1, 0, 0],
      extrapolate: 'clamp',
    }),
    goalImpactScale: timelineMs.interpolate({
      inputRange: [0, 32_850, 33_100, 34_500, GAME_VIEW_DEMO_DURATION_MS],
      outputRange: [0.8, 0.8, 1, 1.42, 1.42],
      extrapolate: 'clamp',
    }),
  }), [pitchSize.height, pitchSize.width, timelineMs]);
  const commentaryTranslateY = commentaryEntrance.interpolate({
    inputRange: [0, 1],
    outputRange: [10, 0],
  });

  const handlePitchLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setPitchSize({ width, height });
  };

  return (
    <View style={styles.root}>
      <View onLayout={handlePitchLayout} style={styles.pitch}>
        <Animated.View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.worldLayer,
            { transform: [
              { translateX: visualAnimations.cameraX },
              { translateY: visualAnimations.cameraY },
              { scale: visualAnimations.cameraScale },
            ] },
          ]}
        >
          <PitchMarkings />

          {ballAnimations ? (
            <>
              <Animated.View
                style={[
                  styles.pressureFocus,
                  {
                    borderColor: readableAccent(activeSideColor),
                    opacity: visualAnimations.pressureOpacity,
                    transform: [
                      { translateX: ballAnimations.mainX },
                      { translateY: ballAnimations.mainY },
                      { scale: visualAnimations.pressureScale },
                    ],
                  },
                ]}
              />

              {playerAnimations.map(({ player, translateX, translateY }) => (
                <TacticalPlayer
                  color={player.side === 'home' ? homeColor : awayColor}
                  facingDegrees={getActorFacing(player.id, elapsedMs)}
                  goalkeeper={player.goalkeeper}
                  key={player.id}
                  number={player.number}
                  pose={getActorPose(player.id, elapsedMs)}
                  translateX={translateX}
                  translateY={translateY}
                />
              ))}

              {isBallInFlight ? (
                <>
                  <Animated.View
                    style={[
                      styles.ballTrail,
                      styles.ballTrailOne,
                      { transform: [
                        { translateX: ballAnimations.trailOneX },
                        { translateY: ballAnimations.trailOneY },
                      ] },
                    ]}
                  />
                  <Animated.View
                    style={[
                      styles.ballTrail,
                      styles.ballTrailTwo,
                      { transform: [
                        { translateX: ballAnimations.trailTwoX },
                        { translateY: ballAnimations.trailTwoY },
                      ] },
                    ]}
                  />
                </>
              ) : null}

              <Animated.View
                style={[
                  styles.ball,
                  { transform: [
                    { translateX: ballAnimations.mainX },
                    { translateY: ballAnimations.mainY },
                    { scale: currentBallEvent.kind === 'shot' ? 1.18 : 1 },
                  ] },
                ]}
              >
                <View style={styles.ballCore} />
              </Animated.View>

              <Animated.View
                style={[
                  styles.goalImpact,
                  {
                    opacity: visualAnimations.goalImpactOpacity,
                    transform: [{ scale: visualAnimations.goalImpactScale }],
                  },
                ]}
              />
            </>
          ) : null}
        </Animated.View>

        <View style={styles.pitchMetaRow}>
          <View style={styles.phasePill}>
            <View style={[styles.phaseSignal, { backgroundColor: activeSideColor }]} />
            <Text numberOfLines={1} style={styles.phaseLabel}>{activeCopy.status(match)}</Text>
          </View>
          <View style={styles.livePill}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>LIVE</Text>
          </View>
        </View>

        <Animated.View
          accessible
          accessibilityLabel={`${activeCopy.label}. ${activeCopy.commentary(match)}`}
          style={[
            styles.commentaryDock,
            {
              opacity: commentaryEntrance,
              transform: [{ translateY: commentaryTranslateY }],
            },
          ]}
        >
          <View style={styles.commentaryStack}>
            {recentBeats.map((beat, index) => {
              const copy = beatCopy[beat.id];
              const isLatest = index === recentBeats.length - 1;
              return (
                <View
                  key={beat.id}
                  style={[
                    styles.commentaryRow,
                    getGameViewCommentaryToneStyle(beat.id),
                    isLatest && styles.commentaryRowLatest,
                  ]}
                >
                  <Text style={styles.commentaryMinute}>
                    {formatDemoMinute(DEMO_CLOCK_START_SECONDS + Math.floor(beat.atMs / 1_000))}
                  </Text>
                  <View style={styles.commentaryCopy}>
                    <Text
                      numberOfLines={isLatest ? 2 : 1}
                      style={[styles.commentaryText, !isLatest && styles.commentaryTextPrevious]}
                    >
                      {copy.commentary(match)}
                    </Text>
                    {isLatest ? (
                      <Text numberOfLines={1} style={styles.commentaryMeta}>
                        {copy.label}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

function PitchMarkings() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, styles.nonInteractive]}
    >
      {Array.from({ length: 8 }).map((_, index) => (
        <View
          key={index}
          style={[
            styles.pitchBand,
            { top: `${index * 12.5}%`, opacity: index % 2 === 0 ? 0.2 : 0.07 },
          ]}
        />
      ))}
      <View style={styles.pitchVignette} />
      <View style={styles.pitchBoundary} />
      <View style={styles.halfwayLine} />
      <View style={styles.centerCircle} />
      <View style={styles.centerSpot} />
      <View style={[styles.penaltyArea, styles.penaltyAreaTop]} />
      <View style={[styles.goalArea, styles.goalAreaTop]} />
      <View style={[styles.penaltySpot, styles.penaltySpotTop]} />
      <View style={[styles.goal, styles.goalTop]} />
      <View style={[styles.penaltyArea, styles.penaltyAreaBottom]} />
      <View style={[styles.goalArea, styles.goalAreaBottom]} />
      <View style={[styles.penaltySpot, styles.penaltySpotBottom]} />
      <View style={[styles.goal, styles.goalBottom]} />
    </View>
  );
}

function TacticalPlayer({
  color,
  facingDegrees,
  goalkeeper,
  number,
  pose,
  translateX,
  translateY,
}: {
  color: string;
  facingDegrees: number;
  goalkeeper?: boolean;
  number: number;
  pose: DemoPose;
  translateX: Animated.AnimatedInterpolation<number>;
  translateY: Animated.AnimatedInterpolation<number>;
}) {
  const kitColor = goalkeeper ? '#F2EEE1' : color;
  const celebrating = pose === 'celebrate';
  const running = pose === 'jog' || pose === 'sprint';
  const striking = pose === 'pass' || pose === 'shoot';
  const diving = pose === 'dive';

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.player, { transform: [{ translateX }, { translateY }] }]}
    >
      <View style={[styles.playerSprite, diving && styles.playerSpriteDive]}>
        <View style={[styles.playerShadow, { backgroundColor: color }]} />
        <View
          style={[
            styles.directionIndicator,
            { borderBottomColor: kitColor, transform: [{ rotate: `${facingDegrees}deg` }] },
          ]}
        />
        <View style={[styles.playerHead, goalkeeper && styles.goalkeeperHead]} />
        <View
          style={[
            styles.playerArm,
            styles.playerArmLeft,
            { backgroundColor: kitColor },
            celebrating && styles.playerArmLeftRaised,
          ]}
        />
        <View
          style={[
            styles.playerArm,
            styles.playerArmRight,
            { backgroundColor: kitColor },
            celebrating && styles.playerArmRightRaised,
          ]}
        />
        <View
          style={[
            styles.playerBody,
            { backgroundColor: kitColor, borderColor: goalkeeper ? color : '#F2EEE1' },
          ]}
        >
          <Text style={[styles.playerNumber, goalkeeper && styles.goalkeeperNumber]}>{number}</Text>
        </View>
        <View style={styles.playerLegs}>
          <View
            style={[
              styles.playerLeg,
              { backgroundColor: kitColor },
              running && styles.playerLegRunningLeft,
            ]}
          />
          <View
            style={[
              styles.playerLeg,
              { backgroundColor: kitColor },
              running && styles.playerLegRunningRight,
              striking && styles.playerLegStriking,
            ]}
          />
        </View>
      </View>
    </Animated.View>
  );
}

function createPlayerPositionTrack(player: PlayerAnchor): PositionTrack {
  const actor = actorTracks.get(player.id);
  if (actor) {
    return {
      atMs: actor.keyframes.map((keyframe) => keyframe.atMs),
      points: actor.keyframes.map((keyframe) => keyframe.point),
    };
  }

  const teamCenterY = player.side === 'home' ? 0.7 : 0.3;
  return {
    atMs: gameViewDemoTeamShapes.map((keyframe) => keyframe.atMs),
    points: gameViewDemoTeamShapes.map((keyframe) => {
      const shape = keyframe[player.side];
      return {
        x: clamp(0.5 + (player.x - 0.5) * (shape.width ?? 1), 0.05, 0.95),
        y: clamp(
          teamCenterY + (player.y - teamCenterY) * (shape.depth ?? 1) + (shape.shiftY ?? 0),
          0.035,
          0.965,
        ),
      };
    }),
  };
}

function createBallPositionTrack(): PositionTrack {
  const atMs: number[] = [];
  const points: NormalizedPoint[] = [];

  for (const [index, event] of gameViewDemoBallEvents.entries()) {
    if (index === 0) {
      atMs.push(event.fromMs);
      points.push(event.from);
    }
    if (event.kind === 'pass' || event.kind === 'shot') {
      atMs.push((event.fromMs + event.toMs) / 2);
      points.push({
        x: (event.from.x + event.to.x) / 2 + event.curve,
        y: (event.from.y + event.to.y) / 2,
      });
    }
    atMs.push(event.toMs);
    points.push(event.to);
  }

  return { atMs, points };
}

function offsetTrack(track: PositionTrack, delayMs: number): PositionTrack {
  return {
    atMs: [0, ...track.atMs.map((atMs) => atMs + delayMs)],
    points: [track.points[0], ...track.points],
  };
}

function interpolateTrack(
  timeline: Animated.Value,
  track: PositionTrack,
  axis: 'x' | 'y',
  extent: number,
  markerSize: number,
): Animated.AnimatedInterpolation<number> {
  const available = Math.max(0, extent - PITCH_INSET * 2);
  return timeline.interpolate({
    inputRange: [...track.atMs],
    outputRange: track.points.map(
      (point) => PITCH_INSET + point[axis] * available - markerSize / 2,
    ),
    extrapolate: 'clamp',
  });
}

function getActorPose(playerId: string, atMs: number): DemoPose {
  const actor = actorTracks.get(playerId);
  return actor ? findActorKeyframe(actor, atMs).pose : 'jog';
}

function getActorFacing(playerId: string, atMs: number): number {
  const actor = actorTracks.get(playerId);
  if (actor) return findActorKeyframe(actor, atMs).facingDegrees;
  return playerId.startsWith('a') ? 180 : 0;
}

function findActorKeyframe(actor: DemoActorTrack, atMs: number) {
  return actor.keyframes[findActiveIndex(actor.keyframes, atMs)];
}

function findBallEvent(atMs: number): DemoBallEvent {
  return gameViewDemoBallEvents.find(
    (event) => atMs >= event.fromMs && atMs < event.toMs,
  ) ?? gameViewDemoBallEvents[gameViewDemoBallEvents.length - 1];
}

function findActiveIndex(collection: readonly { atMs: number }[], atMs: number): number {
  for (let index = collection.length - 1; index >= 0; index -= 1) {
    if (atMs >= collection[index].atMs) return index;
  }
  return 0;
}

function getGameViewCommentaryToneStyle(beatId: DemoBeatId) {
  if (beatId === 'goal' || beatId === 'celebration') return styles.commentaryMajor;
  if (beatId === 'opening' || beatId === 'through_ball' || beatId === 'shot') {
    return styles.commentaryDanger;
  }
  if (beatId === 'build' || beatId === 'advance' || beatId === 'pressure' || beatId === 'switch') {
    return styles.commentaryBuilding;
  }
  return styles.commentaryQuiet;
}

function getDemoScore(match: GameCrewMatch): {
  before: { home: number; away: number };
  after: { home: number; away: number };
} {
  const finalHome = match.score?.home;
  const finalAway = match.score?.away ?? 0;
  if (typeof finalHome === 'number' && finalHome > 0) {
    return {
      before: { home: finalHome - 1, away: finalAway },
      after: { home: finalHome, away: finalAway },
    };
  }
  return {
    before: { home: 0, away: finalAway },
    after: { home: 1, away: finalAway },
  };
}

function formatDemoClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDemoMinute(totalSeconds: number): string {
  return `${Math.floor(totalSeconds / 60)}'`;
}

function useReduceMotionPreference(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}

function getTeamColor(
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

function readableAccent(color: string): string {
  const channels = getColorChannels(color);
  if (!channels) return color;
  const brightness = (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 1_000;
  if (brightness >= 130) return color;
  const lifted = channels.map((channel) => Math.round(channel + (255 - channel) * 0.42));
  return `#${lifted.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

const pitchLine = 'rgba(224, 231, 220, 0.5)';

const styles = StyleSheet.create({
  root: {
    backgroundColor: tokens.shell.background,
    flex: 1,
  },
  pitch: {
    backgroundColor: '#101610',
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  worldLayer: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  pitchBand: {
    backgroundColor: '#70856D',
    height: '12.5%',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  pitchVignette: {
    backgroundColor: 'rgba(3, 8, 3, 0.12)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  pitchBoundary: {
    borderColor: pitchLine,
    borderWidth: 1,
    bottom: 12,
    left: 12,
    position: 'absolute',
    right: 12,
    top: 12,
  },
  halfwayLine: {
    backgroundColor: pitchLine,
    height: 1,
    left: 12,
    position: 'absolute',
    right: 12,
    top: '50%',
  },
  centerCircle: {
    borderColor: pitchLine,
    borderRadius: 52,
    borderWidth: 1,
    height: 104,
    left: '50%',
    marginLeft: -52,
    marginTop: -52,
    position: 'absolute',
    top: '50%',
    width: 104,
  },
  centerSpot: {
    backgroundColor: pitchLine,
    borderRadius: 2,
    height: 4,
    left: '50%',
    marginLeft: -2,
    marginTop: -2,
    position: 'absolute',
    top: '50%',
    width: 4,
  },
  penaltyArea: {
    borderColor: pitchLine,
    borderWidth: 1,
    height: '17%',
    left: '20%',
    position: 'absolute',
    width: '60%',
  },
  penaltyAreaTop: { borderTopWidth: 0, top: 12 },
  penaltyAreaBottom: { borderBottomWidth: 0, bottom: 12 },
  goalArea: {
    borderColor: pitchLine,
    borderWidth: 1,
    height: '7%',
    left: '35%',
    position: 'absolute',
    width: '30%',
  },
  goalAreaTop: { borderTopWidth: 0, top: 12 },
  goalAreaBottom: { borderBottomWidth: 0, bottom: 12 },
  penaltySpot: {
    backgroundColor: pitchLine,
    borderRadius: 2,
    height: 4,
    left: '50%',
    marginLeft: -2,
    position: 'absolute',
    width: 4,
  },
  penaltySpotTop: { top: '11%' },
  penaltySpotBottom: { bottom: '11%' },
  goal: {
    borderColor: pitchLine,
    borderWidth: 1,
    height: 8,
    left: '40%',
    position: 'absolute',
    width: '20%',
  },
  goalTop: { borderBottomWidth: 0, top: 4 },
  goalBottom: { borderTopWidth: 0, bottom: 4 },
  pitchMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 16,
    position: 'absolute',
    right: 16,
    top: 16,
    zIndex: 8,
  },
  phasePill: {
    alignItems: 'center',
    backgroundColor: 'rgba(5, 5, 5, 0.8)',
    borderColor: 'rgba(247, 247, 247, 0.14)',
    borderRadius: tokens.radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    maxWidth: '74%',
    minHeight: 28,
    paddingHorizontal: 10,
  },
  phaseSignal: { borderRadius: 4, height: 7, width: 7 },
  phaseLabel: {
    color: 'rgba(247, 247, 247, 0.84)',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
    lineHeight: 12,
    textTransform: 'uppercase',
  },
  livePill: {
    alignItems: 'center',
    backgroundColor: 'rgba(5, 5, 5, 0.72)',
    borderRadius: tokens.radii.pill,
    flexDirection: 'row',
    gap: 5,
    minHeight: 24,
    paddingHorizontal: 8,
  },
  liveDot: { backgroundColor: '#F04A4A', borderRadius: 3, height: 6, width: 6 },
  liveText: {
    color: tokens.shell.text,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
  },
  pressureFocus: {
    backgroundColor: 'rgba(245, 215, 95, 0.08)',
    borderRadius: 40,
    borderWidth: 1,
    height: 58,
    left: -22,
    position: 'absolute',
    top: -22,
    width: 58,
    zIndex: 1,
  },
  player: {
    height: PLAYER_HEIGHT,
    left: 0,
    position: 'absolute',
    top: 0,
    width: PLAYER_WIDTH,
    zIndex: 3,
  },
  playerSprite: {
    alignItems: 'center',
    height: PLAYER_HEIGHT,
    width: PLAYER_WIDTH,
  },
  playerSpriteDive: { transform: [{ rotate: '-68deg' }, { scale: 1.08 }] },
  playerShadow: {
    borderRadius: 9,
    bottom: 0,
    height: 6,
    opacity: 0.24,
    position: 'absolute',
    transform: [{ scaleX: 1.45 }],
    width: 13,
  },
  directionIndicator: {
    borderBottomWidth: 5,
    borderLeftColor: 'transparent',
    borderLeftWidth: 3,
    borderRightColor: 'transparent',
    borderRightWidth: 3,
    height: 0,
    left: 8,
    opacity: 0.68,
    position: 'absolute',
    top: -3,
    width: 0,
  },
  playerHead: {
    backgroundColor: '#D7B99D',
    borderColor: '#050505',
    borderRadius: 5,
    borderWidth: 1,
    height: 9,
    width: 9,
    zIndex: 2,
  },
  goalkeeperHead: { backgroundColor: '#C9A687' },
  playerArm: {
    borderRadius: 2,
    height: 2,
    position: 'absolute',
    top: 11,
    width: 7,
    zIndex: 0,
  },
  playerArmLeft: { left: 0, transform: [{ rotate: '30deg' }] },
  playerArmRight: { right: 0, transform: [{ rotate: '-30deg' }] },
  playerArmLeftRaised: { top: 6, transform: [{ rotate: '-44deg' }] },
  playerArmRightRaised: { top: 6, transform: [{ rotate: '44deg' }] },
  playerBody: {
    alignItems: 'center',
    borderRadius: 4,
    borderWidth: 1,
    height: 13,
    justifyContent: 'center',
    marginTop: -1,
    width: 15,
    zIndex: 1,
  },
  playerNumber: { color: '#050505', fontSize: 7, fontWeight: '900', lineHeight: 8 },
  goalkeeperNumber: { color: '#171717' },
  playerLegs: {
    flexDirection: 'row',
    gap: 3,
    height: 7,
    justifyContent: 'center',
    marginTop: -1,
  },
  playerLeg: { borderRadius: 2, height: 7, width: 3 },
  playerLegRunningLeft: { transform: [{ rotate: '24deg' }, { translateX: -1 }] },
  playerLegRunningRight: { transform: [{ rotate: '-24deg' }, { translateX: 1 }] },
  playerLegStriking: { transform: [{ rotate: '-48deg' }, { translateY: 2 }] },
  ball: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 244, 207, 0.2)',
    borderRadius: BALL_SIZE / 2,
    height: BALL_SIZE,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    top: 0,
    width: BALL_SIZE,
    zIndex: 6,
  },
  ballCore: {
    backgroundColor: '#FFF8DD',
    borderColor: '#050505',
    borderRadius: 4,
    borderWidth: 1,
    height: 8,
    width: 8,
  },
  ballTrail: {
    backgroundColor: '#FFF4CF',
    borderRadius: 5,
    left: 0,
    position: 'absolute',
    top: 0,
    zIndex: 5,
  },
  ballTrailOne: { height: 8, opacity: 0.34, width: 8 },
  ballTrailTwo: { height: 6, opacity: 0.16, width: 6 },
  goalImpact: {
    borderColor: '#FFF4CF',
    borderRadius: 38,
    borderWidth: 2,
    height: 76,
    left: '50%',
    marginLeft: -38,
    position: 'absolute',
    top: -25,
    width: 76,
    zIndex: 2,
  },
  commentaryDock: {
    bottom: 12,
    left: 12,
    position: 'absolute',
    right: 12,
    zIndex: 9,
  },
  commentaryStack: {
    gap: 5,
    justifyContent: 'flex-end',
  },
  commentaryRow: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.md,
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    minHeight: 32,
    opacity: 0.72,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: 5,
  },
  commentaryQuiet: {
    backgroundColor: tokens.shell.surface,
  },
  commentaryBuilding: {
    backgroundColor: '#151515',
  },
  commentaryDanger: {
    backgroundColor: '#1D1D1D',
  },
  commentaryMajor: {
    backgroundColor: '#262626',
  },
  commentaryRowLatest: {
    gap: tokens.spacing.md,
    minHeight: 62,
    opacity: 1,
    padding: tokens.spacing.md,
  },
  commentaryMinute: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.sm,
    color: tokens.shell.text,
    fontSize: tokens.typography.size.label,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
    minWidth: 42,
    overflow: 'hidden',
    paddingHorizontal: tokens.spacing.xs,
    paddingVertical: 5,
    textAlign: 'center',
  },
  commentaryCopy: { flex: 1, gap: tokens.spacing.xs },
  commentaryText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.body,
  },
  commentaryTextPrevious: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.medium,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  commentaryMeta: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  nonInteractive: { pointerEvents: 'none' },
});
