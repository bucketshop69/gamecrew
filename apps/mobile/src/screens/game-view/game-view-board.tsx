import { gameCrewTokens, type GameViewScene } from '@gamecrew/core';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from 'react-native';
import Reanimated, {
  cancelAnimation,
  Easing as ReanimatedEasing,
  FadeIn,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import {
  resolveClusterPlan,
  type GoalBeatKind,
} from '../game-view-players/cluster-choreography-logic';
import { GameViewActionCluster } from '../game-view-players/game-view-action-cluster';
import {
  type BoardDirection,
  type BoardPresenceState,
  type BoardTeamInfo,
  buildBoardAccessibilityLabel,
  PITCH_MARKINGS,
  resolveAmbientPresence,
  resolveBoardPresence,
  resolveCenteredBoxLayout,
  resolveGoalEndTeams,
} from './game-view-board-logic';

const tokens = gameCrewTokens;

/** Max content width for the pitch on wide screens (fix #6): phones stay full-bleed, web/tablet gets a centered pitch. */
const PITCH_MAX_WIDTH = 480;

/** Floodlit pitch paint: soft enough to sit in the turf, bright enough to
 * describe the field at a phone-sized scale. Primary paint anchors the
 * boundary and halfway geometry; secondary paint keeps box detail quieter. */
const CHALK_PRIMARY_COLOR = 'rgba(231, 240, 232, 0.62)';
const CHALK_SECONDARY_COLOR = 'rgba(219, 233, 221, 0.44)';
const BOARD_SHELL_COLOR = '#050505';

/**
 * The approved perimeter treatment is a three-sided stadium wall: the top
 * and both touchlines carry inward-facing LED faces, while the near/bottom
 * edge stays quiet black. A little more face width than the earlier flat
 * 24px trim gives the perspective transform enough surface to read without
 * consuming the playing area.
 */
const PERIMETER_STRIP_SIZE = 28;
const PERIMETER_BOTTOM_SHELL_SIZE = 18;
const PERIMETER_TOP_CORNER_INSET = 16;
/** Slightly raised luminance vs the turf so the strip reads as a panel, not a shadow. */
const PERIMETER_PANEL_COLOR = '#0B0D0C';
const PERIMETER_PANEL_EDGE_COLOR = 'rgba(226, 238, 229, 0.14)';
const PERIMETER_PANEL_LIP_COLOR = '#1A201D';
const PERIMETER_PANEL_DEPTH_COLOR = '#020303';
/**
 * Grass apron between the ad boards and the chalk boundary, so the touchline
 * doesn't kiss the boards: the "runners' room" real pitches have. The turf
 * runs under the apron; only the line work and play content inset further.
 */
const PITCH_APRON_SIZE = 14;

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
  bootstrapScene,
  commentaryOverlay,
  goalBeat,
  homeTeam,
  overlay,
  participant1Direction = 'up',
  reduceMotion,
  scene,
  sceneWindowKey,
}: {
  awayTeam: BoardTeamInfo;
  /** Nearest prior grounded scene for a cold-mount stoppage; never replaces current-scene truth. */
  bootstrapScene?: GameViewScene;
  /** Source-synchronized Match Pulse transcript, positioned in the lower-left HUD slot. */
  commentaryOverlay?: ReactNode;
  /** Which goal_sequence beat is currently playing, so the cluster can celebrate through the checking treatment (R4). */
  goalBeat?: GoalBeatKind;
  homeTeam: BoardTeamInfo;
  /** Slot for a takeover graphic (B2) to render on top of the idle board. */
  overlay?: ReactNode;
  /** Which visual edge participant 1 attacks; participant 2 attacks the opposite edge. */
  participant1Direction?: BoardDirection;
  reduceMotion: boolean;
  scene: GameViewScene | null;
  /** Active playback-window identity; refreshes choreography when a logical scene is replaced in place. */
  sceneWindowKey?: string;
}) {
  const lastLivePresenceRef = useRef<BoardPresenceState | undefined>(undefined);

  // R4: when the action cluster stages this scene (ambient knot, corner,
  // shot, goal celebration, kickoff) it IS the possession visual -- the
  // abstract presence rings would double up as a second focal point, so they
  // stand down. Scenes the cluster stays off for (takeovers, no-participant
  // ambient) keep the presence/held-presence treatment unchanged.
  const clusterActive = useMemo(
    () => resolveClusterPlan(scene, homeTeam, awayTeam, participant1Direction, goalBeat).kind !== 'none',
    [awayTeam, goalBeat, homeTeam, participant1Direction, scene],
  );

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
  const goalEnds = useMemo(
    () => resolveGoalEndTeams(homeTeam, awayTeam, participant1Direction),
    [awayTeam, homeTeam, participant1Direction],
  );

  return (
    <View style={styles.boardOuter}>
      <View style={styles.board}>
        <View
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="image"
          style={styles.boardCanvas}
        >
          <PerimeterBoards reduceMotion={reduceMotion} />
          <View style={styles.pitchInset}>
            <Turf />
            {/* Grass apron: line work and play content inset further than the
                turf, leaving visible out-of-bounds grass next to the boards. */}
            <View style={styles.apronInset}>
              <ChalkLines goalEnds={goalEnds} />
              <ZonePitch />

              {clusterActive ? (
                <GameViewActionCluster
                  awayTeam={awayTeam}
                  bootstrapScene={bootstrapScene}
                  goalBeat={goalBeat}
                  homeTeam={homeTeam}
                  participant1Direction={participant1Direction}
                  reduceMotion={reduceMotion}
                  scene={scene}
                  sceneWindowKey={sceneWindowKey}
                />
              ) : (
                <PossessionPresence presence={presence} reduceMotion={reduceMotion} />
              )}

              {overlay ? <View style={styles.overlaySlot}>{overlay}</View> : null}
            </View>
          </View>
        </View>

        {commentaryOverlay ? (
          <View style={styles.commentaryInset}>
            <View style={styles.commentarySlot}>
              {commentaryOverlay}
            </View>
          </View>
        ) : null}
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
 * itself doesn't get visually cramped). Product-approved revision
 * 2026-07-16: only the top and side faces carry LED creative. They are
 * perspective-tilted toward the pitch so they read as stadium furniture;
 * the near/bottom edge is an uninterrupted black shell. The first five
 * seconds retain the quiet GAMECREW placeholder; then the Solana ecosystem
 * showcase travels across the three faces from one shared clock. The names
 * are presentation creative only and do not imply sponsorship or partnership.
 * This is a visual trial, not targeting, measurement, or production ad logic.
 */
function PerimeterBoards({ reduceMotion }: { reduceMotion: boolean }) {
  const [adsStarted, setAdsStarted] = useState(false);
  const progress = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    setAdsStarted(false);

    const startTimer = setTimeout(() => {
      setAdsStarted(true);
      if (!reduceMotion) {
        progress.value = withRepeat(
          withTiming(1, {
            duration: PERIMETER_AD_LOOP_DURATION_MS,
            easing: ReanimatedEasing.linear,
          }),
          -1,
          false,
        );
      }
    }, PERIMETER_AD_START_DELAY_MS);

    return () => {
      clearTimeout(startTimer);
      cancelAnimation(progress);
    };
  }, [progress, reduceMotion]);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      <PerimeterStrip adsStarted={adsStarted} edge="top" progress={progress} reduceMotion={reduceMotion} />
      <PerimeterStrip adsStarted={adsStarted} edge="left" progress={progress} reduceMotion={reduceMotion} />
      <PerimeterStrip adsStarted={adsStarted} edge="right" progress={progress} reduceMotion={reduceMotion} />
    </View>
  );
}

