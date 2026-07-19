import { gameCrewTokens } from '@gamecrew/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';

const tokens = gameCrewTokens;

/**
 * Item 2's now-listening bar: floating pill docked above the safe area on
 * Home while a headless listening session (state/commentary-listening-session.ts)
 * is active and playing and the user isn't already on that match's own
 * screen. Same floating-pill visual language as the in-match SOUND/MIC
 * toggles (game-view-sound-toggle.tsx/game-view-voice-toggle.tsx) --
 * translucent black chip, hairline border, a green live/active dot.
 */
export function NowListeningBar({
  bottomInset,
  isLive,
  isPlaying,
  matchLabel,
  onPause,
  onResume,
  onTap,
}: {
  /** Safe-area bottom inset the pill floats above. */
  bottomInset: number;
  isLive: boolean;
  isPlaying: boolean;
  matchLabel: string;
  onPause: () => void;
  onResume: () => void;
  onTap: () => void;
}) {
  return (
    <View style={[styles.bar, { bottom: bottomInset + tokens.spacing.sm }]}>
      {isLive ? <View style={styles.liveDot} /> : null}
      <Pressable
        accessibilityHint="Opens the match"
        accessibilityLabel={`Now listening, ${matchLabel}${isLive ? ', live' : ''}`}
        accessibilityRole="button"
        onPress={onTap}
        style={styles.labelColumn}
      >
        <Text style={styles.eyebrow}>{isLive ? 'LISTENING · LIVE' : 'LISTENING'}</Text>
        <Text numberOfLines={1} style={styles.label}>
          {matchLabel}
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel={isPlaying ? 'Pause commentary' : 'Resume commentary'}
        accessibilityRole="button"
        hitSlop={10}
        onPress={() => {
          if (isPlaying) onPause();
          else onResume();
        }}
        style={styles.playButton}
      >
        <Text style={styles.playButtonText}>{isPlaying ? '❚❚' : '▶'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(3, 7, 4, 0.92)',
    borderColor: 'rgba(231, 240, 232, 0.24)',
    borderRadius: tokens.radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    maxWidth: '92%',
    paddingLeft: tokens.spacing.md,
    paddingRight: tokens.spacing.xs,
    paddingVertical: tokens.spacing.xs,
    position: 'absolute',
    zIndex: 20,
  },
  liveDot: {
    backgroundColor: '#73EF90',
    borderRadius: tokens.radii.pill,
    height: 7,
    width: 7,
  },
  labelColumn: {
    flex: 1,
    flexShrink: 1,
  },
  eyebrow: {
    color: 'rgba(231, 240, 232, 0.6)',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
  },
  label: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.medium,
  },
  playButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(231, 240, 232, 0.14)',
    borderRadius: tokens.radii.pill,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  playButtonText: {
    color: tokens.shell.text,
    fontSize: 13,
  },
});
