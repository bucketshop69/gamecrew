import { gameCrewTokens, type GameViewScene } from '@gamecrew/core';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type DimensionValue } from 'react-native';

import {
  type BoardDirection,
  type BoardPresenceState,
  type BoardTeamInfo,
  buildBoardAccessibilityLabel,
  PITCH_MARKINGS,
  resolveAmbientPresence,
  resolveBoardPresence,
  resolveCenteredBoxLayout,
  resolveGoalEndLabels,
  zoneLabelForDirection,
} from './game-view-board-logic';

const tokens = gameCrewTokens;

/** Max content width for the pitch on wide screens (fix #6): phones stay full-bleed, web/tablet gets a centered pitch. */
const PITCH_MAX_WIDTH = 480;

/**
 * R1 chalk line color: slightly brighter than `tokens.shell.divider` (the
 * existing quiet boundary gray) so the broadcast pitch markings read as
 * "painted lines" while staying within the black/white/gray shell palette --
 * no green turf, per the product's "GameCrew is black and white; the match
 * brings the color" rule.
 */
const CHALK_LINE_COLOR = '#3D3D3D';
/**
 * R1: now that real chalk lines exist, the zone-band divider lines are
 * dimmed further so they read as quiet internal structure rather than
 * competing with the pitch markings.
 */
const ZONE_LINE_COLOR = 'rgba(255, 255, 255, 0.05)';

/**
 * R1 addendum: perimeter LED-board strip thickness. Thin enough to read as
 * stadium furniture without shrinking the playable pitch noticeably (per the
 * "10-14px tall strips" guidance); the pitch content inset (`pitchInset`)
 * uses this same value on all four edges so the strips sit just inside the
 * board container but outside the chalk boundary.
 */
const PERIMETER_STRIP_SIZE = 12;
/** Slightly raised luminance vs the turf so the strip reads as a panel, not a shadow. */
const PERIMETER_PANEL_COLOR = '#111111';

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
        <PerimeterBoards reduceMotion={reduceMotion} />
        <View style={styles.pitchInset}>
          <Turf />
          <ChalkLines />
          <GoalEndLabel edge="top" label={goalEndLabels.top} />
          <ZonePitch direction={presence.direction} />

          <PossessionPresence presence={presence} reduceMotion={reduceMotion} />

          {overlay ? <View style={styles.overlaySlot}>{overlay}</View> : null}
          <GoalEndLabel edge="bottom" label={goalEndLabels.bottom} />
        </View>
      </View>
    </View>
  );
}

/**
 * R1 addendum: pulls forward the perimeter-strip slot from work item C3 of
 * docs/issues/game-view-presentation-polish.md ("Overlay slot system
 * (perimeter strip, corner lockup, break interstitial) with placeholder
 * content"). Renders thin stadium-LED-style boards along the pitch edges,
 * just inside the board container but outside the chalk boundary (the
 * `pitchInset` sibling shrinks to make room, so the playable pitch area
 * itself doesn't get visually cramped). Ships with a placeholder-only
 * repeating GAMECREW wordmark -- no fake sponsor content, per the slot
 * system's "ships with placeholder content; ad logic is a separate later
 * decision" rule. Non-interactive and hidden from accessibility: it's
 * stadium furniture, not board content.
 */
function PerimeterBoards({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      <PerimeterStrip edge="top" reduceMotion={reduceMotion} />
      <PerimeterStrip edge="bottom" reduceMotion={reduceMotion} />
      <PerimeterStrip edge="left" reduceMotion={reduceMotion} />
      <PerimeterStrip edge="right" reduceMotion={reduceMotion} />
    </View>
  );
}

const PERIMETER_WORDMARK = 'GAMECREW';
/** Repeats enough to fill the longest strip edge without measuring layout. */
const PERIMETER_REPEAT = Array.from({ length: 8 }, (_, index) => index);
const PERIMETER_DRIFT_DURATION_MS = 26000;
const PERIMETER_DRIFT_RANGE = 24;

