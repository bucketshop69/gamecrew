import {
  type GameCrewMatch,
  type MatchPulseCommentaryEntry,
  gameCrewTokens,
  getMatchTitle,
} from '@gamecrew/core';
import { StatusBar } from 'expo-status-bar';
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Carousel from 'react-native-reanimated-carousel';
import {
  AccessibilityInfo,
  Animated,
  findNodeHandle,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useGameCrewMatches } from '../hooks/use-gamecrew-matches';
import { useMatchPulse } from '../hooks/use-match-pulse';
import { GameViewDebugToggle } from './game-view-debug-panel';
import {
  partitionHomeMatches,
  resolveHomeSection,
  type HomeSection,
} from './home-screen-state';
import {
  type GameViewPresentationState,
  MatchPreviewScreen,
} from './match-preview-screen';

const tokens = gameCrewTokens;

type PulseTone = 'major' | 'danger' | 'building' | 'quiet';
type MatchDetailMode = 'pulse' | 'game';

interface PulseFeedItem {
  id: string;
  minute: string;
  title: string;
  meta: string;
  tone: PulseTone;
}

interface PendingHomeJump {
  section: HomeSection;
  timeoutId?: ReturnType<typeof setTimeout>;
}

const HOME_HEADER_HEIGHT = 44;
const HOME_CAROUSEL_CHROME_HEIGHT = 24;
const HOME_CONTEXT_CONTROL_CLEARANCE = 72;
const HOME_JUMP_FALLBACK_MS = 900;
const HOME_RECENT_SECTION_TOP_PADDING = 48;

