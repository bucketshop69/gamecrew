import { gameCrewTokens, type GameViewScene } from '@gamecrew/core';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import {
  type BoardDirection,
  type BoardPresenceState,
  type BoardTeamInfo,
  buildBoardAccessibilityLabel,
  resolveAmbientPresence,
  resolveBoardPresence,
  resolveGoalEndLabels,
  zoneLabelForDirection,
} from './game-view-board-logic';

const tokens = gameCrewTokens;

/** Max content width for the pitch on wide screens (fix #6): phones stay full-bleed, web/tablet gets a centered pitch. */
const PITCH_MAX_WIDTH = 480;

/**
 * The ambient zone board renderer (work item B1 of
 * docs/issues/game-view-board-and-presentation.md). Renders the abstract
 * zone pitch plus, for `ambient` scenes, a team-colored possession presence
 * drifting/pulsing inside its zone band. Non-ambient scenes render the pitch
 * idle -- the `overlay` slot is where a future takeover renderer (B2) mounts
 * on top without this component needing to know about takeover kinds.
 *
 * Per the Honesty Rule (docs/prds/game_view.md): this board never draws
 * player positions or pitch coordinates. The presence is a semantic-zone
 * indicator, not a location claim.
 *
 * Fix #4 (no dead black board): when the current scene has no possession
 * presence of its own (ambient scene with no zone/participant, or the board
 * showing through underneath a minor set-piece badge), the last known live
 * presence is carried forward, dimmed and static, via `resolveBoardPresence`.
 * The renderer keeps that last-live presence in a ref so the carry survives
 * across scenes without needing external state.
 */
export function GameViewBoard({
  awayTeam,
  homeTeam,
  overlay,
  participant1Direction = 'up',
  reduceMotion,
  scene,
}: {
  awayTeam: BoardTeamInfo;
  homeTeam: BoardTeamInfo;
  /** Slot for a takeover graphic (B2) to render on top of the idle board. */
  overlay?: ReactNode;
  /** Which visual edge participant 1 attacks; participant 2 attacks the opposite edge. */
  participant1Direction?: BoardDirection;
  reduceMotion: boolean;
  scene: GameViewScene | null;
}) {
  const lastLivePresenceRef = useRef<BoardPresenceState | undefined>(undefined);

  const livePresence = useMemo(
    () => resolveAmbientPresence(scene, homeTeam, awayTeam, participant1Direction),
    [awayTeam, homeTeam, participant1Direction, scene],
  );
  if (livePresence) lastLivePresenceRef.current = livePresence;

  const presence = useMemo(
    () => resolveBoardPresence(scene, homeTeam, awayTeam, lastLivePresenceRef.current, participant1Direction),
    // lastLivePresenceRef.current is read above (kept in sync with livePresence
    // every render), so livePresence is the reactive proxy for that dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [awayTeam, homeTeam, livePresence, participant1Direction, scene],
  );
  const accessibilityLabel = useMemo(
    () => buildBoardAccessibilityLabel(presence),
    [presence],
  );
  const goalEndLabels = useMemo(
    () => resolveGoalEndLabels(homeTeam, awayTeam, participant1Direction),
    [awayTeam, homeTeam, participant1Direction],
  );

  return (
    <View style={styles.boardOuter}>
      <View
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="image"
        style={styles.board}
      >
        <GoalEndLabel edge="top" label={goalEndLabels.top} />
        <ZonePitch direction={presence.direction} />

        <PossessionPresence presence={presence} reduceMotion={reduceMotion} />

        {overlay ? <View style={styles.overlaySlot}>{overlay}</View> : null}
        <GoalEndLabel edge="bottom" label={goalEndLabels.bottom} />
      </View>
    </View>
  );
}

/**
 * Subtle gray label naming the team whose goal sits at this pitch end (fix
 * #1's "attack-direction affordance"), e.g. "ECUADOR GOAL" at the top edge.
 * Deliberately quiet -- textDim color, small caps -- so it reads as chrome,
 * not a takeover.
 */
function GoalEndLabel({ edge, label }: { edge: 'top' | 'bottom'; label: string }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.goalEndLabel, edge === 'top' ? styles.goalEndLabelTop : styles.goalEndLabelBottom]}
    >
      <Text style={styles.goalEndLabelText}>{label}</Text>
    </View>
  );
}

