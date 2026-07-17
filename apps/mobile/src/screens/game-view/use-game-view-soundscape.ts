import type { GameViewScene } from '@gamecrew/core';
import {
  setAudioModeAsync,
  useAudioPlayer,
  type AudioPlayer,
} from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';

import {
  GAME_VIEW_AMBIENT_VOLUME,
  GAME_VIEW_EFFECT_VOLUME,
  canPlayGameViewSoundEffect,
  gameViewSoundEventKey,
  resolveGameViewSoundPlan,
  type GameViewSoundEffect,
  type GameViewSoundGoalBeat,
} from './game-view-sound-logic';

const AMBIENT_FADE_MS = 850;
const AMBIENT_MUTE_FADE_MS = 220;
const AMBIENT_FADE_STEP_MS = 50;

let audioModePromise: Promise<void> | undefined;
let lastPlayedEventKey: string | undefined;
const lastEffectAtMs: Partial<Record<GameViewSoundEffect, number>> = {};

/**
 * Native adapter for the pure Game View sound plan. All players are scoped to
 * this hook and therefore released by `useAudioPlayer` on unmount. The audio
 * remains at natural speed even when visual replay is compressed.
 */
export function useGameViewSoundscape({
  enabled,
  goalBeat,
  isStale,
  scene,
  sceneWindowKey,
}: {
  enabled: boolean;
  goalBeat: GameViewSoundGoalBeat;
  isStale: boolean;
  scene: GameViewScene | null | undefined;
  sceneWindowKey: string | undefined;
}) {
  const ambiencePlayer = useAudioPlayer(
    require('../../../assets/audio/stadium-ambient.mp3'),
    { keepAudioSessionActive: true },
  );
  const whistlePlayer = useAudioPlayer(
    require('../../../assets/audio/referee-whistle.mp3'),
    { keepAudioSessionActive: true },
  );
  const ballStrikePlayer = useAudioPlayer(
    require('../../../assets/audio/ball-strike.mp3'),
    { keepAudioSessionActive: true },
  );
  const crowdSwellPlayer = useAudioPlayer(
    require('../../../assets/audio/crowd-swell.mp3'),
    { keepAudioSessionActive: true },
  );
  const goalRoarPlayer = useAudioPlayer(
    require('../../../assets/audio/goal-roar.mp3'),
    { keepAudioSessionActive: true },
  );

  const plan = useMemo(
    () => resolveGameViewSoundPlan(scene, goalBeat, isStale),
    [goalBeat, isStale, scene],
  );
  const eventKey = useMemo(
    () => gameViewSoundEventKey(sceneWindowKey, scene, goalBeat, plan),
    [goalBeat, plan, scene, sceneWindowKey],
  );

  const ambientTargetRef = useRef(GAME_VIEW_AMBIENT_VOLUME[plan.ambientLevel]);
  const appIsActiveRef = useRef(AppState.currentState === 'active');
  const enabledRef = useRef(enabled);
  const fadeTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  ambientTargetRef.current = GAME_VIEW_AMBIENT_VOLUME[plan.ambientLevel];
  enabledRef.current = enabled;

  const clearAmbientFade = useCallback(() => {
    if (fadeTimerRef.current !== undefined) {
      clearInterval(fadeTimerRef.current);
      fadeTimerRef.current = undefined;
    }
  }, []);

  const fadeAmbience = useCallback((target: number, durationMs: number, pauseAtEnd = false) => {
    clearAmbientFade();
    const start = ambiencePlayer.volume;
    const stepCount = Math.max(1, Math.ceil(durationMs / AMBIENT_FADE_STEP_MS));
    let step = 0;

    fadeTimerRef.current = setInterval(() => {
      step += 1;
      const progress = Math.min(1, step / stepCount);
      ambiencePlayer.volume = start + (target - start) * progress;
      if (progress < 1) return;
      clearAmbientFade();
      if (pauseAtEnd) ambiencePlayer.pause();
    }, AMBIENT_FADE_STEP_MS);
  }, [ambiencePlayer, clearAmbientFade]);

  const activateFromGesture = useCallback(() => {
    void ensureGameViewAudioMode().catch(() => undefined);
    // Enabling midway through a moment should not create a late, misleading
    // kick/whistle. Start the bed now and punctuate from the next entered
    // source scene (or the next goal beat) onward.
    if (eventKey) lastPlayedEventKey = eventKey;
    ambiencePlayer.loop = true;
    ambiencePlayer.playbackRate = 1;
    if (!ambiencePlayer.playing) ambiencePlayer.play();
    fadeAmbience(ambientTargetRef.current, AMBIENT_FADE_MS);
  }, [ambiencePlayer, eventKey, fadeAmbience]);

  const deactivate = useCallback(() => {
    fadeAmbience(0, AMBIENT_MUTE_FADE_MS, true);
    whistlePlayer.pause();
    ballStrikePlayer.pause();
    crowdSwellPlayer.pause();
    goalRoarPlayer.pause();
  }, [ballStrikePlayer, crowdSwellPlayer, fadeAmbience, goalRoarPlayer, whistlePlayer]);

  useEffect(() => {
    void ensureGameViewAudioMode().catch(() => undefined);
    ambiencePlayer.loop = true;
    ambiencePlayer.playbackRate = 1;
    ambiencePlayer.volume = 0;
  }, [ambiencePlayer]);

  useEffect(() => {
    if (!enabled || !appIsActiveRef.current) {
      fadeAmbience(0, AMBIENT_MUTE_FADE_MS, true);
      return;
    }
    if (!ambiencePlayer.playing) ambiencePlayer.play();
    fadeAmbience(GAME_VIEW_AMBIENT_VOLUME[plan.ambientLevel], AMBIENT_FADE_MS);
  }, [ambiencePlayer, enabled, fadeAmbience, plan.ambientLevel]);

  useEffect(() => {
    if (!enabled || !appIsActiveRef.current || !eventKey) return;
    if (lastPlayedEventKey === eventKey) return;
    // Module scope intentionally survives Match Pulse/Game View remounts, so
    // revisiting the tab during the same active window cannot replay an event.
    lastPlayedEventKey = eventKey;

    const nowMs = Date.now();
    plan.effects.forEach((effect) => {
      if (!canPlayGameViewSoundEffect(effect, lastEffectAtMs[effect], nowMs)) return;
      lastEffectAtMs[effect] = nowMs;
      replayEffect(effect, effectPlayer(effect, {
        ballStrikePlayer,
        crowdSwellPlayer,
        goalRoarPlayer,
        whistlePlayer,
      }));
    });
  }, [
    ballStrikePlayer,
    crowdSwellPlayer,
    enabled,
    eventKey,
    goalRoarPlayer,
    plan.effects,
    whistlePlayer,
  ]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const isActive = nextState === 'active';
      appIsActiveRef.current = isActive;

      if (!isActive) {
        clearAmbientFade();
        ambiencePlayer.pause();
        whistlePlayer.pause();
        ballStrikePlayer.pause();
        crowdSwellPlayer.pause();
        goalRoarPlayer.pause();
        return;
      }

      if (enabledRef.current) {
        ambiencePlayer.play();
        fadeAmbience(ambientTargetRef.current, AMBIENT_FADE_MS);
      }
    });

    return () => subscription.remove();
  }, [
    ambiencePlayer,
    ballStrikePlayer,
    clearAmbientFade,
    crowdSwellPlayer,
    fadeAmbience,
    goalRoarPlayer,
    whistlePlayer,
  ]);

  useEffect(() => () => {
    clearAmbientFade();
    ambiencePlayer.pause();
    whistlePlayer.pause();
    ballStrikePlayer.pause();
    crowdSwellPlayer.pause();
    goalRoarPlayer.pause();
  }, [
    ambiencePlayer,
    ballStrikePlayer,
    clearAmbientFade,
    crowdSwellPlayer,
    goalRoarPlayer,
    whistlePlayer,
  ]);

  return { activateFromGesture, deactivate };
}