export function HomeScreen({ onOpenMatch }: { onOpenMatch: (match: GameCrewMatch) => void }) {
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeSection, setActiveSection] = useState<HomeSection>('featured');
  const [jumpInProgress, setJumpInProgress] = useState(false);
  const { loadState, reload } = useGameCrewMatches();
  const reduceMotion = useReducedMotionPreference();
  const scrollRef = useRef<ScrollView>(null);
  const featuredFocusRef = useRef<View>(null);
  const recentHeadingRef = useRef<View>(null);
  const recentSectionYRef = useRef<number | null>(null);
  const activeSectionRef = useRef<HomeSection>('featured');
  const pendingJumpRef = useRef<PendingHomeJump | null>(null);
  const { featuredMatches, recentMatches } = useMemo(
    () => partitionHomeMatches(loadState.matches),
    [loadState.matches],
  );
  const carouselWidth = Math.max(1, width - tokens.spacing.lg * 2);
  const usableContentHeight = Math.max(
    500,
    height - insets.top - insets.bottom - HOME_HEADER_HEIGHT - tokens.spacing.lg * 2,
  );
  const featuredSurfaceHeight = Math.max(440, Math.round(usableContentHeight * 0.9));
  const carouselHeight = Math.max(420, featuredSurfaceHeight - HOME_CAROUSEL_CHROME_HEIGHT);
  const recentSectionMinHeight = Math.max(360, height - insets.top - insets.bottom);

  useEffect(() => {
    setActiveIndex((current) =>
      featuredMatches.length === 0 ? 0 : Math.min(current, featuredMatches.length - 1),
    );
  }, [featuredMatches.length]);

  useEffect(() => () => {
    const pendingJump = pendingJumpRef.current;
    if (pendingJump?.timeoutId) clearTimeout(pendingJump.timeoutId);
  }, []);

  const activeMatch = featuredMatches[activeIndex] ?? featuredMatches[0];

  const updateActiveSection = useCallback((section: HomeSection) => {
    if (activeSectionRef.current === section) return;
    activeSectionRef.current = section;
    setActiveSection(section);
  }, []);

  const focusHomeDestination = useCallback((section: HomeSection) => {
    const destination = section === 'recent' ? recentHeadingRef.current : featuredFocusRef.current;
    if (Platform.OS === 'web') {
      (destination as unknown as { focus?: () => void } | null)?.focus?.();
      return;
    }

    const node = destination ? findNodeHandle(destination) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, []);

  const finishPendingJump = useCallback((section: HomeSection) => {
    const pendingJump = pendingJumpRef.current;
    if (!pendingJump || pendingJump.section !== section) return;

    if (pendingJump.timeoutId) clearTimeout(pendingJump.timeoutId);
    pendingJumpRef.current = null;
    setJumpInProgress(false);
    updateActiveSection(section);

    requestAnimationFrame(() => focusHomeDestination(section));
  }, [focusHomeDestination, updateActiveSection]);

  const cancelPendingJump = useCallback(() => {
    const pendingJump = pendingJumpRef.current;
    if (pendingJump?.timeoutId) clearTimeout(pendingJump.timeoutId);
    pendingJumpRef.current = null;
    setJumpInProgress(false);
  }, []);

  useEffect(() => {
    if (recentMatches.length > 0) return;
    recentSectionYRef.current = null;
    cancelPendingJump();
    updateActiveSection('featured');
  }, [cancelPendingJump, recentMatches.length, updateActiveSection]);

  const jumpToSection = useCallback(() => {
    if (pendingJumpRef.current) return;

    const destination: HomeSection = activeSectionRef.current === 'featured' ? 'recent' : 'featured';
    const recentSectionY = recentSectionYRef.current;
    if (destination === 'recent' && recentSectionY === null) return;

    const targetY = destination === 'recent'
      ? Math.max(
          0,
          (recentSectionY ?? 0) + HOME_RECENT_SECTION_TOP_PADDING - insets.top - tokens.spacing.sm,
        )
      : 0;

    const pendingJump: PendingHomeJump = { section: destination };
    pendingJumpRef.current = pendingJump;
    setJumpInProgress(true);
    scrollRef.current?.scrollTo({ y: targetY, animated: !reduceMotion });

    if (reduceMotion) {
      requestAnimationFrame(() => finishPendingJump(destination));
      return;
    }

    pendingJump.timeoutId = setTimeout(
      () => finishPendingJump(destination),
      HOME_JUMP_FALLBACK_MS,
    );
  }, [finishPendingJump, insets.top, reduceMotion]);

  const handleHomeScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const recentSectionY = recentSectionYRef.current;
    if (recentSectionY === null) return;

    const boundaryY = Math.max(
      0,
      recentSectionY + HOME_RECENT_SECTION_TOP_PADDING - Math.min(height * 0.35, 240),
    );
    const nextSection = resolveHomeSection(
      activeSectionRef.current,
      event.nativeEvent.contentOffset.y,
      boundaryY,
    );
    updateActiveSection(nextSection);
  }, [height, updateActiveSection]);

  const handleRecentSectionLayout = useCallback((event: LayoutChangeEvent) => {
    recentSectionYRef.current = event.nativeEvent.layout.y;
  }, []);

  const handleMomentumScrollEnd = useCallback(() => {
    const pendingJump = pendingJumpRef.current;
    if (pendingJump) finishPendingJump(pendingJump.section);
  }, [finishPendingJump]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.homeContent,
          {
            paddingBottom: insets.bottom + HOME_CONTEXT_CONTROL_CLEARANCE,
            paddingTop: insets.top + tokens.spacing.lg,
          },
        ]}
        contentInsetAdjustmentBehavior="never"
        onMomentumScrollEnd={handleMomentumScrollEnd}
        onScroll={handleHomeScroll}
        onScrollBeginDrag={cancelPendingJump}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        style={styles.homeScroll}
      >
        <HomeHeader />

        {loadState.status === 'error' && loadState.matches.length > 0 ? (
          <StateMessage
            eyebrow="Last update failed"
            title="Showing the latest match list we have."
            body="Retry when the local GameCrew API is back online."
            actionLabel="Retry"
            compact
            onAction={reload}
          />
        ) : null}

        <View style={[styles.featuredSection, { minHeight: featuredSurfaceHeight }]}>
          {loadState.status === 'loading' && loadState.matches.length === 0 ? (
            <PosterSkeleton height={carouselHeight} />
          ) : loadState.status === 'error' && loadState.matches.length === 0 ? (
            <StateMessage
              eyebrow="GameCrew unavailable"
              title="Could not load matches."
              body={getErrorCopy(loadState.message)}
              actionLabel="Retry"
              onAction={reload}
            />
          ) : activeMatch ? (
            <View style={styles.carousel}>
              <Carousel
                data={featuredMatches}
                enabled={featuredMatches.length > 1}
                height={carouselHeight}
                loop={false}
                onConfigurePanGesture={(gesture) => {
                  const panGesture = gesture as unknown as {
                    activeOffsetX(offset: [number, number]): void;
                    failOffsetY(offset: [number, number]): void;
                  };
                  panGesture.activeOffsetX([-8, 8]);
                  panGesture.failOffsetY([-28, 28]);
                }}
                onSnapToItem={setActiveIndex}
                overscrollEnabled={false}
                pagingEnabled
                renderItem={({ index, item }) => (
                  <View style={styles.carouselPage}>
                    <MatchPoster
                      focusRef={index === activeIndex ? featuredFocusRef : undefined}
                      height={carouselHeight}
                      match={item}
                      onPress={() => onOpenMatch(item)}
                    />
                  </View>
                )}
                windowSize={3}
                width={carouselWidth}
              />
              {featuredMatches.length > 1 ? (
                <CarouselDots activeIndex={activeIndex} count={featuredMatches.length} />
              ) : null}
            </View>
          ) : (
            <StateMessage
              eyebrow={recentMatches.length > 0 ? 'Between fixtures' : 'No fixtures'}
              title={recentMatches.length > 0 ? 'No live or upcoming match right now.' : 'No matches found.'}
              body={recentMatches.length > 0
                ? 'Recent final scores are available below.'
                : 'Refresh the GameCrew feed to check for available fixtures.'}
              actionLabel="Refresh"
              onAction={reload}
            />
          )}
        </View>

        {recentMatches.length > 0 ? (
          <RecentGamesSection
            headingRef={recentHeadingRef}
            matches={recentMatches}
            minHeight={recentSectionMinHeight}
            onLayout={handleRecentSectionLayout}
            onOpenMatch={onOpenMatch}
          />
        ) : null}
      </ScrollView>

      {recentMatches.length > 0 ? (
        <HomeContextControl
          bottomInset={insets.bottom}
          disabled={jumpInProgress}
          onPress={jumpToSection}
          reduceMotion={reduceMotion}
          section={activeSection}
        />
      ) : null}
    </View>
  );
}

function RecentGamesSection({
  headingRef,
  matches,
  minHeight,
  onLayout,
  onOpenMatch,
}: {
  headingRef: RefObject<View | null>;
  matches: readonly GameCrewMatch[];
  minHeight: number;
  onLayout: (event: LayoutChangeEvent) => void;
  onOpenMatch: (match: GameCrewMatch) => void;
}) {
  return (
    <View onLayout={onLayout} style={[styles.recentSection, { minHeight }]}>
      <View
        ref={headingRef}
        accessible
        accessibilityRole="header"
        tabIndex={-1}
      >
        <Text style={styles.recentHeading}>RECENT GAMES</Text>
      </View>

      <View style={styles.recentGrid}>
        {matches.map((match) => (
          <RecentMatchTile
            key={match.txline.fixtureId}
            match={match}
            onPress={() => onOpenMatch(match)}
          />
        ))}
      </View>
    </View>
  );
}

