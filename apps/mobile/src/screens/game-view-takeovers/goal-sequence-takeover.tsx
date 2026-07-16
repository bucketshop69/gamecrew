import type { GameViewScene } from '@gamecrew/core';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

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

  const activeEntry = plan[activeIndex] ?? plan[0]!;

  // R4 (docs/issues/game-view-realism-experiment.md, "Goal choreography"):
  // during the tension beat the players are already celebrating ON the board
  // (the action cluster's corner run), so the checking treatment is a
  // compact banner over the visible pitch, not a full-screen card. The full
  // team-color takeover is reserved for confirmation -- which also keeps
  // provisional and confirmed visually distinct, per the PRD.
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {activeEntry.beat.kind === 'tension' ? (
        <TensionBanner awayTeam={awayTeam} homeTeam={homeTeam} scene={scene} />
      ) : (
        <BeatCard
          awayTeam={awayTeam}
          backgroundColor={backgroundColor}
          beat={activeEntry.beat}
          homeTeam={homeTeam}
          scene={scene}
        />
      )}
    </View>
  );
}

/**
 * The checking treatment as a lower-key overlay: a dark pill pinned to the
 * top edge ("GOAL? CHECKING", team-colored dot) that leaves the board -- and
 * the premature celebration playing on it -- fully visible. Announces the
 * same information the old full-screen tension card did.
 */
function TensionBanner({
  awayTeam,
  homeTeam,
  scene,
}: {
  awayTeam: TakeoverBaseProps['awayTeam'];
  homeTeam: TakeoverBaseProps['homeTeam'];
  scene: GameViewScene;
}) {
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  const announcement = `${team?.name ?? 'Goal'} check under way. Goal pending confirmation.`;
  useTakeoverAnnouncement(announcement);

  return (
    <View style={tensionBannerStyles.wrap}>
      <View
        accessibilityLabel={announcement}
        accessibilityLiveRegion="polite"
        accessible
        importantForAccessibility="yes"
        style={tensionBannerStyles.pill}
      >
        <View style={[tensionBannerStyles.dot, { backgroundColor: team?.color ?? tokens.shell.textMuted }]} />
        <Text numberOfLines={1} style={tensionBannerStyles.headline}>GOAL?</Text>
        <Text numberOfLines={1} style={tensionBannerStyles.checking}>CHECKING</Text>
      </View>
    </View>
  );
}

const tensionBannerStyles = StyleSheet.create({
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
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  dot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  headline: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1.5,
  },
  checking: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 2,
  },
});

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
