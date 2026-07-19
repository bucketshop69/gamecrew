import { gameCrewTokens, type EconomyItemId, type MatchEngineParticipant } from '@gamecrew/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { CelebrationParticleBurst } from './game-view-takeovers/celebration-particles';
import { useReducedMotionPreference } from './game-view-takeovers/takeover-shared';
import {
  isScrollAtBottom,
  resolveNewMessagesPillVisible,
  shouldAutoScrollOnContentChange,
} from './global-chat-scroll-logic';
import {
  classifyPromptRowDisplay,
  promptRowCompactOutcomeText,
  promptTakenPillText,
  type GlobalChatRow,
} from './global-chat-logic';

const tokens = gameCrewTokens;

/** Home/away identity for the who-scores-next team-pick card -- team names + a single representative color, sourced from `MatchDetailScreen`'s own match context (a match-owned surface, so team color is allowed here per the UX spec's call-card section, used sparingly as a border accent only, matching the rarity-border convention already established in the stash sheet). */
export interface ChatTeamIdentity {
  name: string;
  color: string;
  participant: MatchEngineParticipant;
}

/** Emoji shown on a Call card's stake button, keyed by item id (mirrors ECONOMY_ITEM_CATALOGUE -- kept local so this render layer needs no runtime import from @gamecrew/core beyond the type). */
const STAKE_EMOJI: Record<EconomyItemId, string> = {
  dust: '✨',
  bananas: '🍌',
  rubber_duck: '🦆',
  traffic_cone: '🚧',
  pizza: '🍕',
  boombox: '📻',
  jetski: '🚤',
  lambo: '🏎️',
};

/**
 * UX review should-fix ("Celebration replay on row remount"): `WinRow`'s
 * spring and `PoolSplitRow`'s particle burst previously re-ran every time
 * the row scrolled out of the FlatList's render window and back in
 * (`windowSize`/`removeClippedSubviews` unmount+remount off-screen rows),
 * breaking the "deliberately rare, once per match" framing for the pool
 * split in particular. Module-level (not per-component-instance) so it
 * survives the row unmounting and remounting, keyed by the row's own stable
 * `id` (each event's `id` is itself stable/deterministic per
 * `packages/core`'s `eventId()` -- see economy.ts), matching this app's
 * existing pattern of a plain module-level `Set` for one-shot state (no
 * persistence needed; a fresh app session naturally resets it, which is
 * the desired behavior -- reopening the app and revisiting a finished
 * match's chat is a fresh viewing, not a replay of the live moment).
 */
const celebratedRowIds = new Set<string>();

function lookupStakeEmoji(itemId: EconomyItemId): { emoji: string; label: string; rarityTier: number } {
  // Only the emoji is ever read from this local lookup by ChatRow; label/rarityTier are unused placeholders to satisfy the shared EconomyItemLookup shape used by promptTakenPillText.
  return { emoji: STAKE_EMOJI[itemId], label: itemId, rarityTier: 1 };
}

/**
 * Global Chat tab content: a FlatList of interleaved room chatter, match
 * moments, Gift reveals, Call cards, social proof, settlement lines, the
 * user's own chat messages, and Gift Pool moments -- following the same
 * FlatList-of-rows shape the Match Pulse tab already uses in
 * gamecrew-screens.tsx (PulseMomentRow / getPulseFeedItems).
 *
 * Round 5/item 2: scrolling now follows a "live chat" standard instead of
 * unconditionally yanking to the end on every content-size change (which
 * previously yanked the list even while the user was reading scrolled up,
 * and made reaction sends visibly jump the feed). See
 * global-chat-scroll-logic.ts for the pure decisions this wires up:
 * - new content auto-scrolls only when the user was already at (or near)
 *   the bottom;
 * - the user's OWN sent message always scrolls to bottom -- signaled via
 *   `lastOwnMessageId`, which the caller (match-chat-sheet.tsx's `onSend`
 *   wiring) bumps to the row id of whatever `user_chat` row a send produces;
 * - when scrolled up and new rows arrive, a floating "New messages" pill
 *   appears over the feed's bottom edge; tapping it scrolls down, and it
 *   hides again once at bottom.
 *
 * `onScrollBeginDrag` dismisses the keyboard on scroll-drag (spec section 5)
 * so browsing history doesn't fight an open keyboard from the composer below.
 */
