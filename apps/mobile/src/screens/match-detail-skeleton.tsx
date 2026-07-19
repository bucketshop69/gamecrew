import { gameCrewTokens } from '@gamecrew/core';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Reanimated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

const tokens = gameCrewTokens;

/**
 * Fix round item 1: replaces the old text-y "Loading match." state message
 * for MatchDetailRoute's LOADING branch only (app/matches/[fixtureId].tsx --
 * error/not_found keep MatchDetailStateScreen's existing copy-driven
 * treatment, see that route's other two branches). Shaped like the real
 * match layout so the transition into the actual screen doesn't jump: a
 * back-button header row, a score-strip block, a large board block, a
 * checkpoint-rail-height strip, and the two-tab bar silhouette -- soft
 * rounded rectangles in the existing dark shell palette
 * (surface/surfaceRaised) with a gentle, looping opacity pulse (matches the
 * pulse pattern already used by floating-chat-button.tsx / gift-reveal-takeover.tsx's
 * `withRepeat`), no text anywhere. Respects reduce-motion the same way every
 * other animated surface in this app does (see gamecrew-screens.tsx's/
 * game-view-screen.tsx's own `useReducedMotionPreference` -- duplicated
 * locally here rather than shared, matching this codebase's own precedent
 * for that hook, see those files' doc comments on why).
 */
export function MatchDetailSkeleton() {
  const reduceMotion = useReducedMotionPreference();
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) {
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(0.45, { duration: 1000, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
  }, [pulse, reduceMotion]);

  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
      <Reanimated.View style={[styles.block, pulseStyle]}>
        <View style={styles.headerRow}>
          <View style={styles.backButton} />
          <View style={styles.competitionLine} />
        </View>

        <View style={styles.scoreStrip}>
          <View style={styles.scoreTeam}>
            <View style={styles.flag} />
            <View style={styles.teamNameLine} />
          </View>
          <View style={styles.scoreCenter}>
            <View style={styles.clockLine} />
          </View>
          <View style={styles.scoreTeam}>
            <View style={styles.flag} />
            <View style={styles.teamNameLine} />
          </View>
        </View>

        <View style={styles.board} />

        <View style={styles.checkpointRail} />

        <View style={styles.tabBar}>
          <View style={styles.tab} />
          <View style={styles.tab} />
        </View>
      </Reanimated.View>
    </SafeAreaView>
  );
}

/** Same detection pattern used across the app -- see gamecrew-screens.tsx's / game-view-screen.tsx's own useReducedMotionPreference doc comments. */
function useReducedMotionPreference(): boolean {
  const [reduceMotion, setReduceMotion] = useState(true);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: tokens.shell.background,
    flex: 1,
  },
  block: {
    flex: 1,
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.sm,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    minHeight: 30,
  },
  backButton: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.pill,
    height: 30,
    width: 64,
  },
  competitionLine: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.pill,
    flex: 1,
    height: 9,
  },
  scoreStrip: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    justifyContent: 'space-between',
    minHeight: 64,
    paddingVertical: tokens.spacing.sm,
  },
  scoreTeam: {
    alignItems: 'center',
    flex: 1,
    gap: tokens.spacing.xs,
  },
  flag: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.sm,
    height: 32,
    width: 48,
  },
  teamNameLine: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.pill,
    height: 9,
    width: 60,
  },
  scoreCenter: {
    alignItems: 'center',
    flexBasis: 112,
    flexGrow: 0,
    flexShrink: 0,
    justifyContent: 'center',
  },
  clockLine: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.pill,
    height: 26,
    width: 72,
  },
  board: {
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.lg,
    flex: 1,
    marginTop: tokens.spacing.xs,
  },
  checkpointRail: {
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.md,
    height: 44,
  },
  tabBar: {
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.pill,
    flexDirection: 'row',
    gap: tokens.spacing.xs,
    marginBottom: tokens.spacing.sm,
    padding: tokens.spacing.xs,
  },
  tab: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.pill,
    flex: 1,
    height: 38,
  },
});