function PerimeterStrip({
  edge,
  reduceMotion,
}: {
  edge: 'top' | 'bottom' | 'left' | 'right';
  reduceMotion: boolean;
}) {
  const drift = useRef(new Animated.Value(0)).current;
  const driftLoop = useRef<Animated.CompositeAnimation | null>(null);
  const isVertical = edge === 'left' || edge === 'right';

  useEffect(() => {
    driftLoop.current?.stop();
    if (reduceMotion) {
      drift.setValue(0);
      return;
    }

    drift.setValue(0);
    driftLoop.current = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: PERIMETER_DRIFT_DURATION_MS,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    driftLoop.current.start();

    return () => {
      driftLoop.current?.stop();
    };
  }, [drift, reduceMotion]);

  const translate = drift.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -PERIMETER_DRIFT_RANGE],
  });
  // Vertical (left/right) strips reuse the same horizontal text row, then
  // rotate the whole row 90deg so it reads top-to-bottom like a real
  // perimeter board's side panel -- the drift still reads as "translateX"
  // in the row's own (pre-rotation) coordinate space.
  const transform = isVertical
    ? [{ rotate: '90deg' }, { translateX: translate }]
    : [{ translateX: translate }];

  return (
    <View style={[styles.perimeterStrip, styles[`perimeterStrip_${edge}`]]}>
      <Animated.View style={[styles.perimeterContentHorizontal, { transform }]}>
        {PERIMETER_REPEAT.map((index) => (
          <Text key={index} numberOfLines={1} style={styles.perimeterText}>
            {PERIMETER_WORDMARK}
          </Text>
        ))}
      </Animated.View>
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
 * R1 (docs/issues/game-view-realism-experiment.md): the turf surface under
 * everything else. Alternating near-black horizontal mowing-stripe bands so
 * the board reads as grass under floodlights rather than a flat void.
 * Deliberately barely-perceptible -- two adjacent shell grays, no green --
 * per the product's "GameCrew is black and white; the match brings the
 * color" rule. Purely decorative: hidden from accessibility, sits below the
 * chalk lines and zone chrome.
 */
function Turf() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      {TURF_STRIPES.map((stripe, index) => (
        <View
          key={index}
          style={[
            styles.turfStripe,
            { backgroundColor: stripe === 0 ? tokens.shell.background : TURF_STRIPE_ALT },
          ]}
        />
      ))}
    </View>
  );
}

/** Count of alternating turf stripes running the length of the pitch. */
const TURF_STRIPE_COUNT = 12;
const TURF_STRIPES = Array.from({ length: TURF_STRIPE_COUNT }, (_, index) => index % 2);
/** Slightly lighter than shell.background -- a barely-perceptible mowing band, not a visible line. */
const TURF_STRIPE_ALT = '#080808';

/**
 * R1: broadcast chalk line work drawn as plain bordered Views (max width
 * intact, no SVG/images per the constraint). Full boundary and halfway line
 * already existed (fix #6); this adds both penalty areas (box + six-yard +
 * spot + arc), goal-mouth brackets, and corner arc hints, all sized as
 * percentages of the board via `PITCH_MARKINGS` so they scale with the
 * board's own flex layout at any width. Sits above the turf, below the zone
 * chrome/presence per the layering order in the parent render.
 */
function ChalkLines() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <PenaltyArea edge="top" />
      <PenaltyArea edge="bottom" />
      <CornerArc corner="topLeft" />
      <CornerArc corner="topRight" />
      <CornerArc corner="bottomLeft" />
      <CornerArc corner="bottomRight" />
    </View>
  );
}

const penaltyBoxLayout = resolveCenteredBoxLayout(PITCH_MARKINGS.penaltyBox);
const sixYardBoxLayout = resolveCenteredBoxLayout(PITCH_MARKINGS.sixYardBox);
const goalMouthLayout = resolveCenteredBoxLayout(PITCH_MARKINGS.goalMouth);
const penaltyArcDiameterPct = PITCH_MARKINGS.penaltyArc.radiusPct * 2 * 100;

/**
 * One end's penalty area: outer box, six-yard box, penalty spot, and the D
 * (penalty arc, approximated as a bordered circle View whose straight edge
 * is clipped by the box's own overflow -- per the constraint, "arc can be
 * approximated with a bordered half-circle View clipped by overflow").
 */
