import type { GameViewScene } from '@gamecrew/core';
import { StyleSheet } from 'react-native';
import Reanimated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

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
  const decision = resolveVarDecision(scene);
  const announcement = [
    decision.announcement,
    team ? `Incident involving ${team.name}.` : undefined,
  ].filter(Boolean).join(' ');

  useTakeoverAnnouncement(announcement);
  useDelayedCompletion(scene.durationHint.minMs, onComplete);

  return (
    <TakeoverShell accessibilityLabel={announcement} backgroundColor={tokens.shell.surface}>
      <PulsingBadge reduceMotion={reduceMotion || decision.settled} />
      {team ? <TakeoverEyebrow style={styles.eyebrow}>{team.name}</TakeoverEyebrow> : null}
      <TakeoverHeadline style={styles.headline}>VAR</TakeoverHeadline>
      {scene.sourceType ? <TakeoverEyebrow style={styles.type}>{scene.sourceType}</TakeoverEyebrow> : null}
      <TakeoverSubline style={styles.subline}>{decision.label}</TakeoverSubline>
    </TakeoverShell>
  );
}

function resolveVarDecision(scene: GameViewScene): { label: string; announcement: string; settled: boolean } {
  const outcome = scene.sourceOutcome?.trim();
  if (!outcome && scene.lifecycle !== 'confirmed') {
    return { label: 'Under review', announcement: 'VAR review in progress.', settled: false };
  }
  const normalized = outcome?.toLowerCase();
  if (normalized === 'stands') {
    return { label: 'Decision stands', announcement: 'VAR decision stands.', settled: true };
  }
  if (normalized === 'overturned') {
    return { label: 'Decision overturned', announcement: 'VAR decision overturned.', settled: true };
  }
  return {
    label: outcome ?? 'Review complete',
    announcement: `VAR review complete${outcome ? `: ${outcome}` : ''}.`,
    settled: true,
  };
}

function PulsingBadge({ reduceMotion }: { reduceMotion: boolean }) {
  const pulse = useSharedValue(0);

  useMountedOnce(() => {
    if (reduceMotion) return undefined;
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 620, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 620, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
    );
    return () => cancelAnimation(pulse);
  });

  const style = useAnimatedStyle(() => {
    if (reduceMotion) {
      return { opacity: 0.6, transform: [{ scale: 1 }] };
    }
    return {
      opacity: 0.3 + pulse.value * 0.45,
      transform: [{ scale: 0.92 + pulse.value * 0.16 }],
    };
  });

  return <Reanimated.View style={[styles.badge, style]} />;
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
  type: { color: tokens.shell.textMuted, marginBottom: 0, marginTop: tokens.spacing.sm },
});
