import type { GameViewScene } from '@gamecrew/core';
import { useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet } from 'react-native';

import {
  TakeoverEyebrow,
  TakeoverHeadline,
  TakeoverShell,
  teamForParticipant,
  tokens,
  useDelayedCompletion,
  useMountedOnce,
  useTakeoverAnnouncement,
  type TakeoverBaseProps,
} from './takeover-shared';

/**
 * A brief, quiet card for play resuming (after a goal or a phase break).
 * Deliberately the least dramatic takeover in the set: short duration, no
 * score restated (the preceding goal_sequence/phase_break already showed
 * it), just a calm confirmation that ambient play is about to resume.
 */
export function RestartCard({
  awayTeam,
  homeTeam,
  onComplete,
  reduceMotion,
  scene,
}: TakeoverBaseProps & { scene: GameViewScene }) {
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  const announcement = team ? `Play resumes. ${team.name} to restart.` : 'Play resumes.';

  useTakeoverAnnouncement(announcement);
  useDelayedCompletion(scene.durationHint.minMs, onComplete);

  return (
    <TakeoverShell accessibilityLabel={announcement} backgroundColor={tokens.shell.background}>
      <QuietFade reduceMotion={reduceMotion}>
        {team ? <TakeoverEyebrow style={styles.eyebrow}>{team.name}</TakeoverEyebrow> : null}
        <TakeoverHeadline style={styles.headline}>Play resumes</TakeoverHeadline>
      </QuietFade>
    </TakeoverShell>
  );
}

function QuietFade({ children, reduceMotion }: { children: React.ReactNode; reduceMotion: boolean }) {
  const entrance = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useMountedOnce(() => {
    if (reduceMotion) return undefined;
    Animated.timing(entrance, {
      duration: 220,
      easing: Easing.out(Easing.quad),
      isInteraction: false,
      toValue: 1,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
    return undefined;
  });

  return <Animated.View style={{ alignItems: 'center', opacity: entrance }}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  eyebrow: { color: tokens.shell.textMuted },
  headline: { color: tokens.shell.text, fontSize: 30, fontWeight: tokens.typography.weight.medium },
});
