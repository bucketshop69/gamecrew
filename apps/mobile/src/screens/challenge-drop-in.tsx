import { gameCrewTokens, type EconomyItemId, type MatchEngineParticipant } from '@gamecrew/core';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Reanimated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import type { ChatTeamIdentity } from './global-chat-feed';

const tokens = gameCrewTokens;

/** Mirrors global-chat-feed.tsx's local STAKE_EMOJI lookup. */
const STAKE_EMOJI: Record<EconomyItemId, string> = {
  dust: '✨',
  bananas: '🍌',
  rubber_duck: '🦆',
  traffic_cone: '🚧',
  pizza: '🍕',
  boombox: '📻',
  jetski: '🚤',
  lambo: '🏎️',
};

/**
 * Challenge drop-in (demo-lockdown item 10): a compact card that drops in
 * from the top over the match when a new call/challenge goes live, following
 * the same dark broadcast styling and Reanimated spring-settle grammar as the
 * Game View takeovers (see game-view-takeovers/takeover-shared.tsx and
 * gift-reveal-takeover.tsx's card-entrance spring config) but positioned as a
 * compact top banner rather than a full-screen overlay -- closer in spirit to
 * card-takeover.tsx's "board stays visible underneath" banner than to a
 * centered modal.
 *
 * The user can answer right here (same takePosition/takeBet flow as the chat
 * prompt card): a single stake button for most predicates, or two team-pick
 * buttons for `who_scores_next`. Tapping an option calls `onAnswer`, which
 * the caller wires to `economy.takeBet` and then dismisses this card.
 * `MatchDetailScreen` also auto-dismisses it after ~8s unanswered (spec item
 * 10) via its own timer -- this component itself has no internal timeout, it
 * only owns the entrance/exit animation, matching the split already
 * established between "queueing/timeout decisions" (match-chat-sheet-logic.ts)
 * and "how a card animates" (this file).
 */
export function ChallengeDropIn({
  awayTeam,
  copy,
  homeTeam,
  isTeamPick,
  onAnswer,
  onTuckAway,
  reduceMotion,
  stakeCoolness,
  stakeItemId,
  topInset,
}: {
  awayTeam: ChatTeamIdentity;
  copy: string;
  homeTeam: ChatTeamIdentity;
  isTeamPick: boolean;
  onAnswer: (pickedParticipant?: MatchEngineParticipant) => void;
  /** Called once the tuck-away exit animation finishes (or immediately under reduce motion). */
  onTuckAway: () => void;
  reduceMotion: boolean;
  stakeCoolness: number;
  stakeItemId: EconomyItemId;
  topInset: number;
}) {
  const translateY = useSharedValue(reduceMotion ? 0 : -160);
  const opacity = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) return;
    translateY.value = withSpring(0, { damping: 16, stiffness: 180 });
    opacity.value = withTiming(1, { duration: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  const tuckAway = () => {
    if (reduceMotion) {
      onTuckAway();
      return;
    }
    translateY.value = withTiming(-160, { duration: 220 });
    // withTiming's completion callback runs on the UI thread (a worklet) --
    // runOnJS hops back to JS to fire onTuckAway, which unmounts this
    // component via the caller's state update.
    opacity.value = withTiming(0, { duration: 180 }, (finished) => {
      'worklet';
      if (finished) runOnJS(onTuckAway)();
    });
  };

  const handleAnswer = (pickedParticipant?: MatchEngineParticipant) => {
    onAnswer(pickedParticipant);
    tuckAway();
  };

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <Reanimated.View
      accessibilityLabel={`New challenge: ${copy}`}
      accessibilityLiveRegion="polite"
      accessible
      pointerEvents="box-none"
      style={[styles.wrap, { top: topInset }, style]}
    >
      <View style={styles.card}>
        <Text numberOfLines={2} style={styles.copy}>{copy}</Text>
        {isTeamPick ? (
          <View style={styles.teamPickRow}>
            {[homeTeam, awayTeam].map((team) => (
              <Pressable
                accessibilityLabel={`Pick ${team.name}`}
                accessibilityRole="button"
                key={team.participant}
                onPress={() => handleAnswer(team.participant)}
                style={({ pressed }) => [styles.teamPickButton, { borderColor: team.color }, pressed && styles.pressed]}
              >
                <Text numberOfLines={1} style={styles.teamPickButtonText}>{team.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Pressable
            accessibilityLabel={`Stake ${STAKE_EMOJI[stakeItemId]} and ${stakeCoolness} coolness`}
            accessibilityRole="button"
            onPress={() => handleAnswer(undefined)}
            style={({ pressed }) => [styles.stakeButton, pressed && styles.pressed]}
          >
            <Text style={styles.stakeButtonText}>
              Stake {STAKE_EMOJI[stakeItemId]} · −{stakeCoolness} coolness
            </Text>
          </Pressable>
        )}
      </View>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    zIndex: 15,
  },
  card: {
    backgroundColor: 'rgba(5, 5, 5, 0.92)',
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: tokens.spacing.sm,
    marginHorizontal: tokens.spacing.lg,
    maxWidth: 420,
    padding: tokens.spacing.lg,
    width: '92%',
  },
  copy: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
    textAlign: 'center',
  },
  stakeButton: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: tokens.shell.text,
    borderRadius: tokens.radii.pill,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: tokens.spacing.lg,
  },
  stakeButtonText: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
  },
  teamPickRow: {
    flexDirection: 'row',
    gap: tokens.spacing.sm,
  },
  teamPickButton: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surface,
    borderRadius: tokens.radii.pill,
    borderWidth: 1.5,
    flex: 1,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: tokens.spacing.md,
  },
  teamPickButtonText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
  },
  pressed: {
    opacity: 0.7,
  },
});
