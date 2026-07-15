import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { GameViewBall } from './game-view-ball';
import { GameViewPlayer } from './game-view-player';
import { PLAYER_POSES, type PlayerPose } from './player-pose-logic';

/**
 * Dev-only taste-review gallery for the Game View player silhouettes (work
 * item R2 of docs/issues/game-view-realism-experiment.md): every pose in
 * both sample team colors at a few sizes, plus one composed corner-scene
 * vignette, on a dark background. Product reviews screenshots of this
 * before R4 wires the silhouettes into the live board (the R3 taste
 * checkpoint in the work item's table) -- this component has no other
 * caller and renders nothing outside `__DEV__` (mirrors
 * `GameViewDebugToggle` in game-view-debug-panel.tsx).
 */

const GALLERY_HOME_COLOR = '#006847'; // Mexico green (sample)
const GALLERY_AWAY_COLOR = '#FFDD00'; // Ecuador yellow (sample)
const GALLERY_SIZES = [24, 32, 40] as const;

export function GameViewPlayerGallery() {
  if (!__DEV__) return null;

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Game View player gallery</Text>
        <Text style={styles.subtitle}>Dev-only taste review · not shown outside __DEV__</Text>

        <VignetteSection />

        {PLAYER_POSES.map((pose) => (
          <PoseSection key={pose} pose={pose} />
        ))}
      </ScrollView>
    </View>
  );
}

function PoseSection({ pose }: { pose: PlayerPose }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{pose}</Text>
      <View style={styles.swatchGrid}>
        {GALLERY_SIZES.map((size) => (
          <View key={`home-${size}`} style={styles.swatch}>
            <GameViewPlayer facing="down" pose={pose} size={size} teamColor={GALLERY_HOME_COLOR} />
            <Text style={styles.swatchLabel}>{size}px</Text>
          </View>
        ))}
        {GALLERY_SIZES.map((size) => (
          <View key={`away-${size}`} style={styles.swatch}>
            <GameViewPlayer facing="up" pose={pose} size={size} teamColor={GALLERY_AWAY_COLOR} />
            <Text style={styles.swatchLabel}>{size}px</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Composed vignette: 3 attackers (home color, facing up/toward the goal) +
 * 1 keeper (away color, mid-dive) + ball, arranged as a loose corner-kick
 * cluster so the product owner can judge how the silhouettes read as a
 * group, not just individually. Purely illustrative layout (absolute
 * positions picked for a plausible corner shape) -- no source coordinates
 * are implied, matching the honesty rule the real R4 cluster will also
 * follow.
 */
function VignetteSection() {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>corner-scene vignette (3 attackers + keeper + ball)</Text>
      <View style={styles.vignette}>
        <View style={[styles.vignetteActor, { left: '18%', top: '58%' }]}>
          <GameViewPlayer facing="up" pose="run_a" size={32} teamColor={GALLERY_HOME_COLOR} />
        </View>
        <View style={[styles.vignetteActor, { left: '40%', top: '38%' }]}>
          <GameViewPlayer facing="up" pose="header" size={32} teamColor={GALLERY_HOME_COLOR} />
        </View>
        <View style={[styles.vignetteActor, { left: '62%', top: '54%' }]}>
          <GameViewPlayer facing="up" pose="run_b" size={32} teamColor={GALLERY_HOME_COLOR} />
        </View>
        <View style={[styles.vignetteActor, { left: '44%', top: '10%' }]}>
          <GameViewPlayer facing="down" pose="keeper_dive_right" size={32} teamColor={GALLERY_AWAY_COLOR} />
        </View>
        <View style={[styles.vignetteActor, { left: '46%', top: '32%' }]}>
          <GameViewBall size={12} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: '#0A0A0A',
    flex: 1,
  },
  scrollContent: {
    gap: 20,
    padding: 16,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  subtitle: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    marginBottom: 4,
  },
  section: {
    backgroundColor: '#101010',
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
    padding: 12,
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  swatchGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  swatch: {
    alignItems: 'center',
    gap: 4,
    minWidth: 48,
  },
  swatchLabel: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 9,
  },
  vignette: {
    backgroundColor: '#0F1A10',
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    height: 220,
    position: 'relative',
    width: '100%',
  },
  vignetteActor: {
    position: 'absolute',
  },
});
