import { Pressable, StyleSheet, Text, View } from 'react-native';

export function GameViewSoundToggle({
  enabled,
  onPress,
}: {
  enabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={enabled ? 'Turn Game View sound off' : 'Turn Game View sound on'}
      accessibilityRole="switch"
      accessibilityState={{ checked: enabled }}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        enabled && styles.controlEnabled,
        pressed && styles.controlPressed,
      ]}
    >
      <View style={[styles.indicator, enabled && styles.indicatorEnabled]} />
      <Text style={[styles.label, enabled && styles.labelEnabled]}>
        SOUND
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
