import type { GameViewScene } from '@gamecrew/core';
import { StyleSheet, Text, View } from 'react-native';

import {
  teamForParticipant,
  tokens,
  useDelayedCompletion,
  useTakeoverAnnouncement,
  type TakeoverBaseProps,
} from './takeover-shared';

export type MatchMomentVariant = 'substitution' | 'injury' | 'additional_time';

/** Compact broadcast-style moment label that keeps the pitch visible underneath. */
export function MatchMomentBanner({
  awayTeam,
  homeTeam,
  onComplete,
  scene,
  variant,
}: TakeoverBaseProps & { scene: GameViewScene; variant: MatchMomentVariant }) {
  const team = teamForParticipant(scene.participant, homeTeam, awayTeam);
  const copy = resolveMomentCopy(scene, variant);
  const announcement = [copy.title, copy.detail, team?.name].filter(Boolean).join('. ');

  useTakeoverAnnouncement(announcement);
  useDelayedCompletion(scene.durationHint.minMs, onComplete);

  return (
    <View
      accessibilityLabel={announcement}
      accessibilityLiveRegion="polite"
      accessible
      style={styles.layer}
    >
      <View style={[styles.banner, { borderLeftColor: team?.color ?? tokens.shell.textMuted }]}>
        <Text style={styles.title}>{copy.title}</Text>
        {copy.detail ? <Text style={styles.detail}>{copy.detail}</Text> : null}
        {team ? <Text style={[styles.team, { color: team.color }]}>{team.name}</Text> : null}
      </View>
    </View>
  );
}

function resolveMomentCopy(
  scene: GameViewScene,
  variant: MatchMomentVariant,
): { title: string; detail?: string } {
  if (variant === 'additional_time') {
    return {
      title: scene.additionalTimeMinutes === undefined
        ? 'ADDED TIME'
        : `+${scene.additionalTimeMinutes} ADDED TIME`,
    };
  }
  if (variant === 'injury') {
    return {
      title: 'INJURY STOPPAGE',
      detail: scene.player?.displayName ?? scene.player?.sourcePreferredName,
    };
  }
  return { title: 'SUBSTITUTION', detail: '↗  ↘' };
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: tokens.spacing.xl,
    pointerEvents: 'none',
    zIndex: 20,
  },
  banner: {
    backgroundColor: 'rgba(12, 14, 18, 0.94)',
    borderLeftWidth: 4,
    borderRadius: 12,
    minWidth: 196,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
  },
  title: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1.6,
    textAlign: 'center',
  },
  detail: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    marginTop: tokens.spacing.xs,
    textAlign: 'center',
  },
  team: {
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
    marginTop: tokens.spacing.xs,
    textAlign: 'center',
  },
});
