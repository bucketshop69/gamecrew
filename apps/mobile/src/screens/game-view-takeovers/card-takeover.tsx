import type { GameViewScene } from '@gamecrew/core';
import { useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';

import { playerDisplayName, resolveCardVariant, type CardVariant } from './game-view-takeover-logic';
import {
  TakeoverEyebrow,
  TakeoverHeadline,
  TakeoverShell,
  TakeoverSubline,
  teamForParticipant,
  tokens,
  useDelayedCompletion,
  useMountedOnce,
  useTakeoverAnnouncement,
  type TakeoverBaseProps,
} from './takeover-shared';

const CARD_COLOR: Record<CardVariant, string> = {
  yellow: '#F5D75F',
  red: '#E23546',
};

const CARD_LABEL: Record<CardVariant, string> = {
  yellow: 'YELLOW CARD',
  red: 'RED CARD',
};

/**
 * Card takeover: a yellow or red card graphic with team-color accent and the
 * carded player's name when the source provides it. The director's `card`
 * scene does not carry the yellow/red distinction (only the source cue's
 * `value.action` does, see game-view-takeover-logic.ts's
 * resolveCardVariant doc comment) so the caller supplies it via `variant`.
 */
export function CardTakeover({
  awayTeam,
  homeTeam,
  onComplete,
  reduceMotion,
  scene,
  variant,
}: TakeoverBaseProps & { scene: GameViewScene; variant?: CardVariant }) {
  const resolvedVariant = resolveCardVariant(variant);
  const cardColor = CARD_COLOR[resolvedVariant];
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  const player = playerDisplayName(scene.player);

  const announcement = [
    `${CARD_LABEL[resolvedVariant]}.`,
    player ? `${player}${team ? `, ${team.name}` : ''}.` : team ? `${team.name}.` : undefined,
  ].filter(Boolean).join(' ');

  useTakeoverAnnouncement(announcement);
  useDelayedCompletion(scene.durationHint.minMs, onComplete);

  return (
    <TakeoverShell accessibilityLabel={announcement} backgroundColor={tokens.shell.surface}>
      <CardEntrance reduceMotion={reduceMotion}>
        <View style={[styles.cardGraphic, { backgroundColor: cardColor }]} />
        {team ? <View style={[styles.teamAccent, { backgroundColor: team.color }]} /> : null}
        <TakeoverEyebrow style={styles.eyebrow}>{team?.name ?? 'Card'}</TakeoverEyebrow>
        <TakeoverHeadline style={[styles.headline, resolvedVariant === 'red' && styles.headlineRed]}>
          {CARD_LABEL[resolvedVariant]}
        </TakeoverHeadline>
        {player ? <TakeoverSubline style={styles.subline}>{player}</TakeoverSubline> : null}
      </CardEntrance>
    </TakeoverShell>
  );
}

function CardEntrance({ children, reduceMotion }: { children: React.ReactNode; reduceMotion: boolean }) {
  const entrance = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useMountedOnce(() => {
    if (reduceMotion) return;
    Animated.timing(entrance, {
      duration: 240,
      easing: Easing.out(Easing.back(1.4)),
      isInteraction: false,
      toValue: 1,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  });

  const scale = entrance.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] });

  return (
    <Animated.View style={{ alignItems: 'center', opacity: entrance, transform: [{ scale }] }}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  cardGraphic: {
    borderRadius: 6,
    height: 84,
    marginBottom: tokens.spacing.lg,
    width: 60,
  },
  teamAccent: {
    borderRadius: tokens.radii.pill,
    height: 4,
    marginBottom: tokens.spacing.md,
    width: 48,
  },
  eyebrow: { color: tokens.shell.text },
  headline: { color: tokens.shell.text, fontSize: 40 },
  headlineRed: { color: '#E23546' },
  subline: { color: tokens.shell.text },
});
