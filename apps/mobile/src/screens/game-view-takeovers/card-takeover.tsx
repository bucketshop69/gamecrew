import type { GameViewScene } from '@gamecrew/core';
import { StyleSheet, Text, View } from 'react-native';

import { playerDisplayName, resolveCardVariant, type CardVariant } from './game-view-takeover-logic';
import {
  teamForParticipant,
  tokens,
  useDelayedCompletion,
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
 * Card banner: a compact pill over the still-visible board -- a small
 * card-shaped chip in yellow/red plus the team (and player when the source
 * provides one). Was a full-screen takeover; product feedback (2026-07-15,
 * with the 22-player formation view) is that a card must not blank the
 * pitch -- the players hold their positions underneath (see the cluster's
 * 'hold' plan) and richer detail belongs to the commentary layer.
 *
 * The director's `card` scene does not carry the yellow/red distinction
 * (only the source cue's `value.action` does, see resolveCardVariant's doc
 * comment) so the caller supplies it via `variant`.
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

  const bannerText = [
    player ?? team?.name,
    CARD_LABEL[resolvedVariant],
  ].filter(Boolean).join(' · ').toUpperCase();

  useTakeoverAnnouncement(announcement);
  useDelayedCompletion(scene.durationHint.minMs, onComplete);

  return (
    <CardEntrance reduceMotion={reduceMotion}>
      <View
        accessibilityLabel={announcement}
        accessibilityLiveRegion="polite"
        accessible
        importantForAccessibility="yes"
        style={styles.pill}
      >
        <View style={[styles.cardChip, { backgroundColor: cardColor }]} />
        {team ? <View style={[styles.teamDot, { backgroundColor: team.color }]} /> : null}
        <Text numberOfLines={1} style={styles.text}>{bannerText}</Text>
      </View>
    </CardEntrance>
  );
}

function CardEntrance({ children }: { children: React.ReactNode; reduceMotion: boolean }) {
  // Compact incident banners are information before motion. Keeping this
  // shell static also avoids a web/JS-driver entrance race where a short
  // replay scene could remain at opacity 0 for its entire visible window.
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
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  // A little card, not a dot: the shape is the signal.
  cardChip: {
    borderRadius: 2,
    height: 14,
    width: 10,
  },
  teamDot: {
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
