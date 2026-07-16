import type { GameViewScene } from '@gamecrew/core';
import { StyleSheet, Text, View } from 'react-native';

import {
  teamForParticipant,
  tokens,
  useDelayedCompletion,
  useTakeoverAnnouncement,
  type TakeoverBaseProps,
} from './takeover-shared';

/**
 * A brief, quiet banner for play resuming (after a goal or a phase break).
 * Deliberately the least dramatic takeover in the set: short duration, no
 * score restated (the preceding goal_sequence/phase_break already showed
 * it), just a calm confirmation that ambient play is about to resume.
 *
 * R4 (docs/issues/game-view-realism-experiment.md, "Goal choreography"):
 * this used to be a full-screen card; it is now a compact pill over the
 * still-visible board, because the restart scene is exactly when the action
 * cluster lines both teams up in their own halves for kickoff -- the reset
 * beat IS the picture, so the copy stops covering it.
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
    <QuietFade reduceMotion={reduceMotion}>
      <View
        accessibilityLabel={announcement}
        accessibilityLiveRegion="polite"
        accessible
        importantForAccessibility="yes"
        style={styles.pill}
      >
        {team ? <View style={[styles.dot, { backgroundColor: team.color }]} /> : null}
        <Text numberOfLines={1} style={styles.text}>
          {team ? `PLAY RESUMES · ${team.name.toUpperCase()}` : 'PLAY RESUMES'}
        </Text>
      </View>
    </QuietFade>
  );
}

function QuietFade({ children }: { children: React.ReactNode; reduceMotion: boolean }) {
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