function RecentMatchTile({
  match,
  onPress,
}: {
  match: GameCrewMatch;
  onPress: () => void;
}) {
  const scoreLabel = match.score ? `${match.score.home} - ${match.score.away}` : 'FT';
  const label = match.score
    ? `${getMatchTitle(match)}, final score ${match.score.home} to ${match.score.away}`
    : `${getMatchTitle(match)}, final`;

  return (
    <Pressable
      accessibilityHint="Opens the completed match"
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.recentMatch, pressed && styles.recentMatchPressed]}
    >
      <View style={styles.recentTeams}>
        <View style={styles.recentTeam}>
          <StaticFlag
            bands={match.homeTeam.flag.bands}
            countryCode={match.homeTeam.countryCode}
            size="recent"
          />
          <Text numberOfLines={2} selectable style={styles.recentTeamName}>
            {match.homeTeam.name}
          </Text>
        </View>
        <View style={styles.recentTeam}>
          <StaticFlag
            bands={match.awayTeam.flag.bands}
            countryCode={match.awayTeam.countryCode}
            size="recent"
          />
          <Text numberOfLines={2} selectable style={styles.recentTeamName}>
            {match.awayTeam.name}
          </Text>
        </View>
      </View>
      <Text selectable style={styles.recentScore}>
        {scoreLabel}
      </Text>
      <Text selectable style={styles.recentMeta}>
        {formatRecentMatchTime(match.kickoffUtc)}
      </Text>
    </Pressable>
  );
}

function HomeContextControl({
  bottomInset,
  disabled,
  onPress,
  reduceMotion,
  section,
}: {
  bottomInset: number;
  disabled: boolean;
  onPress: () => void;
  reduceMotion: boolean;
  section: HomeSection;
}) {
  const appearance = useRef(new Animated.Value(1)).current;
  const targetsRecent = section === 'featured';

  useEffect(() => {
    appearance.stopAnimation();
    if (reduceMotion) {
      appearance.setValue(1);
      return;
    }

    appearance.setValue(0);
    Animated.timing(appearance, {
      duration: 180,
      toValue: 1,
      useNativeDriver: true,
    }).start();
  }, [appearance, reduceMotion, section]);

  return (
    <Pressable
      accessibilityLabel={targetsRecent
        ? 'Go down to recent games'
        : 'Go up to live and upcoming matches'}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={[
        styles.homeContextControl,
        { bottom: bottomInset + tokens.spacing.sm },
        disabled && styles.homeContextControlDisabled,
      ]}
    >
      <Animated.Text
        style={[
          styles.homeContextText,
          {
            opacity: appearance,
            transform: [{
              translateY: appearance.interpolate({
                inputRange: [0, 1],
                outputRange: [3, 0],
              }),
            }],
          },
        ]}
      >
        {targetsRecent ? 'RECENT GAMES ↓' : 'LIVE & UPCOMING ↑'}
      </Animated.Text>
    </Pressable>
  );
}

function useReducedMotionPreference(): boolean {
  const [reduceMotion, setReduceMotion] = useState(true);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion,
    );

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}

function HomeHeader() {
  return (
    <View style={styles.header}>
      <View style={styles.headerSide} />
      <Text style={styles.wordmark} selectable>
        GameCrew
      </Text>
      <Pressable accessibilityRole="button" style={styles.accountButton}>
        <Text style={styles.accountText}>GC</Text>
      </Pressable>
    </View>
  );
}