/**
 * The abstract top-down pitch: subtle horizontal zone bands with gray lines
 * and labels, dividing the board into semantic bands (defensive / midfield /
 * attack / danger / high danger), plus a visible boundary (side/goal lines,
 * center line + circle hint -- fix #6) so the board reads as a pitch rather
 * than full-bleed emptiness.
 *
 * Band chrome follows the CURRENT possession direction so the labels never
 * contradict the presence: when the possessing team attacks the top edge the
 * rows read danger-at-top / own-third-at-bottom, and when possession flips
 * to the team attacking the bottom edge the label order mirrors (the row
 * weights stay physical -- narrow strips near both goals). The goal-end
 * labels are the fixed anchors; this text is deliberately quiet chrome, not
 * a broadcast-style pitch with markings.
 */
function ZonePitch({ direction }: { direction: BoardDirection }) {
  const rows = direction === 'down'
    ? ZONE_BAND_ROWS.map((band, index) => ({
        ...band,
        zone: ZONE_BAND_ROWS[ZONE_BAND_ROWS.length - 1 - index].zone,
      }))
    : ZONE_BAND_ROWS;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <View style={styles.pitchSurface}>
        {rows.map((band) => (
          <View key={band.zone} style={[styles.zoneBand, { flex: band.weight }]}>
            <View style={styles.zoneBandLine} />
            <Text style={styles.zoneBandLabel}>{zoneLabelForDirection(band.zone, direction)}</Text>
          </View>
        ))}
      </View>
      <View style={styles.pitchBoundary} pointerEvents="none" />
      <View style={styles.centerLine} />
      <View style={styles.centerCircle} />
      <View style={styles.centerDot} />
    </View>
  );
}

/**
 * Top-to-bottom band order matching the visual layout (top edge = one
 * team's attacking direction, bottom edge = the other's). Weighted so
 * high-danger/danger bands read as narrower, closer-to-goal strips than the
 * wide midfield band -- matching `ZONE_BAND_POSITION` in
 * game-view-board-logic.ts.
 */
const ZONE_BAND_ROWS: readonly { zone: 'high_danger' | 'danger' | 'attack' | 'neutral' | 'safe'; weight: number }[] = [
  { zone: 'high_danger', weight: 0.8 },
  { zone: 'danger', weight: 1.2 },
  { zone: 'attack', weight: 1.6 },
  { zone: 'neutral', weight: 2 },
  { zone: 'safe', weight: 1.2 },
];

const PULSE_SCALE_DELTA = 0.14;
const DRIFT_RANGE = 0.035;

function PossessionPresence({
  presence,
  reduceMotion,
}: {
  presence: BoardPresenceState;
  reduceMotion: boolean;
}) {
  const position = useRef(new Animated.Value(presence.position)).current;
  // The ring color must follow the CURRENT possession team; pinning it at
  // mount left the glow in the first team's color while the label flipped.
  const color = presence.color;
  const pulse = useRef(new Animated.Value(0)).current;
  const drift = useRef(new Animated.Value(0)).current;
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);
  const driftLoop = useRef<Animated.CompositeAnimation | null>(null);
  // Fix #4: a held (last-known/neutral) presence never pulses or drifts --
  // it's a static "this is where play last was" marker, not an active
  // possession reading.
  const suppressMotion = reduceMotion || presence.isHeld;

  // Smooth transitions when zone/team changes: animate position; snap
  // instantly under reduce-motion so state changes are still fully legible
  // without motion (per the PRD's reduce-motion rule).
  useEffect(() => {
    if (reduceMotion) {
      position.setValue(presence.position);
      return;
    }
    Animated.timing(position, {
      toValue: presence.position,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [position, presence.position, reduceMotion]);

  // Pulse + drift loops: presentation only, disabled under reduce-motion
  // ("no drift/pulse, instant state changes") and also for a held presence
  // (fix #4's dimmed, static "last known position" treatment).
  useEffect(() => {
    pulseLoop.current?.stop();
    driftLoop.current?.stop();

    if (suppressMotion) {
      pulse.setValue(0);
      drift.setValue(0);
      return;
    }

    pulse.setValue(0);
    pulseLoop.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: presence.intensity.pulseDurationMs,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: presence.intensity.pulseDurationMs,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    pulseLoop.current.start();

    drift.setValue(0);
    driftLoop.current = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: presence.intensity.pulseDurationMs * 1.6,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(drift, {
          toValue: -1,
          duration: presence.intensity.pulseDurationMs * 3.2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: presence.intensity.pulseDurationMs * 1.6,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    driftLoop.current.start();

    return () => {
      pulseLoop.current?.stop();
      driftLoop.current?.stop();
    };
  }, [drift, presence.intensity.pulseDurationMs, pulse, suppressMotion]);

  const translateY = position.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });
  const driftTranslateX = drift.interpolate({
    inputRange: [-1, 1],
    outputRange: [`-${DRIFT_RANGE * 100}%`, `${DRIFT_RANGE * 100}%`],
  });
  const pulseScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1 + PULSE_SCALE_DELTA],
  });

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.presenceAnchor,
        { transform: [{ translateY }, { translateX: driftTranslateX }] },
      ]}
    >
      <Animated.View
        style={[
          styles.presenceRing,
          styles.presenceRingOuter,
          {
            backgroundColor: color,
            opacity: presence.intensity.outerOpacity,
            transform: [{ scale: Animated.multiply(presence.intensity.scale, pulseScale) }],
          },
        ]}
      />
      <View
        style={[
          styles.presenceRing,
          styles.presenceRingInner,
          { backgroundColor: color, opacity: presence.intensity.innerOpacity },
        ]}
      />
      <View style={[styles.presenceCore, { backgroundColor: color }]} />
      <PresenceTeamLabel presence={presence} />
    </Animated.View>
  );
}