function PenaltyArea({ edge }: { edge: 'top' | 'bottom' }) {
  const edgeStyle: { top: DimensionValue } | { bottom: DimensionValue } =
    edge === 'top' ? { top: 0 } : { bottom: 0 };
  const penaltySpotFromGoalLinePct: DimensionValue = `${PITCH_MARKINGS.penaltySpot.fromGoalLinePct * 100}%`;
  const arcEdgeStyle: { top: DimensionValue } | { bottom: DimensionValue } =
    edge === 'top' ? { top: penaltySpotFromGoalLinePct } : { bottom: penaltySpotFromGoalLinePct };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View
        style={[
          styles.penaltyBox,
          edgeStyle,
          {
            left: `${penaltyBoxLayout.leftPct}%`,
            width: `${penaltyBoxLayout.widthPct}%`,
            height: `${penaltyBoxLayout.depthPct}%`,
          },
        ]}
      />
      <View
        style={[
          styles.penaltyBox,
          edgeStyle,
          {
            left: `${sixYardBoxLayout.leftPct}%`,
            width: `${sixYardBoxLayout.widthPct}%`,
            height: `${sixYardBoxLayout.depthPct}%`,
          },
        ]}
      />
      <View
        style={[
          styles.penaltySpot,
          edge === 'top' ? { top: penaltySpotFromGoalLinePct } : { bottom: penaltySpotFromGoalLinePct },
        ]}
      />
      {/* Penalty arc: a full circle centered on the spot, clipped to only
          show the half that bulges out of the box via the box's own
          overflow:hidden -- the arc's far half sits inside the (visually
          transparent) box area and is simply covered by the box outline. */}
      <View
        style={[
          styles.penaltyArcClip,
          edgeStyle,
          { height: `${PITCH_MARKINGS.penaltyBox.depthPct * 100 + 10}%` },
        ]}
      >
        <View
          style={[
            styles.penaltyArc,
            arcEdgeStyle,
            { width: `${penaltyArcDiameterPct}%`, height: `${penaltyArcDiameterPct}%` },
          ]}
        />
      </View>
      <GoalMouth edge={edge} />
    </View>
  );
}

/** Small bracket rectangle just outside the goal line, hinting at the goal frame. */
function GoalMouth({ edge }: { edge: 'top' | 'bottom' }) {
  return (
    <View
      style={[
        styles.goalMouth,
        edge === 'top'
          ? { top: -(PITCH_MARKINGS.goalMouth.depthPct * 100) }
          : { bottom: -(PITCH_MARKINGS.goalMouth.depthPct * 100) },
        {
          left: `${goalMouthLayout.leftPct}%`,
          width: `${goalMouthLayout.widthPct}%`,
          height: `${PITCH_MARKINGS.goalMouth.depthPct * 100}%`,
        },
      ]}
    />
  );
}

const CORNER_STYLE_KEY = {
  topLeft: 'cornerArcTopLeft',
  topRight: 'cornerArcTopRight',
  bottomLeft: 'cornerArcBottomLeft',
  bottomRight: 'cornerArcBottomRight',
} as const;

