import { gameCrewTokens } from '@gamecrew/core';
import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Reanimated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

const tokens = gameCrewTokens;

/**
 * Floating chat button (demo-lockdown item 4; round 5 upgrade) -- sits above
 * the checkpoint dock on both the Match Pulse and Game View tabs, opening
 * the chat sheet. With the challenge drop-in card removed (round 5/item 1),
 * this button is the one remaining out-of-sheet signal for a new challenge,
 * so it upgrades from a bare unread dot to a small count badge showing the
 * number of open challenges not yet seen (see match-chat-sheet-logic.ts's
 * `countUnseenOpenChallenges`), plus a brief pulse when that count
 * increases (a genuinely new challenge arrived, not just the initial
 * mount). Sheet open still clears "seen" (caller's responsibility, same as
 * before).
 */
export function FloatingChatButton({
  bottomOffset,
  onPress,
  unseenOpenChallengeCount,
}: {
  /** Distance from the screen bottom to the button's bottom edge -- caller positions this just above the checkpoint dock. */
  bottomOffset: number;
  onPress: () => void;
  /** Item 1/4: number of open challenges not yet seen (0 hides the badge entirely). */
  unseenOpenChallengeCount: number;
}) {
  const hasUnread = unseenOpenChallengeCount > 0;
  const pulse = useSharedValue(1);
  const previousCountRef = useRef(unseenOpenChallengeCount);

  useEffect(() => {
    const previousCount = previousCountRef.current;
    previousCountRef.current = unseenOpenChallengeCount;
    // Only pulse when the count genuinely INCREASED (a new challenge
    // arrived) -- not on mount, and not when it drops back down after the
    // sheet is opened and clears "seen".
    if (unseenOpenChallengeCount <= previousCount) return;

    cancelAnimation(pulse);
    pulse.value = withSequence(
      withTiming(1.18, { duration: 160, easing: Easing.out(Easing.quad) }),
      withTiming(1, { duration: 220, easing: Easing.inOut(Easing.quad) }),
    );
  }, [pulse, unseenOpenChallengeCount]);

  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  return (
    <Reanimated.View style={[styles.buttonWrap, { bottom: bottomOffset }, pulseStyle]}>
      <Pressable
        accessibilityLabel={hasUnread
          ? `Open chat, ${unseenOpenChallengeCount} new ${unseenOpenChallengeCount === 1 ? 'challenge' : 'challenges'}`
          : 'Open chat'}
        accessibilityRole="button"
        onPress={onPress}
        style={styles.button}
      >
        <Text style={styles.icon}>💬</Text>
        {hasUnread ? (
          <View style={styles.badge}>
            <Text numberOfLines={1} style={styles.badgeText}>
              {unseenOpenChallengeCount > 9 ? '9+' : String(unseenOpenChallengeCount)}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  buttonWrap: {
    position: 'absolute',
    right: tokens.spacing.lg,
    zIndex: 18,
  },
  button: {
    alignItems: 'center',
    backgroundColor: tokens.shell.text,
    borderRadius: tokens.radii.pill,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  icon: {
    fontSize: 22,
  },
  badge: {
    alignItems: 'center',
    backgroundColor: '#E23546',
    borderColor: tokens.shell.background,
    borderRadius: tokens.radii.pill,
    borderWidth: 2,
    justifyContent: 'center',
    minWidth: 20,
    paddingHorizontal: 4,
    position: 'absolute',
    right: -2,
    top: -2,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    lineHeight: 16,
  },
});