interface EcosystemBrand {
  color: string;
  colorSecondary: string;
  logo?: {
    height: number;
    uri: string;
    width: number;
  };
  mark: string;
  name: string;
  panelColor: string;
  strapline: string;
}

const ECOSYSTEM_BRANDS: readonly EcosystemBrand[] = [
  {
    color: '#14F195',
    colorSecondary: '#9945FF',
    logo: {
      height: 15,
      uri: 'https://solana.com/src/img/branding/solanaLogoMark.png',
      width: 17,
    },
    mark: 'SOL',
    name: 'SOLANA',
    panelColor: '#071B18',
    strapline: 'NETWORK',
  },
  {
    color: '#C7F284',
    colorSecondary: '#27C7D9',
    logo: {
      height: 16,
      uri: 'https://jup.ag/svg/jupiter-logo.png',
      width: 16,
    },
    mark: 'JUP',
    name: 'JUPITER',
    panelColor: '#0A1C18',
    strapline: 'ONCHAIN',
  },
  {
    color: '#F3F5EF',
    colorSecondary: '#8B8F89',
    mark: '$A',
    name: '$ANSEM',
    panelColor: '#161817',
    strapline: 'COMMUNITY',
  },
  {
    color: '#FF7A45',
    colorSecondary: '#FFC145',
    mark: 'PHX',
    name: 'PHOENIX',
    panelColor: '#24110A',
    strapline: 'ORDERBOOK',
  },
  {
    color: '#FF5A0A',
    colorSecondary: '#7B2CFF',
    logo: {
      height: 16,
      uri: 'https://mintcdn.com/meteora/FuYCvEvL3a7_z_Mt/assets/logo/meteora.png?fit=max&auto=format&n=FuYCvEvL3a7_z_Mt&q=85&s=5ae3f2a17133bed15a6360c41694c4d7',
      width: 16,
    },
    mark: 'MET',
    name: 'METEORA',
    panelColor: '#1A1023',
    strapline: 'LIQUIDITY',
  },
];
const PERIMETER_AD_START_DELAY_MS = 5000;
const PERIMETER_AD_LOOP_DURATION_MS = 28000;
/** Keeps the ecosystem wall atmospheric so the match remains the primary focal layer. */
const PERIMETER_AD_CREATIVE_OPACITY = 0.65;
const PERIMETER_SPONSOR_WIDTH = 152;
const PERIMETER_SPONSOR_MARK_HEIGHT = 72;
const PERIMETER_SPONSOR_GAP = 7;
const PERIMETER_HORIZONTAL_CYCLE_WIDTH = ECOSYSTEM_BRANDS.length
  * (PERIMETER_SPONSOR_WIDTH + PERIMETER_SPONSOR_GAP);
