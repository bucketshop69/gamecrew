import { Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * Small chip, same visual language as GameViewSoundToggle, that toggles
 * commentary voice specifically. Sits next to the SOUND pill: SOUND enables
 * the whole broadcast (crowd + voice), this chip narrows voice on/off within
 * that. Disabled (dimmed, non-interactive) while sound itself is off, since
 * voice cannot play without it either way.
 */
export function GameViewVoiceToggle({
  enabled,
  onPress,
  soundEnabled,
}: {
  enabled: boolean;
  onPress: () => void;
  soundEnabled: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={enabled ? 'Turn commentary voice off' : 'Turn commentary voice on'}
      accessibilityRole="switch"
      accessibilityState={{ checked: enabled, disabled: !soundEnabled }}
      disabled={!soundEnabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        enabled && soundEnabled && styles.controlEnabled,
        !soundEnabled && styles.controlDisabled,
        pressed && styles.controlPressed,
      ]}
    >
      <View style={[styles.indicator, enabled && soundEnabled && styles.indicatorEnabled]} />
      <Text style={[styles.label, enabled && soundEnabled && styles.labelEnabled]}>
        MIC
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  control: {
    alignItems: 'center',
    backgroundColor: 'rgba(3, 7, 4, 0.78)',
    borderColor: 'rgba(231, 240, 232, 0.24)',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 6,
    minHeight: 28,
    paddingHorizontal: 9,
  },
  controlEnabled: {
    backgroundColor: 'rgba(3, 10, 6, 0.88)',
    borderColor: 'rgba(115, 239, 144, 0.42)',
  },
  controlDisabled: {
    opacity: 0.45,
  },
  controlPressed: {
    opacity: 0.7,
  },
  indicator: {
    backgroundColor: 'rgba(231, 240, 232, 0.36)',
    borderRadius: 999,
    height: 5,
    width: 5,
  },
  indicatorEnabled: {
    backgroundColor: '#73EF90',
  },
  label: {
    color: 'rgba(231, 240, 232, 0.62)',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.1,
    lineHeight: 10,
  },
  labelEnabled: {
    color: '#E7F0E8',
  },
});
