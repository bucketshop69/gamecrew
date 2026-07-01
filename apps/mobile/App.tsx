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

type PulseTone = 'major' | 'danger' | 'building' | 'quiet';

interface PulseFeedItem {
  id: string;
  minute: string;
  title: string;
  meta: string;
  tone: PulseTone;
  verified?: boolean;
}

export default function App() {
  const { height, width } = useWindowDimensions();
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedMatch, setSelectedMatch] = useState<GameCrewMatch | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading', matches: [] });
  const carouselWidth = Math.max(1, width - tokens.spacing.lg * 2);
  const carouselHeight = Math.max(560, height - 130);

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
            <CarouselDots activeIndex={activeIndex} count={loadState.matches.length} />
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
  const isUpcoming = match.status === 'upcoming' && !match.score;

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
      <View style={styles.posterBackdrop} />

      <View style={styles.posterChrome}>
        {isUpcoming ? (
          <UpcomingPosterContent match={match} />
        ) : (
          <LivePosterContent homeBands={homeBands} awayBands={awayBands} match={match} />
        )}
      </View>
    </Pressable>
  );
}

function LivePosterContent({
  awayBands,
  homeBands,
  match,
}: {
  awayBands: readonly string[];
  homeBands: readonly string[];
  match: GameCrewMatch;
}) {
  return (
    <View style={styles.posterStack}>
      <FlagMark bands={homeBands} countryCode={match.homeTeam.countryCode} />
      <Text style={styles.teamScoreText} selectable>
        {getTeamCardLabel(match, 'home')}
      </Text>
      <Text style={styles.clockText} selectable>
        {getClockCardLabel(match)}
      </Text>
      <Text style={styles.matchupText} selectable>
        {getMatchTitle(match)}
      </Text>
      <Text style={styles.competitionText} selectable>
        {getMetaLabel(match)}
      </Text>
      <Text style={styles.teamScoreText} selectable>
        {getTeamCardLabel(match, 'away')}
      </Text>
      <FlagMark bands={awayBands} countryCode={match.awayTeam.countryCode} />
    </View>
  );
}

