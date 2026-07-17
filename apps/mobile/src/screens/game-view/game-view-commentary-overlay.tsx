import type { MatchPulseCommentaryEntry } from '@gamecrew/core';
import { StyleSheet, Text, View } from 'react-native';

/**
 * A broadcast-native, non-interactive touchline transcript. It deliberately
 * avoids the visual weight of the main Match Pulse cards: the pitch remains
 * primary, older lines recede, and only the newest grounded line reads at
 * full strength.
 */
export function GameViewCommentaryOverlay({
  entries,
}: {
  entries: readonly MatchPulseCommentaryEntry[];
}) {
  if (entries.length === 0) return null;

  const accessibilityLabel = entries
    .map((entry) => `${entry.clock.label}: ${entry.commentary}`)
    .join('. ');

  return (
    <View
      accessibilityLabel={`Match Pulse. ${accessibilityLabel}`}
      accessible
      style={styles.transcript}
    >
      <View style={styles.headingRow}>
        <View style={styles.headingRule} />
        <Text style={styles.heading}>MATCH PULSE</Text>
      </View>

      <View style={styles.entries}>
        {entries.map((entry, index) => (
          <View
            key={entry.id}
            style={[
              styles.entry,
              getRecencyStyle(entries.length - index - 1),
            ]}
          >
            <Text numberOfLines={1} style={styles.minute}>
              {entry.clock.label}
            </Text>
            <Text numberOfLines={2} style={styles.commentary}>
              {entry.commentary}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function getRecencyStyle(age: number) {
  if (age <= 0) return styles.entryCurrent;
  if (age === 1) return styles.entryRecent;
  if (age === 2) return styles.entryOlder;
  return styles.entryOldest;
}

const styles = StyleSheet.create({
  transcript: {
    backgroundColor: 'rgba(3, 7, 4, 0.72)',
    borderLeftColor: 'rgba(231, 240, 232, 0.42)',
    borderLeftWidth: 1.5,
    borderRadius: 5,
    gap: 6,
    paddingBottom: 8,
    paddingHorizontal: 9,
    paddingTop: 7,
    width: '100%',
  },
  headingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  headingRule: {
    backgroundColor: 'rgba(231, 240, 232, 0.28)',
    height: StyleSheet.hairlineWidth,
    width: 18,
  },
  heading: {
    color: 'rgba(231, 240, 232, 0.62)',
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: 1.1,
    lineHeight: 9,
  },
  entries: {
    gap: 4,
  },
  entry: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 6,
  },
  entryCurrent: {
    opacity: 1,
  },
  entryRecent: {
    opacity: 0.37,
  },
  entryOlder: {
    opacity: 0.28,
  },
  entryOldest: {
    opacity: 0.2,
  },
  minute: {
    color: '#E7F0E8',
    fontSize: 8,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    lineHeight: 12,
    width: 26,
  },
  commentary: {
    color: '#E7F0E8',
    flex: 1,
    fontSize: 9,
    fontWeight: '500',
    lineHeight: 12,
  },
});
