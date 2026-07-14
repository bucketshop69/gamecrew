import type { GameViewScene } from '@gamecrew/core';
import { useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';

import { resolveSetPieceVariant, setPieceLabel, type SetPieceVariant } from './game-view-takeover-logic';
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

const PICTOGRAM_SIZE = 96;

/**
 * Set-piece vignette: corner / free kick / throw-in / penalty label with a
 * small staged pictogram (silhouettes/pictograms are allowed inside staged
 * vignettes per the PRD's Honesty Rule, unlike continuous play). The
 * director's `set_piece` scene does not carry which specific dead-ball type
 * it is (only the source cue's `value.action` does), so the caller supplies
 * it via `variant`.
 */
export function SetPieceVignette({
  awayTeam,
  homeTeam,
  onComplete,
  reduceMotion,
  scene,
  variant,
}: TakeoverBaseProps & { scene: GameViewScene; variant?: SetPieceVariant }) {
  const resolvedVariant = resolveSetPieceVariant(variant);
  const label = setPieceLabel(resolvedVariant);
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  const accentColor = team?.color ?? tokens.shell.textMuted;

  const announcement = [
    `${label}.`,
    team ? `${team.name}.` : undefined,
  ].filter(Boolean).join(' ');

  useTakeoverAnnouncement(announcement);
  useDelayedCompletion(scene.durationHint.minMs, onComplete);

  return (
    <TakeoverShell accessibilityLabel={announcement} backgroundColor={tokens.shell.surface}>
      <PictogramEntrance reduceMotion={reduceMotion}>
        <SetPiecePictogram accentColor={accentColor} variant={resolvedVariant} />
        {team ? <TakeoverEyebrow style={styles.eyebrow}>{team.name}</TakeoverEyebrow> : null}
        <TakeoverHeadline style={styles.headline}>{label}</TakeoverHeadline>
      </PictogramEntrance>
    </TakeoverShell>
  );
}

function PictogramEntrance({ children, reduceMotion }: { children: React.ReactNode; reduceMotion: boolean }) {
  const entrance = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useMountedOnce(() => {
    if (reduceMotion) return;
    Animated.timing(entrance, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
      isInteraction: false,
      toValue: 1,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  });

  const translateY = entrance.interpolate({ inputRange: [0, 1], outputRange: [10, 0] });

  return (
    <Animated.View style={{ alignItems: 'center', opacity: entrance, transform: [{ translateY }] }}>
      {children}
    </Animated.View>
  );
}

/**
 * A small staged pictogram drawn entirely with Views (no images/SVGs): a
 * corner-of-pitch bracket with a ball dot placed at the arc for 'corner',
 * a simple dead-ball marker + wall hint for 'free_kick', a sideline tick
 * for 'throw_in', and a penalty spot centered in a box outline for
 * 'penalty'. Stylized/abstract per the PRD -- not a positional claim,
 * a staged scene icon.
 */
function SetPiecePictogram({ accentColor, variant }: { accentColor: string; variant: SetPieceVariant }) {
  return (
    <View style={styles.pictogram}>
      {variant === 'corner' ? (
        <>
          <View style={[styles.cornerBracketH, { borderColor: accentColor }]} />
          <View style={[styles.cornerBracketV, { borderColor: accentColor }]} />
          <View style={[styles.cornerArc, { borderColor: accentColor }]} />
          <View style={[styles.ballDot, styles.cornerBallDot, { backgroundColor: accentColor }]} />
        </>
      ) : null}
      {variant === 'free_kick' ? (
        <>
          <View style={[styles.wallRow]}>
            <View style={[styles.wallSegment, { backgroundColor: accentColor }]} />
            <View style={[styles.wallSegment, { backgroundColor: accentColor }]} />
            <View style={[styles.wallSegment, { backgroundColor: accentColor }]} />
          </View>
          <View style={[styles.ballDot, styles.freeKickBallDot, { backgroundColor: accentColor }]} />
        </>
      ) : null}
      {variant === 'throw_in' ? (
        <>
          <View style={[styles.sideline, { backgroundColor: accentColor }]} />
          <View style={[styles.ballDot, styles.throwInBallDot, { backgroundColor: accentColor }]} />
        </>
      ) : null}
      {variant === 'penalty' ? (
        <>
          <View style={[styles.penaltyBox, { borderColor: accentColor }]} />
          <View style={[styles.ballDot, styles.penaltyBallDot, { backgroundColor: accentColor }]} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pictogram: {
    alignItems: 'center',
    height: PICTOGRAM_SIZE,
    justifyContent: 'center',
    marginBottom: tokens.spacing.lg,
    width: PICTOGRAM_SIZE,
  },
  ballDot: {
    borderRadius: 5,
    height: 10,
    position: 'absolute',
    width: 10,
  },
  // Corner: an L-shaped bracket marking the pitch corner, a quarter-arc, and
  // the ball sitting on the arc.
  cornerBracketH: {
    borderTopWidth: 2,
    height: 0,
    position: 'absolute',
    right: 6,
    top: 6,
    width: 40,
  },
  cornerBracketV: {
    borderLeftWidth: 2,
    height: 40,
    position: 'absolute',
    right: 6,
    top: 6,
    width: 0,
  },
  cornerArc: {
    borderBottomLeftRadius: 22,
    borderWidth: 2,
    borderColor: 'transparent',
    height: 22,
    position: 'absolute',
    right: 6,
    top: 6,
    width: 22,
  },
  cornerBallDot: { right: 24, top: 24 },
  // Free kick: a small wall of three segments with the ball placed in front.
  wallRow: {
    flexDirection: 'row',
    gap: 4,
    position: 'absolute',
    top: 18,
  },
  wallSegment: { borderRadius: 3, height: 22, width: 8 },
  freeKickBallDot: { bottom: 18 },
  // Throw-in: a sideline tick with the ball resting just inside it.
  sideline: {
    height: 56,
    position: 'absolute',
    right: 30,
    width: 3,
  },
  throwInBallDot: { left: 38 },
  // Penalty: a box outline with the spot centered.
  penaltyBox: {
    borderWidth: 2,
    height: 60,
    position: 'absolute',
    width: 76,
  },
  penaltyBallDot: {},
  eyebrow: { color: tokens.shell.text },
  headline: { color: tokens.shell.text, fontSize: 36 },
});