function MatchPoster({
  focusRef,
  height,
  match,
  onPress,
}: {
  focusRef?: RefObject<View | null>;
  height?: number;
  match: GameCrewMatch;
  onPress: () => void;
}) {
  const { width } = useWindowDimensions();
  const posterMinHeight = Math.max(430, Math.min(560, width * 1.2));
  const homeBands = match.homeTeam.flag.bands;
  const awayBands = match.awayTeam.flag.bands;
  const isUpcoming = match.status === 'upcoming' && !match.score;
  const compact = (height ?? posterMinHeight) < 520;

  return (
    <Pressable
      ref={focusRef}
      accessibilityRole="button"
      accessibilityLabel={`Open ${getMatchTitle(match)}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.poster,
        { height, minHeight: height ?? posterMinHeight, opacity: pressed ? 0.92 : 1 },
      ]}
    >
      <View style={styles.posterBackdrop} />

      <View style={[styles.posterChrome, compact && styles.posterChromeCompact]}>
        {isUpcoming ? (
          <UpcomingPosterContent
            compact={compact}
            match={match}
          />
        ) : (
          <LivePosterContent
            awayBands={awayBands}
            compact={compact}
            homeBands={homeBands}
            match={match}
          />
        )}
      </View>
    </Pressable>
  );
}

function LivePosterContent({
  awayBands,
  compact,
  homeBands,
  match,
}: {
  awayBands: readonly string[];
  compact: boolean;
  homeBands: readonly string[];
  match: GameCrewMatch;
}) {
  return (
    <View style={[styles.posterStack, compact && styles.posterStackCompact]}>
      <FlagMark
        bands={homeBands}
        compact={compact}
        countryCode={match.homeTeam.countryCode}
      />
      <Text style={[styles.teamScoreText, compact && styles.teamScoreTextCompact]} selectable>
        {getTeamCardLabel(match, 'home')}
      </Text>
      <Text style={[styles.clockText, compact && styles.clockTextCompact]} selectable>
        {getClockCardLabel(match)}
      </Text>
      <Text style={styles.matchupText} selectable>
        {getMatchTitle(match)}
      </Text>
      <Text numberOfLines={2} style={styles.competitionText} selectable>
        {getMetaLabel(match)}
      </Text>
      <Text style={[styles.teamScoreText, compact && styles.teamScoreTextCompact]} selectable>
        {getTeamCardLabel(match, 'away')}
      </Text>
      <FlagMark
        bands={awayBands}
        compact={compact}
        countryCode={match.awayTeam.countryCode}
      />
    </View>
  );
}

function UpcomingPosterContent({
  compact,
  match,
}: {
  compact: boolean;
  match: GameCrewMatch;
}) {
  return (
    <View style={[styles.posterStack, compact && styles.posterStackCompact]}>
      <FlagMark
        bands={match.homeTeam.flag.bands}
        compact={compact}
        countryCode={match.homeTeam.countryCode}
      />
      <Text style={styles.kickoffDateText} selectable>
        {formatKickoffDate(match.kickoffUtc)}
      </Text>
      <Text style={[styles.kickoffTimeText, compact && styles.kickoffTimeTextCompact]} selectable>
        {formatKickoffTime(match.kickoffUtc)}
      </Text>
      <Text style={styles.matchupText} selectable>
        {getMatchTitle(match)}
      </Text>
      <Text numberOfLines={2} style={styles.competitionText} selectable>
        {getMetaLabel(match)}
      </Text>
      <FlagMark
        bands={match.awayTeam.flag.bands}
        compact={compact}
        countryCode={match.awayTeam.countryCode}
      />
    </View>
  );
}

function CarouselDots({ activeIndex, count }: { activeIndex: number; count: number }) {
  const dotCount = Math.min(3, Math.max(1, count));

  return (
    <View style={styles.carouselDots}>
      {Array.from({ length: dotCount }).map((_, index) => (
        <View
          key={index}
          style={[
            styles.carouselDot,
            index === Math.min(activeIndex, dotCount - 1) && styles.carouselDotActive,
          ]}
        />
      ))}
    </View>
  );
}

function FlagField({ bands, align }: { bands: readonly string[]; align: 'left' | 'right' }) {
  return (
    <View style={[styles.flagField, align === 'left' ? styles.flagLeft : styles.flagRight]}>
      {bands.map((band, index) => (
        <View key={`${band}-${index}`} style={[styles.flagBand, { backgroundColor: band }]} />
      ))}
    </View>
  );
}

function FlagMark({
  bands,
  compact,
  countryCode,
}: {
  bands: readonly string[];
  compact: boolean;
  countryCode?: string;
}) {
  return (
    <StaticFlag
      bands={bands}
      compact={compact}
      countryCode={countryCode}
      size="poster"
    />
  );
}

function StaticFlag({
  bands,
  compact = false,
  countryCode,
  size,
}: {
  bands: readonly string[];
  compact?: boolean;
  countryCode?: string;
  size: 'poster' | 'recent';
}) {
  return (
    <View
      style={[
        size === 'poster' ? styles.flagMark : styles.recentFlag,
        size === 'poster' && compact && styles.flagMarkCompact,
        getFlagDirection(countryCode) === 'horizontal' && styles.flagMarkHorizontal,
      ]}
    >
      {bands.map((band, index) => (
        <View key={`${band}-${index}`} style={[styles.flagMarkBand, { backgroundColor: band }]} />
      ))}
    </View>
  );
}

function PosterSkeleton({ height }: { height?: number }) {
  return (
    <View style={[styles.skeletonPoster, height ? { minHeight: height } : undefined]}>
      <View style={[styles.skeletonGlow, styles.skeletonGlowTop]} />
      <View style={[styles.skeletonGlow, styles.skeletonGlowBottom]} />
      <View style={styles.skeletonFlag} />
      <View style={styles.skeletonLineSmall} />
      <View style={styles.skeletonScore} />
      <View style={styles.skeletonLineLarge} />
      <View style={styles.skeletonFlag} />
    </View>
  );
}

function StateMessage({
  eyebrow,
  title,
  body,
  actionLabel,
  compact,
  onAction,
}: {
  eyebrow?: string;
  title: string;
  body?: string;
  actionLabel: string;
  compact?: boolean;
  onAction: () => void;
}) {
  return (
    <View style={[styles.stateMessage, compact && styles.stateMessageCompact]}>
      {eyebrow ? (
        <Text style={styles.stateEyebrow} selectable>
          {eyebrow}
        </Text>
      ) : null}
      <Text style={styles.stateTitle} selectable>
        {title}
      </Text>
      {body ? (
        <Text style={styles.stateBody} selectable>
          {body}
        </Text>
      ) : null}
      <Pressable accessibilityRole="button" onPress={onAction} style={styles.stateAction}>
        <Text style={styles.stateActionText}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

export function MatchDetailScreen({
  match,
  onBack,
}: {
  match: GameCrewMatch;
  onBack: () => void;
}) {
  const [activeMode, setActiveMode] = useState<MatchDetailMode>('pulse');
  const [gamePresentation, setGamePresentation] = useState<GameViewPresentationState | null>(null);
  const { pulseLoadState, reload } = useMatchPulse(
    match.txline.fixtureId,
    match.status === 'live',
  );
  const pulseItems = getPulseFeedItems(pulseLoadState.entries);
  const visibleGamePresentation = activeMode === 'game' ? gamePresentation : null;

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.detailScreen}>
      <StatusBar style="light" />
      <View style={styles.detailFixed}>
        <View style={styles.detailUtilityRow}>
          <Pressable accessibilityRole="button" onPress={onBack} style={styles.backButton}>
            <Text style={styles.backButtonText}>Back</Text>
          </Pressable>
          <Text numberOfLines={1} style={styles.detailCompetition}>
            {match.competition}
          </Text>
        </View>

        <View style={styles.detailHeader}>
          <DetailTeamScore
            align="left"
            bands={match.homeTeam.flag.bands}
            countryCode={match.homeTeam.countryCode}
            name={match.homeTeam.name}
            score={visibleGamePresentation
              ? String(visibleGamePresentation.score.home)
              : getDetailScoreLabel(match, 'home')}
          />

          <DetailMatchClock match={match} presentation={visibleGamePresentation} />

          <DetailTeamScore
            align="right"
            bands={match.awayTeam.flag.bands}
            countryCode={match.awayTeam.countryCode}
            name={match.awayTeam.name}
            score={visibleGamePresentation
              ? String(visibleGamePresentation.score.away)
              : getDetailScoreLabel(match, 'away')}
          />
        </View>

        <View style={styles.detailTabs} accessibilityRole="tablist">
          <Pressable
            accessibilityLabel="Show Match Pulse"
            accessibilityRole="tab"
            accessibilityState={{ selected: activeMode === 'pulse' }}
            onPress={() => setActiveMode('pulse')}
            style={({ pressed }) => [
              styles.detailTab,
              activeMode === 'pulse' && styles.detailTabSelected,
              pressed && styles.detailTabPressed,
            ]}
          >
            <Text style={activeMode === 'pulse'
              ? styles.detailTabSelectedText
              : styles.detailTabText}
            >
              Match Pulse
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Show Game View"
            accessibilityRole="tab"
            accessibilityState={{ selected: activeMode === 'game' }}
            onPress={() => setActiveMode('game')}
            style={({ pressed }) => [
              styles.detailTab,
              activeMode === 'game' && styles.detailTabSelected,
              pressed && styles.detailTabPressed,
            ]}
          >
            <Text style={activeMode === 'game'
              ? styles.detailTabSelectedText
              : styles.detailTabText}
            >
              Game View
            </Text>
          </Pressable>
        </View>
      </View>

      {activeMode === 'pulse' ? (
        <ScrollView
          style={styles.pulseScroll}
          contentContainerStyle={styles.pulseStack}
          contentInsetAdjustmentBehavior="automatic"
        >
          {pulseLoadState.status === 'loading' && pulseItems.length === 0 ? (
            <PulseStatePanel title="Loading Match Pulse" body="Loading the saved match story." />
          ) : pulseLoadState.status === 'error' && pulseItems.length === 0 ? (
            <PulseStatePanel
              title="Match Pulse unavailable"
              body={getPulseErrorCopy(pulseLoadState.message)}
              actionLabel="Retry"
              onAction={reload}
            />
          ) : pulseItems.length === 0 ? (
            <PulseStatePanel
              title={match.status === 'live' ? 'No match updates yet' : 'No saved Match Pulse yet'}
              body={match.status === 'live'
                ? 'The match story will appear here as moments are confirmed.'
                : 'Refresh to check whether this completed match has been added to the archive.'}
              actionLabel="Refresh"
              onAction={reload}
            />
          ) : (
            <>
              {pulseLoadState.status === 'error' ? (
                <PulseStatePanel
                  title="Latest update unavailable"
                  body="Showing the saved Match Pulse timeline. Try again shortly for the latest moments."
                  actionLabel="Retry"
                  onAction={reload}
                />
              ) : null}
              {pulseItems.map((item) => <PulseMomentRow key={item.id} item={item} />)}
            </>
          )}
        </ScrollView>
      ) : (
        <View style={styles.gameViewContent}>
          <MatchPreviewScreen match={match} onPresentationChange={setGamePresentation} />
          {__DEV__ ? (
            <GameViewDebugToggle fixtureId={match.txline.fixtureId} isLive={match.status === 'live'} />
          ) : null}
        </View>
      )}
    </SafeAreaView>
  );
}

export function MatchDetailStateScreen({
  actionLabel,
  body,
  eyebrow,
  onAction,
  onBack,
  title,
}: {
  actionLabel: string;
  body?: string;
  eyebrow?: string;
  onAction: () => void;
  onBack: () => void;
  title: string;
}) {
  return (
    <View style={[styles.detailScreen, styles.detailStateScreen]}>
      <StatusBar style="light" />
      <Pressable accessibilityRole="button" onPress={onBack} style={styles.backButton}>
        <Text style={styles.backButtonText}>Back</Text>
      </Pressable>
      <StateMessage
        actionLabel={actionLabel}
        body={body}
        eyebrow={eyebrow}
        onAction={onAction}
        title={title}
      />
    </View>
  );
}

function PulseMomentRow({ item }: { item: PulseFeedItem }) {
  return (
    <View style={[styles.pulseMoment, getPulseToneStyle(item.tone)]}>
      <Text style={styles.pulseMinute} selectable>
        {item.minute}
      </Text>
      <View style={styles.pulseCopy}>
        <View style={styles.pulseMomentHeader}>
          <Text style={styles.pulseMomentTitle} selectable>
            {item.title}
          </Text>
        </View>
        <Text style={styles.pulseBody} selectable>
          {item.meta}
        </Text>
      </View>
    </View>
  );
}

function PulseStatePanel({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.pulseStatePanel}>
      <Text style={styles.pulseStateTitle} selectable>
        {title}
      </Text>
      <Text style={styles.pulseBody} selectable>
        {body}
      </Text>
      {actionLabel && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} style={styles.pulseStateAction}>
          <Text style={styles.pulseStateActionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function DetailTeamScore({
  align,
  bands,
  countryCode,
  name,
  score,
}: {
  align: 'left' | 'right';
  bands: readonly string[];
  countryCode?: string;
  name: string;
  score: string;
}) {
  const team = (
    <View style={styles.detailTeamIdentity}>
      <MiniFlag bands={bands} countryCode={countryCode} />
      <Text
        adjustsFontSizeToFit
        ellipsizeMode="tail"
        minimumFontScale={0.78}
        numberOfLines={1}
        selectable
        style={styles.detailTeamName}
      >
        {name}
      </Text>
    </View>
  );

  return (
    <View style={[styles.detailTeamColumn, align === 'right' && styles.detailTeamColumnRight]}>
      {align === 'left' ? team : null}
      {score ? (
        <Text selectable style={styles.detailTeamScore}>
          {score}
        </Text>
      ) : null}
      {align === 'right' ? team : null}
    </View>
  );
}

function DetailMatchClock({
  match,
  presentation,
}: {
  match: GameCrewMatch;
  presentation?: GameViewPresentationState | null;
}) {
  if (presentation) {
    return (
      <View style={styles.detailCenterColumn}>
        <Text numberOfLines={1} selectable style={styles.detailClock}>
          {presentation.clockLabel}
        </Text>
        <Text numberOfLines={1} selectable style={styles.detailPhase}>
          {presentation.phaseLabel}
        </Text>
      </View>
    );
  }

  const isScheduled = match.status === 'upcoming' || match.status === 'hosted';

  if (isScheduled) {
    return (
      <View style={styles.detailCenterColumn}>
        <Text numberOfLines={1} selectable style={styles.detailKickoffDate}>
          {formatKickoffDate(match.kickoffUtc).toUpperCase()}
        </Text>
        <Text
          adjustsFontSizeToFit
          minimumFontScale={0.82}
          numberOfLines={1}
          selectable
          style={styles.detailClock}
        >
          {formatKickoffTime(match.kickoffUtc)}
        </Text>
        {match.status === 'hosted' ? (
          <Text numberOfLines={1} selectable style={styles.detailPhase}>
            Hosted match
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.detailCenterColumn}>
      <Text numberOfLines={1} selectable style={styles.detailClock}>
        {getClockCardLabel(match)}
      </Text>
      <Text numberOfLines={1} selectable style={styles.detailPhase}>
        {getCompactMatchPhaseLabel(match)}
      </Text>
    </View>
  );
}

function MiniFlag({ bands, countryCode }: { bands: readonly string[]; countryCode?: string }) {
  return (
    <View style={[styles.miniFlag, getFlagDirection(countryCode) === 'horizontal' && styles.miniFlagHorizontal]}>
      {bands.map((band, index) => (
        <View key={`${band}-${index}`} style={[styles.flagMarkBand, { backgroundColor: band }]} />
      ))}
    </View>
  );
}

function getMetaLabel(match: GameCrewMatch): string {
  if (!match.round || match.round === match.competition) {
    return match.competition;
  }

  return `${match.competition} - ${match.round}`;
}

function getTeamCardLabel(match: GameCrewMatch, side: 'home' | 'away'): string {
  if (match.score) {
    return String(side === 'home' ? match.score.home : match.score.away);
  }

  if (match.status === 'live') {
    return '-';
  }

  return side === 'home' ? match.homeTeam.shortName : match.awayTeam.shortName;
}

function getDetailScoreLabel(
  match: GameCrewMatch,
  side: 'home' | 'away',
): string {
  if (!match.score) {
    if (match.status === 'upcoming' || match.status === 'hosted') return '';
    return '-';
  }

  const score = side === 'home' ? match.score.home : match.score.away;
  return String(score);
}

function getCompactMatchPhaseLabel(match: GameCrewMatch): string {
  if (match.status === 'live') {
    if (match.clock.phase === 'half_time') return 'Half time';
    if (match.clock.phase === 'extra_time') return 'Extra time';
    return 'In play';
  }

  if (match.status === 'finished' || match.status === 'replayable') return 'Full time';
  if (match.status === 'hosted') return 'Hosted match';
  return '';
}

function getPulseFeedItems(
  entries: readonly MatchPulseCommentaryEntry[],
): readonly PulseFeedItem[] {
  return [...entries]
    .sort(compareCommentaryNewestFirst)
    .map((entry) => ({
      id: entry.id,
      minute: entry.clock.label,
      title: entry.commentary,
      meta: getPulseEntryMeta(entry),
      tone: entry.intensity,
    }));
}

function compareCommentaryNewestFirst(
  left: MatchPulseCommentaryEntry,
  right: MatchPulseCommentaryEntry,
): number {
  const leftSequence = left.sortSeq ?? left.toSeq ?? left.fromSeq;
  const rightSequence = right.sortSeq ?? right.toSeq ?? right.fromSeq;

  if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
    return rightSequence - leftSequence;
  }

  if (left.sortTimestamp && right.sortTimestamp) {
    return right.sortTimestamp.localeCompare(left.sortTimestamp);
  }

  return right.id.localeCompare(left.id);
}

function getPulseEntryMeta(entry: MatchPulseCommentaryEntry): string {
  const team = entry.team?.shortName ?? entry.team?.name;
  const confirmed = entry.confidence === 'verified' ? 'Confirmed' : undefined;
  return [team, getPulseKindLabel(entry.kind), confirmed].filter(Boolean).join(' · ');
}

function getPulseKindLabel(kind: MatchPulseCommentaryEntry['kind']): string {
  if (kind === 'goal') return 'Goal';
  if (kind === 'card') return 'Card';
  if (kind === 'pressure' || kind === 'danger') return 'Pressure';
  if (kind === 'shot') return 'Attempt';
  if (kind === 'corner') return 'Corner';
  if (kind === 'free_kick' || kind === 'set_piece') return 'Set piece';
  if (kind === 'substitution') return 'Substitution';
  if (kind === 'var') return 'VAR';
  if (kind === 'phase_change') return 'Match phase';
  return 'Match update';
}

function getPulseToneStyle(tone: PulseTone) {
  if (tone === 'major') {
    return styles.pulseMomentMajor;
  }

  if (tone === 'danger') {
    return styles.pulseMomentDanger;
  }

  if (tone === 'building') {
    return styles.pulseMomentBuilding;
  }

  return styles.pulseMomentQuiet;
}

function getClockCardLabel(match: GameCrewMatch): string {
  if (match.status === 'live') {
    if (match.clock.phase === 'half_time') {
      return 'HT';
    }

    return match.clock.minute ? `${match.clock.minute}'` : match.clock.label;
  }

  if (match.status === 'replayable' || match.status === 'finished') {
    return 'FT';
  }

  return formatKickoff(match.kickoffUtc);
}

function formatKickoff(kickoffUtc: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(kickoffUtc));
}