const PERIMETER_VERTICAL_CYCLE_HEIGHT = ECOSYSTEM_BRANDS.length
  * (PERIMETER_SPONSOR_MARK_HEIGHT + PERIMETER_SPONSOR_GAP);
const PERIMETER_HORIZONTAL_TRACK_COPIES = [0, 1];
/** Enough repeated height to keep tall phones/tablets covered through the full one-cycle translation. */
const PERIMETER_VERTICAL_TRACK_COPIES = [0, 1, 2, 3, 4];
const PERIMETER_PLACEHOLDER_REPEAT = Array.from({ length: 6 }, (_, index) => index);

function PerimeterStrip({
  adsStarted,
  edge,
  progress,
  reduceMotion,
}: {
  adsStarted: boolean;
  edge: 'top' | 'left' | 'right';
  progress: SharedValue<number>;
  reduceMotion: boolean;
}) {
  const isVertical = edge === 'left' || edge === 'right';
  const clockwiseStyle = useAnimatedStyle(() => {
    if (isVertical) {
      const translateY = edge === 'left'
        ? -PERIMETER_VERTICAL_CYCLE_HEIGHT * progress.value
        : PERIMETER_VERTICAL_CYCLE_HEIGHT * (progress.value - 1);
      return { transform: [{ translateY }] };
    }
    const translateX = PERIMETER_HORIZONTAL_CYCLE_WIDTH * (progress.value - 1);
    return { transform: [{ translateX }] };
  });

  if (!adsStarted) {
    return (
      <PerimeterWall edge={edge}>
        <View style={styles.perimeterStripFace}>
          {isVertical ? (
            <View style={styles.perimeterLedColumn}>
              {PERIMETER_LED_SEGMENTS.map((index) => (
                <View key={index} style={styles.perimeterLedDash} />
              ))}
            </View>
          ) : (
            <View style={styles.perimeterContentHorizontal}>
              {PERIMETER_PLACEHOLDER_REPEAT.map((index) => (
                <Text key={index} numberOfLines={1} style={styles.perimeterText}>
                  GAMECREW
                </Text>
              ))}
            </View>
          )}
        </View>
      </PerimeterWall>
    );
  }

  return (
    <PerimeterWall edge={edge}>
      <View style={styles.perimeterStripFace}>
        <Reanimated.View
          entering={reduceMotion ? undefined : FadeIn.duration(420)}
          style={[
            isVertical
              ? styles.perimeterSponsorTrackVertical
              : styles.perimeterSponsorTrackHorizontal,
            styles.perimeterAdCreative,
            clockwiseStyle,
          ]}
        >
          {(isVertical ? PERIMETER_VERTICAL_TRACK_COPIES : PERIMETER_HORIZONTAL_TRACK_COPIES)
            .flatMap((copy) => ECOSYSTEM_BRANDS.map((brand) => (
              isVertical ? (
                <View
                  key={`${edge}-${copy}-${brand.mark}`}
                  style={[
                    styles.perimeterSponsorSide,
                    { backgroundColor: brand.panelColor },
                  ]}
                >
                  <EcosystemBrandTexture brand={brand} />
                  <View
                    style={[
                      styles.perimeterSponsorSideCreative,
                      edge === 'left'
                        ? styles.perimeterSponsorSideCreative_left
                        : styles.perimeterSponsorSideCreative_right,
                    ]}
                  >
                    <EcosystemBrandMark brand={brand} side />
                    <Text
                      numberOfLines={1}
                      style={styles.perimeterSponsorSideName}
                    >
                      {brand.name}
                    </Text>
                  </View>
                </View>
              ) : (
                <View
                  key={`${edge}-${copy}-${brand.mark}`}
                  style={[
                    styles.perimeterSponsorHorizontal,
                    { backgroundColor: brand.panelColor },
                  ]}
                >
                  <EcosystemBrandTexture brand={brand} />
                  <EcosystemBrandMark brand={brand} />
                  <Text numberOfLines={1} style={styles.perimeterSponsorName}>
                    {brand.name}
                  </Text>
                  <Text numberOfLines={1} style={styles.perimeterSponsorStrapline}>
                    {brand.strapline}
                  </Text>
                </View>
              )
            )))}
        </Reanimated.View>
      </View>
    </PerimeterWall>
  );
}

