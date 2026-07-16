import { StyleSheet, View } from 'react-native';

/**
 * The match ball, plain Views only (no image/SVG assets): a white sphere
 * with a thin outline, a dark center pentagon, and three edge patches -- the
 * classic black-and-white football read, legible at 11-14px on the green
 * turf. Product feedback 2026-07-15: the earlier single-seam circle read as
 * a generic dot; this suggests actual panels.
 */
export function GameViewBall({ size = 12 }: { size?: number }) {
  const pentagon = size * 0.3;
  const patch = size * 0.16;
  const patchInset = size * 0.08;
  const focusRingInset = Math.max(1, size * 0.09);
  const shadowHeight = Math.max(1.5, size * 0.18);
  const shadowWidth = size * 0.72;

  return (
    <View style={[styles.frame, { height: size, width: size }]}>
      <View
        style={[
          styles.contactShadow,
          {
            borderRadius: shadowHeight / 2,
            bottom: -shadowHeight * 0.55,
            height: shadowHeight,
            left: (size - shadowWidth) / 2,
            width: shadowWidth,
          },
        ]}
      />
      <View
        style={[
          styles.focusRing,
          {
            borderRadius: (size + focusRingInset * 2) / 2,
            bottom: -focusRingInset,
            left: -focusRingInset,
            right: -focusRingInset,
            top: -focusRingInset,
          },
        ]}
      />
      <View style={[styles.ball, { borderRadius: size / 2, height: size, width: size }]}>
        <View
          style={[
            styles.panel,
            {
              borderRadius: pentagon * 0.3,
              height: pentagon,
              transform: [{ rotate: '22deg' }],
              width: pentagon,
            },
          ]}
        />
        <View style={[styles.panel, styles.edgePatch, { borderRadius: patch / 2, height: patch, width: patch, top: patchInset, left: size * 0.28 }]} />
        <View style={[styles.panel, styles.edgePatch, { borderRadius: patch / 2, height: patch, width: patch, bottom: patchInset, left: size * 0.2 }]} />
        <View style={[styles.panel, styles.edgePatch, { borderRadius: patch / 2, height: patch, width: patch, right: patchInset * 0.6, top: size * 0.38 }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    position: 'relative',
  },
  contactShadow: {
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
    position: 'absolute',
  },
  focusRing: {
    borderColor: 'rgba(238, 246, 235, 0.52)',
    borderWidth: 1,
    position: 'absolute',
  },
  ball: {
    alignItems: 'center',
    backgroundColor: '#F8FBF5',
    borderColor: 'rgba(8, 12, 9, 0.86)',
    borderWidth: 1,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'absolute',
  },
  panel: {
    backgroundColor: '#151A16',
  },
  edgePatch: {
    opacity: 0.66,
    position: 'absolute',
  },
});
