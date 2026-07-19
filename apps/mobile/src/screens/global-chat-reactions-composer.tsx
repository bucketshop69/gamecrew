import { gameCrewTokens } from '@gamecrew/core';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Pressable } from 'react-native';

import { REACTION_CHIPS } from './match-chat-sheet-logic';

const tokens = gameCrewTokens;

/**
 * Reactions-only composer (demo-lockdown item 9) -- replaces the free-text
 * `GlobalChatComposer` inside the chat sheet. No keyboard: a single
 * horizontally scrollable row of predefined reaction phrases + emoji chips.
 * One tap sends the chip's exact label text through the same `onSend` path
 * the old text composer used (`useEconomy().sendMessage`), landing as an
 * ordinary `user_chat` row -- see match-chat-sheet-logic.ts's
 * `REACTION_CHIPS`/`buildReactionSendPayload` for the pure chip list/lookup
 * this component renders and calls.
 *
 * `GlobalChatComposer` itself is left in place and unused (spec: "keep the
 * diff reversible") -- `MatchDetailScreen` simply stops rendering it in favor
 * of this component inside the new sheet.
 */
export function GlobalChatReactionsComposer({
  onSend,
}: {
  onSend: (text: string) => boolean;
}) {
  return (
    <View style={styles.bar}>
      <ScrollView
        contentContainerStyle={styles.row}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        {REACTION_CHIPS.map((chip) => (
          <Pressable
            accessibilityLabel={`Send: ${chip.label}`}
            accessibilityRole="button"
            key={chip.id}
            onPress={() => onSend(chip.label)}
            style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
          >
            <Text style={styles.chipText}>{chip.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: tokens.shell.surface,
    borderTopColor: tokens.shell.divider,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: tokens.spacing.sm,
  },
  row: {
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
  },
  chip: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surfaceRaised,
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: tokens.spacing.lg,
  },
  chipPressed: {
    opacity: 0.7,
  },
  chipText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
  },
});