function EcosystemBrandTexture({ brand }: { brand: EcosystemBrand }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[styles.perimeterBrandGlow, { backgroundColor: brand.color }]} />
      <View
        style={[
          styles.perimeterBrandStripe,
          { backgroundColor: brand.colorSecondary },
        ]}
      />
      <View style={[styles.perimeterBrandScanline, styles.perimeterBrandScanline_top]} />
      <View style={[styles.perimeterBrandScanline, styles.perimeterBrandScanline_bottom]} />
    </View>
  );
}

function EcosystemBrandMark({
  brand,
  side = false,
}: {
  brand: EcosystemBrand;
  side?: boolean;
}) {
  const containerStyle = side
    ? styles.perimeterSponsorSideMark
    : styles.perimeterSponsorLogo;

  return (
    <View
      style={[
        containerStyle,
        brand.logo
          ? styles.perimeterSponsorLogoImageShell
          : { borderColor: brand.color },
      ]}
    >
      {brand.logo ? (
        <Image
          resizeMode="contain"
          source={{ uri: brand.logo.uri }}
          style={{ height: brand.logo.height, width: brand.logo.width }}
        />
      ) : (
        <Text
          style={[
            side
              ? styles.perimeterSponsorSideText
              : styles.perimeterSponsorLogoText,
            { color: brand.color },
          ]}
        >
          {brand.mark}
        </Text>
      )}
    </View>
  );
}

/**
 * Physical shell around each LED face. The transforms turn the side faces
 * toward one another and pitch the far/top face toward the grass. Dark inner
 * lips and lower end caps supply the depth cue without introducing another
 * bright decorative layer.
 */
