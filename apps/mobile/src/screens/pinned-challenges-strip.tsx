import { gameCrewTokens, type EconomyItemId } from '@gamecrew/core';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ChatTeamIdentity } from './global-chat-feed';
import type { PinnedChallengeChip } from './match-chat-sheet-logic';

const tokens = gameCrewTokens;

/** Mirrors global-chat-feed.tsx's local STAKE_EMOJI lookup -- kept local so this component has no runtime dependency on that file beyond its exported type. */
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
 * Pinned challenges strip (demo-lockdown item 11) -- sits at the top of the
 * chat sheet, above the feed. A horizontally scrollable row of chips, one
 * per currently open-or-taken challenge (see match-chat-sheet-logic.ts's
 * `buildPinnedChallengeStrip`, which reuses the same `prompt`-kind row
 * derivation the feed itself renders, so the strip and the feed can never
 * disagree about a prompt's state -- resolved/expired challenges are already
 * filtered out there).
 *
 * Chip tap behavior (spec's "your call" on the simplest-reliable option):
 * tapping an *untaken* chip scrolls the feed to that prompt's row via
 * `onPickChip`, letting the user answer it from the card's own buttons
 * rather than duplicating the stake/team-pick UI inline in the strip. A
 * *taken* chip shows the pick inline ("You: Argentina" / "You: 🍌") and is
 * not pressable -- nothing to do once it's already answered.
 */
export function PinnedChallengesStrip({
  awayTeam,
  chips,
  homeTeam,
  onPickChip,
}: {
  awayTeam: ChatTeamIdentity;
  chips: readonly PinnedChallengeChip[];
  homeTeam: ChatTeamIdentity;
  onPickChip: (promptId: string) => void;
}) {
  if (chips.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <ScrollView
        contentContainerStyle={styles.row}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {chips.map((chip) => (
          <ChallengeChip
            awayTeam={awayTeam}
            chip={chip}
            homeTeam={homeTeam}
            key={chip.promptId}
            onPress={() => onPickChip(chip.promptId)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function ChallengeChip({
  awayTeam,
  chip,
  homeTeam,
  onPress,
}: {
  awayTeam: ChatTeamIdentity;
  chip: PinnedChallengeChip;
  homeTeam: ChatTeamIdentity;
  onPress: () => void;
}) {
  const taken = chip.status === 'taken';
  const pickLabel = taken ? takenPickLabel(chip, homeTeam, awayTeam) : 'Pick';

  return (
    <Pressable
      accessibilityLabel={taken ? `${chip.shortCopy}, you picked ${pickLabel}` : `${chip.shortCopy}, tap to pick`}
      accessibilityRole="button"
      disabled={taken}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        taken && styles.chipTaken,
        pressed && !taken && styles.chipPressed,
      ]}
    >
      <Text numberOfLines={1} style={styles.chipCopy}>{chip.shortCopy}</Text>
      <Text numberOfLines={1} style={[styles.chipStatus, taken && styles.chipStatusTaken]}>
        {taken ? pickLabel : 'Pick'}
      </Text>
    </Pressable>
  );
}

function takenPickLabel(
  chip: PinnedChallengeChip,
  homeTeam: ChatTeamIdentity,
  awayTeam: ChatTeamIdentity,
): string {
  if (chip.takenParticipant !== undefined) {
    const teamName = chip.takenParticipant === homeTeam.participant
      ? homeTeam.name
      : chip.takenParticipant === awayTeam.participant
        ? awayTeam.name
        : undefined;
    if (teamName) return `You: ${teamName}`;
  }
  if (chip.takenItemId) return `You: ${STAKE_EMOJI[chip.takenItemId]}`;
  return 'You called it';
}

const styles = StyleSheet.create({
  wrap: {
    borderBottomColor: tokens.shell.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: tokens.spacing.sm,
  },
  row: {
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.lg,
  },
  chip: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
    maxWidth: 180,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  chipTaken: {
    opacity: 0.85,
  },
  chipPressed: {
    opacity: 0.7,
  },
  chipCopy: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
  },
  chipStatus: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.medium,
  },
  chipStatusTaken: {
    color: tokens.shell.textDim,
  },
});