function ensureGameViewAudioMode(): Promise<void> {
  audioModePromise ??= setAudioModeAsync({
    allowsRecording: false,
    interruptionMode: 'mixWithOthers',
    playsInSilentMode: false,
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  }).catch((error) => {
    // A failed configuration should not permanently poison future user
    // attempts (notably a temporarily unavailable web audio context).
    audioModePromise = undefined;
    throw error;
  });
  return audioModePromise;
}

function effectPlayer(
  effect: GameViewSoundEffect,
  players: {
    ballStrikePlayer: AudioPlayer;
    crowdSwellPlayer: AudioPlayer;
    goalRoarPlayer: AudioPlayer;
    whistlePlayer: AudioPlayer;
  },
): AudioPlayer {
  switch (effect) {
    case 'referee_whistle':
      return players.whistlePlayer;
    case 'ball_strike':
      return players.ballStrikePlayer;
    case 'crowd_swell':
      return players.crowdSwellPlayer;
    case 'goal_roar':
      return players.goalRoarPlayer;
  }
}

function replayEffect(effect: GameViewSoundEffect, player: AudioPlayer) {
  player.volume = GAME_VIEW_EFFECT_VOLUME[effect];
  player.playbackRate = 1;
  void player.seekTo(0).then(() => player.play()).catch(() => undefined);
}
