import { gameCrewTokens } from '@gamecrew/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatTransportStripLabel, type TransportStripLabel } from './match-transport-strip-logic';

const tokens = gameCrewTokens;

/**
 * Transport strip (demo-lockdown round 5, item 7) -- a single play/pause
 * button plus a short state label, rendered in `MatchDetailScreen` between
 * the checkpoint dock and the bottom tab bar, visible on BOTH Match Pulse
 * and Game View tabs. Same dark pill/dock visual language as
 * now-listening-bar.tsx's floating pill (translucent black chip, hairline
 * border, a round play/pause button) but docked in normal flex flow here
 * rather than floating absolutely, since the checkpoint dock and tab bar it
 * sits between are themselves in flex flow.
 *
 * All label/state/action DECISIONS live in the pure
 * match-transport-strip-logic.ts module (`resolveTransportStripLabel`,
 * `resolveTransportButtonAction`, `shouldShowBackToFullTime`) -- this
 * component only renders whatever that module already resolved and forwards
 * taps to the caller's `onPlay`/`onPause`/`onStop` handlers. It never reads
 * `playback`/`gameViewIntent` directly, so it stays trivially presentational
 * and easy to reason about in isolation, matching the split every other
 * pure-logic/renderer pair in this codebase already follows.
 */
export function MatchTransportStrip({
  disabled = false,
  isPaused,
  label,
  onPress,
  onStop,
  onToggleSound,
  onToggleVoice,
  showBackToFullTime,
  soundEnabled,
  voiceEnabled,
}: {
  /** Item 4: true for an upcoming/hosted fixture -- the play/pause button renders dimmed and ignores taps (there is nothing to play yet). */
  disabled?: boolean;
  /** Whether the button should render as a play (paused/parked) or pause (actively advancing) glyph. */
  isPaused: boolean;
  label: TransportStripLabel;
  /** The single play/pause button's tap handler -- the caller has already resolved which concrete action (`start_full_replay`/`pause`/`resume`/`return_to_live`/`none`) this corresponds to via `resolveTransportButtonAction`. */
  onPress: () => void;
  /** Only called while `showBackToFullTime` is true. */
  onStop: () => void;
  /** Crowd/broadcast sound toggle (the old on-pitch SOUND pill, relocated). The caller owns activateFromGesture ordering. */
  onToggleSound: () => void;
  /** Commentary voice toggle (the old "MIC" chip, relocated and de-mic'd -- headset glyph, since a mic implies the user's own microphone). */
  onToggleVoice: () => void;
  showBackToFullTime: boolean;
  soundEnabled: boolean;
  voiceEnabled: boolean;
}) {
  const labelText = formatTransportStripLabel(label);

  return (
    <View accessibilityLabel={`Match transport, ${labelText}`} style={styles.root}>
      <Pressable
        accessibilityLabel={isPaused ? 'Play' : 'Pause'}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={8}
        onPress={onPress}
        style={({ pressed }) => [
          styles.playButton,
          disabled && styles.playButtonDisabled,
          pressed && !disabled && styles.pressed,
        ]}
      >
        <Text style={styles.playButtonText}>{isPaused ? '▶' : '❚❚'}</Text>
      </Pressable>

      <Text numberOfLines={1} style={styles.label}>
        {labelText}
      </Text>

      <Pressable
        accessibilityLabel={soundEnabled ? 'Mute crowd sound' : 'Enable crowd sound'}
        accessibilityRole="button"
        hitSlop={6}
        onPress={onToggleSound}
        style={({ pressed }) => [
          styles.iconButton,
          !soundEnabled && styles.iconButtonOff,
          pressed && styles.pressed,
        ]}
      >
        {/* Item 10: same 🔊 glyph at low opacity when off, rather than the
            muted-speaker emoji -- 🔇 renders with a red slash on several
            platforms, which reads as an alert/error color rather than the
            intended quiet "dim, not red" off-state. */}
        <Text style={[styles.iconText, !soundEnabled && styles.iconTextOff]}>🔊</Text>
        <Text style={styles.iconCaption}>CROWD</Text>
      </Pressable>

      <Pressable
        accessibilityLabel={voiceEnabled ? 'Mute commentary' : 'Enable commentary'}
        accessibilityRole="button"
        hitSlop={6}
        onPress={onToggleVoice}
        style={({ pressed }) => [
          styles.iconButton,
          !voiceEnabled && styles.iconButtonOff,
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.iconText, !voiceEnabled && styles.iconTextOff]}>🎧</Text>
        <Text style={styles.iconCaption}>VOICE</Text>
      </Pressable>

      {showBackToFullTime ? (
        <Pressable
          accessibilityLabel="Back to full time"
          accessibilityRole="button"
          hitSlop={8}
          onPress={onStop}
          style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
        >
          <Text style={styles.stopButtonText}>■</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    backgroundColor: 'rgba(3, 7, 4, 0.92)',
    borderColor: 'rgba(231, 240, 232, 0.16)',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.xs,
  },
  playButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(231, 240, 232, 0.14)',
    borderRadius: tokens.radii.pill,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  playButtonDisabled: {
    opacity: 0.4,
  },
  playButtonText: {
    color: tokens.shell.text,
    fontSize: 13,
  },
  label: {
    color: tokens.shell.text,
    flex: 1,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 0.4,
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(231, 240, 232, 0.14)',
    borderRadius: tokens.radii.sm,
    gap: 1,
    justifyContent: 'center',
    minHeight: 32,
    minWidth: 32,
    paddingHorizontal: tokens.spacing.xs,
    paddingVertical: 3,
  },
  iconButtonOff: {
    backgroundColor: 'rgba(231, 240, 232, 0.05)',
  },
  iconText: {
    fontSize: 13,
  },
  iconTextOff: {
    opacity: 0.35,
  },
  /** Item 10: tiny "CROWD"/"VOICE" captions under the audio icons -- reuses the same muted mono caption tokens as the transport label's dim state elsewhere in this file. */
  iconCaption: {
    color: tokens.shell.textMuted,
    fontSize: 8,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 0.5,
  },
  stopButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(231, 240, 232, 0.14)',
    borderRadius: tokens.radii.pill,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  stopButtonText: {
    color: tokens.shell.textMuted,
    fontSize: 10,
  },
  pressed: {
    opacity: 0.72,
  },
});
