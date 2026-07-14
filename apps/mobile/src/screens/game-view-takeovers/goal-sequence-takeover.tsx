import type { GameViewScene } from '@gamecrew/core';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet } from 'react-native';

import {
  escalationLabel,
  formatScoreline,
  planGoalSequenceBeats,
  playerDisplayName,
  reduceMotionHoldMs,
  selectGoalSequenceEscalation,
  type GoalBeatPlanEntry,
} from './game-view-takeover-logic';
import {
  TakeoverEyebrow,
  TakeoverHeadline,
  TakeoverScoreline,
  TakeoverShell,
  TakeoverSubline,
  teamForParticipant,
  tokens,
  useDelayedCompletion,
  useTakeoverAnnouncement,
  type TakeoverBaseProps,
} from './takeover-shared';

/**
 * Plays a goal_sequence scene's beats in order: 'tension' (checking
 * treatment, no score change shown -- see docs/prds/game_view.md "The
 * Honesty Rule") then 'celebration' (team-color takeover with scorer +
 * new scoreline + data-driven escalation line). Timing is driven by
 * `planGoalSequenceBeats`, which splits the scene's `durationHint` across
 * the beats it actually has. Calls `onComplete` once after the last beat's
 * hold elapses.
 *
 * A scene may carry only a tension beat (still provisional, no
 * goal_confirmed yet) -- the takeover holds on that beat and still calls
 * onComplete at the end of its planned duration so playback isn't stuck
 * waiting on a beat that may never come in this render pass; the director
 * emits an updated scene (now with a celebration beat) if/when confirmation
 * arrives, which the playback layer feeds back in as a fresh scene.
 */
export function GoalSequenceTakeover({
  awayTeam,
  homeTeam,
  onComplete,
  reduceMotion,
  scene,
}: TakeoverBaseProps & { scene: GameViewScene }) {
  const plan = planGoalSequenceBeats(scene);
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  const backgroundColor = team?.color ?? tokens.shell.surface;
  const hasNoBeats = plan.length === 0;

  // No beats at all: nothing choreographable. This hook always runs (rules
  // of hooks) but only actually schedules when there is nothing to play
  // (onComplete is undefined otherwise, which useDelayedCompletion treats as
  // a no-op), so the dispatcher still gets onComplete for a
  // malformed/partial scene instead of stalling playback.
  useDelayedCompletion(0, hasNoBeats ? onComplete : undefined);

  if (hasNoBeats) return null;

  if (reduceMotion) {
    return (
      <ReducedMotionGoalSequence
        awayTeam={awayTeam}
        backgroundColor={backgroundColor}
        homeTeam={homeTeam}
        onComplete={onComplete}
        plan={plan}
        scene={scene}
      />
    );
  }

  return (
    <AnimatedGoalSequence
      awayTeam={awayTeam}
      backgroundColor={backgroundColor}
      homeTeam={homeTeam}
      onComplete={onComplete}
      plan={plan}
      scene={scene}
    />
  );
}

function ReducedMotionGoalSequence({
  awayTeam,
  backgroundColor,
  homeTeam,
  onComplete,
  plan,
  scene,
}: {
  awayTeam: TakeoverBaseProps['awayTeam'];
  backgroundColor: string;
  homeTeam: TakeoverBaseProps['homeTeam'];
  onComplete: TakeoverBaseProps['onComplete'];
  plan: readonly GoalBeatPlanEntry[];
  scene: GameViewScene;
}) {
  // Reduce motion: show the final (most informative) beat as a static,
  // fully readable card rather than animating through each beat -- same
  // information, no motion, per the PRD's reduce-motion rule.
  const finalEntry = plan[plan.length - 1]!;
  const totalMs = finalEntry.offsetMs + finalEntry.durationMs;
  const holdMs = reduceMotionHoldMs(totalMs);
  useDelayedCompletion(holdMs, onComplete);

  return (
    <BeatCard
      awayTeam={awayTeam}
      backgroundColor={backgroundColor}
      beat={finalEntry.beat}
      homeTeam={homeTeam}
      scene={scene}
    />
  );
}

