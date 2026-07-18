import { gameCrewTokens } from '@gamecrew/core';
import { useMemo } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from 'react-native';

import {
  type GameViewCheckpoint,
  type GameViewCheckpointKind,
  type GameViewCheckpointRailModel,
  findActiveGameViewCheckpointId,
  resolveGameViewCheckpointProgress,
} from './game-view-checkpoint-logic';

const tokens = gameCrewTokens;

const MARKER_COLORS: Record<GameViewCheckpointKind, string> = {
  goal: '#F6C453',
  red_card: '#ED3348',
  penalty: '#F09A32',
  var: '#9A7BFF',
  overturned_goal: '#AAB2AE',
};

const MARKER_SYMBOLS: Record<GameViewCheckpointKind, string> = {
  goal: 'G',
  red_card: 'R',
  penalty: 'P',
  var: 'V',
  overturned_goal: '×',
};

/**
 * Shared horizontal full-match navigation docked above the bottom tabs.
 * Match Pulse and Game View consume the same markers and canonical playhead;
 * Chat intentionally omits it.
 */
export function GameViewCheckpointRail({
  currentClockSeconds,
  model,
  onSelect,
  playheadIndex,
}: {
  currentClockSeconds: number | undefined;
  model: GameViewCheckpointRailModel;
  onSelect: (sceneIndex: number) => void;
  playheadIndex: number;
}) {
  const activeCheckpointId = useMemo(
    () => findActiveGameViewCheckpointId(model.checkpoints, playheadIndex),
    [model.checkpoints, playheadIndex],
  );
  const progress = resolveGameViewCheckpointProgress(
    currentClockSeconds,
    model.durationSeconds,
  );

  return (
    <View pointerEvents="box-none" style={styles.rail}>
      <Text style={styles.endpointLabel}>0′</Text>
      <View pointerEvents="box-none" style={styles.trackArea}>
        <View pointerEvents="none" style={styles.track} />
        <View
          pointerEvents="none"
          style={[styles.elapsedTrack, { width: percent(progress) }]}
        />

        {model.checkpoints.map((checkpoint) => (
          <CheckpointMarker
            active={checkpoint.id === activeCheckpointId}
            checkpoint={checkpoint}
            key={checkpoint.id}
            onPress={() => onSelect(checkpoint.sceneIndex)}
          />
        ))}

        <View
          pointerEvents="none"
          style={[styles.playheadNotch, { left: percent(progress) }]}
        />
      </View>
      <Text style={styles.endpointLabel}>{model.endLabel}</Text>
    </View>
  );
}

function CheckpointMarker({
  active,
  checkpoint,
  onPress,
}: {
  active: boolean;
  checkpoint: GameViewCheckpoint;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityHint="Starts replay shortly before this match moment"
      accessibilityLabel={checkpoint.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={5}
      onPress={onPress}
      style={({ pressed }) => [
        styles.markerButton,
        {
          left: percent(clampMarkerPosition(checkpoint.position)),
          top: checkpoint.lane * 10,
        },
        pressed ? styles.markerPressed : undefined,
      ]}
      testID={`game-view-checkpoint-${checkpoint.kind}-${checkpoint.sceneIndex}`}
    >
      <View
        style={[
          styles.marker,
          { backgroundColor: MARKER_COLORS[checkpoint.kind] },
          active ? styles.markerActive : undefined,
        ]}
      >
        <Text style={styles.markerText}>{MARKER_SYMBOLS[checkpoint.kind]}</Text>
      </View>
    </Pressable>
  );
}

function percent(value: number): DimensionValue {
  return `${Math.round(value * 10_000) / 100}%`;
}

function clampMarkerPosition(value: number): number {
  return Math.min(0.985, Math.max(0.015, value));
}

const styles = StyleSheet.create({
  rail: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 44,
    paddingHorizontal: 4,
    width: '100%',
  },
  endpointLabel: {
    color: 'rgba(238, 244, 239, 0.72)',
    fontSize: 8,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 0.3,
    lineHeight: 10,
    textAlign: 'center',
    width: 28,
  },
  trackArea: {
    flex: 1,
    height: 40,
    position: 'relative',
  },
  track: {
    backgroundColor: 'rgba(224, 235, 226, 0.24)',
    height: 2,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 26,
  },
  elapsedTrack: {
    backgroundColor: 'rgba(246, 196, 83, 0.58)',
    height: 2,
    left: 0,
    position: 'absolute',
    top: 26,
  },
  playheadNotch: {
    backgroundColor: '#F7FAF7',
    borderRadius: 1,
    height: 10,
    position: 'absolute',
    top: 22,
    transform: [{ translateX: -1 }],
    width: 2,
  },
  markerButton: {
    alignItems: 'center',
    height: 24,
    justifyContent: 'center',
    position: 'absolute',
    transform: [{ translateX: -11 }],
    width: 22,
    zIndex: 2,
  },
  markerPressed: {
    opacity: 0.72,
  },
  marker: {
    alignItems: 'center',
    borderColor: 'rgba(4, 7, 5, 0.88)',
    borderRadius: 8,
    borderWidth: 1,
    height: 16,
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.35,
    shadowRadius: 2,
    width: 16,
  },
  markerActive: {
    borderColor: '#FFFFFF',
    borderWidth: 2,
    transform: [{ scale: 1.12 }],
  },
  markerText: {
    color: '#080A09',
    fontSize: 8,
    fontWeight: tokens.typography.weight.bold,
    lineHeight: 9,
    textAlign: 'center',
  },
});
