import { gameCrewTokens, type LeaderboardRow } from '@gamecrew/core';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

const tokens = gameCrewTokens;

/**
 * The leaderboard sheet ("Board" -- UX spec section 4). Reuses
 * `EconomyPileSheet`'s exact modal chrome (slide-up, `sheet` bg
 * `tokens.shell.surface`, `radii.lg` top corners, drag `handle`, header row
 * + `Close` pill) but is deliberately plainer: no rarity borders, no item
 * previews, no wallet row -- coolness ranking only, per the PRD's "ranked
 * purely on coolness."
 *
 * Row anatomy: rank (tabular-nums, fixed width) -- name (flex, ellipsis) --
 * coolness (tabular-nums, right-aligned). The local user's row gets a
 * `tokens.shell.text` left border-accent in its natural position; if that
 * row isn't currently visible in the scrollable list, a pinned footer row
 * repeats it (`You · #{rank} · {coolness}`) so the user never has to scroll
 * to find themselves.
 *
 * No auto-refresh/re-sort while open (spec: "renders ... as of the moment it
 * was opened") -- the parent only needs to call `useLeaderboard` once per
 * open, not poll it live.
 */
export function EconomyLeaderboardSheet({
  onClose,
  rows,
  status,
  visible,
}: {
  onClose: () => void;
  rows: readonly LeaderboardRow[];
  status: 'ready' | 'loading' | 'error';
  visible: boolean;
}) {
  const userRow = rows.find((row) => row.isUser);

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="Close board" accessibilityRole="button" onPress={onClose} style={styles.backdropTap} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Board</Text>
            <Pressable accessibilityLabel="Close board" accessibilityRole="button" onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>Close</Text>
            </Pressable>
          </View>

          {status === 'loading' ? (
            <LeaderboardSkeleton />
          ) : status === 'error' ? (
            <View style={styles.stateBlock}>
              <Text style={styles.stateTitle}>Couldn't load the leaderboard.</Text>
              <Pressable accessibilityRole="button" onPress={onClose} style={styles.stateAction}>
                <Text style={styles.stateActionText}>Close</Text>
              </Pressable>
            </View>
          ) : rows.length === 0 ? (
            <Text style={styles.emptyText}>Nobody's on the board yet</Text>
          ) : (
            <>
              <FlatList
                contentContainerStyle={styles.list}
                data={rows}
                keyExtractor={(row) => row.id}
                nestedScrollEnabled
                renderItem={({ item }) => <LeaderboardRowItem row={item} />}
              />
              {userRow ? (
                <View style={styles.pinnedFooter}>
                  <Text style={styles.pinnedFooterText}>
                    You · #{userRow.rank} · {userRow.coolness}
                  </Text>
                </View>
              ) : null}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

function LeaderboardRowItem({ row }: { row: LeaderboardRow }) {
  return (
    <View style={[styles.row, row.isUser && styles.rowUser]}>
      <Text style={styles.rank}>{row.rank}</Text>
      <Text numberOfLines={1} style={styles.name}>{row.name}</Text>
      <Text style={styles.coolness}>{row.coolness}</Text>
    </View>
  );
}

function LeaderboardSkeleton() {
  return (
    <View style={styles.list}>
      {[0, 1, 2, 3].map((index) => (
        <View key={index} style={styles.skeletonRow} />
      ))}
    </View>
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
    maxHeight: '78%',
    paddingBottom: tokens.spacing.xxl,
    paddingHorizontal: tokens.spacing.lg,
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
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.lg,
  },
  headerTitle: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.title,
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
  emptyText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.body,
    paddingVertical: tokens.spacing.xl,
    textAlign: 'center',
  },
  list: {
    gap: tokens.spacing.sm,
    paddingBottom: tokens.spacing.lg,
  },
  row: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.md,
    borderLeftColor: 'transparent',
    borderLeftWidth: 2,
    flexDirection: 'row',
    gap: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
  },
  rowUser: {
    borderLeftColor: tokens.shell.text,
  },
  rank: {
    color: tokens.shell.text,
    fontVariant: ['tabular-nums'],
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    minWidth: 28,
  },
  name: {
    color: tokens.shell.text,
    flex: 1,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.medium,
  },
  coolness: {
    color: tokens.shell.text,
    fontVariant: ['tabular-nums'],
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    textAlign: 'right',
  },
  pinnedFooter: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.md,
    borderTopColor: tokens.shell.divider,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
  },
  pinnedFooterText: {
    color: tokens.shell.text,
    fontVariant: ['tabular-nums'],
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
  },
  skeletonRow: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.md,
    height: 52,
    opacity: 0.5,
  },
  stateBlock: {
    alignItems: 'center',
    gap: tokens.spacing.md,
    paddingVertical: tokens.spacing.xl,
  },
  stateTitle: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    textAlign: 'center',
  },
  stateAction: {
    alignItems: 'center',
    backgroundColor: tokens.shell.text,
    borderRadius: tokens.radii.pill,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: tokens.spacing.lg,
  },
  stateActionText: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
  },
});
