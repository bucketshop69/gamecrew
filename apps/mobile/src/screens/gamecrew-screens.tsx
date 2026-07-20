import {
  ECONOMY_FIXED_STAKE_COOLNESS,
  type EconomyItemId,
  type GameCrewMatch,
  type LeaderboardRow,
  type MatchEngineParticipant,
  type MatchPulseCommentaryEntry,
  gameCrewTokens,
  getEconomyItemDefinition,
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
  FlatList,
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
import {
  buildListeningSessionLabel,
  enterListeningSession,
  pauseListeningSession,
  resumeListeningSession,
  useAttachListeningSessionEngine,
  useListeningSessionState,
  useNowListeningBarVisible,
} from '../state/commentary-listening-session';
import { useEconomy, useLeaderboard, useUserPile } from '../state/use-economy';
import { usePlaybackEngine } from '../state/use-playback-engine';
import { useWallet } from '../state/use-wallet';
import { EconomyLeaderboardSheet } from './economy-leaderboard-sheet';
import { EconomyPileSheet } from './economy-pile-sheet';
import { PrivyLoginBridge } from './economy-privy-login-bridge';
import { GameViewCheckpointRail } from './game-view/game-view-checkpoint-rail';
import {
  buildGameViewCheckpointRail,
  buildGameViewHighlightsSequence,
  buildGameViewScorerTimeline,
  findGameViewCheckpointCommentaryEntryId,
  resolveGameViewCheckpointClipWindow,
  resolveGameViewCheckpointReplayStartIndex,
  resolveGameViewHighlightsAdvance,
  type GameViewCheckpointClipWindow,
} from './game-view/game-view-checkpoint-logic';
import { GameViewFullTimeBoard } from './game-view/game-view-fulltime-board';
import {
  GameViewScreen,
  type GameViewPresentationState,
  useGoalSequenceScoreHold,
  useReduceMotionPreference,
} from './game-view/game-view-screen';
import {
  resolveGameViewLoadState,
  resolveGameViewPlaybackActive,
  resolvePresentationScene,
  shouldHeaderShowFullTimeTruth,
  shouldLandAtFullTime,
} from './game-view/game-view-screen-logic';
import {
  setGameViewSoundEnabled,
  setGameViewVoiceEnabled,
  useGameViewSoundPreference,
  useGameViewVoicePreference,
} from './game-view/game-view-sound-preference';
import { stopCommentaryVoiceImmediately, useCommentaryVoiceSpeaking } from './game-view/use-commentary-voice';
import { useGameViewSoundscape } from './game-view/use-game-view-soundscape';
import { GiftRevealTakeover } from './game-view-takeovers/gift-reveal-takeover';
import { FloatingChatButton } from './floating-chat-button';
import type { ChatTeamIdentity } from './global-chat-feed';
import {
  buildGlobalChatStreamRows,
  buildPileRows,
  latestGiftRevealItems,
  poolChipText,
  truncateWalletAddress,
  type GlobalChatRow,
} from './global-chat-logic';
import {
  partitionHomeMatches,
  resolveHomeSection,
  type HomeSection,
} from './home-screen-state';
import { MatchChatSheet } from './match-chat-sheet';
import {
  buildPinnedChallengeStrip,
  countUnseenOpenChallenges,
} from './match-chat-sheet-logic';
import { MatchTransportStrip } from './match-transport-strip';
import {
  resolveTransportButtonAction,
  resolveTransportStripButtonDisabled,
  resolveTransportStripIsPaused,
  resolveTransportStripLabel,
  shouldShowBackToFullTime,
} from './match-transport-strip-logic';
import { NowListeningBar } from './now-listening-bar';
import { ProfileSheet } from './profile-sheet';

/** Set at build time (EXPO_PUBLIC_PRIVY_APP_ID/CLIENT_ID) -- mirrors app/_layout.tsx's gate exactly, so the claim UI's "unavailable" state and the actual PrivyProvider mount agree on whether Privy is configured. */
const PRIVY_AVAILABLE = Boolean(
  process.env.EXPO_PUBLIC_PRIVY_APP_ID && process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID,
);

const tokens = gameCrewTokens;

type PulseTone = 'major' | 'danger' | 'building' | 'quiet';
export type MatchDetailMode = 'pulse' | 'game' | 'chat';

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

interface PendingPulseJump {
  index: number;
  retryCount: number;
}

const HOME_HEADER_HEIGHT = 44;
const HOME_CAROUSEL_CHROME_HEIGHT = 24;
const HOME_CONTEXT_CONTROL_CLEARANCE = 72;
const HOME_JUMP_FALLBACK_MS = 900;
const HOME_RECENT_SECTION_TOP_PADDING = 48;
const PULSE_JUMP_RETRY_MS = 80;
const PULSE_JUMP_MAX_RETRIES = 4;
const PULSE_ROW_FALLBACK_HEIGHT = 112;

export function HomeScreen({
  onOpenFixture,
  onOpenMatch,
}: {
  /** Item 2: tapping the now-listening bar jumps back into that fixture, which may not be in `loadState.matches` (e.g. a recent match scrolled out of the list) -- navigated by id alone, same route MatchDetailRoute already resolves fixtureId against. Fix round item 4: an optional tab hint ('game') so the bar can land directly on Game View instead of the default Match Pulse tab. */
  onOpenFixture: (fixtureId: string, tab?: MatchDetailMode) => void;
  onOpenMatch: (match: GameCrewMatch) => void;
}) {
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeSection, setActiveSection] = useState<HomeSection>('featured');
  const [jumpInProgress, setJumpInProgress] = useState(false);
  const [profileVisible, setProfileVisible] = useState(false);
  // Item 3a: Stash re-homed to the profile sheet -- "Your Stash" opens this
  // same EconomyPileSheet MatchDetailScreen already uses, mounted here at
  // the Home level since Stash access no longer requires being inside a
  // specific match.
  const [pileSheetVisible, setPileSheetVisible] = useState(false);
  const { loadState, reload } = useGameCrewMatches();
  // Items 5+6: cross-match identity for the profile sheet -- useUserPile is
  // fixture-independent (folds every fixture's cached economy log) and
  // useWallet's claims are already cross-fixture too (the same hook the
  // Stash uses inside a match), so neither needs a MatchSession/fixtureId.
  const userPile = useUserPile();
  const profileWallet = useWallet();
  const profileWalletAddress = profileWallet.walletAddress
    ? truncateWalletAddress(profileWallet.walletAddress)
    : null;
  const profileHeldItemCount = userPile.pile.filter((entry) => entry.quantity > 0).length;
  const profileClaimedItemCount = useMemo(
    () => new Set(
      profileWallet.claims.filter((claim) => claim.status === 'minted').map((claim) => claim.itemId),
    ).size,
    [profileWallet.claims],
  );
  const profilePileRows = useMemo(
    () => buildPileRows(userPile.pile, getEconomyItemDefinition),
    [userPile.pile],
  );
  // Item 3a narrowing: a cross-match Stash claim has no single owning
  // fixture in the current data model (useUserPile folds quantities across
  // every fixture's cached economy log without retaining which fixture each
  // unit came from) -- claiming from Home therefore can't carry a real
  // per-fixture provenance the backend would otherwise get from a match
  // screen's claim. Rather than inventing new cross-fixture tracking in
  // packages/core (out of scope for this round), claims initiated from the
  // profile Stash are tagged with this explicit sentinel fixtureId so the
  // claim still round-trips through the exact same `wallet.claimItem` path
  // (and its idempotency/sourceEventId guarantees) a match-scoped claim
  // uses, just without a real fixture attached.
  const handleProfileClaimItem = useCallback(
    (itemId: EconomyItemId, quantity: number) => {
      profileWallet.claimItem({
        fixtureId: 'profile',
        itemId,
        quantity,
        sourceEventId: `pile:${itemId}`,
      });
    },
    [profileWallet],
  );
  const profilePrivyLoginRef = useRef<((provider: 'google' | 'apple') => Promise<string | undefined>) | null>(null);
  const handleProfilePrivyReady = useCallback((login: (provider: 'google' | 'apple') => Promise<string | undefined>) => {
    profilePrivyLoginRef.current = login;
  }, []);
  const handleProfileStartLogin = useCallback(
    async (provider: 'google' | 'apple'): Promise<boolean> => {
      const login = profilePrivyLoginRef.current;
      if (!login) return false;
      const address = await login(provider);
      if (!address) return false;
      profileWallet.setWalletAddress(address);
      return true;
    },
    [profileWallet],
  );
  const handleProfileCancelLogin = useCallback(() => {
    profileWallet.cancelLogin();
  }, [profileWallet]);
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
        <HomeHeader onOpenProfile={() => setProfileVisible(true)} />

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

      <HomeNowListeningBar bottomInset={insets.bottom} onOpenFixture={onOpenFixture} />

      <ProfileSheet
        claimedItemCount={profileClaimedItemCount}
        coolness={userPile.coolness}
        heldItemCount={profileHeldItemCount}
        onClose={() => setProfileVisible(false)}
        onOpenStash={() => setPileSheetVisible(true)}
        visible={profileVisible}
        walletAddress={profileWalletAddress}
      />

      {/* PrivyLoginBridge is only ever mounted when Privy is configured --
          calling its hooks unconditionally would throw with no PrivyProvider
          in the tree (see app/_layout.tsx and economy-privy-login-bridge.tsx). */}
      {PRIVY_AVAILABLE ? <PrivyLoginBridge onReady={handleProfilePrivyReady} /> : null}

      <EconomyPileSheet
        claims={profileWallet.claims}
        coolness={userPile.coolness}
        onCancelLogin={handleProfileCancelLogin}
        onClaimItem={handleProfileClaimItem}
        onClose={() => setPileSheetVisible(false)}
        onStartLogin={handleProfileStartLogin}
        pileRows={profilePileRows}
        privyAvailable={PRIVY_AVAILABLE}
        visible={pileSheetVisible}
        walletAddress={profileWallet.walletAddress}
        walletStatus={profileWallet.walletStatus}
      />
    </View>
  );
}

