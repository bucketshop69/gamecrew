import type { GameViewScene } from '@gamecrew/core';
import { useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';

import { resolveSetPieceVariant, setPieceLabel, type SetPieceVariant } from './game-view-takeover-logic';
import {
  teamForParticipant,
  tokens,
  useDelayedCompletion,
  useMountedOnce,
  useTakeoverAnnouncement,
  type TakeoverBaseProps,
} from './takeover-shared';

/**
 * Compact badge for minor set pieces (throw-in, free kick -- see fix #2 and
 * `shouldSetPieceUseFullVignette` in game-view-screen-logic.ts): a small
 * team-color dot + "TEAM THROW-IN" toast pinned to the top edge, over the
 * still-visible ambient board, instead of the full-screen `SetPieceVignette`
 * corner/penalty use. Auto-dismisses with the scene like every other
 * takeover (calls `onComplete` once after the scene's `durationHint`), so
 * playback advancement is unaffected -- only the visual treatment changes.
 *
 * Deliberately does NOT use `TakeoverShell` (which fills the screen with a
 * background color): this badge is an overlay accent, not a takeover of the
 * board.
 */
export function MinorSetPieceBadge({
  awayTeam,
  homeTeam,
  onComplete,
  reduceMotion,
  scene,
  variant,
}: TakeoverBaseProps & { scene: GameViewScene; variant?: SetPieceVariant }) {
  const resolvedVariant = resolveSetPieceVariant(variant);
  const label = setPieceLabel(resolvedVariant);
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  const accentColor = team?.color ?? tokens.shell.textMuted;

  const announcement = [
    team ? `${team.name}.` : undefined,
    `${label}.`,
  ].filter(Boolean).join(' ');

  useTakeoverAnnouncement(announcement);
  useDelayedCompletion(scene.durationHint.minMs, onComplete);

  return (
    <BadgeEntrance reduceMotion={reduceMotion}>
      <View
        accessibilityLabel={announcement}
        accessibilityLiveRegion="polite"
        accessible
        importantForAccessibility="yes"
        style={styles.badge}
      >
        <View style={[styles.dot, { backgroundColor: accentColor }]} />
        <Text numberOfLines={1} style={styles.text}>
          {team ? `${team.name.toUpperCase()} ${label}` : label}
        </Text>
      </View>
    </BadgeEntrance>
  );
}

function BadgeEntrance({ children, reduceMotion }: { children: React.ReactNode; reduceMotion: boolean }) {
  const entrance = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useMountedOnce(() => {
    if (reduceMotion) return;
    Animated.timing(entrance, {
      duration: 180,
      easing: Easing.out(Easing.cubic),
      isInteraction: false,
      toValue: 1,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  });

  const translateY = entrance.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] });

  return (
    <Animated.View style={[styles.entranceWrap, { opacity: entrance, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  entranceWrap: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: tokens.spacing.lg,
  },
  badge: {
    alignItems: 'center',
    backgroundColor: 'rgba(5, 5, 5, 0.82)',
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  dot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  text: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1,
  },
});