function AnimatedGoalSequence({
  awayTeam,
  backgroundColor,
  homeTeam,
  onComplete,
  plan,
  scene,
}: {
  awayTeam: TakeoverBaseProps['awayTeam'];
  backgroundColor: string;
  homeTeam: TakeoverBaseProps['homeTeam'];
  onComplete: TakeoverBaseProps['onComplete'];
  plan: readonly GoalBeatPlanEntry[];
  scene: GameViewScene;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const entrance = useRef(new Animated.Value(0)).current;
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Schedule an index-advance timer at each beat's offset (beat 0 starts
    // immediately) and a final completion timer at the plan's total
    // duration. Timers, not Animated.sequence, because each beat needs its
    // own React-rendered content (headline/scorer/scoreline text), not just
    // an interpolated numeric style -- see the "no existing onComplete
    // pattern" gap noted for match-preview-screen.tsx; setTimeout is the
    // straightforward, standard-RN way to drive that here.
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    plan.forEach((entry, index) => {
      if (index === 0) return;
      const handle = setTimeout(() => setActiveIndex(index), entry.offsetMs);
      timersRef.current.push(handle);
    });

    const last = plan[plan.length - 1]!;
    const completionHandle = setTimeout(() => {
      onComplete?.();
    }, last.offsetMs + last.durationMs);
    timersRef.current.push(completionHandle);

    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.id]);

  useEffect(() => {
    entrance.stopAnimation();
    entrance.setValue(0);
    Animated.timing(entrance, {
      duration: 260,
      easing: Easing.out(Easing.cubic),
      isInteraction: false,
      toValue: 1,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [activeIndex, entrance]);

  const activeEntry = plan[activeIndex] ?? plan[0]!;
  const translateY = entrance.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity: entrance, transform: [{ translateY }] }]}>
      <BeatCard
        awayTeam={awayTeam}
        backgroundColor={backgroundColor}
        beat={activeEntry.beat}
        homeTeam={homeTeam}
        scene={scene}
      />
    </Animated.View>
  );
}

function BeatCard({
  awayTeam,
  backgroundColor,
  beat,
  homeTeam,
  scene,
}: {
  awayTeam: TakeoverBaseProps['awayTeam'];
  backgroundColor: string;
  beat: GoalBeatPlanEntry['beat'];
  homeTeam: TakeoverBaseProps['homeTeam'];
  scene: GameViewScene;
}) {
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  const isTension = beat.kind === 'tension';
  const scorer = playerDisplayName(beat.player);
  const scoreline = formatScoreline(beat.scoreAtMoment ?? scene.scoreAtMoment);
  const escalation = isTension ? undefined : escalationLabel(selectGoalSequenceEscalation(scene.scoreEvents));

  const announcement = isTension
    ? `${team?.name ?? 'Goal'} check under way. Goal pending confirmation.`
    : [
      `Goal for ${team?.name ?? 'the attacking team'}.`,
      scorer ? `Scored by ${scorer}.` : undefined,
      scoreline ? `Score now ${scoreline.replace('-', ' to ')}.` : undefined,
      escalation ? `${escalation}.` : undefined,
    ].filter(Boolean).join(' ');

  useTakeoverAnnouncement(announcement);

  return (
    <TakeoverShell
      accessibilityLabel={announcement}
      backgroundColor={isTension ? tokens.shell.surface : backgroundColor}
    >
      {team ? <TakeoverEyebrow>{team.name}</TakeoverEyebrow> : null}
      <TakeoverHeadline style={isTension ? tensionStyles.headline : celebrationStyles.headline}>
        {isTension ? 'GOAL?' : 'GOAL'}
      </TakeoverHeadline>
      {isTension ? (
        <TakeoverSubline style={tensionStyles.subline}>Checking</TakeoverSubline>
      ) : (
        <>
          {scorer ? <TakeoverSubline style={celebrationStyles.subline}>{scorer}</TakeoverSubline> : null}
          {scoreline ? (
            <TakeoverScoreline style={celebrationStyles.scoreline}>{scoreline}</TakeoverScoreline>
          ) : null}
          {escalation ? (
            <TakeoverSubline style={celebrationStyles.escalation}>{escalation}</TakeoverSubline>
          ) : null}
        </>
      )}
    </TakeoverShell>
  );
}

const tensionStyles = StyleSheet.create({
  headline: { color: tokens.shell.text, opacity: 0.82 },
  subline: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.body,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
});

const celebrationStyles = StyleSheet.create({
  headline: {},
  subline: {},
  scoreline: {},
  escalation: {
    fontSize: tokens.typography.size.title,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1.5,
    marginTop: tokens.spacing.lg,
    textTransform: 'uppercase',
  },
});