/** Tiny quarter-circle hint at a pitch corner via the border-radius trick. */
function CornerArc({ corner }: { corner: keyof typeof CORNER_STYLE_KEY }) {
  const sizePct = PITCH_MARKINGS.cornerArc.radiusPct * 100;
  return (
    <View
      style={[
        styles.cornerArc,
        styles[CORNER_STYLE_KEY[corner]],
        { width: `${sizePct}%`, height: `${sizePct}%` },
      ]}
    />
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
  // R1 addendum: insets all pitch content (turf, chalk lines, zone chrome,
  // presence, overlay, goal-end labels) by PERIMETER_STRIP_SIZE on every
  // edge so the perimeter LED-board strips have room to sit just inside the
  // board container without visually cramping the playable pitch.
  pitchInset: {
    bottom: PERIMETER_STRIP_SIZE,
    left: PERIMETER_STRIP_SIZE,
    position: 'absolute',
    right: PERIMETER_STRIP_SIZE,
    top: PERIMETER_STRIP_SIZE,
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
    backgroundColor: ZONE_LINE_COLOR,
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
  // Fix #6, upgraded for R1: a visible pitch boundary (side lines + goal
  // lines) so the board reads as a pitch rather than an unbounded gradient.
  // Uses CHALK_LINE_COLOR (brighter than the plain shell divider) now that
  // it's drawn alongside full broadcast markings.
  pitchBoundary: {
    borderColor: CHALK_LINE_COLOR,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  centerLine: {
    backgroundColor: CHALK_LINE_COLOR,
    height: StyleSheet.hairlineWidth,
    left: 0,
    position: 'absolute',
    right: 0,
    top: '50%',
  },
  // Fix #6: a center-circle hint (kept small/subtle) plus the center spot,
  // completing the "pitch" read without becoming a broadcast-style diagram.
  centerCircle: {
    borderColor: CHALK_LINE_COLOR,
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
    backgroundColor: CHALK_LINE_COLOR,
    borderRadius: 2,
    height: 4,
    left: '50%',
    marginLeft: -2,
    marginTop: -2,
    position: 'absolute',
    top: '50%',
    width: 4,
  },
  // R1: turf surface stripe -- see `Turf`. Each stripe is an equal-height
  // flex row; the alternating backgroundColor prop is applied per-instance.
  turfStripe: {
    flex: 1,
  },
  // R1: shared style for both the outer penalty box and the six-yard box --
  // only position/left/width/height differ per instance.
  penaltyBox: {
    borderColor: CHALK_LINE_COLOR,
    borderWidth: StyleSheet.hairlineWidth,
    position: 'absolute',
  },
  penaltySpot: {
    backgroundColor: CHALK_LINE_COLOR,
    borderRadius: 2,
    height: 3,
    left: '50%',
    marginLeft: -1.5,
    marginTop: -1.5,
    position: 'absolute',
    width: 3,
  },
  // R1: clips the penalty arc to only the sliver that bulges past the box
  // edge, per the constraint's "clipped by overflow" approximation. Spans
  // slightly past the box depth so the arc's curve is visible outside it.
  penaltyArcClip: {
    left: '10%',
    overflow: 'hidden',
    position: 'absolute',
    right: '10%',
  },
  penaltyArc: {
    borderColor: CHALK_LINE_COLOR,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    left: '50%',
    position: 'absolute',
    transform: [{ translateX: '-50%' }, { translateY: '-50%' }],
  },
  // R1: small bracket rectangle just outside the goal line hinting at the
  // goal frame -- open-bottomed toward the pitch (no border on the edge
  // facing the field) so it reads as a goal mouth, not a closed box.
  goalMouth: {
    borderColor: CHALK_LINE_COLOR,
    borderWidth: StyleSheet.hairlineWidth,
    position: 'absolute',
  },
  // R1: corner quarter-circle hints via the border-radius trick -- a small
  // square with only the pitch-facing corner rounded and bordered.
  cornerArc: {
    borderColor: CHALK_LINE_COLOR,
    position: 'absolute',
  },
  cornerArcTopLeft: {
    borderBottomRightRadius: 999,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    left: 0,
    top: 0,
  },
  cornerArcTopRight: {
    borderBottomLeftRadius: 999,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    right: 0,
    top: 0,
  },
  cornerArcBottomLeft: {
    borderTopRightRadius: 999,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    left: 0,
    bottom: 0,
  },
  cornerArcBottomRight: {
    borderTopLeftRadius: 999,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    right: 0,
    bottom: 0,
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
  // R1 addendum (C3 perimeter slot pulled forward): base panel style shared
  // by all four strip edges -- a slightly raised-luminance dark panel,
  // clipped so the drifting wordmark content never spills past its strip.
  perimeterStrip: {
    alignItems: 'center',
    backgroundColor: PERIMETER_PANEL_COLOR,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'absolute',
  },
  perimeterStrip_top: {
    height: PERIMETER_STRIP_SIZE,
    left: 0,
    right: 0,
    top: 0,
  },
  perimeterStrip_bottom: {
    bottom: 0,
    height: PERIMETER_STRIP_SIZE,
    left: 0,
    right: 0,
  },
  perimeterStrip_left: {
    bottom: 0,
    left: 0,
    top: 0,
    width: PERIMETER_STRIP_SIZE,
  },
  perimeterStrip_right: {
    bottom: 0,
    right: 0,
    top: 0,
    width: PERIMETER_STRIP_SIZE,
  },
  perimeterContentHorizontal: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  perimeterText: {
    color: tokens.shell.textDim,
    fontSize: 8,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 2,
    marginHorizontal: tokens.spacing.lg,
    marginVertical: tokens.spacing.lg,
    opacity: 0.5,
    textTransform: 'uppercase',
  },
});