/**
 * Item 2: thin wrapper so HomeScreen's own render doesn't need to
 * conditionally subscribe to the listening-session store -- this always
 * subscribes (useNowListeningBarVisible/useListeningSessionState are cheap,
 * module-level useSyncExternalStore reads) and renders nothing when there's
 * no active/playing off-screen session. `viewingFixtureId` is always
 * undefined here since HomeScreen is never a match's own screen.
 */
function HomeNowListeningBar({
  bottomInset,
  onOpenFixture,
}: {
  bottomInset: number;
  onOpenFixture: (fixtureId: string, tab?: MatchDetailMode) => void;
}) {
  const visible = useNowListeningBarVisible(undefined);
  const session = useListeningSessionState();

  if (!visible || !session.active) return null;

  return (
    <NowListeningBar
      bottomInset={bottomInset}
      isLive={session.active.isLive}
      isPlaying={session.isPlaying}
      matchLabel={session.active.label}
      onPause={pauseListeningSession}
      onResume={resumeListeningSession}
      // Fix round item 4: land directly on Game View, same running session.
      onTap={() => onOpenFixture(session.active!.fixtureId, 'game')}
    />
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
  // Item 9b: the "recent games" grid is reused for a not-yet-played
  // fixture too (e.g. an upcoming match scrolled in alongside real recent
  // results) -- a match with no score yet must never read as a scoreless
  // "FT 0-0", it must show its kickoff time instead, same as the hero
  // carousel's own upcoming treatment.
  const isUpcomingMatch = match.status === 'upcoming' || match.status === 'hosted';
  const scoreLabel = match.score
    ? `${match.score.home} - ${match.score.away}`
    : isUpcomingMatch ? formatKickoffTime(match.kickoffUtc) : 'FT';
  const label = match.score
    ? `${getMatchTitle(match)}, final score ${match.score.home} to ${match.score.away}`
    : isUpcomingMatch
      ? `${getMatchTitle(match)}, kicks off ${formatKickoff(match.kickoffUtc)}`
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
          <Text ellipsizeMode="tail" numberOfLines={1} selectable style={styles.recentTeamName}>
            {match.homeTeam.name}
          </Text>
        </View>
        <View style={styles.recentTeam}>
          <StaticFlag
            bands={match.awayTeam.flag.bands}
            countryCode={match.awayTeam.countryCode}
            size="recent"
          />
          <Text ellipsizeMode="tail" numberOfLines={1} selectable style={styles.recentTeamName}>
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

function HomeHeader({ onOpenProfile }: { onOpenProfile: () => void }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerSide} />
      <Text style={styles.wordmark} selectable>
        GameCrew
      </Text>
      <Pressable
        accessibilityLabel="Open profile"
        accessibilityRole="button"
        onPress={onOpenProfile}
        style={styles.accountButton}
      >
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
  initialMode = 'pulse',
  match,
  onBack,
}: {
  /** Item 4 (fix round): which tab this screen lands on when it mounts -- the now-listening bar passes 'game' so tapping it opens directly on Game View instead of the default Match Pulse. Every other entry path omits this and keeps the 'pulse' default. */
  initialMode?: MatchDetailMode;
  match: GameCrewMatch;
  onBack: () => void;
}) {
  const [activeMode, setActiveMode] = useState<MatchDetailMode>(initialMode);
  const [gamePresentation, setGamePresentation] = useState<GameViewPresentationState | null>(null);
  // Item 5 (fix round): "takeovers own the stage" -- while a Game View
  // takeover (goal sequence, card, VAR, a full-vignette set-piece, phase
  // break, etc, see GameViewScreen's `onTakeoverActiveChange`) or the Gift
  // Reveal takeover is up, the Match Pulse mini-overlay (handled inside
  // GameViewScreen itself, see its `commentaryOverlay` gating) and the
  // FloatingChatButton (handled here) both hide, restoring once the
  // takeover clears.
  const [gameViewTakeoverActive, setGameViewTakeoverActive] = useState(false);
  const [pileSheetVisible, setPileSheetVisible] = useState(false);
  const [leaderboardVisible, setLeaderboardVisible] = useState(false);
  // Item 4: chat is now a slide-up sheet over either tab rather than its own
  // tab -- MatchDetailMode keeps the 'chat' union member (simpler than
  // narrowing every switch/branch below that already handles it) but it is
  // never set anymore; the tab bar only offers 'pulse'/'game' (see the tab
  // list below), so this state is effectively unreachable dead weight kept
  // for diff minimality.
  const [chatSheetVisible, setChatSheetVisible] = useState(false);
  const reduceMotionPreference = useReducedMotionPreference();
  // Measured heights of the checkpoint dock, the transport strip (item 7),
  // and the bottom tab bar so the floating chat button (itself absolutely
  // positioned against the whole screen, a sibling of all three) can float
  // just above them (spec item 4: "sits above the checkpoint dock on both
  // tabs") -- all three sit in normal flex flow below the tab content, so
  // the button's `bottom` offset must clear all their heights, not just the
  // dock's. Fall back to reasonable defaults before the first onLayout
  // fires on each.
  const [checkpointDockHeight, setCheckpointDockHeight] = useState(96);
  const [transportStripHeight, setTransportStripHeight] = useState(48);
  const [bottomNavigationHeight, setBottomNavigationHeight] = useState(64);
  const handleCheckpointDockLayout = useCallback((event: LayoutChangeEvent) => {
    setCheckpointDockHeight(event.nativeEvent.layout.height);
  }, []);
  const handleTransportStripLayout = useCallback((event: LayoutChangeEvent) => {
    setTransportStripHeight(event.nativeEvent.layout.height);
  }, []);
  const handleBottomNavigationLayout = useCallback((event: LayoutChangeEvent) => {
    setBottomNavigationHeight(event.nativeEvent.layout.height);
  }, []);
  // UX review should-fix ("Leaderboard snapshot-at-open"): the sheet must
  // render the leaderboard as of the moment it was opened, not live re-sort
  // while the user is reading it -- captured once, on the same tap that
  // opens the sheet, rather than fed continuously from `leaderboard.rows`.
  const [leaderboardSnapshot, setLeaderboardSnapshot] = useState<readonly LeaderboardRow[]>([]);
  const { pulseLoadState, reload } = useMatchPulse(
    match.txline.fixtureId,
    match.status === 'live',
  );
  const playback = usePlaybackEngine(match.txline.fixtureId, match.status === 'live');
  const economy = useEconomy(match.txline.fixtureId, match.status === 'live');
  const wallet = useWallet();
  const leaderboard = useLeaderboard(match.txline.fixtureId, match.status === 'live', economy.streamEvents);
  const handleClaimItem = useCallback(
    (itemId: EconomyItemId, quantity: number) => {
      wallet.claimItem({
        fixtureId: match.txline.fixtureId,
        itemId,
        quantity,
        sourceEventId: `pile:${itemId}`,
      });
    },
    [match.txline.fixtureId, wallet],
  );

  // Privy login bridge: onReady hands this ref the real login(provider)
  // function once PrivyLoginBridge mounts (only when PRIVY_AVAILABLE) -- see
  // economy-privy-login-bridge.tsx's doc comment for why this indirection
  // exists (hooks can't be called conditionally, but a component can be
  // conditionally mounted).
  const privyLoginRef = useRef<((provider: 'google' | 'apple') => Promise<string | undefined>) | null>(null);
  const handlePrivyReady = useCallback((login: (provider: 'google' | 'apple') => Promise<string | undefined>) => {
    privyLoginRef.current = login;
  }, []);
  const handleStartLogin = useCallback(
    async (provider: 'google' | 'apple'): Promise<boolean> => {
      const login = privyLoginRef.current;
      if (!login) return false;
      const address = await login(provider);
      if (!address) return false;
      wallet.setWalletAddress(address);
      return true;
    },
    [wallet],
  );
  const handleCancelLogin = useCallback(() => {
    wallet.cancelLogin();
  }, [wallet]);
  const handleOpenLeaderboard = useCallback(() => {
    setLeaderboardSnapshot(leaderboard.rows);
    setLeaderboardVisible(true);
  }, [leaderboard.rows]);

  const pulseItems = getPulseFeedItems(pulseLoadState.entries);
  const pulseListRef = useRef<FlatList<PulseFeedItem> | null>(null);
  const pendingPulseJumpRef = useRef<PendingPulseJump | null>(null);
  const pulseJumpRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedPulseId, setHighlightedPulseId] = useState<string | undefined>();
  const checkpointRail = useMemo(
    () => buildGameViewCheckpointRail(playback.snapshot.timeline),
    [playback.snapshot.timeline],
  );

  // Item 3/8/12/13: for a completed match, Game View lands on the full-time
  // board's end state instead of auto-replaying from kickoff (see
  // GameViewScreen's replaced auto-startReplay effect). `gameViewIntent`
  // tracks what the shared playback engine is currently doing on behalf of
  // that board so it knows when to show itself (idle) versus stay hidden
  // (a clip/highlights/the full replay is actively running) -- see the
  // "reappearing when playback settles" requirement. Irrelevant for live
  // matches, which never render the board at all (see the `showFullTimeBoard`
  // computation below).
  const [gameViewIntent, setGameViewIntent] = useState<'idle' | 'clip' | 'highlights' | 'full'>('idle');
  const highlightsSequenceRef = useRef<readonly GameViewCheckpointClipWindow[]>([]);
  const highlightsIndexRef = useRef(-1);
  const gameViewLoadState = resolveGameViewLoadState(
    playback.snapshot.sessionStatus,
    playback.snapshot.timeline.length > 0,
  );
  const showFullTimeBoard = shouldLandAtFullTime(match.status)
    && gameViewIntent === 'idle'
    && gameViewLoadState.status === 'ready';
  const scorerTimeline = useMemo(
    () => buildGameViewScorerTimeline(playback.snapshot.timeline, checkpointRail.checkpoints, pulseLoadState.entries),
    [checkpointRail.checkpoints, playback.snapshot.timeline, pulseLoadState.entries],
  );

  // Item 1 (round four): the "fire newest commentary entry -> play clip"
  // loop that used to live entirely in this component (useCommentaryVoiceSession
  // + a local firing effect) is now owned by the module-level headless
  // listening session (state/commentary-listening-session.ts), which
  // duplicates the exact same selector (selectVisibleGameViewCommentary) and
  // queue policy so in-match behavior is unchanged. Entering this screen
  // hands control to that session (adopts it if it's already running for
  // this fixture, e.g. the user came back from Home mid-playback; starts
  // fresh otherwise), then attaches THIS screen's own `playback` engine
  // (from usePlaybackEngine above) as the session's snapshot source --
  // critical so checkpoint/highlights/full-replay seeks (which move
  // `playback`, not a second independent engine) stay in lockstep with
  // voice exactly as before the lift. Leaving this screen does NOT stop the
  // session -- it detaches (hands off to a headless engine) instead, see
  // enterListeningSession/useAttachListeningSessionEngine's doc comments.
  // Owner's rule: a COMPLETED match always opens in the default state --
  // nothing active, nothing speaking (sound off is the app-wide default;
  // the commentary flag back to its default too), even when the user
  // enabled sound in a previous match this session. A LIVE match stays
  // seamless across back-and-forth, so its remembered toggles are left
  // untouched. Declared BEFORE the enter/attach effects below so the reset
  // runs first on entry and a stale ON preference can never voice the
  // parked full-time board. Keyed once per fixture entry (the ref), so a
  // live match finishing mid-view does not yank the user's toggles.
  const lastPreferenceResetFixtureRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastPreferenceResetFixtureRef.current === match.txline.fixtureId) return;
    lastPreferenceResetFixtureRef.current = match.txline.fixtureId;
    if (!shouldLandAtFullTime(match.status)) return;
    setGameViewSoundEnabled(false);
    setGameViewVoiceEnabled(true);
  }, [match.status, match.txline.fixtureId]);
  const listeningSessionMatchInfo = useMemo(
    () => ({
      fixtureId: match.txline.fixtureId,
      label: buildListeningSessionLabel(match.homeTeam.name, match.awayTeam.name),
      isLive: match.status === 'live',
    }),
    [match.awayTeam.name, match.homeTeam.name, match.status, match.txline.fixtureId],
  );
  useEffect(() => {
    enterListeningSession(listeningSessionMatchInfo);
  }, [listeningSessionMatchInfo]);
  // Bug fix: `listeningSessionMatchInfo` is also passed to the attach hook
  // below so that if something kills the driver while this screen is still
  // mounted (belt-and-braces -- the specific kill-on-preference-disable path
  // is already fixed at its source, see shouldPreferenceDisableStopSession),
  // the very next render rebuilds it instead of leaving commentary dead for
  // the rest of the visit.
  useAttachListeningSessionEngine(match.txline.fixtureId, playback.snapshot, listeningSessionMatchInfo);

  // Item 1 (fix round): once the full-time board is the thing actually
  // showing, the header must tell the truth regardless of whatever
  // presentation a now-parked clip/replay last reported -- see
  // `shouldHeaderShowFullTimeTruth`'s doc comment for the root cause
  // (`onPresentationChange` has no "settled back to idle" clear hook).
  // `DetailTeamScore`/`DetailMatchClock` already fall back to the match's
  // own FT label/score whenever no presentation is supplied, so forcing
  // `null` here is sufficient -- no separate FT-specific presentation needs
  // to be constructed.
  const visibleGamePresentation = activeMode === 'game' && !shouldHeaderShowFullTimeTruth(match.status, gameViewIntent)
    ? gamePresentation
    : null;
  const chatListRef = useRef<FlatList<GlobalChatRow> | null>(null);
  const chatRows = useMemo(
    // Item 12: the real per-call stake cost, not a hardcoded placeholder --
    // same ECONOMY_FIXED_STAKE_COOLNESS constant already imported above for
    // MatchChatSheet's `stakeCoolness` prop.
    () => buildGlobalChatStreamRows(
      economy.streamRows,
      economy.openPrompts,
      economy.pile,
      getEconomyItemDefinition,
      ECONOMY_FIXED_STAKE_COOLNESS,
    ),
    [economy.streamRows, economy.openPrompts, economy.pile],
  );
  // Item 2: the feed's "always scroll to bottom on MY OWN send" rule needs to
  // know the row id of whatever `user_chat` row a send actually produced --
  // `economy.sendMessage` itself only returns a boolean (no id), and its
  // effect on `economy.streamRows` lands one render later (it goes through
  // `setChatMessages`, ordinary React state), so the id can't be read
  // synchronously right after calling it. Instead: a successful send arms
  // `awaitingOwnMessageRef`; the effect below watches `chatRows` (recomputed
  // whenever `economy.streamRows` changes) and, once armed, treats the
  // newest `user_chat` row as the one that was just sent. `knownUserChatRowIdsRef`
  // seeds from the very first render so an already-existing message (e.g.
  // restored from persistence) is never mistaken for a fresh send.
  const knownUserChatRowIdsRef = useRef<ReadonlySet<string> | undefined>(undefined);
  const awaitingOwnMessageRef = useRef(false);
  const [lastOwnMessageId, setLastOwnMessageId] = useState<string | undefined>(undefined);
  useEffect(() => {
    const currentUserChatRows = chatRows.filter((row) => row.kind === 'user_chat');
    const currentIds = new Set(currentUserChatRows.map((row) => row.id));
    if (knownUserChatRowIdsRef.current === undefined) {
      knownUserChatRowIdsRef.current = currentIds;
      return;
    }
    if (awaitingOwnMessageRef.current) {
      const newlySent = currentUserChatRows.find((row) => !knownUserChatRowIdsRef.current!.has(row.id));
      if (newlySent) {
        awaitingOwnMessageRef.current = false;
        setLastOwnMessageId(newlySent.id);
      }
    }
    knownUserChatRowIdsRef.current = currentIds;
  }, [chatRows]);
  const handleChatSend = useCallback((text: string): boolean => {
    const sent = economy.sendMessage(text);
    if (sent) awaitingOwnMessageRef.current = true;
    return sent;
  }, [economy]);
  // Team identity for the who-scores-next team-pick card (QA HIGH fix): a
  // single representative color per team, sourced directly from the match's
  // own team colors -- MatchDetailScreen is a match-owned surface, so team
  // color is allowed here (unlike the rest of the chat tab's monochrome
  // chrome), used sparingly as a border accent only (see global-chat-feed.tsx's
  // TeamPickButtons doc comment).
  const chatHomeTeam: ChatTeamIdentity = useMemo(
    () => ({ name: match.homeTeam.name, color: match.homeTeam.colors.primary, participant: 1 }),
    [match.homeTeam.name, match.homeTeam.colors.primary],
  );
  const chatAwayTeam: ChatTeamIdentity = useMemo(
    () => ({ name: match.awayTeam.name, color: match.awayTeam.colors.primary, participant: 2 }),
    [match.awayTeam.name, match.awayTeam.colors.primary],
  );
  const pileRows = useMemo(
    () => buildPileRows(economy.pile, getEconomyItemDefinition),
    [economy.pile],
  );
  const giftRevealItems = useMemo(
    () => latestGiftRevealItems(economy.streamEvents, getEconomyItemDefinition),
    [economy.streamEvents],
  );
  const poolChipLabel = useMemo(
    () => poolChipText(economy.poolSeed, getEconomyItemDefinition),
    [economy.poolSeed],
  );
  // Item 11: the pinned challenges strip reuses the same 'prompt'-kind rows
  // the feed already renders (buildPinnedChallengeStrip filters/derives from
  // chatRows), so the strip and the feed can never disagree about a prompt's
  // open/taken/closed state.
  const pinnedChips = useMemo(() => buildPinnedChallengeStrip(chatRows), [chatRows]);

  // Item 1/4: the floating chat button's count badge -- tracks which row
  // ids have been "seen" (as of the last sheet open) in plain component
  // state, no persistence needed per spec. Upgraded from a bare unread dot
  // (`hasUnreadSignal`) to the number of open challenges not yet seen
  // (`countUnseenOpenChallenges`) now that the challenge drop-in card is
  // gone and this button is the only out-of-sheet challenge signal.
  const [seenChatRowIds, setSeenChatRowIds] = useState<ReadonlySet<string>>(new Set());
  const unseenOpenChallengeCount = useMemo(
    () => countUnseenOpenChallenges(chatRows, seenChatRowIds),
    [chatRows, seenChatRowIds],
  );
  const handleOpenChatSheet = useCallback(() => {
    setChatSheetVisible(true);
    setSeenChatRowIds(new Set(chatRows.map((row) => row.id)));
  }, [chatRows]);
  const handleCloseChatSheet = useCallback(() => {
    setChatSheetVisible(false);
  }, []);

  const handlePickPinnedChip = useCallback((promptId: string) => {
    const index = chatRows.findIndex((row) => row.kind === 'prompt' && row.promptId === promptId);
    if (index < 0) return;
    chatListRef.current?.scrollToIndex({ animated: true, index, viewPosition: 0.3 });
  }, [chatRows]);

  const jumpToPulseIndex = useCallback((index: number) => {
    if (pulseJumpRetryTimerRef.current) {
      clearTimeout(pulseJumpRetryTimerRef.current);
      pulseJumpRetryTimerRef.current = null;
    }
    pendingPulseJumpRef.current = { index, retryCount: 0 };
    pulseListRef.current?.scrollToIndex({ animated: true, index, viewPosition: 0.35 });
  }, []);
  const handlePulseJumpFailure = useCallback(({
    averageItemLength,
    index,
  }: {
    averageItemLength: number;
    index: number;
  }) => {
    const pendingJump = pendingPulseJumpRef.current;
    if (!pendingJump || pendingJump.index !== index) return;

    const estimatedRowHeight = averageItemLength > 0
      ? averageItemLength
      : PULSE_ROW_FALLBACK_HEIGHT;
    pulseListRef.current?.scrollToOffset({
      animated: false,
      offset: Math.max(0, estimatedRowHeight * index),
    });

    if (pendingJump.retryCount >= PULSE_JUMP_MAX_RETRIES) return;
    pendingJump.retryCount += 1;
    if (pulseJumpRetryTimerRef.current) clearTimeout(pulseJumpRetryTimerRef.current);
    pulseJumpRetryTimerRef.current = setTimeout(() => {
      pulseJumpRetryTimerRef.current = null;
      if (pendingPulseJumpRef.current?.index !== index) return;
      pulseListRef.current?.scrollToIndex({ animated: true, index, viewPosition: 0.35 });
    }, PULSE_JUMP_RETRY_MS);
  }, []);
  useEffect(() => () => {
    if (pulseJumpRetryTimerRef.current) clearTimeout(pulseJumpRetryTimerRef.current);
  }, []);
  const handleCheckpointSelect = useCallback((sceneIndex: number) => {
    // Any seek must silence whatever voice clip is mid-sentence before
    // entries start firing again from the new position -- otherwise a clip
    // grounded in the old position keeps talking over the newly jumped-to
    // moment.
    stopCommentaryVoiceImmediately();
    highlightsSequenceRef.current = [];
    highlightsIndexRef.current = -1;

    if (match.status === 'live') {
      // Item 8: live matches keep today's behavior -- jump and keep playing,
      // no bounded clip.
      setGameViewIntent('idle');
      playback.controls.startReplayAt(resolveGameViewCheckpointReplayStartIndex(sceneIndex));
    } else {
      // Item 8: a completed match plays exactly the checkpoint's bounded
      // clip window, then stops and settles back to the full-time board --
      // see the `rangeStopAtIndex` watcher effect below for the "settle"
      // half of this.
      const checkpoint = checkpointRail.checkpoints.find((candidate) => candidate.sceneIndex === sceneIndex);
      const window = checkpoint
        ? resolveGameViewCheckpointClipWindow(playback.snapshot.timeline, checkpoint)
        : undefined;
      setGameViewIntent('clip');
      if (window) {
        playback.controls.startReplayRange(window.startSceneIndex, window.endSceneIndex);
      } else {
        // No checkpoint metadata for this scene index (defensive only --
        // every call site sources sceneIndex from the rail itself): fall
        // back to the pre-item-8 lead-in jump rather than stalling on an
        // undefined window.
        playback.controls.startReplayAt(resolveGameViewCheckpointReplayStartIndex(sceneIndex));
      }
    }

    if (activeMode !== 'pulse') return;

    const commentaryId = findGameViewCheckpointCommentaryEntryId(
      playback.snapshot.timeline,
      sceneIndex,
      pulseLoadState.entries,
    );
    if (!commentaryId) return;

    setHighlightedPulseId(commentaryId);
    const itemIndex = pulseItems.findIndex((item) => item.id === commentaryId);
    if (itemIndex >= 0) {
      jumpToPulseIndex(itemIndex);
    }
  }, [activeMode, checkpointRail.checkpoints, jumpToPulseIndex, match.status, playback, pulseItems, pulseLoadState.entries]);

  const handleWatchFullMatch = useCallback(() => {
    stopCommentaryVoiceImmediately();
    highlightsSequenceRef.current = [];
    highlightsIndexRef.current = -1;
    setGameViewIntent('full');
    playback.controls.startReplay();
  }, [playback]);

  const handlePlayHighlights = useCallback(() => {
    const sequence = buildGameViewHighlightsSequence(playback.snapshot.timeline, checkpointRail.checkpoints);
    highlightsSequenceRef.current = sequence;
    const firstWindow = sequence[0];
    if (!firstWindow) return; // No checkpoints to highlight -- nothing to chain, stay on the full-time board.

    stopCommentaryVoiceImmediately();
    highlightsIndexRef.current = 0;
    setGameViewIntent('highlights');
    playback.controls.startReplayRange(firstWindow.startSceneIndex, firstWindow.endSceneIndex);
  }, [checkpointRail.checkpoints, playback]);

  // Item 13: the highlights sequencer's driving effect -- watches the shared
  // playback snapshot for the current bounded window (clip or highlights
  // clip-in-sequence) reaching its stop scene, then either advances to the
  // next highlight clip or settles back to the full-time board. A lone
  // checkpoint clip (`gameViewIntent === 'clip'`) also settles here once its
  // single window ends, since it uses the same `rangeStopAtIndex` mechanism
  // and has no "next" to advance to.
  useEffect(() => {
    if (gameViewIntent !== 'clip' && gameViewIntent !== 'highlights') return;
    const { rangeStopAtIndex, playheadIndex } = playback.snapshot;
    if (rangeStopAtIndex === undefined || playheadIndex !== rangeStopAtIndex) return;

    if (gameViewIntent === 'clip') {
      setGameViewIntent('idle');
      return;
    }

    const decision = resolveGameViewHighlightsAdvance(highlightsSequenceRef.current, highlightsIndexRef.current);
    if (decision.kind === 'settle') {
      highlightsIndexRef.current = -1;
      setGameViewIntent('idle');
      return;
    }

    // Every jump -- manual checkpoint or sequencer-driven -- goes through the
    // same stop-voice-first path so a clip's narration never talks over the
    // next one's opening moment.
    stopCommentaryVoiceImmediately();
    highlightsIndexRef.current = decision.nextIndex;
    playback.controls.startReplayRange(decision.window.startSceneIndex, decision.window.endSceneIndex);
  }, [gameViewIntent, playback.controls, playback.snapshot]);

  // Item 7: the transport strip's play/pause button. `isPausedByStrip` is
  // tracked here (not derived from `playback.snapshot.mode === 'paused'`
  // alone) because `PlaybackEngine.pause()` also discards `rangeStopAtIndex`
  // (see playback-engine.ts's `pause()`) -- resuming a paused clip/highlight
  // needs to restart the SAME bounded window it was paused on, which this
  // ref captures at pause time (`pausedRangeRef`) so `resolveTransportButtonAction`'s
  // 'resume' case can replay it via `startReplayRange`/`startReplayAt`
  // exactly where the user left off, rather than jumping back to the live
  // head (`play()`) or restarting the whole replay from scene 0.
  const [isPausedByStrip, setIsPausedByStrip] = useState(false);
  const pausedRangeRef = useRef<{ index: number; stopAtIndex: number | undefined } | undefined>(undefined);
  useEffect(() => {
    // Any engine-driven settle back to 'idle' (highlights/clip finishing on
    // their own, a fresh checkpoint jump, Watch full match, etc.) clears the
    // strip's own paused flag so it never shows "paused" over content that
    // is no longer the thing it paused.
    setIsPausedByStrip(false);
    pausedRangeRef.current = undefined;
  }, [gameViewIntent]);
  const currentMinute = playback.snapshot.currentScene?.clockSeconds !== undefined
    ? Math.max(1, Math.ceil(playback.snapshot.currentScene.clockSeconds / 60))
    : undefined;
  const transportStripLabel = resolveTransportStripLabel({
    currentMinute,
    gameViewIntent,
    kickoffLabel: formatKickoffShort(match.kickoffUtc),
    matchStatus: match.status,
    playbackMode: playback.snapshot.mode,
  });
  const showBackToFullTime = shouldShowBackToFullTime(match.status, gameViewIntent);
  const handleTransportPress = useCallback(() => {
    const action = resolveTransportButtonAction({
      gameViewIntent,
      isPaused: isPausedByStrip,
      matchStatus: match.status,
    });
    switch (action.kind) {
      case 'start_full_replay':
        handleWatchFullMatch();
        return;
      case 'pause':
        pausedRangeRef.current = {
          index: playback.snapshot.playheadIndex,
          stopAtIndex: playback.snapshot.rangeStopAtIndex,
        };
        setIsPausedByStrip(true);
        stopCommentaryVoiceImmediately();
        playback.controls.pause();
        return;
      case 'resume': {
        const paused = pausedRangeRef.current;
        setIsPausedByStrip(false);
        if (!paused) {
          // Defensive only -- 'resume' is only reachable via 'pause' having
          // run first, which always sets pausedRangeRef.
          return;
        }
        if (paused.stopAtIndex === undefined) {
          playback.controls.startReplayAt(paused.index);
        } else {
          playback.controls.startReplayRange(paused.index, paused.stopAtIndex);
        }
        return;
      }
      case 'return_to_live':
        setIsPausedByStrip(false);
        playback.controls.play();
        return;
      case 'none':
        // Item 4: upcoming/hosted -- nothing to play yet, the button is
        // disabled (see resolveTransportStripButtonDisabled) so this should
        // be unreachable via a real tap, but stays a no-op defensively.
        return;
    }
  }, [gameViewIntent, handleWatchFullMatch, isPausedByStrip, match.status, playback]);
  const handleTransportStop = useCallback(() => {
    stopCommentaryVoiceImmediately();
    highlightsSequenceRef.current = [];
    highlightsIndexRef.current = -1;
    setIsPausedByStrip(false);
    pausedRangeRef.current = undefined;
    setGameViewIntent('idle');
    playback.controls.pause();
  }, [playback.controls]);

  // Fix round (controls to transport strip): the sound/commentary toggles and
  // the ambient soundscape player lifted out of GameViewScreen, so the strip
  // (visible on BOTH tabs) owns the buttons and the crowd bed survives tab
  // switches. The inputs below mirror exactly what GameViewScreen computed
  // locally for its own soundscape call before the lift.
  const reduceMotion = useReduceMotionPreference();
  const [soundEnabled, setSoundEnabled] = useGameViewSoundPreference();
  const [voiceEnabled, setVoiceEnabled] = useGameViewVoicePreference();
  const voiceIsSpeaking = useCommentaryVoiceSpeaking();
  const soundScene = useMemo(
    () => resolvePresentationScene(
      playback.snapshot.currentScene,
      playback.snapshot.activeSceneWindow,
    ) ?? undefined,
    [playback.snapshot],
  );
  const { activeBeatIndex: soundGoalBeatIndex } = useGoalSequenceScoreHold(
    soundScene,
    reduceMotion,
    playback.snapshot.activeSceneWindow?.instanceKey,
  );
  const soundGoalBeat = soundScene?.kind === 'goal_sequence' && soundScene.beats?.length
    ? soundScene.beats[Math.min(soundGoalBeatIndex, soundScene.beats.length - 1)]?.kind
    : undefined;
  const soundPlaybackActive = resolveGameViewPlaybackActive({
    gameViewIntent,
    matchStatus: match.status,
    playbackMode: playback.snapshot.mode,
  });
  const soundscape = useGameViewSoundscape({
    enabled: soundEnabled,
    goalBeat: soundGoalBeat,
    isSpeaking: voiceIsSpeaking,
    isStale: gameViewLoadState.isStale,
    playbackActive: soundPlaybackActive,
    scene: soundScene,
    sceneWindowKey: playback.snapshot.activeSceneWindow?.instanceKey,
  });
  const handleToggleSound = useCallback(() => {
    if (soundEnabled) {
      setSoundEnabled(false);
      soundscape.deactivate();
      return;
    }
    // Order matters: the audio-session unlock must run synchronously inside
    // the user gesture (browser/iOS autoplay policy), before state flips.
    soundscape.activateFromGesture();
    setSoundEnabled(true);
  }, [setSoundEnabled, soundEnabled, soundscape]);
  const handleToggleVoice = useCallback(() => {
    if (voiceEnabled) stopCommentaryVoiceImmediately();
    setVoiceEnabled(!voiceEnabled);
  }, [setVoiceEnabled, voiceEnabled]);

  // Item 4 (fix round): an upcoming/hosted match has no saved story to
  // "refresh and check the archive" for -- that copy only makes sense for a
  // completed match TxLINE might not have picked up yet. A match that
  // simply hasn't kicked off gets its own honest empty state instead, with
  // the kickoff time when the match model has one.
  const isUpcomingMatch = match.status === 'upcoming' || match.status === 'hosted';
  const pulseEmptyState = pulseLoadState.status === 'loading' ? (
    <PulseStatePanel title="Loading Match Pulse" body="Loading the saved match story." />
  ) : pulseLoadState.status === 'error' ? (
    <PulseStatePanel
      title="Match Pulse unavailable"
      body={getPulseErrorCopy(pulseLoadState.message)}
      actionLabel="Retry"
      onAction={reload}
    />
  ) : isUpcomingMatch ? (
    <PulseStatePanel
      title="Match Pulse begins at kickoff"
      body={`Kickoff ${formatKickoffShort(match.kickoffUtc)}.`}
      actionLabel="Refresh"
      onAction={reload}
    />
  ) : (
    <PulseStatePanel
      title={match.status === 'live' ? 'No match updates yet' : 'No saved Match Pulse yet'}
      body={match.status === 'live'
        ? 'The match story will appear here as moments are confirmed.'
        : 'Refresh to check whether this completed match has been added to the archive.'}
      actionLabel="Refresh"
      onAction={reload}
    />
  );

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

      </View>

      {activeMode === 'pulse' ? (
        <FlatList
          data={pulseItems}
          ref={pulseListRef}
          style={styles.pulseScroll}
          contentContainerStyle={styles.pulseStack}
          contentInsetAdjustmentBehavior="automatic"
          initialNumToRender={12}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={pulseEmptyState}
          ListHeaderComponent={pulseLoadState.status === 'error' && pulseItems.length > 0 ? (
            <PulseStatePanel
              title="Latest update unavailable"
              body="Showing the saved Match Pulse timeline. Try again shortly for the latest moments."
              actionLabel="Retry"
              onAction={reload}
            />
          ) : null}
          maxToRenderPerBatch={12}
          onScrollToIndexFailed={handlePulseJumpFailure}
          removeClippedSubviews={Platform.OS === 'android'}
          renderItem={({ item }) => (
            <PulseMomentRow highlighted={item.id === highlightedPulseId} item={item} />
          )}
          windowSize={9}
        />
      ) : (
        <View style={styles.gameViewContent}>
          <GameViewScreen
            commentaryEntries={pulseLoadState.entries}
            commentaryProjectionGeneration={pulseLoadState.projectionGeneration}
            gameViewIntent={gameViewIntent}
            match={match}
            onPresentationChange={setGamePresentation}
            onTakeoverActiveChange={setGameViewTakeoverActive}
            playback={playback}
          />
          {showFullTimeBoard ? (
            <View style={StyleSheet.absoluteFill}>
              <GameViewFullTimeBoard
                awayTeam={chatAwayTeam}
                homeTeam={chatHomeTeam}
                onPlayHighlights={handlePlayHighlights}
                onWatchFullMatch={handleWatchFullMatch}
                score={{
                  home: match.score?.home ?? gamePresentation?.score.home ?? 0,
                  away: match.score?.away ?? gamePresentation?.score.away ?? 0,
                }}
                scorerTimeline={scorerTimeline}
              />
            </View>
          ) : null}
        </View>
      )}

      <View onLayout={handleCheckpointDockLayout} style={styles.checkpointDock}>
        <GameViewCheckpointRail
          currentClockSeconds={playback.snapshot.currentScene?.clockSeconds}
          model={checkpointRail}
          onSelect={handleCheckpointSelect}
          playheadIndex={playback.snapshot.playheadIndex}
        />
      </View>

      <View onLayout={handleTransportStripLayout}>
        <MatchTransportStrip
          disabled={resolveTransportStripButtonDisabled(match.status)}
          isPaused={resolveTransportStripIsPaused({
            gameViewIntent,
            isPausedByStrip,
            matchStatus: match.status,
          })}
          label={transportStripLabel}
          onPress={handleTransportPress}
          onStop={handleTransportStop}
          onToggleSound={handleToggleSound}
          onToggleVoice={handleToggleVoice}
          showBackToFullTime={showBackToFullTime}
          soundEnabled={soundEnabled}
          voiceEnabled={voiceEnabled}
        />
      </View>

      {/* Item 5: hidden while a Game View takeover or the Gift Reveal
          takeover owns the stage -- restored the instant either clears. */}
      {gameViewTakeoverActive || (economy.pendingGift && !shouldLandAtFullTime(match.status)) ? null : (
        <FloatingChatButton
          bottomOffset={checkpointDockHeight + transportStripHeight + bottomNavigationHeight + tokens.spacing.sm}
          onPress={handleOpenChatSheet}
          unseenOpenChallengeCount={unseenOpenChallengeCount}
        />
      )}

      <View onLayout={handleBottomNavigationLayout} style={styles.detailBottomNavigation}>
        <View accessibilityRole="tablist" style={styles.detailTabs}>
          {([
            { accessibilityLabel: 'Show Match Pulse', label: 'Match Pulse', mode: 'pulse' },
            { accessibilityLabel: 'Show Game View', label: 'Game View', mode: 'game' },
          ] as const).map((tab) => {
            const selected = activeMode === tab.mode;
            return (
              <Pressable
                accessibilityLabel={tab.accessibilityLabel}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                key={tab.mode}
                onPress={() => setActiveMode(tab.mode)}
                style={({ pressed }) => [
                  styles.detailTab,
                  selected && styles.detailTabSelected,
                  pressed && styles.detailTabPressed,
                ]}
              >
                <Text style={selected ? styles.detailTabSelectedText : styles.detailTabText}>
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* PrivyLoginBridge is only ever mounted when Privy is configured --
          calling its hooks unconditionally would throw with no PrivyProvider
          in the tree (see app/_layout.tsx and economy-privy-login-bridge.tsx). */}
      {PRIVY_AVAILABLE ? <PrivyLoginBridge onReady={handlePrivyReady} /> : null}

      {/* Demo decision (2026-07-20): the welcome-gift reveal only shows on
          matches that haven't finished (upcoming/hosted/live) -- a finished
          match opens clean, and the gift stays pending for the next
          not-yet-finished game the user enters. */}
      {economy.pendingGift && !shouldLandAtFullTime(match.status) ? (
        <GiftRevealTakeover
          items={giftRevealItems}
          onClaim={economy.claimGift}
          onDismiss={economy.claimGift}
        />
      ) : null}

      <EconomyPileSheet
        claims={wallet.claims}
        coolness={economy.coolness}
        onCancelLogin={handleCancelLogin}
        onClaimItem={handleClaimItem}
        onClose={() => setPileSheetVisible(false)}
        onStartLogin={handleStartLogin}
        pileRows={pileRows}
        privyAvailable={PRIVY_AVAILABLE}
        visible={pileSheetVisible}
        walletAddress={wallet.walletAddress}
        walletStatus={wallet.walletStatus}
      />

      <EconomyLeaderboardSheet
        onClose={() => setLeaderboardVisible(false)}
        rows={leaderboardSnapshot}
        status="ready"
        visible={leaderboardVisible}
      />

      <MatchChatSheet
        awayTeam={chatAwayTeam}
        chatListRef={chatListRef}
        coolness={economy.coolness}
        homeTeam={chatHomeTeam}
        lastOwnMessageId={lastOwnMessageId}
        onClose={handleCloseChatSheet}
        onPickPinnedChip={handlePickPinnedChip}
        onSend={handleChatSend}
        onStake={economy.takeBet}
        pinnedChips={pinnedChips}
        poolChipLabel={poolChipLabel}
        rows={chatRows}
        stakeCoolness={ECONOMY_FIXED_STAKE_COOLNESS}
        visible={chatSheetVisible}
      />
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

function PulseMomentRow({
  highlighted,
  item,
}: {
  highlighted: boolean;
  item: PulseFeedItem;
}) {
  return (
    <View style={[
      styles.pulseMoment,
      getPulseToneStyle(item.tone),
      highlighted && styles.pulseMomentCheckpoint,
    ]}>
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

/** Item 4: compact "Mon 00:30" form (weekday + 24-hour time, no timezone suffix) for the Match Pulse empty state and the transport strip's kickoff label. */
function formatKickoffShort(kickoffUtc: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
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
    flexShrink: 1,
    gap: tokens.spacing.xs,
    minWidth: 68,
  },
  recentTeamName: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.medium,
    lineHeight: tokens.typography.lineHeight.caption,
    maxWidth: 84,
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
  checkpointDock: {
    backgroundColor: tokens.shell.background,
    borderTopColor: tokens.shell.divider,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: tokens.spacing.md,
  },
  detailBottomNavigation: {
    backgroundColor: tokens.shell.background,
    paddingBottom: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.sm,
    zIndex: 20,
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
  pulseMomentCheckpoint: {
    borderColor: '#F6C453',
    borderWidth: 1,
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