function PerimeterWall({
  children,
  edge,
}: {
  children: ReactNode;
  edge: 'top' | 'left' | 'right';
}) {
  return (
    <View style={[styles.perimeterWall, styles[`perimeterWall_${edge}`]]}>
      {children}
      <View style={[styles.perimeterWallLip, styles[`perimeterWallLip_${edge}`]]} />
      {edge !== 'top' ? <View style={styles.perimeterWallEndCap} /> : null}
    </View>
  );
}

/** Quiet LED segments for the side rails; enough to fill any pitch height. */
const PERIMETER_LED_SEGMENTS = Array.from({ length: 18 }, (_, index) => index);

/** The two team identities the chalk layer needs to paint each goal mouth. */
interface GoalEndColors {
  top: BoardTeamInfo;
  bottom: BoardTeamInfo;
}

/**
 * The turf surface under everything else: alternating dark-green horizontal
 * mowing-stripe bands so the board reads as grass under floodlights.
 * Product decision 2026-07-15 (turf pass, with the 22-player formation
 * view): the pitch is greenish -- the earlier "no green, black shell only"
 * rule is overridden for the playing surface specifically; the shell around
 * the board stays black. Deliberately deep and desaturated so team colors
 * and chalk lines still carry the scene. Purely decorative: hidden from
 * accessibility, sits below the chalk lines and zone chrome.
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
            { backgroundColor: stripe === 0 ? TURF_STRIPE_BASE : TURF_STRIPE_ALT },
          ]}
        />
      ))}
    </View>
  );
}

/** Count of alternating turf stripes running the length of the pitch. */
const TURF_STRIPE_COUNT = 12;
const TURF_STRIPES = Array.from({ length: TURF_STRIPE_COUNT }, (_, index) => index % 2);
/**
 * Floodlit-grass greens: clearly green against the black shell, dark enough
 * that white chalk, the ball, and both teams' colors stay the loudest
 * things on screen. Base vs alt is the mowing-stripe contrast.
 */
const TURF_STRIPE_BASE = '#112A1A';
const TURF_STRIPE_ALT = '#183820';

/**
 * R1: broadcast chalk line work drawn as plain bordered Views (max width
 * intact, no SVG/images per the constraint). Full boundary and halfway line
 * already existed (fix #6); this adds both penalty areas (box + six-yard +
 * spot + arc), goal-mouth brackets, and corner arc hints, all sized as
 * percentages of the board via `PITCH_MARKINGS` so they scale with the
 * board's own flex layout at any width. Sits above the turf, below the zone
 * chrome/presence per the layering order in the parent render.
 */
function ChalkLines({ goalEnds }: { goalEnds: GoalEndColors }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <PenaltyArea edge="top" goalColor={goalEnds.top.color} />
      <PenaltyArea edge="bottom" goalColor={goalEnds.bottom.color} />
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
function PenaltyArea({ edge, goalColor }: { edge: 'top' | 'bottom'; goalColor: string }) {
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
      <GoalMouth edge={edge} goalColor={goalColor} />
    </View>
  );
}

/**
 * Bracket rectangle just outside the goal line, hinting at the goal frame.
 * Painted in the defending team's color (frame + translucent "netting"
 * fill): the language-free replacement for the old "FRANCE GOAL" end
 * labels -- which end is whose now reads from color alone, matching the
 * team colors already carried by the figures and score rail.
 */
