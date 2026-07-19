import { gameCrewTokens } from '@gamecrew/core';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

const tokens = gameCrewTokens;

/**
 * Items 5 + 6's profile sheet: wires the Home header's "GC" button to
 * cross-match identity -- wallet short address (same `truncateWalletAddress`
 * convention the Stash's wallet row uses), cross-match coolness total
 * (`useUserPile`, previously unused), how many items are held/claimed, and a
 * non-interactive "Global leaderboard -- coming soon" row (no new leaderboard
 * build, per item 6).
 *
 * Round 5/item 3a: gains a "Your Stash" row that opens the existing
 * `EconomyPileSheet` (mounted by the caller, `HomeScreen`, since Stash
 * access is no longer scoped to being inside a specific match) -- identity
 * and earnings now live in profile + the FT board, chat stays conversation +
 * challenges only.
 *
 * Same Modal sheet pattern as EconomyPileSheet: slide-up, transparent,
 * backdrop tap to dismiss, rounded-top sheet card.
 */
export function ProfileSheet({
  claimedItemCount,
  coolness,
  heldItemCount,
  onClose,
  onOpenStash,
  visible,
  walletAddress,
}: {
  /** Count of distinct item ids with at least one minted (on-chain) claim, across every fixture. */
  claimedItemCount: number;
  coolness: number;
  /** Count of distinct item ids currently held (positive quantity) in the cross-match pile. */
  heldItemCount: number;
  onClose: () => void;
  /** Item 3a: opens the cross-match Stash (EconomyPileSheet), mounted by the caller. */
  onOpenStash: () => void;
  visible: boolean;
  /** Truncated for display by the caller (same `truncateWalletAddress` convention as the Stash); null when no wallet exists yet. */
  walletAddress: string | null;
}) {
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="Close profile" accessibilityRole="button" onPress={onClose} style={styles.backdropTap} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Profile</Text>
            <Pressable accessibilityLabel="Close profile" accessibilityRole="button" onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>Close</Text>
            </Pressable>
          </View>

          <IdentityRow walletAddress={walletAddress} />

          <View style={styles.coolnessCard}>
            <Text style={styles.coolnessLabel}>Coolness, across every match</Text>
            <Text style={styles.coolnessValue}>{coolness}</Text>
          </View>

          <View style={styles.statsRow}>
            <StatTile label="Held" value={heldItemCount} />
            <StatTile label="Claimed on-chain" value={claimedItemCount} />
          </View>

          <Pressable
            accessibilityLabel="Open your stash"
            accessibilityRole="button"
            onPress={onOpenStash}
            style={({ pressed }) => [styles.stashRow, pressed && styles.stashRowPressed]}
          >
            <Text style={styles.stashLabel}>Your Stash</Text>
            <Text style={styles.stashChevron}>›</Text>
          </Pressable>

          {/* Item 15 (fix round): "Global leaderboard -- Coming soon" hidden
              for the demo -- kept in code (component/copy untouched) for a
              post-demo re-enable, per spec ("just don't render it"). */}
        </View>
      </View>
    </Modal>
  );
}

function IdentityRow({ walletAddress }: { walletAddress: string | null }) {
  if (!walletAddress) {
    return (
      <View style={styles.identityRow}>
        <Text style={styles.identityMuted}>No wallet yet -- claim an item in the Stash to set one up.</Text>
      </View>
    );
  }

  return (
    <View style={styles.identityRow}>
      <View style={styles.identityDot} />
      <Text style={styles.identityAddress}>{walletAddress}</Text>
    </View>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
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
  identityRow: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.sm,
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    marginBottom: tokens.spacing.lg,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  identityDot: {
    backgroundColor: '#4CD37B',
    borderRadius: tokens.radii.pill,
    height: 8,
    width: 8,
  },
  identityAddress: {
    color: tokens.shell.text,
    flex: 1,
    fontSize: tokens.typography.size.caption,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.medium,
  },
  identityMuted: {
    color: tokens.shell.textDim,
    flex: 1,
    fontSize: tokens.typography.size.caption,
  },
  coolnessCard: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.md,
    marginBottom: tokens.spacing.md,
    paddingVertical: tokens.spacing.lg,
  },
  coolnessLabel: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1.2,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  coolnessValue: {
    color: tokens.shell.text,
    fontVariant: ['tabular-nums'],
    fontSize: tokens.typography.size.display,
    fontWeight: tokens.typography.weight.bold,
    marginTop: tokens.spacing.xs,
  },
  statsRow: {
    flexDirection: 'row',
    gap: tokens.spacing.md,
    marginBottom: tokens.spacing.lg,
  },
  statTile: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.md,
    flex: 1,
    paddingVertical: tokens.spacing.md,
  },
  statValue: {
    color: tokens.shell.text,
    fontVariant: ['tabular-nums'],
    fontSize: tokens.typography.size.title,
    fontWeight: tokens.typography.weight.bold,
  },
  statLabel: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
    marginTop: 2,
  },
  stashRow: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.md,
  },
  stashRowPressed: {
    opacity: 0.72,
  },
  stashLabel: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
  },
  stashChevron: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.title,
  },
  leaderboardRow: {
    alignItems: 'center',
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.md,
  },
  leaderboardLabel: {
    color: tokens.shell.textDim,
    fontSize: tokens.typography.size.body,
  },
  leaderboardComingSoon: {
    color: tokens.shell.textDim,
    fontSize: tokens.typography.size.caption,
    fontStyle: 'italic',
  },
});
