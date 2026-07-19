import { gameCrewTokens, type EconomyItemId, type MatchEngineParticipant } from '@gamecrew/core';
import { FlatList, Keyboard, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { GlobalChatFeed, type ChatTeamIdentity } from './global-chat-feed';
import { GlobalChatReactionsComposer } from './global-chat-reactions-composer';
import type { GlobalChatRow } from './global-chat-logic';
import type { PinnedChallengeChip } from './match-chat-sheet-logic';
import { PinnedChallengesStrip } from './pinned-challenges-strip';

const tokens = gameCrewTokens;

/**
 * Chat slide-up sheet (demo-lockdown item 4) -- follows the EXACT existing
 * sheet pattern established by economy-pile-sheet.tsx/economy-leaderboard-sheet.tsx:
 * a transparent `Modal` with `animationType="slide"`, a tappable-to-dismiss
 * backdrop, a drag handle, and `tokens.shell.surface` sheet chrome. Rendered
 * as an overlay `Modal` (not a route/screen swap) so `MatchDetailScreen`'s
 * content underneath is never unmounted -- playback and commentary voice
 * keep running exactly as they do on the Pulse/Game tabs while this sheet is
 * open (see gamecrew-screens.tsx's `enterListeningSession` call and
 * state/commentary-listening-session.ts, which owns playback/commentary
 * voice at the module level now -- unaffected by this sheet's visible state,
 * or by MatchDetailScreen's own mounted state at all).
 *
 * Round 5/item 3: Board and Stash left this header entirely -- chat is now
 * conversation + challenges only. Stash re-homed to the profile sheet;
 * Board re-homed to the FT board's recap row (see match-recap-row.tsx's
 * `onOpenBoard`). Only the pool chip stays here (it's conversation-adjacent
 * context, not a navigation affordance).
 *
 * Contains, top to bottom: the chat header row (coolness, pool chip), the
 * pinned challenges strip (item 11), the existing `GlobalChatFeed`, and the
 * reactions-only composer (item 9, replacing `GlobalChatComposer` inside the
 * sheet only -- the old composer component file is untouched and simply
 * unused here).
 */
export function MatchChatSheet({
  awayTeam,
  chatListRef,
  coolness,
  homeTeam,
  lastOwnMessageId,
  onClose,
  onPickPinnedChip,
  onSend,
  onStake,
  pinnedChips,
  poolChipLabel,
  rows,
  stakeCoolness,
  visible,
}: {
  awayTeam: ChatTeamIdentity;
  chatListRef: React.RefObject<FlatList<GlobalChatRow> | null>;
  coolness: number;
  homeTeam: ChatTeamIdentity;
  /** Item 2: the row id of the most recently sent-by-the-user message -- threaded straight through to `GlobalChatFeed`. */
  lastOwnMessageId?: string;
  onClose: () => void;
  onPickPinnedChip: (promptId: string) => void;
  onSend: (text: string) => boolean;
  onStake: (promptId: string, itemId: EconomyItemId, pickedParticipant?: MatchEngineParticipant) => void;
  pinnedChips: readonly PinnedChallengeChip[];
  poolChipLabel: string;
  rows: readonly GlobalChatRow[];
  stakeCoolness: number;
  visible: boolean;
}) {
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="Close chat" accessibilityRole="button" onPress={onClose} style={styles.backdropTap} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Chat</Text>
            <View style={styles.headerActions}>
              <Text style={styles.coolnessLabel}>Coolness {coolness}</Text>
              <Text numberOfLines={1} style={styles.poolChipText}>{poolChipLabel}</Text>
            </View>
            <Pressable accessibilityLabel="Close chat" accessibilityRole="button" onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>Close</Text>
            </Pressable>
          </View>

          <PinnedChallengesStrip
            awayTeam={awayTeam}
            chips={pinnedChips}
            homeTeam={homeTeam}
            onPickChip={onPickPinnedChip}
          />

          <View style={styles.feedWrap}>
            <GlobalChatFeed
              awayTeam={awayTeam}
              emptyLabel="The room is quiet -- check back once the match gets going."
              homeTeam={homeTeam}
              lastOwnMessageId={lastOwnMessageId}
              listRef={chatListRef}
              onScrollBeginDrag={Keyboard.dismiss}
              onStake={onStake}
              rows={rows}
              stakeCoolness={stakeCoolness}
            />
          </View>

          <GlobalChatReactionsComposer onSend={onSend} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdropTap: StyleSheet.absoluteFill,
  sheet: {
    backgroundColor: tokens.shell.surface,
    borderTopLeftRadius: tokens.radii.lg,
    borderTopRightRadius: tokens.radii.lg,
    height: '86%',
    paddingTop: tokens.spacing.sm,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    height: 4,
    marginBottom: tokens.spacing.md,
    width: 36,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: tokens.spacing.sm,
    justifyContent: 'space-between',
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.sm,
  },
  headerTitle: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.title,
    fontWeight: tokens.typography.weight.bold,
  },
  headerActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: tokens.spacing.sm,
  },
  coolnessLabel: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
  },
  poolChipText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
  },
  closeButton: {
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: 1,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  closeButtonText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.medium,
  },
  feedWrap: {
    flex: 1,
  },
});