function GoalMouth({ edge, goalColor }: { edge: 'top' | 'bottom'; goalColor: string }) {
  return (
    <View
      style={[
        styles.goalMouth,
        edge === 'top'
          ? { top: -(PITCH_MARKINGS.goalMouth.depthPct * 100) }
          : { bottom: -(PITCH_MARKINGS.goalMouth.depthPct * 100) },
        {
          borderColor: goalColor,
          left: `${goalMouthLayout.leftPct}%`,
          width: `${goalMouthLayout.widthPct}%`,
          height: `${PITCH_MARKINGS.goalMouth.depthPct * 100}%`,
        },
      ]}
    >
      <View style={[StyleSheet.absoluteFill, styles.goalMouthNetting, { backgroundColor: goalColor }]} />
    </View>
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
 * The pitch structure layer: boundary (side/goal lines), center line,
 * center circle, and spot. The zone-band hairlines and text labels
 * ("DANGER", "MIDFIELD", "OWN THIRD") that used to divide the board are
 * gone -- product direction 2026-07-15: with 22 players and a real ball on
 * the pitch, the match itself shows where the danger is, and the
 * commentary lower-third carries the words. The semantic zones still drive
 * all staging logic; they just aren't printed on the grass.
 */
function ZonePitch() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <View style={styles.pitchBoundary} pointerEvents="none" />
      <View style={styles.centerLine} />
      <View style={styles.centerCircle} />
      <View style={styles.centerDot} />
    </View>
  );
}

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
    backgroundColor: BOARD_SHELL_COLOR,
    flex: 1,
  },
  board: {
    backgroundColor: BOARD_SHELL_COLOR,
    flex: 1,
    maxWidth: PITCH_MAX_WIDTH,
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  },
  boardCanvas: {
    ...StyleSheet.absoluteFill,
  },
  // R1 addendum: the far/top and touchline edges make room for the three LED
  // walls; the near/bottom edge keeps only a smaller black-shell reveal.
  pitchInset: {
    bottom: PERIMETER_BOTTOM_SHELL_SIZE,
    left: PERIMETER_STRIP_SIZE,
    position: 'absolute',
    right: PERIMETER_STRIP_SIZE,
    top: PERIMETER_STRIP_SIZE,
  },
  // The runners' room: grass between the boards and the touchline.
  apronInset: {
    bottom: PITCH_APRON_SIZE,
    left: PITCH_APRON_SIZE,
    position: 'absolute',
    right: PITCH_APRON_SIZE,
    top: PITCH_APRON_SIZE,
  },
  // Fix #6, upgraded for R1: a visible pitch boundary (side lines + goal
  // lines) so the board reads as a pitch rather than an unbounded gradient.
  // Uses the primary chalk paint so the field's outer geometry anchors the
  // quieter secondary details at phone scale.
  pitchBoundary: {
    borderColor: CHALK_PRIMARY_COLOR,
    borderWidth: 1,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  centerLine: {
    backgroundColor: CHALK_PRIMARY_COLOR,
    height: 1,
    left: 0,
    position: 'absolute',
    right: 0,
    top: '50%',
  },
  // Fix #6: a center-circle hint (kept small/subtle) plus the center spot,
  // completing the "pitch" read without becoming a broadcast-style diagram.
  centerCircle: {
    borderColor: CHALK_PRIMARY_COLOR,
    borderRadius: 999,
    borderWidth: 1,
    height: 72,
    left: '50%',
    marginLeft: -36,
    marginTop: -36,
    position: 'absolute',
    top: '50%',
    width: 72,
  },
  centerDot: {
    backgroundColor: CHALK_PRIMARY_COLOR,
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
    borderColor: CHALK_SECONDARY_COLOR,
    borderWidth: 1,
    position: 'absolute',
  },
  penaltySpot: {
    backgroundColor: CHALK_SECONDARY_COLOR,
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
    borderColor: CHALK_SECONDARY_COLOR,
    borderRadius: 999,
    borderWidth: 1,
    left: '50%',
    position: 'absolute',
    transform: [{ translateX: '-50%' }, { translateY: '-50%' }],
  },
  // Small bracket rectangle just outside the goal line hinting at the goal
  // frame. The border color is applied per-instance in the defending team's
  // color (see GoalMouth); slightly heavier than the chalk hairlines because
  // it now carries meaning, not just structure.
  goalMouth: {
    borderWidth: 1.5,
    overflow: 'hidden',
    position: 'absolute',
  },
  // Translucent team-color wash inside the goal frame -- reads as netting.
  goalMouthNetting: {
    opacity: 0.22,
  },
  // R1: corner quarter-circle hints via the border-radius trick -- a small
  // square with only the pitch-facing corner rounded and bordered.
  cornerArc: {
    borderColor: CHALK_SECONDARY_COLOR,
    position: 'absolute',
  },
  cornerArcTopLeft: {
    borderBottomRightRadius: 999,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    left: 0,
    top: 0,
  },
  cornerArcTopRight: {
    borderBottomLeftRadius: 999,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
    right: 0,
    top: 0,
  },
  cornerArcBottomLeft: {
    borderTopRightRadius: 999,
    borderRightWidth: 1,
    borderTopWidth: 1,
    left: 0,
    bottom: 0,
  },
  cornerArcBottomRight: {
    borderTopLeftRadius: 999,
    borderLeftWidth: 1,
    borderTopWidth: 1,
    right: 0,
    bottom: 0,
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
  commentarySlot: {
    bottom: 10,
    left: 10,
    maxWidth: 310,
    pointerEvents: 'none',
    position: 'absolute',
    width: '72%',
    zIndex: 20,
  },
  commentaryInset: {
    bottom: PERIMETER_BOTTOM_SHELL_SIZE + PITCH_APRON_SIZE,
    left: PERIMETER_STRIP_SIZE + PITCH_APRON_SIZE,
    pointerEvents: 'box-none',
    position: 'absolute',
    right: PERIMETER_STRIP_SIZE + PITCH_APRON_SIZE,
    top: PERIMETER_STRIP_SIZE + PITCH_APRON_SIZE,
    zIndex: 20,
  },
  // Three-sided physical wall shell. The perspective/rotation lives here so
  // both placeholder and active creative inherit exactly the same geometry.
  perimeterWall: {
    backgroundColor: PERIMETER_PANEL_DEPTH_COLOR,
    borderColor: PERIMETER_PANEL_EDGE_COLOR,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    position: 'absolute',
  },
  perimeterWall_top: {
    height: PERIMETER_STRIP_SIZE,
    left: PERIMETER_TOP_CORNER_INSET,
    right: PERIMETER_TOP_CORNER_INSET,
    top: -2,
    transform: [
      { perspective: 420 },
      { rotateX: '-12deg' },
      { scaleX: 1.025 },
    ],
    zIndex: 4,
  },
  perimeterWall_left: {
    bottom: PERIMETER_BOTTOM_SHELL_SIZE - 1,
    left: -2,
    top: PERIMETER_STRIP_SIZE - 6,
    transform: [
      { perspective: 520 },
      { rotateY: '42deg' },
      { rotateZ: '1.1deg' },
    ],
    width: PERIMETER_STRIP_SIZE + 4,
    zIndex: 3,
  },
  perimeterWall_right: {
    bottom: PERIMETER_BOTTOM_SHELL_SIZE - 1,
    right: -2,
    top: PERIMETER_STRIP_SIZE - 6,
    transform: [
      { perspective: 520 },
      { rotateY: '-42deg' },
      { rotateZ: '-1.1deg' },
    ],
    width: PERIMETER_STRIP_SIZE + 4,
    zIndex: 3,
  },
  perimeterStripFace: {
    alignItems: 'center',
    backgroundColor: PERIMETER_PANEL_COLOR,
    bottom: 3,
    justifyContent: 'center',
    left: 3,
    overflow: 'hidden',
    position: 'absolute',
    right: 3,
    top: 2,
  },
  perimeterWallLip: {
    backgroundColor: PERIMETER_PANEL_LIP_COLOR,
    position: 'absolute',
  },
  perimeterWallLip_top: {
    bottom: 0,
    height: 3,
    left: 0,
    right: 0,
  },
  perimeterWallLip_left: {
    bottom: 0,
    right: 0,
    top: 0,
    width: 3,
  },
  perimeterWallLip_right: {
    bottom: 0,
    left: 0,
    top: 0,
    width: 3,
  },
  perimeterWallEndCap: {
    backgroundColor: '#111512',
    borderTopColor: 'rgba(236,244,238,0.16)',
    borderTopWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    height: 7,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  perimeterContentHorizontal: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  perimeterAdCreative: {
    opacity: PERIMETER_AD_CREATIVE_OPACITY,
  },
  perimeterSponsorTrackHorizontal: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: PERIMETER_SPONSOR_GAP,
  },
  perimeterSponsorTrackVertical: {
    alignItems: 'center',
    flexDirection: 'column',
    gap: PERIMETER_SPONSOR_GAP,
  },
  perimeterSponsorHorizontal: {
    alignItems: 'center',
    borderRightColor: 'rgba(255,255,255,0.08)',
    borderRightWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 6,
    height: PERIMETER_STRIP_SIZE,
    overflow: 'hidden',
    paddingHorizontal: 8,
    position: 'relative',
    width: PERIMETER_SPONSOR_WIDTH,
  },
  perimeterSponsorLogo: {
    alignItems: 'center',
    borderRadius: 3,
    borderWidth: 1,
    height: 15,
    justifyContent: 'center',
    width: 15,
    zIndex: 2,
  },
  perimeterSponsorLogoImageShell: {
    backgroundColor: 'rgba(0,0,0,0.18)',
    borderColor: 'transparent',
    borderWidth: 0,
  },
  perimeterSponsorLogoText: {
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: -0.3,
    lineHeight: 9,
  },
  perimeterSponsorName: {
    color: '#F7FBF8',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.1,
    lineHeight: 12,
    textShadowColor: 'rgba(0,0,0,0.72)',
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 2,
    zIndex: 2,
  },
  perimeterSponsorStrapline: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 6,
    fontWeight: '700',
    letterSpacing: 0.9,
    lineHeight: 8,
    textShadowColor: 'rgba(0,0,0,0.72)',
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 2,
    zIndex: 2,
  },
  perimeterSponsorSide: {
    alignItems: 'center',
    borderBottomColor: 'rgba(255,255,255,0.07)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    height: PERIMETER_SPONSOR_MARK_HEIGHT,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    width: PERIMETER_STRIP_SIZE,
  },
  perimeterSponsorSideCreative: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    height: 22,
    justifyContent: 'center',
    width: 64,
    zIndex: 2,
  },
  perimeterSponsorSideCreative_left: {
    transform: [{ rotateZ: '-90deg' }],
  },
  perimeterSponsorSideCreative_right: {
    transform: [{ rotateZ: '90deg' }],
  },
  perimeterSponsorSideMark: {
    alignItems: 'center',
    borderRadius: 3,
    borderWidth: 1,
    height: 16,
    justifyContent: 'center',
    width: 16,
  },
  perimeterSponsorSideText: {
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: -0.4,
    lineHeight: 9,
  },
  perimeterSponsorSideName: {
    color: '#F7FBF8',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.8,
    lineHeight: 10,
    textShadowColor: 'rgba(0,0,0,0.72)',
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 2,
  },
  perimeterBrandGlow: {
    borderRadius: 999,
    height: 54,
    left: -16,
    opacity: 0.14,
    position: 'absolute',
    top: -19,
    width: 76,
  },
  perimeterBrandStripe: {
    height: 10,
    opacity: 0.16,
    position: 'absolute',
    right: -12,
    top: 7,
    transform: [{ rotateZ: '-18deg' }],
    width: 76,
  },
  perimeterBrandScanline: {
    backgroundColor: 'rgba(255,255,255,0.055)',
    height: StyleSheet.hairlineWidth,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  perimeterBrandScanline_top: {
    top: '34%',
  },
  perimeterBrandScanline_bottom: {
    top: '68%',
  },
  perimeterLedColumn: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'space-evenly',
  },
  // Sized for the deeper approved walls: dashes and wordmark scale with the
  // face so the LED panels read as real stadium furniture, not trim.
  perimeterLedDash: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 1.5,
    height: 16,
    width: 3,
  },
  perimeterText: {
    color: tokens.shell.textDim,
    fontSize: 13,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 3,
    marginHorizontal: tokens.spacing.lg,
    marginVertical: tokens.spacing.lg,
    opacity: 0.34,
    textTransform: 'uppercase',
  },
});
