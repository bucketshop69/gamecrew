import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Thin wrapper over expo-haptics -- no-ops on web (haptics APIs aren't
 * available there) and swallows any native errors so a haptic failure never
 * takes down a tap handler. Callers should never import `expo-haptics`
 * directly; go through these two helpers instead.
 *
 * Kept deliberately subtle per the UX review: taps only ever get a Light
 * impact, never Medium/Heavy -- this is a chat/economy surface, not a game
 * controller.
 */

/** Fire on any lightweight tap (chip send, stake button, reaction tap). */
export function hapticTap(): void {
  if (Platform.OS === 'web') return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/** Fire when an action has a clear, synchronous completion signal (e.g. a send/stake that just succeeded). */
export function hapticSuccess(): void {
  if (Platform.OS === 'web') return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}
