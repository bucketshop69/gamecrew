import { gameCrewTokens, type GameViewScene } from '@gamecrew/core';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePlaybackEngine } from '../state/use-playback-engine';

/**
 * Dev-only proof surface for the Game View data pipeline (session -> director
 * -> scene timeline -> playhead). Renders the pipeline's current state as
 * plain text: no production graphics. See work item 7 of
 * docs/issues/game-view-director-and-playback.md.
 *
 * This is intentionally additive and unobtrusive: it does not replace or
 * alter the existing scripted Game View demo. Mount `GameViewDebugToggle`
 * anywhere in a screen (dev builds only) to get a small "Debug" button that
 * reveals this panel as an overlay.
 */
export function GameViewDebugPanel({
  fixtureId,
  isLive,
}: {
  fixtureId: string;
  isLive: boolean;
}) {
  const { snapshot, controls } = usePlaybackEngine(fixtureId, isLive);

  return (
    <View style={styles.panel}>
      <Text style={styles.heading}>Game View debug</Text>

      <Row label="session status" value={snapshot.sessionStatus} />
      <Row label="head revision" value={String(snapshot.headRevision)} />
      <Row label="frame count" value={String(snapshot.frameCount)} />
      <Row label="mode" value={snapshot.mode} />
      <Row
        label="playhead"
        value={`${snapshot.playheadIndex + 1} / ${snapshot.timeline.length}`}
      />

      <View style={styles.controlsRow}>
        <DebugButton label="Live" onPress={controls.play} />
        <DebugButton label="Pause" onPress={controls.pause} />
        <DebugButton label="Replay" onPress={controls.startReplay} />
      </View>

      <Text style={styles.sceneHeading}>Current scene</Text>
      {snapshot.currentScene ? (
        <SceneText scene={snapshot.currentScene} />
      ) : (
        <Text style={styles.dim}>none</Text>
      )}
    </View>
  );
}

function SceneText({ scene }: { scene: GameViewScene }) {
  const zoneLabel = scene.zone ?? scene.pressure ?? '-';
  const scoreLabel = scene.scoreAtMoment
    ? `${scene.scoreAtMoment.participant1}-${scene.scoreAtMoment.participant2}`
    : '-';
  const teamLabel = scene.teamId ?? scene.participant ?? '-';

  return (
    <View>
      <Row label="kind" value={scene.kind} />
      <Row label="team" value={String(teamLabel)} />
      <Row label="zone" value={String(zoneLabel)} />
      <Row label="score" value={scoreLabel} />
      <Row label="clock" value={scene.clockSeconds !== undefined ? `${scene.clockSeconds}s` : '-'} />
      <Row label="phase" value={scene.phase ?? '-'} />
      <Row label="lifecycle" value={scene.lifecycle ?? '-'} />
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function DebugButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.button}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

/**
 * Long-press-to-reveal toggle. Mount this once inside a dev build alongside
 * the existing Game View content; it stays collapsed (a small unobtrusive
 * chip) until long-pressed, then shows `GameViewDebugPanel` as an overlay.
 * No-op (renders nothing) outside __DEV__.
 */
export function GameViewDebugToggle({
  fixtureId,
  isLive,
}: {
  fixtureId: string;
  isLive: boolean;
}) {
  const [visible, setVisible] = useState(false);

  if (!__DEV__) return null;

  return (
    <View pointerEvents="box-none" style={styles.toggleContainer}>
      {visible ? (
        <View style={styles.overlayWrap}>
          <GameViewDebugPanel fixtureId={fixtureId} isLive={isLive} />
        </View>
      ) : null}
      <Pressable
        accessibilityLabel="Toggle Game View debug panel"
        accessibilityRole="button"
        delayLongPress={400}
        onLongPress={() => setVisible((current) => !current)}
        style={styles.chip}
      >
        <Text style={styles.chipText}>{visible ? 'Hide debug' : 'Debug'}</Text>
      </Pressable>
    </View>
  );
}

const tokens = gameCrewTokens;

const styles = StyleSheet.create({
  toggleContainer: {
    bottom: 12,
    position: 'absolute',
    right: 12,
    zIndex: 50,
  },
  chip: {
    alignSelf: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderColor: 'rgba(255,255,255,0.2)',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  overlayWrap: {
    marginBottom: 8,
    maxWidth: 260,
  },
  panel: {
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
  },
  heading: {
    color: tokens.shell.text,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  sceneHeading: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
    marginTop: 8,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 1,
  },
  label: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 10,
  },
  value: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  dim: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 10,
  },
  controlsRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 6,
  },
  button: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  buttonText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
});