export function GlobalChatFeed({
  awayTeam,
  emptyLabel,
  homeTeam,
  lastOwnMessageId,
  listRef,
  onScrollBeginDrag,
  onStake,
  rows,
  stakeCoolness,
}: {
  awayTeam: ChatTeamIdentity;
  emptyLabel: string;
  homeTeam: ChatTeamIdentity;
  /** The row id of the most recently sent-by-the-user message, if any -- a change in this value always scrolls to bottom regardless of current scroll position (item 2). */
  lastOwnMessageId?: string;
  listRef: React.RefObject<FlatList<GlobalChatRow> | null>;
  onScrollBeginDrag?: () => void;
  onStake: (promptId: string, itemId: EconomyItemId, pickedParticipant?: MatchEngineParticipant) => void;
  rows: readonly GlobalChatRow[];
  stakeCoolness: number;
}) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const previousRowCountRef = useRef<number | undefined>(undefined);
  const previousLastOwnMessageIdRef = useRef<string | undefined>(undefined);
  const [pillVisible, setPillVisible] = useState(false);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const atBottom = isScrollAtBottom({
      contentOffsetY: contentOffset.y,
      contentHeight: contentSize.height,
      layoutHeight: layoutMeasurement.height,
    });
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
    if (atBottom) setPillVisible(false);
  }, []);

  const scrollToBottom = useCallback((animated: boolean) => {
    listRef.current?.scrollToEnd({ animated });
  }, [listRef]);

  const handleContentSizeChange = useCallback(() => {
    const previousRowCount = previousRowCountRef.current;
    const nextRowCount = rows.length;
    const wasAtBottom = isAtBottomRef.current;

    const shouldScroll = shouldAutoScrollOnContentChange({
      lastOwnMessageId,
      nextRowCount,
      previousLastOwnMessageId: previousLastOwnMessageIdRef.current,
      previousRowCount,
      wasAtBottom,
    });
    const pillShouldShow = resolveNewMessagesPillVisible({
      isAtBottom: wasAtBottom,
      nextRowCount,
      previousRowCount,
    }) && !shouldScroll;

    previousRowCountRef.current = nextRowCount;
    previousLastOwnMessageIdRef.current = lastOwnMessageId;

    if (shouldScroll) {
      scrollToBottom(previousRowCount !== undefined);
      return;
    }
    if (pillShouldShow) setPillVisible(true);
  }, [lastOwnMessageId, rows.length, scrollToBottom]);

  const handlePillPress = useCallback(() => {
    scrollToBottom(true);
    setPillVisible(false);
  }, [scrollToBottom]);

  return (
    <View style={styles.feedRoot}>
      <FlatList
        contentContainerStyle={styles.stack}
        data={rows as GlobalChatRow[]}
        initialNumToRender={16}
        keyExtractor={(row) => row.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={styles.emptyText}>{emptyLabel}</Text>}
        maxToRenderPerBatch={16}
        onContentSizeChange={handleContentSizeChange}
        onScroll={handleScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        ref={listRef}
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item }) => (
          <ChatRow awayTeam={awayTeam} homeTeam={homeTeam} onStake={onStake} row={item} stakeCoolness={stakeCoolness} />
        )}
        scrollEventThrottle={16}
        style={styles.list}
        windowSize={9}
      />
      {pillVisible && !isAtBottom ? (
        <Pressable
          accessibilityLabel="New messages, scroll to bottom"
          accessibilityRole="button"
          onPress={handlePillPress}
          style={styles.newMessagesPill}
        >
          <Text style={styles.newMessagesPillText}>New messages ↓</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ChatRow({
  awayTeam,
  homeTeam,
  onStake,
  row,
  stakeCoolness,
}: {
  awayTeam: ChatTeamIdentity;
  homeTeam: ChatTeamIdentity;
  onStake: (promptId: string, itemId: EconomyItemId, pickedParticipant?: MatchEngineParticipant) => void;
  row: GlobalChatRow;
  stakeCoolness: number;
}) {
  switch (row.kind) {
    case 'chatter':
      return (
        <Text style={styles.chatterText} selectable>
          {row.text}
        </Text>
      );
    case 'match_moment':
      return (
        <View style={styles.momentPill}>
          <Text style={styles.momentText} selectable>{row.text}</Text>
        </View>
      );
    case 'user_chat':
      // UX spec section 5: plain text-colored body-size text, right-aligned
      // -- no bubble, no card background (bubbles would be this product's
      // one chat-app cliché, and every other row here is bare text or a
      // bordered card, never a colored speech bubble).
      return (
        <View style={styles.userChatRow}>
          <Text style={styles.userChatText} selectable>{row.text}</Text>
        </View>
      );
    case 'gift_reveal':
      return (
        <View style={styles.dropRow}>
          <Text style={styles.dropText} selectable>{row.text}</Text>
        </View>
      );
    case 'pool_seeded':
      // Reuses momentPill's shell (UX spec section 3: "keep the shell as
      // is") -- this is the once-per-match, first-in-stream announcement.
      return (
        <View style={styles.momentPill}>
          <Text style={styles.momentText} selectable>{row.text}</Text>
        </View>
      );
    case 'pool_split':
      return <PoolSplitRow row={row} />;
    case 'prompt': {
      const isTeamPick = row.predicate === 'who_scores_next';
      const takenTeamName = row.takenParticipant === homeTeam.participant
        ? homeTeam.name
        : row.takenParticipant === awayTeam.participant
          ? awayTeam.name
          : undefined;

      // Item 16 (fix round): a closed/resolved call ('taken' or 'closed' --
      // nothing actionable left) collapses to a single compact one-line row
      // instead of stacking as a full card into the feed's activity log;
      // only a genuinely open, actionable call keeps the full card.
      if (classifyPromptRowDisplay(row) === 'compact') {
        return (
          <View style={styles.promptCompactRow}>
            <Text numberOfLines={1} style={styles.promptCompactCopy}>
              {row.copy}
            </Text>
            <Text numberOfLines={1} style={styles.promptCompactOutcome}>
              {promptRowCompactOutcomeText(row, lookupStakeEmoji, takenTeamName)}
            </Text>
          </View>
        );
      }

      return (
        <View style={styles.promptCard}>
          <Text style={styles.promptCopy}>{row.copy}</Text>
          {isTeamPick ? (
            <TeamPickButtons
              awayTeam={awayTeam}
              homeTeam={homeTeam}
              onPick={(participant) => onStake(row.promptId, row.stakeItemId, participant)}
              stakeCoolness={stakeCoolness}
              stakeEmoji={STAKE_EMOJI[row.stakeItemId]}
            />
          ) : (
            <Pressable
              accessibilityLabel={`Stake ${STAKE_EMOJI[row.stakeItemId]} and ${stakeCoolness} coolness on: ${row.copy}`}
              accessibilityRole="button"
              onPress={() => onStake(row.promptId, row.stakeItemId)}
              style={({ pressed }) => [styles.stakeButton, pressed && styles.stakeButtonPressed]}
            >
              <Text style={styles.stakeButtonText}>
                Stake {STAKE_EMOJI[row.stakeItemId]} · −{stakeCoolness} coolness
              </Text>
            </Pressable>
          )}
        </View>
      );
    }
    case 'social_proof':
      return (
        <Text style={styles.socialProofText} selectable>
          {row.text}
        </Text>
      );
    case 'settlement_win':
      return <WinRow id={row.id} itemDeltas={row.itemDeltas} text={row.text} />;
    case 'settlement_loss':
      return (
        <Text style={styles.lossText} selectable>
          {row.text}
        </Text>
      );
    case 'settlement_voided':
      return (
        <View style={styles.voidedRow}>
          <Text style={styles.voidedText} selectable>{row.text}</Text>
        </View>
      );
    default:
      return null;
  }
}

/**
 * Team-pick card for a `who_scores_next` Call (QA HIGH fix): two buttons,
 * home and away, replacing the single stake button. Tapping either both
 * picks the team and stakes the auto-picked item in one action (still
 * "single tap, no picker" per the PRD -- the picker here is which team,
 * not how much or which item, so it doesn't reintroduce the stake-amount
 * picker the PRD explicitly rules out).
 *
 * Team color is used sparingly -- a thin border accent only, matching the
 * rarity-border convention already established in the stash sheet -- not a
 * filled background, since this call card otherwise stays in the app's
 * monochrome chrome per the UX spec's overall restraint. `MatchDetailScreen`
 * is a match-owned surface, so this is allowed (unlike the rest of the chat
 * tab's chrome, which stays black/white/gray).
 */
function TeamPickButtons({
  awayTeam,
  homeTeam,
  onPick,
  stakeCoolness,
  stakeEmoji,
}: {
  awayTeam: ChatTeamIdentity;
  homeTeam: ChatTeamIdentity;
  onPick: (participant: MatchEngineParticipant) => void;
  stakeCoolness: number;
  stakeEmoji: string;
}) {
  return (
    <View style={styles.teamPickRow}>
      {[homeTeam, awayTeam].map((team) => (
        <Pressable
          accessibilityLabel={`Stake ${stakeEmoji} and ${stakeCoolness} coolness on ${team.name} to score next`}
          accessibilityRole="button"
          key={team.participant}
          onPress={() => onPick(team.participant)}
          style={({ pressed }) => [styles.teamPickButton, { borderColor: team.color }, pressed && styles.stakeButtonPressed]}
        >
          {/* Item 12: the button shows its real cost, not just the team --
              e.g. "France · 10 ⚡" -- sourced from the prompt's own
              stakeCoolness (ECONOMY_FIXED_STAKE_COOLNESS), never hardcoded. */}
          <Text numberOfLines={1} style={styles.teamPickButtonText}>
            {team.name} · {stakeCoolness} {stakeEmoji}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Call win row: the loudest thing that happens inside the ordinary stream,
 * calibrated per spec as "accent color + a spring pop, not a burst" -- the
 * particle burst is reserved for the Gift Reveal popup and the Gift Pool
 * split, never a per-win occurrence (reusing it here would cheapen both).
 * One-shot entrance: scale 0.92->1 with the same spring used by Gift
 * Reveal's card entrance. Reduce motion: renders at rest immediately.
 */
function WinRow({
  id,
  itemDeltas,
  text,
}: {
  id: string;
  itemDeltas: readonly { itemId: EconomyItemId; quantity: number }[];
  text: string;
}) {
  const reduceMotion = useReducedMotionPreference();
  // Already celebrated (e.g. this row scrolled out of the FlatList's render
  // window and back in) -- render at rest immediately, same as reduce
  // motion, rather than replaying the spring.
  const alreadyCelebrated = useRef(celebratedRowIds.has(id)).current;
  const skipAnimation = reduceMotion || alreadyCelebrated;
  const scale = useSharedValue(skipAnimation ? 1 : 0.92);
  const opacity = useSharedValue(skipAnimation ? 1 : 0);

  useEffect(() => {
    if (skipAnimation) return;
    celebratedRowIds.add(id);
    scale.value = withSpring(1, { damping: 14, stiffness: 180 });
    opacity.value = withSpring(1, { damping: 20, stiffness: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipAnimation]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  return (
    <Reanimated.View style={[styles.winCard, style]}>
      <Text style={styles.winText} selectable>{text}</Text>
      {itemDeltas.length > 0 ? (
        <Text style={styles.winPayoutText}>
          {itemDeltas.map((delta) => `+${delta.quantity} ${STAKE_EMOJI[delta.itemId]}`).join(', ')}
        </Text>
      ) : null}
    </Reanimated.View>
  );
}

/**
 * Gift Pool full-time split row (UX spec section 3) -- the one other moment
 * (besides a Call win) allowed the spring/particle celebration grammar,
 * transplanting `GiftRevealTakeover`'s reveal-beat visual grammar in-stream
 * rather than as a full-screen modal (this is a room event, not a personal
 * gate -- it must never block interaction the way the popup can).
 *
 * The `noWinners` case renders plainly with no burst at all, per spec:
 * "this is the one Gift-Pool moment that should NOT burst, because nothing
 * was won."
 */
function PoolSplitRow({ row }: { row: GlobalChatRow & { kind: 'pool_split' } }) {
  const reduceMotion = useReducedMotionPreference();
  // Once-per-session guard (UX review should-fix): the split is "deliberately
  // rare, once per match" -- scrolling back up to it later must not replay
  // the 24-particle burst.
  const alreadyCelebrated = useRef(celebratedRowIds.has(row.id)).current;
  const skipAnimation = reduceMotion || alreadyCelebrated;
  const scale = useSharedValue(skipAnimation ? 1 : 0.86);
  const opacity = useSharedValue(skipAnimation ? 1 : 0);
  const celebrate = !skipAnimation && !row.noWinners && row.itemDeltas.length > 0;

  useEffect(() => {
    if (skipAnimation) return;
    celebratedRowIds.add(row.id);
    scale.value = withSpring(1, { damping: 14, stiffness: 180 });
    opacity.value = withSpring(1, { damping: 20, stiffness: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipAnimation]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  return (
    <Reanimated.View style={[styles.poolSplitCard, style]}>
      {celebrate ? (
        <CelebrationParticleBurst
          emojiPool={row.itemDeltas.map((delta) => STAKE_EMOJI[delta.itemId])}
          seed={row.itemDeltas.length * 2654435761 + 7}
        />
      ) : null}
      <Text style={styles.poolSplitEyebrow}>Full time</Text>
      <Text style={styles.poolSplitHeadline}>Gift Pool split!</Text>
      <Text style={styles.poolSplitBody} selectable>{row.text}</Text>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  feedRoot: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  newMessagesPill: {
    alignSelf: 'center',
    backgroundColor: tokens.shell.text,
    borderRadius: tokens.radii.pill,
    bottom: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.sm,
    position: 'absolute',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  newMessagesPillText: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
  },
  stack: {
    gap: tokens.spacing.sm,
    paddingBottom: tokens.spacing.xxl,
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.sm,
  },
  emptyText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.body,
    paddingVertical: tokens.spacing.xl,
    textAlign: 'center',
  },
  chatterText: {
    color: tokens.shell.textDim,
    fontSize: tokens.typography.size.label,
    fontStyle: 'italic',
  },
  momentPill: {
    alignSelf: 'flex-start',
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.pill,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  momentText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 0.5,
  },
  userChatRow: {
    alignItems: 'flex-end',
  },
  userChatText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    maxWidth: '85%',
    textAlign: 'right',
  },
  dropRow: {
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.md,
    padding: tokens.spacing.md,
  },
  dropText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.medium,
  },
  promptCard: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: tokens.spacing.sm,
    padding: tokens.spacing.lg,
  },
  promptCopy: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
  },
  stakeButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: tokens.shell.text,
    borderRadius: tokens.radii.pill,
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.lg,
  },
  stakeButtonPressed: {
    opacity: 0.7,
  },
  stakeButtonText: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
  },
  teamPickRow: {
    flexDirection: 'row',
    gap: tokens.spacing.sm,
  },
  teamPickButton: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.pill,
    borderWidth: 1.5,
    flex: 1,
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.md,
  },
  teamPickButtonText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
  },
  /** Item 16 (fix round): closed/resolved calls -- question + outcome on one muted line, no card shell, no buttons. */
  promptCompactRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.xs,
  },
  promptCompactCopy: {
    color: tokens.shell.textDim,
    flexShrink: 1,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.medium,
  },
  promptCompactOutcome: {
    color: tokens.shell.textMuted,
    flexShrink: 0,
    fontSize: tokens.typography.size.caption,
  },
  socialProofText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
    paddingLeft: tokens.spacing.md,
  },
  winCard: {
    backgroundColor: '#1D2A1D',
    borderRadius: tokens.radii.md,
    gap: tokens.spacing.xs,
    padding: tokens.spacing.md,
  },
  winText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
  },
  winPayoutText: {
    color: '#8FD98F',
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
  },
  lossText: {
    color: tokens.shell.textDim,
    fontSize: tokens.typography.size.caption,
    paddingLeft: tokens.spacing.md,
  },
  voidedRow: {
    backgroundColor: tokens.shell.surface,
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: tokens.spacing.md,
  },
  voidedText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontStyle: 'italic',
  },
  poolSplitCard: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: tokens.spacing.xs,
    overflow: 'hidden',
    padding: tokens.spacing.lg,
    position: 'relative',
  },
  poolSplitEyebrow: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  poolSplitHeadline: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.title,
    fontWeight: tokens.typography.weight.bold,
  },
  poolSplitBody: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.body,
  },
});
