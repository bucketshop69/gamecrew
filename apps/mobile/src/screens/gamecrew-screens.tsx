import {
  type GameCrewMatch,
  type MatchPulseCommentaryEntry,
  gameCrewTokens,
  getMatchTitle,
} from '@gamecrew/core';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import Carousel from 'react-native-reanimated-carousel';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useGameCrewMatches } from '../hooks/use-gamecrew-matches';
import { useMatchPulse } from '../hooks/use-match-pulse';
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

export function HomeScreen({ onOpenMatch }: { onOpenMatch: (match: GameCrewMatch) => void }) {
  const { height, width } = useWindowDimensions();
  const [activeIndex, setActiveIndex] = useState(0);
  const { loadState, reload } = useGameCrewMatches();
  const carouselWidth = Math.max(1, width - tokens.spacing.lg * 2);
  const carouselHeight = Math.max(560, height - 130);

  useEffect(() => {
    setActiveIndex((current) =>
      loadState.matches.length === 0 ? 0 : Math.min(current, loadState.matches.length - 1),
    );
  }, [loadState.matches.length]);

  const activeMatch = loadState.matches[activeIndex] ?? loadState.matches[0];

  return (
    <View style={styles.root}>
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
            onAction={reload}
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
            onAction={reload}
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
                    onPress={() => onOpenMatch(item)}
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
            onAction={reload}
          />
        )}
      </View>
    </View>
  );
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
