import type { EconomyItemId } from '@gamecrew/core';
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Reanimated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { CelebrationParticleBurst } from './celebration-particles';
import {
  TakeoverEyebrow,
  TakeoverHeadline,
  TakeoverSubline,
  tokens,
  useReducedMotionPreference,
  useTakeoverAnnouncement,
} from './takeover-shared';

/** One granted item, ready to render (emoji/label already resolved by the caller -- see global-chat-logic.ts's EconomyItemLookup). */
export interface GiftRevealItem {
  itemId: EconomyItemId;
  emoji: string;
  label: string;
  quantity: number;
}

/**
 * The first-visit gift popup (docs/plans/playful-economy-poc.md, "Gift
 * gate"). Two beats, same shape as GoalSequenceTakeover: beat 1 is a
 * lightweight offer ("We've got some gifts for you") with a claim CTA; beat
 * 2 is the reveal of what actually landed. Unlike the Game View takeovers,
 * beat advancement here is user-driven (tap to claim) rather than
 * timer-driven, because this is a popup the user is interacting with, not a
 * scripted match replay beat.
 *
 * Soft gate, not a hard gate (UI review call, docs/plans/playful-economy-poc.md
 * open question 2): dismissible via tap-outside or the skip link, and
 * dismissing still claims the gift silently (`onDismiss` fires the same
 * claim as `onClaim` would) so a user who skips isn't punished by losing
 * their drop -- it just doesn't play the whole reveal.
 *
 * Chrome stays black/white/gray (gameCrewTokens) -- this is app chrome, not
 * a match-owned surface, so no team-color background like the goal/card
 * takeovers get. The celebration lives in motion (spring entrance, staggered
 * item rows, a capped emoji-particle burst on reveal), not in color -- see
 * "Firecrackers" feedback (Bibhu, 2026-07-17): the offer beat stays calm (a
 * gentle button pulse at most) so the reveal beat's payoff reads as a
 * contrast, not a repeat.
 */
export function GiftRevealTakeover({
  items,
  onClaim,
  onDismiss,
}: {
  items: readonly GiftRevealItem[];
  onClaim: () => void;
  onDismiss: () => void;
}) {
  const [beat, setBeat] = useState<'offer' | 'reveal'>('offer');
  const reduceMotion = useReducedMotionPreference();

  const handleClaim = () => {
    onClaim();
    setBeat('reveal');
  };

  return (
    <Modal animationType="fade" onRequestClose={onDismiss} statusBarTranslucent transparent visible>
      <View pointerEvents="box-none" style={styles.container}>
        <Pressable
          accessibilityLabel="Dismiss gift popup"
          accessibilityRole="button"
          onPress={onDismiss}
          style={styles.scrim}
        />
        {beat === 'offer' ? (
          <OfferBeat onClaim={handleClaim} onDismiss={onDismiss} reduceMotion={reduceMotion} />
        ) : (
          <RevealBeat items={items} onDone={onDismiss} reduceMotion={reduceMotion} />
        )}
      </View>
    </Modal>
  );
}

