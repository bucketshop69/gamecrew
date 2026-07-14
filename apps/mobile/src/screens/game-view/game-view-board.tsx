import { gameCrewTokens, type GameViewScene } from '@gamecrew/core';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import {
  type BoardDirection,
  type BoardPresenceState,
  type BoardTeamInfo,
  buildBoardAccessibilityLabel,
  resolveAmbientPresence,
  ZONE_LABELS,
} from './game-view-board-logic';

const tokens = gameCrewTokens;

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
  const presence = useMemo(
    () => resolveAmbientPresence(scene, homeTeam, awayTeam, participant1Direction),
    [awayTeam, homeTeam, participant1Direction, scene],
  );
  const accessibilityLabel = useMemo(
    () => buildBoardAccessibilityLabel(presence),
    [presence],
  );

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="image"
      style={styles.board}
    >
      <ZonePitch />

      {presence ? (
        <PossessionPresence presence={presence} reduceMotion={reduceMotion} />
      ) : null}

      {overlay ? <View style={styles.overlaySlot}>{overlay}</View> : null}
    </View>
  );
}

/**
 * The abstract top-down pitch: subtle horizontal zone bands with gray lines
 * and labels, dividing the board into semantic bands (defensive / midfield /
 * attack / danger / high danger). Band order is symmetric around the
 * midfield line, so it reads correctly no matter which edge either team is
 * currently attacking -- the possession presence (positioned by
 * `zoneToBandPosition`) is what carries the actual attacking direction, not
 * the pitch chrome itself. This is deliberately quiet chrome, not a
 * broadcast-style pitch with markings.
 */
function ZonePitch() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <View style={styles.pitchSurface}>
        {ZONE_BAND_ROWS.map((band) => (
          <View key={band.zone} style={[styles.zoneBand, { flex: band.weight }]}>
            <View style={styles.zoneBandLine} />
            <Text style={styles.zoneBandLabel}>{ZONE_LABELS[band.zone]}</Text>
          </View>
        ))}
      </View>
      <View style={styles.centerLine} />
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
  const color = useRef(presence.color).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const drift = useRef(new Animated.Value(0)).current;
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);
  const driftLoop = useRef<Animated.CompositeAnimation | null>(null);

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

  // Pulse + drift loops: presentation only, disabled entirely under
  // reduce-motion ("no drift/pulse, instant state changes").
  useEffect(() => {
    pulseLoop.current?.stop();
    driftLoop.current?.stop();

    if (reduceMotion) {
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
  }, [drift, presence.intensity.pulseDurationMs, pulse, reduceMotion]);

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
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  board: {
    backgroundColor: tokens.shell.background,
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
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
  centerLine: {
    backgroundColor: tokens.shell.divider,
    height: StyleSheet.hairlineWidth,
    left: 0,
    position: 'absolute',
    right: 0,
    top: '50%',
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
  overlaySlot: {
    ...StyleSheet.absoluteFill,
    zIndex: 10,
  },
});
