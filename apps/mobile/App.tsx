import {
  GameCrewMatch,
  gameCrewTokens,
  getMatchResultLabel,
  getMatchTitle,
} from '@gamecrew/core';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Carousel from 'react-native-reanimated-carousel';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

type LoadState =
  | { status: 'loading'; matches: readonly GameCrewMatch[] }
  | { status: 'ready'; matches: readonly GameCrewMatch[] }
  | { status: 'error'; matches: readonly GameCrewMatch[]; message: string };

const tokens = gameCrewTokens;
const gameCrewApiUrl = process.env.EXPO_PUBLIC_GAMECREW_API_URL ?? 'http://localhost:8787';

interface MatchesResponse {
  source: 'txline' | 'sample' | 'sample-fallback';
  matches: readonly GameCrewMatch[];
}

export default function App() {
  const { height, width } = useWindowDimensions();
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedMatch, setSelectedMatch] = useState<GameCrewMatch | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading', matches: [] });
  const carouselWidth = Math.max(1, width - tokens.spacing.lg * 2);
  const carouselHeight = Math.max(520, height - 150);

  const loadMatches = () => {
    setLoadState((current) => ({ status: 'loading', matches: current.matches }));

    fetchGameCrewMatches()
      .then((matches) => setLoadState({ status: 'ready', matches }))
      .catch((error: unknown) =>
        setLoadState((current) => ({
          status: 'error',
          matches: current.matches,
          message: error instanceof Error ? error.message : 'GameCrew API is unavailable.',
        })),
      );
  };

  useEffect(() => {
    loadMatches();
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [loadState.matches]);

  const activeMatch = loadState.matches[activeIndex] ?? loadState.matches[0];

  if (selectedMatch) {
    return (
      <GestureHandlerRootView style={styles.root}>
        <MatchDetailPlaceholder match={selectedMatch} onBack={() => setSelectedMatch(null)} />
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.homeContent}>
        <HomeHeader />

        {loadState.status === 'error' && loadState.matches.length > 0 ? (
          <StateMessage
            eyebrow="Last update failed"
            title="Showing the latest match list we have."
            body="Retry when the local GameCrew API is back online."
            actionLabel="Retry"
            compact
            onAction={loadMatches}
          />
        ) : null}

        {loadState.status === 'loading' && loadState.matches.length === 0 ? (
          <PosterSkeleton />
        ) : loadState.status === 'error' && loadState.matches.length === 0 ? (
          <StateMessage
            eyebrow="TxLINE unavailable"
            title="Could not load matches."
            body={getErrorCopy(loadState.message)}
            actionLabel="Retry"
            onAction={loadMatches}
          />
        ) : activeMatch ? (
          <View style={styles.carousel}>
            <Carousel
              data={[...loadState.matches]}
              enabled
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
              renderItem={({ item }) => (
                <View style={styles.carouselPage}>
                  <MatchPoster
                    height={carouselHeight}
                    match={item}
                    onPress={() => setSelectedMatch(item)}
                  />
                </View>
              )}
              windowSize={3}
              width={carouselWidth}
            />
            <Text style={styles.carouselCount} selectable>
              {activeIndex + 1} / {loadState.matches.length}
            </Text>
          </View>
        ) : (
          <StateMessage
            eyebrow="No fixtures"
            title="No matches found."
            body="Refresh the TxLINE feed to check for available fixtures."
            actionLabel="Refresh"
            onAction={loadMatches}
          />
        )}
      </View>
    </GestureHandlerRootView>
  );
}

async function fetchGameCrewMatches(): Promise<readonly GameCrewMatch[]> {
  const response = await fetch(`${gameCrewApiUrl}/matches`);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(body || `GameCrew API failed with ${response.status}`);
  }

  const parsed = JSON.parse(body) as MatchesResponse;
  return parsed.matches;
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
  height,
  match,
  onPress,
}: {
  height?: number;
  match: GameCrewMatch;
  onPress: () => void;
}) {
  const { width } = useWindowDimensions();
  const posterMinHeight = Math.max(430, Math.min(560, width * 1.2));
  const homeBands = match.homeTeam.flag.bands;
  const awayBands = match.awayTeam.flag.bands;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${getMatchTitle(match)}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.poster,
        { height, minHeight: height ?? posterMinHeight, opacity: pressed ? 0.92 : 1 },
      ]}
    >
      <View style={styles.posterBackdrop}>
        <View
          style={[
            styles.identityGlow,
            {
              backgroundColor: match.homeTeam.colors.primary,
              left: -80,
              top: 20,
            },
          ]}
        />
        <View
          style={[
            styles.identityGlow,
            {
              backgroundColor: match.awayTeam.colors.primary,
              right: -80,
              bottom: 24,
            },
          ]}
        />
      </View>

      <View style={styles.posterChrome}>
        <FlagMark bands={homeBands} />
        <Text style={styles.competitionText} selectable>
          {match.competition}
          {match.round ? ` - ${match.round}` : ''}
        </Text>
        <View style={styles.scoreBlock}>
          <Text style={styles.scoreText} selectable>
            {getMatchResultLabel(match)}
          </Text>
          <Text style={styles.phaseText} selectable>
            {getPhaseCopy(match)}
          </Text>
        </View>
        <FlagMark bands={awayBands} />
      </View>
    </Pressable>
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

