import type { GameViewScene } from '@gamecrew/core';
import { useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet } from 'react-native';

import { formatScoreline, phaseBreakLabel, resolvePhaseBreakMoment } from './game-view-takeover-logic';
import {
  TakeoverHeadline,
  TakeoverScoreline,
  TakeoverShell,
  tokens,
  useDelayedCompletion,
  useMountedOnce,
  useTakeoverAnnouncement,
  type TakeoverBaseProps,
} from './takeover-shared';

/**
 * Kickoff / half-time / full-time typography moment. The moment is resolved
 * from `scene.phase` (the only signal a phase_break scene carries -- see
 * resolvePhaseBreakMoment's doc comment) rather than any invented field.
 */
export function PhaseBreakTakeover({
  onComplete,
  reduceMotion,
  scene,
}: TakeoverBaseProps & { scene: GameViewScene }) {
  const moment = resolvePhaseBreakMoment(scene.phase);
  const label = phaseBreakLabel(moment);
  const scoreline = formatScoreline(scene.scoreAtMoment);
  const showScore = moment === 'half_time' || moment === 'full_time';

  const announcement = [
    `${label}.`,
    showScore && scoreline ? `Score ${scoreline.replace('-', ' to ')}.` : undefined,
  ].filter(Boolean).join(' ');

  useTakeoverAnnouncement(announcement);
  useDelayedCompletion(scene.durationHint.minMs, onComplete);

  return (
    <TakeoverShell accessibilityLabel={announcement} backgroundColor={tokens.shell.background}>
      <FadeIn reduceMotion={reduceMotion}>
        <TakeoverHeadline style={styles.headline}>{label}</TakeoverHeadline>
        {showScore && scoreline ? (
          <TakeoverScoreline style={styles.scoreline}>{scoreline}</TakeoverScoreline>
        ) : null}
      </FadeIn>
    </TakeoverShell>
  );
}

function FadeIn({ children, reduceMotion }: { children: React.ReactNode; reduceMotion: boolean }) {
  const entrance = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useMountedOnce(() => {
    if (reduceMotion) return undefined;
    Animated.timing(entrance, {
      duration: 320,
      easing: Easing.out(Easing.cubic),
      isInteraction: false,
      toValue: 1,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
    return undefined;
  });

  return <Animated.View style={{ alignItems: 'center', opacity: entrance }}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  headline: { color: tokens.shell.text, fontSize: 44, letterSpacing: 2 },
  scoreline: { color: tokens.shell.text },
});
