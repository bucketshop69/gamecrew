import type { GameViewScene } from '@gamecrew/core';
import { StyleSheet, Text, View } from 'react-native';

import { formatScoreline, phaseBreakLabel, resolvePhaseBreakMoment } from './game-view-takeover-logic';
import {
  tokens,
  useDelayedCompletion,
  useTakeoverAnnouncement,
  type TakeoverBaseProps,
} from './takeover-shared';

/**
 * Kickoff / half-time / full-time as a compact pill over the still-visible
 * board. Was a full-screen typography card; product direction (2026-07-15,
 * with the 22-player formation view) is that the break IS the picture --
 * the players assemble for kickoff or walk off to their benches (see the
 * cluster's phase-break staging) -- so the copy shrinks to a quiet label,
 * and the commentary lower-third will carry the words once it lands. The
 * moment is resolved from `scene.phase` (the only signal a phase_break
 * scene carries), never invented.
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
    <FadeIn reduceMotion={reduceMotion}>
      <View
        accessibilityLabel={announcement}
        accessibilityLiveRegion="polite"
        accessible
        importantForAccessibility="yes"
        style={styles.pill}
      >
        <Text numberOfLines={1} style={styles.text}>
          {showScore && scoreline ? `${label} · ${scoreline}` : label}
        </Text>
      </View>
    </FadeIn>
  );
}

function FadeIn({ children }: { children: React.ReactNode; reduceMotion: boolean }) {
  return <View style={styles.wrap}>{children}</View>;
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: tokens.spacing.lg,
  },
  pill: {
    alignItems: 'center',
    backgroundColor: 'rgba(5, 5, 5, 0.86)',
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  text: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.label,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1.5,
  },
});
