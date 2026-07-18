import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

/**
 * Shared capped emoji-particle burst, extracted from `gift-reveal-takeover.tsx`
 * so it can be reused verbatim by the Gift Pool full-time split row
 * (`global-chat-feed.tsx`) per the UX spec's explicit instruction ("reuse the
 * Gift Reveal takeover's reveal beat visual grammar... exactly the 'the junk
 * itself rains' principle already documented in that file") -- this is
 * deliberately the *only* other place in the whole economy surface allowed
 * to use this celebration grammar (UX spec section 9's "exactly two things
 * get real celebration motion" rule). Do not reach for this anywhere else.
 *
 * Capped at `PARTICLE_COUNT` (24), transform/opacity-only animation (runs on
 * Reanimated's UI thread, no native-driver flag needed), and fully unmounts
 * itself after `PARTICLE_LIFETIME_MS` -- nothing here animates forever.
 */

export const PARTICLE_COUNT = 24;
/** How long the whole burst plays before every particle has fully faded, in ms -- also the unmount deadline. */
export const PARTICLE_LIFETIME_MS = 1500;

interface ParticleSpec {
  key: string;
  emoji: string;
  /** Starting horizontal offset from center, in px. */
  startX: number;
  /** Horizontal drift by the end of the burst, in px. */
  driftX: number;
  /** Vertical fall distance by the end of the burst, in px. */
  fallY: number;
  /** Full rotation amount, in degrees. */
  spin: number;
  delayMs: number;
  fontSize: number;
}

/** Small deterministic PRNG (mulberry32) so a burst is stable across re-renders of the same reveal, matching the seeded-RNG discipline used elsewhere in the economy stack. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds a capped particle burst using the supplied emoji pool (e.g. the granted/pooled items' own emoji), radiating outward and falling. On-brand: the junk itself rains, not generic confetti. */
function buildParticles(emojiPool: readonly string[], seed: number): readonly ParticleSpec[] {
  const pool = emojiPool.length > 0 ? emojiPool : ['🎉', '✨', '🎊'];
  const rng = mulberry32(seed);
  return Array.from({ length: PARTICLE_COUNT }, (_, index) => {
    const angle = (index / PARTICLE_COUNT) * Math.PI * 2 + (rng() - 0.5) * 0.6;
    const radius = 90 + rng() * 70;
    return {
      key: `particle-${index}`,
      emoji: pool[index % pool.length]!,
      startX: Math.cos(angle) * 16,
      driftX: Math.cos(angle) * radius,
      fallY: Math.abs(Math.sin(angle)) * radius + 60 + rng() * 40,
      spin: (rng() - 0.5) * 360,
      delayMs: rng() * 160,
      fontSize: 16 + rng() * 14,
    };
  });
}

/**
 * Renders a capped, self-unmounting particle burst. `emojiPool` should be
 * the granted/pooled items' own emoji (falls back to sparkle/confetti
 * glyphs if empty); `seed` should be a small stable integer derived from the
 * calling context (e.g. item count, or a hash of the triggering event id)
 * so repeated renders of the *same* celebration produce the same burst.
 */
export function CelebrationParticleBurst({ emojiPool, seed }: { emojiPool: readonly string[]; seed: number }) {
  const [visible, setVisible] = useState(true);
  const particles = useMemo(() => buildParticles(emojiPool, seed), [emojiPool, seed]);

  useEffect(() => {
    const handle = setTimeout(() => setVisible(false), PARTICLE_LIFETIME_MS);
    return () => clearTimeout(handle);
  }, []);

  if (!visible) return null;

  return (
    <View pointerEvents="none" style={styles.particleField}>
      {particles.map((particle) => (
        <Particle key={particle.key} spec={particle} />
      ))}
    </View>
  );
}

function Particle({ spec }: { spec: ParticleSpec }) {
  const progress = useSharedValue(0);
  const opacity = useSharedValue(0);

  useEffect(() => {
    opacity.value = withDelay(
      spec.delayMs,
      withSequence(
        withTiming(1, { duration: 140 }),
        withTiming(1, { duration: PARTICLE_LIFETIME_MS - spec.delayMs - 140 - 260 }),
        withTiming(0, { duration: 260 }),
      ),
    );
    progress.value = withDelay(
      spec.delayMs,
      withTiming(1, { duration: PARTICLE_LIFETIME_MS - spec.delayMs, easing: Easing.out(Easing.quad) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: spec.startX + progress.value * spec.driftX },
      { translateY: progress.value * spec.fallY },
      { rotate: `${progress.value * spec.spin}deg` },
      { scale: 0.6 + progress.value * 0.4 },
    ],
  }));

  return (
    <Reanimated.Text style={[styles.particleText, { fontSize: spec.fontSize }, style]}>
      {spec.emoji}
    </Reanimated.Text>
  );
}

const styles = StyleSheet.create({
  particleField: {
    alignItems: 'center',
    justifyContent: 'center',
    left: '50%',
    marginLeft: -1,
    marginTop: -1,
    position: 'absolute',
    top: '18%',
    height: 2,
    width: 2,
    zIndex: 5,
  },
  particleText: {
    position: 'absolute',
  },
});