function FlagMark({ bands }: { bands: readonly string[] }) {
  return (
    <View style={styles.flagMark}>
      {bands.map((band, index) => (
        <View key={`${band}-${index}`} style={[styles.flagMarkBand, { backgroundColor: band }]} />
      ))}
    </View>
  );
}

function PosterSkeleton() {
  return (
    <View style={styles.skeletonPoster}>
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

function MatchDetailPlaceholder({
  match,
  onBack,
}: {
  match: GameCrewMatch;
  onBack: () => void;
}) {
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.detailContent}
      contentInsetAdjustmentBehavior="automatic"
    >
      <StatusBar style="light" />
      <Pressable accessibilityRole="button" onPress={onBack} style={styles.backButton}>
        <Text style={styles.backButtonText}>Back</Text>
      </Pressable>

      <View style={styles.detailHeader}>
        <FlagField bands={match.homeTeam.flag.bands} align="left" />
        <FlagField bands={match.awayTeam.flag.bands} align="right" />
        <View style={styles.detailHeaderCopy}>
          <Text style={styles.detailKicker} selectable>
            Match Detail
          </Text>
          <Text style={styles.detailTitle} selectable>
            {getMatchTitle(match)}
          </Text>
          <Text style={styles.detailScore} selectable>
            {getMatchResultLabel(match)}
          </Text>
        </View>
      </View>

      <View style={styles.detailTabs} accessibilityRole="tablist">
        <View style={[styles.detailTab, styles.detailTabSelected]}>
          <Text style={styles.detailTabSelectedText}>Match Pulse</Text>
        </View>
        <View style={styles.detailTab}>
          <Text style={styles.detailTabText}>Chat</Text>
        </View>
      </View>

      <View style={styles.pulsePanel}>
        <Text style={styles.pulseTitle} selectable>
          {getPhaseCopy(match)}
        </Text>
        <Text style={styles.pulseBody} selectable>
          Match Pulse placeholder for the selected fixture. TxLINE-backed moments will appear here
          once the live adapter is connected.
        </Text>
      </View>
    </ScrollView>
  );
}

function getPhaseCopy(match: GameCrewMatch): string {
  if (match.status === 'live') {
    return match.clock.label;
  }

  if (match.status === 'upcoming') {
    return formatKickoff(match.kickoffUtc);
  }

  if (match.status === 'replayable') {
    return match.replay?.label ?? 'Replay ready';
  }

  if (match.status === 'hosted') {
    return match.hosted?.label ?? match.clock.label;
  }

  return match.clock.label;
}

function formatKickoff(kickoffUtc: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(kickoffUtc));
}

function getErrorCopy(message: string): string {
  if (message.includes('Network request failed') || message.includes('Failed to fetch')) {
    return 'Start the local GameCrew API, then try again.';
  }

  return 'The local API could not return the TxLINE match feed.';
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: tokens.shell.background,
  },
  homeContent: {
    flexGrow: 1,
    gap: tokens.spacing.lg,
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.xxl,
    paddingTop: tokens.spacing.lg,
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
    boxShadow: tokens.shadows.matchGlow,
    overflow: 'hidden',
  },
  posterBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: tokens.shell.background,
  },
  identityGlow: {
    borderRadius: 140,
    height: 150,
    opacity: 0.18,
    position: 'absolute',
    width: 150,
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
    gap: tokens.spacing.xl,
    justifyContent: 'space-between',
    padding: tokens.spacing.xl,
  },
  competitionText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.medium,
    lineHeight: tokens.typography.lineHeight.caption,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  flagMark: {
    borderRadius: tokens.radii.md,
    boxShadow: '0 0 34px rgba(255, 255, 255, 0.12)',
    flexDirection: 'row',
    height: 104,
    overflow: 'hidden',
    width: 178,
  },
  flagMarkBand: {
    flex: 1,
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
    gap: tokens.spacing.md,
  },
  carouselPage: {
    justifyContent: 'center',
  },
  carouselCount: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontVariant: ['tabular-nums'],
    lineHeight: tokens.typography.lineHeight.caption,
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
  detailContent: {
    flexGrow: 1,
    gap: tokens.spacing.lg,
    padding: tokens.spacing.lg,
    paddingBottom: tokens.spacing.xxl,
  },
  backButton: {
    alignSelf: 'flex-start',
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: 1,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.sm,
  },
  backButtonText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.medium,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  detailHeader: {
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.lg,
    minHeight: 260,
    overflow: 'hidden',
  },
  detailHeaderCopy: {
    flex: 1,
    gap: tokens.spacing.md,
    justifyContent: 'center',
    padding: tokens.spacing.xl,
  },
  detailKicker: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
    textTransform: 'uppercase',
  },
  detailTitle: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.title,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.title,
  },
  detailScore: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.display,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.display,
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
  pulsePanel: {
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.md,
    gap: tokens.spacing.sm,
    padding: tokens.spacing.lg,
  },
  pulseTitle: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.body,
  },
  pulseBody: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.body,
    lineHeight: tokens.typography.lineHeight.body,
  },
});