function OfferBeat({
  onClaim,
  onDismiss,
  reduceMotion,
}: {
  onClaim: () => void;
  onDismiss: () => void;
  reduceMotion: boolean;
}) {
  const announcement = "We've got some gifts for you. Want to see what you got?";
  useTakeoverAnnouncement(announcement);

  // Calm beat: at most a gentle pulse on the Claim button as an attention
  // cue, never a burst -- the reveal beat is where the payoff lives, so the
  // contrast has to hold. Skipped entirely under reduce motion.
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) return;
    pulse.value = withRepeat(
      withSequence(
        withTiming(1.04, { duration: 900, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(pulse);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  return (
    <View
      accessibilityLabel={announcement}
      accessibilityLiveRegion="polite"
      accessible
      style={styles.card}
    >
      <TakeoverEyebrow>Gift</TakeoverEyebrow>
      <TakeoverHeadline style={styles.offerHeadline}>
        We've got some gifts for you
      </TakeoverHeadline>
      <TakeoverSubline style={styles.offerSubline}>Want to see what you got?</TakeoverSubline>
      <Reanimated.View style={reduceMotion ? undefined : pulseStyle}>
        <Pressable
          accessibilityLabel="Claim your gift"
          accessibilityRole="button"
          onPress={onClaim}
          style={({ pressed }) => [styles.claimButton, pressed && styles.claimButtonPressed]}
        >
          <Text style={styles.claimButtonText}>Claim</Text>
        </Pressable>
      </Reanimated.View>
      <Pressable accessibilityLabel="Skip for now" accessibilityRole="button" onPress={onDismiss} style={styles.skipLink}>
        <Text style={styles.skipLinkText}>Skip for now</Text>
      </Pressable>
    </View>
  );
}

function RevealBeat({
  items,
  onDone,
  reduceMotion,
}: {
  items: readonly GiftRevealItem[];
  onDone: () => void;
  reduceMotion: boolean;
}) {
  const announcement = items.length > 0
    ? `You got ${items.map((item) => `${item.quantity} ${item.label.toLowerCase()}`).join(', ')}.`
    : 'Your gift is on its way.';
  useTakeoverAnnouncement(announcement);

  // Card spring-in: scale from slightly-small + faded to full, once on
  // mount. Reduce motion skips straight to the resting state (no animation,
  // same end appearance) rather than disabling the effect and leaving the
  // card stuck at its initial (invisible) values.
  const cardScale = useSharedValue(reduceMotion ? 1 : 0.86);
  const cardOpacity = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    if (reduceMotion) return;
    cardScale.value = withSpring(1, { damping: 14, stiffness: 180 });
    cardOpacity.value = withTiming(1, { duration: 220 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);
  const cardStyle = useAnimatedStyle(() => ({
    opacity: cardOpacity.value,
    transform: [{ scale: cardScale.value }],
  }));

  return (
    <Reanimated.View
      accessibilityLabel={announcement}
      accessibilityLiveRegion="polite"
      accessible
      style={[styles.card, cardStyle]}
    >
      {!reduceMotion ? (
        <CelebrationParticleBurst
          emojiPool={items.map((item) => item.emoji)}
          seed={items.length > 0 ? items.length * 2654435761 : 1}
        />
      ) : null}
      <TakeoverEyebrow>You got</TakeoverEyebrow>
      <TakeoverHeadline style={styles.revealHeadline}>Nice haul!</TakeoverHeadline>
      <View style={styles.revealList}>
        {items.map((item, index) => (
          <RevealItemRow index={index} item={item} key={item.itemId} reduceMotion={reduceMotion} />
        ))}
      </View>
      <Pressable
        accessibilityLabel="Continue to match"
        accessibilityRole="button"
        onPress={onDone}
        style={({ pressed }) => [styles.claimButton, pressed && styles.claimButtonPressed]}
      >
        <Text style={styles.claimButtonText}>Nice</Text>
      </Pressable>
    </Reanimated.View>
  );
}

/** Stagger delay between each reveal row landing, in ms. */
const ROW_STAGGER_MS = 90;
/** Base delay before the first row starts, so it lands just after the card's spring settles. */
const ROW_START_DELAY_MS = 160;

function RevealItemRow({
  index,
  item,
  reduceMotion,
}: {
  index: number;
  item: GiftRevealItem;
  reduceMotion: boolean;
}) {
  const scale = useSharedValue(reduceMotion ? 1 : 0.5);
  const opacity = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) return;
    const delay = ROW_START_DELAY_MS + index * ROW_STAGGER_MS;
    scale.value = withDelay(delay, withSpring(1, { damping: 12, stiffness: 220 }));
    opacity.value = withDelay(delay, withTiming(1, { duration: 180 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion, index]);

  const rowStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  return (
    <Reanimated.View style={[styles.revealRow, rowStyle]}>
      <Text style={styles.revealEmoji}>{item.emoji}</Text>
      <Text style={styles.revealQuantity}>{item.quantity}</Text>
      <Text style={styles.revealLabel}>{item.label}</Text>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.xl,
  },
  scrim: {
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  card: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surface,
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 420,
    overflow: 'hidden',
    paddingHorizontal: tokens.spacing.xl,
    paddingVertical: tokens.spacing.xxl,
    width: '100%',
  },
  offerHeadline: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.title,
  },
  offerSubline: {
    color: tokens.shell.textMuted,
  },
  revealHeadline: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.display,
    marginTop: tokens.spacing.xs,
  },
  claimButton: {
    alignItems: 'center',
    backgroundColor: tokens.shell.text,
    borderRadius: tokens.radii.pill,
    justifyContent: 'center',
    marginTop: tokens.spacing.xl,
    minHeight: 46,
    paddingHorizontal: tokens.spacing.xxl,
  },
  claimButtonPressed: {
    opacity: 0.7,
  },
  claimButtonText: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
  },
  skipLink: {
    marginTop: tokens.spacing.lg,
    padding: tokens.spacing.sm,
  },
  skipLinkText: {
    color: tokens.shell.textDim,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.medium,
    textDecorationLine: 'underline',
  },
  revealList: {
    gap: tokens.spacing.sm,
    marginTop: tokens.spacing.lg,
    width: '100%',
  },
  revealRow: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.md,
    flexDirection: 'row',
    gap: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
  },
  revealEmoji: {
    fontSize: 28,
  },
  revealQuantity: {
    color: tokens.shell.text,
    fontVariant: ['tabular-nums'],
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    minWidth: 28,
  },
  revealLabel: {
    color: tokens.shell.text,
    flex: 1,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.medium,
  },
});
