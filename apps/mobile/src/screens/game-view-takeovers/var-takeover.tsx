import type { GameViewScene } from '@gamecrew/core';
import { useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet } from 'react-native';

import {
  TakeoverEyebrow,
  TakeoverHeadline,
  TakeoverShell,
  TakeoverSubline,
  teamForParticipant,
  tokens,
  useDelayedCompletion,
  useMountedOnce,
  useTakeoverAnnouncement,
  type TakeoverBaseProps,
} from './takeover-shared';

/**
 * Review-in-progress treatment for a var_review scene: a muted, pulsing
 * "VAR" checking card. Distinct from the goal_sequence tension beat (which
 * is goal-specific) -- this covers a standalone VAR review not tied to a
 * pending goal.
 */
export function VarTakeover({
  awayTeam,
  homeTeam,
  onComplete,
  reduceMotion,
  scene,
}: TakeoverBaseProps & { scene: GameViewScene }) {
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  const announcement = [
    'VAR review in progress.',
    team ? `Incident involving ${team.name}.` : undefined,
  ].filter(Boolean).join(' ');

  useTakeoverAnnouncement(announcement);
  useDelayedCompletion(scene.durationHint.minMs, onComplete);

  return (
    <TakeoverShell accessibilityLabel={announcement} backgroundColor={tokens.shell.surface}>
      <PulsingBadge reduceMotion={reduceMotion} />
      {team ? <TakeoverEyebrow style={styles.eyebrow}>{team.name}</TakeoverEyebrow> : null}
      <TakeoverHeadline style={styles.headline}>VAR</TakeoverHeadline>
      <TakeoverSubline style={styles.subline}>Under review</TakeoverSubline>
    </TakeoverShell>
  );
}

function PulsingBadge({ reduceMotion }: { reduceMotion: boolean }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);

  useMountedOnce(() => {
    if (reduceMotion) return undefined;
    loopRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          duration: 620,
          easing: Easing.inOut(Easing.sin),
          isInteraction: false,
          toValue: 1,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(pulse, {
          duration: 620,
          easing: Easing.inOut(Easing.sin),
          isInteraction: false,
          toValue: 0,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]),
    );
    loopRef.current.start();
    return () => loopRef.current?.stop();
  });

  const opacity = reduceMotion ? 0.6 : pulse.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.75] });
  const scale = reduceMotion ? 1 : pulse.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.08] });

  return (
    <Animated.View
      style={[styles.badge, { opacity, transform: [{ scale }] }]}
    />
  );
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: tokens.shell.textMuted,
    borderRadius: 34,
    height: 68,
    marginBottom: tokens.spacing.lg,
    width: 68,
  },
  eyebrow: { color: tokens.shell.text },
  headline: { color: tokens.shell.text, fontSize: 44, letterSpacing: 3 },
  subline: { color: tokens.shell.textMuted },
});
