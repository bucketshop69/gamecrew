import { gameCrewTokens, type EconomyItemId } from '@gamecrew/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MatchRecapModel } from '../match-recap-logic';

const tokens = gameCrewTokens;

/**
 * Item 14's match recap row: renders on the full-time board for the
 * signed-in user -- coolness earned this match, calls won/lost, pool share
 * if a split happened, and a "claim your item" affordance when something is
 * still unclaimed (opens the existing Stash sheet via `onClaimItem`, no new
 * claim UI here).
 *
 * Round 5/item 3: Board and Stash left the chat sheet's header entirely --
 * Stash re-homed to the profile sheet (identity/earnings live there now),
 * and this row is the FT board's own entry point into that fixture's Board
 * (`onOpenBoard`, opening the existing `EconomyLeaderboardSheet`). The
 * "Match board" link always renders once the match is over (it doesn't
 * depend on the user having done anything this match -- the board itself
 * is fixture-scoped, not activity-scoped), even when the rest of the row
 * (stats/claim) is suppressed for a user with zero activity, per the FT
 * board's "resting broadcast moment" tone -- an all-zero stat row would
 * just be noise under the scorer timeline, but the board link is still
 * useful with nothing to show off.
 */
export function MatchRecapRow({
  lookupItemLabel,
  onOpenBoard,
  onOpenStash,
  recap,
}: {
  lookupItemLabel: (itemId: EconomyItemId) => string;
  /** Item 3: opens this fixture's Board (EconomyLeaderboardSheet), re-homed here from the chat sheet header. */
  onOpenBoard: () => void;
  onOpenStash: () => void;
  recap: MatchRecapModel;
}) {
  const hasStats = recap.hasActivity || recap.hasUnclaimedItem;

  return (
    <View accessible accessibilityLabel="Your match recap" style={styles.root}>
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>Your match</Text>
        <Pressable
          accessibilityLabel="Open the match board"
          accessibilityRole="button"
          hitSlop={6}
          onPress={onOpenBoard}
          style={({ pressed }) => [styles.boardLink, pressed && styles.boardLinkPressed]}
        >
          <Text style={styles.boardLinkText}>Match board</Text>
        </Pressable>
      </View>

      {hasStats ? (
        <>
          <View style={styles.statRow}>
            <RecapStat label="Coolness" value={`+${recap.coolnessEarned}`} />
            <RecapStat label="Calls won" value={String(recap.callsWon)} />
            <RecapStat label="Calls lost" value={String(recap.callsLost)} />
          </View>

          {recap.poolShare && recap.poolShare.length > 0 ? (
            <Text style={styles.poolShareText}>
              Pool share: {recap.poolShare.map((entry) => `${entry.quantity} ${lookupItemLabel(entry.itemId)}`).join(' · ')}
            </Text>
          ) : null}

          {recap.hasUnclaimedItem ? (
            <Pressable
              accessibilityLabel="Claim your item"
              accessibilityRole="button"
              onPress={onOpenStash}
              style={({ pressed }) => [styles.claimButton, pressed && styles.claimButtonPressed]}
            >
              <Text style={styles.claimButtonText}>Claim your item</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function RecapStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.md,
    marginTop: tokens.spacing.xl,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  eyebrow: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  boardLink: {
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.xs,
  },
  boardLinkPressed: {
    opacity: 0.72,
  },
  boardLinkText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.medium,
  },
  statRow: {
    flexDirection: 'row',
    gap: tokens.spacing.lg,
    marginTop: tokens.spacing.sm,
  },
  stat: {
    alignItems: 'flex-start',
  },
  statValue: {
    color: tokens.shell.text,
    fontVariant: ['tabular-nums'],
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
  },
  statLabel: {
    color: tokens.shell.textDim,
    fontSize: tokens.typography.size.caption,
  },
  poolShareText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
    marginTop: tokens.spacing.sm,
  },
  claimButton: {
    alignSelf: 'flex-start',
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.xs,
  },
  claimButtonPressed: {
    opacity: 0.72,
  },
  claimButtonText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.medium,
  },
});