/**
 * Fix #1: attaches the owning team's name to the possession presence itself
 * (small caps, team color) so the glow reads as "whose ball this is" without
 * having to cross-reference the score rail. Sits just below the presence
 * rings. Rendered in `presence.color` directly (not the presence-ring's
 * mount-pinned `color` ref) so the label always matches the team the current
 * presence actually names, including the neutral "Kickoff" placeholder.
 */
function PresenceTeamLabel({ presence }: { presence: BoardPresenceState }) {
  return (
    <Text
      numberOfLines={1}
      style={[
        styles.presenceLabel,
        { color: presence.color, opacity: presence.isHeld ? 0.55 : 0.92 },
      ]}
    >
      {presence.teamName}
    </Text>
  );
}

const styles = StyleSheet.create({
  // Fix #6: centers the pitch and caps its width on wide screens (web/
  // tablet) so it reads as a pitch instead of full-bleed emptiness; phones
  // stay effectively full-width since PITCH_MAX_WIDTH exceeds phone
  // viewports.
  boardOuter: {
    alignItems: 'center',
    backgroundColor: tokens.shell.background,
    flex: 1,
  },
  board: {
    backgroundColor: tokens.shell.background,
    flex: 1,
    maxWidth: PITCH_MAX_WIDTH,
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  },
  pitchSurface: {
    flex: 1,
    flexDirection: 'column',
  },
  zoneBand: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: tokens.spacing.xs,
  },
  zoneBandLine: {
    backgroundColor: tokens.shell.divider,
    height: StyleSheet.hairlineWidth,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  zoneBandLabel: {
    color: tokens.shell.textDim,
    fontSize: 9,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  // Fix #6: a visible pitch boundary (side lines + goal lines) so the board
  // reads as a pitch rather than an unbounded gradient. Quiet/thin per the
  // PRD's "zones are subtle structure, not loud chrome".
  pitchBoundary: {
    borderColor: tokens.shell.divider,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  centerLine: {
    backgroundColor: tokens.shell.divider,
    height: StyleSheet.hairlineWidth,
    left: 0,
    position: 'absolute',
    right: 0,
    top: '50%',
  },
  // Fix #6: a center-circle hint (kept small/subtle) plus the center spot,
  // completing the "pitch" read without becoming a broadcast-style diagram.
  centerCircle: {
    borderColor: tokens.shell.divider,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    height: 72,
    left: '50%',
    marginLeft: -36,
    marginTop: -36,
    position: 'absolute',
    top: '50%',
    width: 72,
  },
  centerDot: {
    backgroundColor: tokens.shell.divider,
    borderRadius: 2,
    height: 4,
    left: '50%',
    marginLeft: -2,
    marginTop: -2,
    position: 'absolute',
    top: '50%',
    width: 4,
  },
  // Fix #1: quiet goal-end labels so zone bands read relative to a real
  // goal at either end of the pitch.
  goalEndLabel: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    zIndex: 2,
  },
  goalEndLabelTop: {
    top: tokens.spacing.sm,
  },
  goalEndLabelBottom: {
    bottom: tokens.spacing.sm,
  },
  goalEndLabelText: {
    color: tokens.shell.textDim,
    fontSize: 9,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  presenceAnchor: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'flex-start',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 4,
  },
  presenceRing: {
    borderRadius: 999,
    position: 'absolute',
  },
  presenceRingOuter: {
    height: 88,
    width: 88,
  },
  presenceRingInner: {
    height: 52,
    width: 52,
  },
  presenceCore: {
    borderRadius: 999,
    height: 18,
    width: 18,
  },
  // Fix #1: the team-name label attached to the possession presence.
  // Positioned just below the presence core; small caps, team-colored.
  presenceLabel: {
    fontSize: 10,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1,
    marginTop: 14,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  overlaySlot: {
    ...StyleSheet.absoluteFill,
    zIndex: 10,
  },
});
