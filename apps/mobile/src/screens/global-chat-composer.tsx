import { gameCrewTokens } from '@gamecrew/core';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CHAT_MESSAGE_MAX_LENGTH } from '../state/user-pile-store';

const tokens = gameCrewTokens;

/**
 * The user chat input bar (UX spec section 5) -- pinned to the bottom of the
 * Chat tab, below `GlobalChatFeed` and above the safe-area bottom inset.
 * `KeyboardAvoidingView` rides it above the keyboard so it never gets
 * covered, and the economy strip/tabs above stay fixed (only the feed's
 * `FlatList` shrinks) -- exactly the "fixed chrome below/above a scrolling
 * list" pattern this tab already uses elsewhere in `gamecrew-screens.tsx`.
 *
 * Per spec: `surface` bg, `divider` top hairline, a pill-shaped `surfaceRaised`
 * text input (placeholder "Say something…"), and a text-pill "Send" button
 * (not an icon -- this app's whole action vocabulary elsewhere is text pills:
 * Pile, Board, Stake, Close, Claim on-chain) that dims when the input is
 * empty. Multiline up to ~4 lines before it scrolls internally. The keyboard
 * is never auto-dismissed on send (rapid consecutive messages are a normal
 * chat pattern); the caller wires the list's `onScrollBeginDrag`/
 * `keyboardShouldPersistTaps` to dismiss on scroll-drag instead (browsing
 * history shouldn't fight the keyboard).
 */
export function GlobalChatComposer({
  onSend,
}: {
  onSend: (text: string) => boolean;
}) {
  const [draft, setDraft] = useState('');
  const canSend = draft.trim().length > 0;

  const handleSend = () => {
    if (!canSend) return;
    const sent = onSend(draft);
    if (sent) setDraft('');
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={styles.bar}>
        <TextInput
          accessibilityLabel="Message"
          maxLength={CHAT_MESSAGE_MAX_LENGTH}
          multiline
          onChangeText={setDraft}
          placeholder="Say something…"
          placeholderTextColor={tokens.shell.textDim}
          style={styles.input}
          value={draft}
        />
        <Pressable
          accessibilityLabel="Send message"
          accessibilityRole="button"
          disabled={!canSend}
          onPress={handleSend}
          style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
        >
          <Text style={[styles.sendButtonText, !canSend && styles.sendButtonTextDisabled]}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'flex-end',
    backgroundColor: tokens.shell.surface,
    borderTopColor: tokens.shell.divider,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    padding: tokens.spacing.md,
  },
  input: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.pill,
    color: tokens.shell.text,
    flex: 1,
    fontSize: tokens.typography.size.body,
    maxHeight: 96,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.sm,
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: tokens.shell.text,
    borderRadius: tokens.radii.pill,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: tokens.spacing.lg,
  },
  sendButtonDisabled: {
    backgroundColor: tokens.shell.surfaceRaised,
  },
  sendButtonText: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
  },
  sendButtonTextDisabled: {
    color: tokens.shell.textDim,
  },
});