function formatKickoffDate(kickoffUtc: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(kickoffUtc));
}

function formatKickoffTime(kickoffUtc: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(kickoffUtc));
}

function formatRecentMatchTime(kickoffUtc: string): string {
  const kickoff = new Date(kickoffUtc);
  const date = new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
  }).format(kickoff).replace(',', '').toUpperCase();
  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(kickoff);

  return `${date} · ${time}`;
}

function getFlagDirection(countryCode?: string): 'horizontal' | 'vertical' {
  return horizontalFlagCodes.has(countryCode ?? '') ? 'horizontal' : 'vertical';
}

const horizontalFlagCodes = new Set(['AR', 'CO', 'DE', 'EC', 'NL', 'SN']);

function getErrorCopy(message: string): string {
  if (message.includes('Network request failed') || message.includes('Failed to fetch')) {
    return 'Check your connection, then try again.';
  }

  return 'Match data could not be loaded right now.';
}

function getPulseErrorCopy(message: string): string {
  if (message.includes('Network request failed') || message.includes('Failed to fetch')) {
    return 'Check your connection, then retry Match Pulse.';
  }

  return 'The saved Match Pulse timeline could not be loaded.';
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: tokens.shell.background,
  },
  homeScroll: {
    flex: 1,
  },
  homeContent: {
    flexGrow: 1,
    gap: tokens.spacing.lg,
    paddingHorizontal: tokens.spacing.lg,
  },
  featuredSection: {
    justifyContent: 'flex-start',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  headerSide: {
    width: 40,
  },
  wordmark: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 0,
    lineHeight: tokens.typography.lineHeight.body,
  },
  accountButton: {
    alignItems: 'center',
    backgroundColor: tokens.shell.text,
    borderRadius: tokens.radii.pill,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  accountText: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  poster: {
    borderRadius: tokens.radii.lg,
    overflow: 'hidden',
  },
  posterBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: tokens.shell.background,
  },
  flagField: {
    height: '58%',
    opacity: 0.9,
    overflow: 'hidden',
    position: 'absolute',
    width: '48%',
  },
  flagLeft: {
    borderBottomRightRadius: 120,
    left: 0,
    top: 0,
  },
  flagRight: {
    borderTopLeftRadius: 120,
    bottom: 0,
    right: 0,
  },
  flagBand: {
    flex: 1,
  },
  posterChrome: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: 48,
    paddingTop: 42,
  },
  posterChromeCompact: {
    paddingBottom: tokens.spacing.lg,
    paddingTop: tokens.spacing.lg,
  },
  competitionText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
    maxWidth: '100%',
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  flagMark: {
    borderRadius: tokens.radii.md,
    flexDirection: 'row',
    height: 120,
    overflow: 'hidden',
    width: 234,
  },
  flagMarkCompact: {
    borderRadius: tokens.radii.sm,
    height: 78,
    width: 156,
  },
  flagMarkHorizontal: {
    flexDirection: 'column',
  },
  flagMarkBand: {
    flex: 1,
  },
  posterStack: {
    alignItems: 'center',
    gap: tokens.spacing.md,
    width: '100%',
  },
  posterStackCompact: {
    gap: tokens.spacing.sm,
  },
  teamScoreText: {
    color: tokens.shell.text,
    fontSize: 62,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: 66,
    textAlign: 'center',
  },
  teamScoreTextCompact: {
    fontSize: 46,
    lineHeight: 48,
  },
  clockText: {
    color: tokens.shell.text,
    fontSize: 54,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: 58,
    textAlign: 'center',
  },
  clockTextCompact: {
    fontSize: 40,
    lineHeight: 44,
  },
  matchupText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
    textAlign: 'center',
  },
  kickoffDateText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.body,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  kickoffTimeText: {
    color: tokens.shell.text,
    fontSize: 54,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: 62,
    textAlign: 'center',
  },
  kickoffTimeTextCompact: {
    fontSize: 42,
    lineHeight: 46,
  },
  scoreBlock: {
    alignItems: 'center',
    gap: tokens.spacing.sm,
  },
  scoreText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.display,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.display,
    textAlign: 'center',
  },
  phaseText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.medium,
    lineHeight: tokens.typography.lineHeight.body,
    textAlign: 'center',
  },
  carousel: {
    alignItems: 'center',
    gap: tokens.spacing.sm,
  },
  carouselPage: {
    justifyContent: 'center',
  },
  homeContextControl: {
    alignItems: 'flex-start',
    backgroundColor: tokens.shell.background,
    justifyContent: 'center',
    left: tokens.spacing.lg,
    minHeight: 44,
    minWidth: 148,
    paddingRight: tokens.spacing.sm,
    position: 'absolute',
    zIndex: 20,
  },
  homeContextControlDisabled: {
    opacity: 0.48,
  },
  homeContextText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1.2,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  carouselDots: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    height: 12,
    justifyContent: 'center',
  },
  carouselDot: {
    backgroundColor: tokens.shell.textDim,
    borderRadius: tokens.radii.pill,
    height: 6,
    opacity: 0.7,
    width: 6,
  },
  carouselDotActive: {
    backgroundColor: tokens.shell.text,
    height: 4,
    opacity: 1,
    width: 24,
  },
  recentSection: {
    gap: tokens.spacing.xl,
    paddingTop: HOME_RECENT_SECTION_TOP_PADDING,
  },
  recentHeading: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1.5,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  recentGrid: {
    columnGap: tokens.spacing.md,
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: tokens.spacing.xxl,
  },
  recentMatch: {
    alignItems: 'center',
    flexBasis: '47%',
    flexGrow: 1,
    gap: tokens.spacing.sm,
    justifyContent: 'flex-start',
    minHeight: 136,
    paddingVertical: tokens.spacing.sm,
  },
  recentMatchPressed: {
    opacity: 0.64,
  },
  recentTeams: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: tokens.spacing.lg,
    justifyContent: 'center',
  },
  recentTeam: {
    alignItems: 'center',
    gap: tokens.spacing.xs,
    width: 68,
  },
  recentTeamName: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.medium,
    lineHeight: tokens.typography.lineHeight.caption,
    minHeight: tokens.typography.lineHeight.caption * 2,
    textAlign: 'center',
  },
  recentFlag: {
    borderRadius: tokens.radii.sm,
    flexDirection: 'row',
    height: 38,
    overflow: 'hidden',
    width: 56,
  },
  recentScore: {
    color: tokens.shell.text,
    fontSize: 30,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: 36,
    textAlign: 'center',
  },
  recentMeta: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 0.6,
    lineHeight: tokens.typography.lineHeight.caption,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  skeletonPoster: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.lg,
    gap: tokens.spacing.xl,
    justifyContent: 'center',
    minHeight: 460,
    overflow: 'hidden',
    padding: tokens.spacing.xl,
  },
  skeletonGlow: {
    borderRadius: 110,
    height: 132,
    opacity: 0.12,
    position: 'absolute',
    width: 132,
  },
  skeletonGlowTop: {
    backgroundColor: '#FFFFFF',
    left: -52,
    top: 36,
  },
  skeletonGlowBottom: {
    backgroundColor: '#FFFFFF',
    bottom: 44,
    right: -52,
  },
  skeletonFlag: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.md,
    height: 92,
    width: 164,
  },
  skeletonLineLarge: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.pill,
    height: 22,
    width: '70%',
  },
  skeletonScore: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.pill,
    height: 74,
    width: '46%',
  },
  skeletonLineSmall: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.pill,
    height: 16,
    width: '42%',
  },
  stateMessage: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.lg,
    gap: tokens.spacing.lg,
    justifyContent: 'center',
    minHeight: 460,
    padding: tokens.spacing.xl,
  },
  stateMessageCompact: {
    alignItems: 'flex-start',
    minHeight: 0,
    paddingVertical: tokens.spacing.lg,
  },
  stateEyebrow: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  stateTitle: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.title,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.title,
    textAlign: 'center',
  },
  stateBody: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.body,
    lineHeight: tokens.typography.lineHeight.body,
    maxWidth: 280,
    textAlign: 'center',
  },
  stateAction: {
    backgroundColor: tokens.shell.text,
    borderRadius: tokens.radii.pill,
    paddingHorizontal: tokens.spacing.xl,
    paddingVertical: tokens.spacing.md,
  },
  stateActionText: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  detailScreen: {
    backgroundColor: tokens.shell.background,
    flex: 1,
  },
  detailStateScreen: {
    padding: tokens.spacing.lg,
  },
  detailFixed: {
    borderBottomColor: tokens.shell.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: tokens.spacing.sm,
    paddingBottom: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.sm,
    zIndex: 10,
  },
  pulseScroll: {
    flex: 1,
  },
  gameViewContent: {
    flex: 1,
    overflow: 'hidden',
  },
  detailUtilityRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 30,
  },
  backButton: {
    alignSelf: 'flex-start',
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: 1,
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.md,
  },
  backButtonText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.medium,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  detailCompetition: {
    color: tokens.shell.textDim,
    flex: 1,
    fontSize: 9,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 0.8,
    marginLeft: tokens.spacing.md,
    textAlign: 'right',
    textTransform: 'uppercase',
  },
  detailHeader: {
    alignItems: 'center',
    backgroundColor: tokens.shell.background,
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    justifyContent: 'space-between',
    minHeight: 64,
    overflow: 'hidden',
    paddingVertical: 2,
  },
  detailTeamColumn: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    minWidth: 0,
  },
  detailTeamColumnRight: {
    justifyContent: 'flex-end',
  },
  detailTeamIdentity: {
    alignItems: 'center',
    flexShrink: 1,
    gap: 3,
    minWidth: 0,
    width: 84,
  },
  detailCenterColumn: {
    alignItems: 'center',
    flexBasis: 112,
    flexGrow: 0,
    flexShrink: 0,
    gap: 1,
    justifyContent: 'center',
    minWidth: 112,
  },
  miniFlag: {
    borderRadius: tokens.radii.sm,
    flexDirection: 'row',
    flexShrink: 0,
    height: 32,
    overflow: 'hidden',
    width: 48,
  },
  miniFlagHorizontal: {
    flexDirection: 'column',
  },
  detailTeamName: {
    color: tokens.shell.textMuted,
    fontSize: 9,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 0.7,
    lineHeight: 11,
    maxWidth: 84,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  detailTeamScore: {
    color: tokens.shell.text,
    flexShrink: 0,
    fontSize: 30,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: 32,
  },
  detailClock: {
    color: tokens.shell.text,
    fontSize: 24,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: -0.4,
    lineHeight: 27,
    textAlign: 'center',
  },
  detailKickoffDate: {
    color: tokens.shell.textMuted,
    fontSize: 9,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 0.8,
    lineHeight: 12,
    textAlign: 'center',
  },
  detailPhase: {
    color: tokens.shell.textDim,
    fontSize: 8,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 0.8,
    lineHeight: 10,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  detailTabs: {
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.pill,
    flexDirection: 'row',
    gap: tokens.spacing.xs,
    padding: tokens.spacing.xs,
  },
  detailTab: {
    alignItems: 'center',
    borderRadius: tokens.radii.pill,
    flex: 1,
    minHeight: 38,
    justifyContent: 'center',
  },
  detailTabPressed: {
    opacity: 0.62,
  },
  detailTabSelected: {
    backgroundColor: tokens.shell.text,
  },
  detailTabText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.medium,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  detailTabSelectedText: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  pulseStack: {
    gap: tokens.spacing.sm,
    paddingBottom: tokens.spacing.xxl,
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.sm,
  },
  pulseBody: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  pulseStatePanel: {
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.md,
    gap: tokens.spacing.sm,
    padding: tokens.spacing.lg,
  },
  pulseStateTitle: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.body,
  },
  pulseStateAction: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: tokens.shell.text,
    borderRadius: tokens.radii.pill,
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.lg,
  },
  pulseStateActionText: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  pulseMoment: {
    alignItems: 'center',
    borderRadius: tokens.radii.md,
    flexDirection: 'row',
    gap: tokens.spacing.md,
    padding: tokens.spacing.md,
  },
  pulseMomentQuiet: {
    backgroundColor: tokens.shell.surface,
  },
  pulseMomentBuilding: {
    backgroundColor: '#151515',
  },
  pulseMomentDanger: {
    backgroundColor: '#1D1D1D',
  },
  pulseMomentMajor: {
    backgroundColor: '#262626',
  },
  pulseMinute: {
    color: tokens.shell.text,
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.sm,
    fontSize: tokens.typography.size.label,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
    minWidth: 48,
    overflow: 'hidden',
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: tokens.spacing.sm,
    textAlign: 'center',
  },
  pulseCopy: {
    flex: 1,
    gap: tokens.spacing.xs,
  },
  pulseMomentHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: tokens.spacing.sm,
  },
  pulseMomentTitle: {
    color: tokens.shell.text,
    flex: 1,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.body,
  },
});
