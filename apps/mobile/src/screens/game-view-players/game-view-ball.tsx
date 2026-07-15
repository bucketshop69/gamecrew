import { StyleSheet, View } from 'react-native';

/**
 * Tiny ball component: a white circle with a dark seam hint, sized relative
 * to the players it's drawn alongside (work item R2 of
 * docs/issues/game-view-realism-experiment.md). No image/SVG asset --
 * plain Views only, matching the retired demo's `styles.ball`/`ballCore`
 * pairing (see git history, `match-preview-screen.tsx` at commit 19d6eff^)
 * but pulled out as its own reusable component instead of inline styles.
 */
export function GameViewBall({ size = 14 }: { size?: number }) {
  const coreSize = size * 0.58;

  return (
    <View style={[styles.ball, { borderRadius: size / 2, height: size, width: size }]}>
      <View style={[styles.seamHint, { borderRadius: size * 0.1, top: coreSize * 0.18, width: coreSize * 0.5 }]} />
      <View
        style={[
          styles.core,
          { borderRadius: coreSize / 2, height: coreSize, width: coreSize },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  ball: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
  },
  core: {
    borderColor: 'rgba(20, 20, 20, 0.55)',
    borderWidth: 1,
  },
  seamHint: {
    backgroundColor: 'rgba(20, 20, 20, 0.35)',
    height: 1.5,
    position: 'absolute',
  },
});