function UpcomingPosterContent({ match }: { match: GameCrewMatch }) {
  return (
    <View style={styles.posterStack}>
      <FlagMark bands={match.homeTeam.flag.bands} countryCode={match.homeTeam.countryCode} />
      <Text style={styles.kickoffDateText} selectable>
        {formatKickoffDate(match.kickoffUtc)}
      </Text>
      <Text style={styles.kickoffTimeText} selectable>
        {formatKickoffTime(match.kickoffUtc)}
      </Text>
      <Text style={styles.matchupText} selectable>
        {getMatchTitle(match)}
      </Text>
      <Text style={styles.competitionText} selectable>
        {getMetaLabel(match)}
      </Text>
      <FlagMark bands={match.awayTeam.flag.bands} countryCode={match.awayTeam.countryCode} />
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

function FlagMark({ bands, countryCode }: { bands: readonly string[]; countryCode?: string }) {
  return (
    <View style={[styles.flagMark, getFlagDirection(countryCode) === 'horizontal' && styles.flagMarkHorizontal]}>
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
  const pulseItems = getPulseFeedItems(match);

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
        <View style={styles.detailTeamColumn}>
          <MiniFlag bands={match.homeTeam.flag.bands} countryCode={match.homeTeam.countryCode} />
          <Text style={styles.detailTeamName} selectable>
            {match.homeTeam.shortName}
          </Text>
          <Text style={styles.detailTeamScore} selectable>
            {getDetailScoreLabel(match, 'home')}
          </Text>
        </View>

        <View style={styles.detailCenterColumn}>
          <Text style={styles.detailClock} selectable>
            {getClockCardLabel(match)}
          </Text>
          <Text style={styles.detailTitle} selectable>
            {getMatchTitle(match)}
          </Text>
          <Text style={styles.detailMeta} selectable>
            {getMetaLabel(match)}
          </Text>
        </View>

        <View style={styles.detailTeamColumn}>
          <MiniFlag bands={match.awayTeam.flag.bands} countryCode={match.awayTeam.countryCode} />
          <Text style={styles.detailTeamName} selectable>
            {match.awayTeam.shortName}
          </Text>
          <Text style={styles.detailTeamScore} selectable>
            {getDetailScoreLabel(match, 'away')}
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

      <View style={styles.pulseStack}>
        {pulseItems.map((item) => (
          <PulseMomentRow key={item.id} item={item} />
        ))}
      </View>

      <View style={styles.chatPanel}>
        <Text style={styles.pulseTitle} selectable>
          Chat
        </Text>
        <View style={styles.chatBubble}>
          <Text style={styles.chatName} selectable>
            Maya
          </Text>
          <Text style={styles.chatText} selectable>
            That pressure is building.
          </Text>
        </View>
        <View style={[styles.chatBubble, styles.chatBubbleAlt]}>
          <Text style={styles.chatName} selectable>
            Dev
          </Text>
          <Text style={styles.chatText} selectable>
            Need one more clean chance.
          </Text>
        </View>
        <View style={styles.chatInput}>
          <Text style={styles.chatInputText}>Message the crew</Text>
        </View>
      </View>
    </ScrollView>
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
          {item.verified ? (
            <Text style={styles.pulseVerified} selectable>
              Verified
            </Text>
          ) : null}
        </View>
        <Text style={styles.pulseBody} selectable>
          {item.meta}
        </Text>
      </View>
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

function getDetailScoreLabel(match: GameCrewMatch, side: 'home' | 'away'): string {
  if (!match.score) {
    return '-';
  }

  return String(side === 'home' ? match.score.home : match.score.away);
}

function getPulseFeedItems(match: GameCrewMatch): readonly PulseFeedItem[] {
  const items: PulseFeedItem[] = [];

  if (match.pulse) {
    const presentation = getPulseActionPresentation(match.pulse.action, match.pulse.label);
    items.push({
      id: 'latest-pulse',
      minute: getClockCardLabel(match),
      title: presentation.title,
      meta: presentation.meta,
      tone: presentation.tone,
      verified: match.pulse.verified,
    });
  } else {
    items.push({
      id: 'match-state',
      minute: getClockCardLabel(match),
      title: getPhaseCopy(match),
      meta: match.status === 'upcoming' ? 'Kickoff schedule from TxLINE' : 'Current match state',
      tone: 'quiet',
    });
  }

  if (match.score) {
    items.push({
      id: 'score-state',
      minute: match.status === 'replayable' || match.status === 'finished' ? 'FT' : getClockCardLabel(match),
      title: `${match.homeTeam.shortName} ${match.score.home} - ${match.score.away} ${match.awayTeam.shortName}`,
      meta: getMetaLabel(match),
      tone: match.status === 'live' ? 'building' : 'quiet',
    });
  }

  return items;
}

function getPulseActionPresentation(
  action: string | undefined,
  fallbackLabel: string,
): Pick<PulseFeedItem, 'title' | 'meta' | 'tone'> {
  switch (action) {
    case 'goal':
      return { title: 'Goal', meta: fallbackLabel, tone: 'major' };
    case 'shot':
      return { title: 'Shot', meta: fallbackLabel, tone: 'danger' };
    case 'corner':
      return { title: 'Corner', meta: fallbackLabel, tone: 'danger' };
    case 'penalty':
      return { title: 'Penalty moment', meta: fallbackLabel, tone: 'major' };
    case 'red_card':
      return { title: 'Red card', meta: fallbackLabel, tone: 'major' };
    case 'yellow_card':
      return { title: 'Yellow card', meta: fallbackLabel, tone: 'building' };
    case 'substitution':
      return { title: 'Substitution', meta: fallbackLabel, tone: 'quiet' };
    case 'free_kick':
      return { title: 'Free kick', meta: fallbackLabel, tone: 'building' };
    case 'attack_possession':
      return { title: 'Attack building', meta: fallbackLabel, tone: 'building' };
    case 'danger_possession':
    case 'high_danger_possession':
      return { title: 'Danger attack', meta: fallbackLabel, tone: 'danger' };
    case 'safe_possession':
    case 'possession':
      return { title: 'Possession', meta: fallbackLabel, tone: 'quiet' };
    case 'throw_in':
      return { title: 'Throw-in', meta: fallbackLabel, tone: 'quiet' };
    case 'goal_kick':
      return { title: 'Goal kick', meta: fallbackLabel, tone: 'quiet' };
    case 'var':
      return { title: 'VAR check', meta: fallbackLabel, tone: 'danger' };
    case 'injury':
      return { title: 'Injury stoppage', meta: fallbackLabel, tone: 'building' };
    default:
      return { title: fallbackLabel, meta: 'TxLINE match event', tone: 'quiet' };
  }
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

function getFlagDirection(countryCode?: string): 'horizontal' | 'vertical' {
  return horizontalFlagCodes.has(countryCode ?? '') ? 'horizontal' : 'vertical';
}

const horizontalFlagCodes = new Set(['AR', 'CO', 'DE', 'EC', 'NL', 'SN']);

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
  competitionText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
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
  teamScoreText: {
    color: tokens.shell.text,
    fontSize: 62,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: 66,
    textAlign: 'center',
  },
  clockText: {
    color: tokens.shell.text,
    fontSize: 54,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: 58,
    textAlign: 'center',
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
    alignItems: 'center',
    backgroundColor: tokens.shell.background,
    flexDirection: 'row',
    gap: tokens.spacing.md,
    justifyContent: 'space-between',
    minHeight: 176,
    overflow: 'hidden',
    paddingVertical: tokens.spacing.lg,
  },
  detailTeamColumn: {
    alignItems: 'center',
    flex: 1,
    gap: tokens.spacing.sm,
    justifyContent: 'center',
  },
  detailCenterColumn: {
    alignItems: 'center',
    flex: 1.35,
    gap: tokens.spacing.sm,
    justifyContent: 'center',
  },
  miniFlag: {
    borderRadius: tokens.radii.sm,
    flexDirection: 'row',
    height: 50,
    overflow: 'hidden',
    width: 78,
  },
  miniFlagHorizontal: {
    flexDirection: 'column',
  },
  detailTeamName: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
    textTransform: 'uppercase',
  },
  detailTeamScore: {
    color: tokens.shell.text,
    fontSize: 48,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: 52,
    textAlign: 'center',
  },
  detailClock: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.title,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.title,
    textAlign: 'center',
  },
  detailTitle: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
    textAlign: 'center',
  },
  detailMeta: {
    color: tokens.shell.textDim,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
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
  },
  pulseTitle: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.body,
  },
  pulseBody: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
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
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.body,
  },
  pulseVerified: {
    color: tokens.shell.textDim,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
    textTransform: 'uppercase',
  },
  chatPanel: {
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.md,
    gap: tokens.spacing.md,
    padding: tokens.spacing.lg,
  },
  chatBubble: {
    alignSelf: 'flex-start',
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.md,
    gap: tokens.spacing.xs,
    maxWidth: '82%',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  chatBubbleAlt: {
    alignSelf: 'flex-end',
  },
  chatName: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  chatText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    lineHeight: tokens.typography.lineHeight.body,
  },
  chatInput: {
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: 1,
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.lg,
  },
  chatInputText: {
    color: tokens.shell.textDim,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.medium,
    lineHeight: tokens.typography.lineHeight.caption,
  },
});
