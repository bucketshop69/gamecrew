import { gameCrewTokens } from '@gamecrew/core';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View, type ViewStyle } from 'react-native';

/**
 * Shared visual language + small primitives for the Game View takeover
 * renderers. Design language (see docs/prds/game_view.md "Visual Direction"
 * and docs/issues/game-view-board-and-presentation.md): black shell, bold
 * brief typography-led overlays in the owning team's color, tabular-nums for
 * score/time, no gradients or blur.
 */
export const tokens = gameCrewTokens;

/** Shared "team" shape every takeover component's props accept for color/identity. */
export interface TakeoverTeam {
  name: string;
  color: string;
  participant: 1 | 2;
}

/** Every takeover component shares this props contract, layered with its own scene-specific fields. */
export interface TakeoverBaseProps {
  homeTeam: TakeoverTeam;
  awayTeam: TakeoverTeam;
  reduceMotion: boolean;
  /** Called exactly once when the takeover has finished playing (or immediately/after a hold when reduceMotion is on), so the playback layer can advance to the next scene. */
  onComplete?: () => void;
}

export function teamForParticipant(
  participant: 1 | 2 | undefined,
  homeTeam: TakeoverTeam,
  awayTeam: TakeoverTeam,
): TakeoverTeam | undefined {
  if (participant === undefined) return undefined;
  return participant === homeTeam.participant ? homeTeam : awayTeam;
}

/**
 * Same detection pattern as gamecrew-screens.tsx's useReducedMotionPreference:
 * defaults to true (motion-safe) until the OS setting resolves, then tracks
 * live changes. Exported so the dispatcher can read it once and pass it down
 * to whichever takeover renders, keeping every scene's reduce-motion behavior
 * consistent with a single source of truth.
 */
export function useReducedMotionPreference(): boolean {
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

/**
 * Fires `onComplete` once after `delayMs`, cancelling the pending timer on
 * unmount or if `delayMs`/`onComplete` change before it fires. Used by
 * reduce-motion static cards (which still need to advance playback after a
 * readable hold) and can also back a takeover's overall duration timer.
 */
export function useDelayedCompletion(delayMs: number, onComplete: (() => void) | undefined): void {
  useEffect(() => {
    if (!onComplete) return;
    const handle = setTimeout(onComplete, Math.max(0, delayMs));
    return () => clearTimeout(handle);
  }, [delayMs, onComplete]);
}

/**
 * Announces a takeover's readable summary to screen readers the moment it
 * mounts (or its announced text changes), matching the "every takeover
 * announces itself" requirement. The app has no existing
 * announceForAccessibility precedent (confirmed: not used elsewhere in
 * apps/mobile), so this establishes it directly rather than approximating
 * with accessibilityLiveRegion alone, which Android/iOS support inconsistently
 * on a container that mounts already-populated (a fresh mount doesn't always
 * trigger a live-region announcement, whereas announceForAccessibility always
 * does). accessibilityLiveRegion is still set on the container as a
 * defense-in-depth for platforms/tools that rely on it instead.
 */
export function useTakeoverAnnouncement(message: string): void {
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(message);
  }, [message]);
}

/** Full-area absolute-fill overlay shell every takeover renders itself inside. */
export function TakeoverShell({
  accessibilityLabel,
  backgroundColor,
  children,
  style,
}: {
  accessibilityLabel: string;
  backgroundColor: string;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityLiveRegion="polite"
      accessible
      importantForAccessibility="yes"
      style={[StyleSheet.absoluteFill, styles.shell, { backgroundColor }, style]}
    >
      {children}
    </View>
  );
}

/** Large bold headline used for "GOAL", "GOAL?", "NO GOAL", "KICK OFF", etc. */
export function TakeoverHeadline({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[styles.headline, style]}>{children}</Text>;
}

/** Secondary line beneath a headline (scorer name, card reason, set-piece descriptor). */
export function TakeoverSubline({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[styles.subline, style]}>{children}</Text>;
}

/** Large tabular-nums scoreline, e.g. "2-1". */
export function TakeoverScoreline({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[styles.scoreline, style]}>{children}</Text>;
}

/** Small caps eyebrow label above a headline, e.g. team name or moment kind. */
export function TakeoverEyebrow({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[styles.eyebrow, style]}>{children}</Text>;
}

/**
 * Runs `effect` once on mount, same as `useEffect(fn, [])`, but named for
 * intent at call sites that start a one-shot entrance animation. Supports
 * returning a cleanup function (e.g. to stop a looping Animated animation on
 * unmount), exactly like a normal effect.
 */
export function useMountedOnce(effect: () => (() => void) | void): void {
  useEffect(() => {
    return effect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const styles = StyleSheet.create({
  shell: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.xl,
    zIndex: 20,
  },
  eyebrow: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 2,
    marginBottom: tokens.spacing.sm,
    opacity: 0.72,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  headline: {
    color: tokens.shell.inverseText,
    fontSize: 56,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  subline: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.title,
    fontWeight: tokens.typography.weight.medium,
    marginTop: tokens.spacing.md,
    textAlign: 'center',
  },
  scoreline: {
    color: tokens.shell.inverseText,
    fontVariant: ['tabular-nums'],
    fontSize: tokens.typography.size.display,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1,
    marginTop: tokens.spacing.lg,
    textAlign: 'center',
  },
});
