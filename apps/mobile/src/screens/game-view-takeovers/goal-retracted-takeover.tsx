import type { GameViewScene } from '@gamecrew/core';
import { useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet } from 'react-native';

import { formatScoreline } from './game-view-takeover-logic';
import {
  TakeoverEyebrow,
  TakeoverHeadline,
  TakeoverScoreline,
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
 * The takeback: a visible reversal that removes a previously celebrated goal
 * and restores the prior score. `scene.scoreAtMoment` on a goal_retracted
 * scene is already the restored score (see packages/core's
 * handleIncidentRetracted), so this component never computes a "prior
 * score" itself -- it only displays what the director already resolved,
 * per the renderer's "zero match-interpretation decisions" rule.
 */
export function GoalRetractedTakeover({
  awayTeam,
  homeTeam,
  onComplete,
  reduceMotion,
  scene,
}: TakeoverBaseProps & { scene: GameViewScene }) {
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  const scoreline = formatScoreline(scene.scoreAtMoment);

  const announcement = [
    'Goal disallowed after review.',
    team ? `${team.name}.` : undefined,
    scoreline ? `Score is now ${scoreline.replace('-', ' to ')}.` : undefined,
  ].filter(Boolean).join(' ');

  useTakeoverAnnouncement(announcement);
  useDelayedCompletion(scene.durationHint.minMs, onComplete);

  return (
    <TakeoverShell accessibilityLabel={announcement} backgroundColor={tokens.shell.surface}>
      <StrikeThroughGoal reduceMotion={reduceMotion} />
      {team ? <TakeoverEyebrow style={styles.eyebrow}>{team.name}</TakeoverEyebrow> : null}
      <TakeoverHeadline style={styles.headline}>NO GOAL</TakeoverHeadline>
      <TakeoverSubline style={styles.subline}>Overturned on review</TakeoverSubline>
      {scoreline ? <TakeoverScoreline style={styles.scoreline}>{scoreline}</TakeoverScoreline> : null}
    </TakeoverShell>
  );
}

/** A "GOAL" label with a strike-through bar wiping across it, then fading -- the visible takeback. */
function StrikeThroughGoal({ reduceMotion }: { reduceMotion: boolean }) {
  const wipe = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useMountedOnce(() => {
    if (reduceMotion) return undefined;
    Animated.timing(wipe, {
      duration: 420,
      easing: Easing.out(Easing.cubic),
      isInteraction: false,
      toValue: 1,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
    return undefined;
  });

  const scaleX = wipe.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  return (
    <Animated.View style={styles.retractedRow}>
      <Animated.Text style={styles.retractedGoalText}>GOAL</Animated.Text>
      <Animated.View style={[styles.strike, { transform: [{ scaleX }] }]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  retractedRow: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: tokens.spacing.lg,
    position: 'relative',
  },
  retractedGoalText: {
    color: tokens.shell.textMuted,
    fontSize: 28,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1,
    opacity: 0.6,
  },
  strike: {
    backgroundColor: '#E23546',
    height: 3,
    left: 0,
    position: 'absolute',
    right: 0,
    top: '50%',
  },
  eyebrow: { color: tokens.shell.text },
  headline: { color: '#E23546', fontSize: 48 },
  subline: { color: tokens.shell.textMuted },
  scoreline: { color: tokens.shell.text },
});
