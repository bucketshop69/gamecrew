import { gameCrewTokens } from '@gamecrew/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { GAME_VIEW_STATE_COPY, selectStatePanelCopy, type GameViewLoadStatus } from './game-view-board-logic';

const tokens = gameCrewTokens;

/**
 * View-state panels for Game View (work item B3 of
 * docs/issues/game-view-board-and-presentation.md): loading, empty, error,
 * and stale. Copy is exact PRD text, sourced from
 * `GAME_VIEW_STATE_COPY`/`selectStatePanelCopy` in game-view-board-logic.ts
 * so the copy itself stays covered by plain-function tests.
 *
 * Black-shell styled per the PRD's "Visual States": loading/empty/error each
 * take over the full board area, while stale is a quiet banner layered over
 * the still-visible board rather than replacing it.
 */
export function GameViewStatePanel({
  status,
  onRetry,
}: {
  status: Exclude<GameViewLoadStatus, 'ready'>;
  onRetry?: () => void;
}) {
  const copy = selectStatePanelCopy(status);
  if (!copy) return null;

  return (
    <View
      accessibilityLiveRegion={status === 'error' ? 'assertive' : 'polite'}
      accessibilityRole={status === 'error' ? 'alert' : 'text'}
      style={styles.panel}
    >
      <Text accessibilityRole="header" selectable style={styles.title}>
        {copy.title}
      </Text>

      {copy.actionLabel && onRetry ? (
        <Pressable
          accessibilityLabel={copy.actionLabel}
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
        >
          <Text style={styles.actionText}>{copy.actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Quiet banner for the `stale` state: rendered as an overlay over the still-
 * visible board (per the PRD, stale "keep[s] the board at its last state ...
 * mark[s] the feed as stale" rather than replacing it), so this is a small
 * top-anchored strip, not a full-panel takeover.
 */
export function GameViewStaleBanner() {
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="text"
      style={styles.staleBanner}
    >
      <View style={styles.staleDot} />
      <Text selectable style={styles.staleText}>
        {GAME_VIEW_STATE_COPY.stale.title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    alignItems: 'center',
    backgroundColor: tokens.shell.background,
    flex: 1,
    gap: tokens.spacing.lg,
    justifyContent: 'center',
    padding: tokens.spacing.xl,
  },
  title: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.title,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.title,
    maxWidth: 300,
    textAlign: 'center',
  },
  action: {
    backgroundColor: tokens.shell.text,
    borderRadius: tokens.radii.pill,
    paddingHorizontal: tokens.spacing.xl,
    paddingVertical: tokens.spacing.md,
  },
  actionPressed: {
    opacity: 0.72,
  },
  actionText: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: tokens.typography.lineHeight.caption,
  },
  staleBanner: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(5, 5, 5, 0.82)',
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    marginTop: tokens.spacing.lg,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    position: 'absolute',
    top: 0,
    zIndex: 20,
  },
  staleDot: {
    backgroundColor: tokens.shell.textMuted,
    borderRadius: 4,
    height: 7,
    width: 7,
  },
  staleText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.medium,
    lineHeight: tokens.typography.lineHeight.caption,
  },
});
