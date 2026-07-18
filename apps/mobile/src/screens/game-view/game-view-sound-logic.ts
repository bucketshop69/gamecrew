import type { GameViewScene } from '@gamecrew/core';

export type GameViewAmbientLevel = 'quiet' | 'building' | 'danger';

export type GameViewSoundEffect =
  | 'referee_whistle'
  | 'ball_strike'
  | 'crowd_swell'
  | 'goal_roar';

export type GameViewSoundGoalBeat = 'tension' | 'celebration' | undefined;

export interface GameViewSoundPlan {
  ambientLevel: GameViewAmbientLevel;
  effects: readonly GameViewSoundEffect[];
}

/**
 * Sound is another projection of the canonical Game View scene -- never a
 * second event detector. This pure plan deliberately stays small: continuous
 * crowd energy follows grounded pressure, while punctuating effects attach
 * only to scene kinds/actions the match engine has actually emitted.
 */
export function resolveGameViewSoundPlan(
  scene: GameViewScene | null | undefined,
  goalBeat: GameViewSoundGoalBeat,
  isStale = false,
): GameViewSoundPlan {
  if (!scene || isStale) return soundPlan('quiet');

  switch (scene.kind) {
    case 'ambient':
      return soundPlan(resolvePressureAmbientLevel(scene));

    case 'set_piece':
      return resolveSetPieceSoundPlan(scene.sourceAction);

    case 'shot':
      return resolveShotSoundPlan(scene.sourceOutcome);

    case 'goal_sequence':
      if (goalBeat === 'celebration') {
        return soundPlan('danger', ['goal_roar']);
      }
      return soundPlan('danger', ['crowd_swell']);

    case 'goal_retracted':
      return soundPlan('quiet', ['referee_whistle']);

    case 'card':
      return soundPlan('building', ['referee_whistle']);

    case 'phase_break':
      return soundPlan('quiet', ['referee_whistle']);

    case 'restart':
      return soundPlan('building', ['referee_whistle', 'ball_strike']);

    case 'var_review':
      return soundPlan('quiet');

    case 'substitution':
      return soundPlan('building');

    case 'injury':
      return soundPlan('quiet', ['referee_whistle']);

    case 'additional_time':
      return soundPlan('building');
  }
}

/**
 * The active playback-window key is the event identity. React renders and
 * director corrections may revisit a logical scene, but only a newly entered
 * source window (or a new beat inside a goal window) is allowed to punctuate.
 */
export function gameViewSoundEventKey(
  sceneWindowKey: string | undefined,
  scene: GameViewScene | null | undefined,
  goalBeat: GameViewSoundGoalBeat,
  plan: GameViewSoundPlan,
): string | undefined {
  if (!sceneWindowKey || !scene || plan.effects.length === 0) return undefined;
  const beatKey = scene.kind === 'goal_sequence' ? goalBeat ?? 'tension' : scene.kind;
  return `${sceneWindowKey}:${beatKey}`;
}

/**
 * Dense source feeds can legitimately emit adjacent moments. Cooldowns keep
 * secondary crowd/ball punctuation from becoming a barrage without muting a
 * goal confirmation, which always plays once for its unique beat key.
 */
export function canPlayGameViewSoundEffect(
  effect: GameViewSoundEffect,
  lastPlayedAtMs: number | undefined,
  nowMs: number,
): boolean {
  if (lastPlayedAtMs === undefined) return true;
  return nowMs - lastPlayedAtMs >= EFFECT_COOLDOWN_MS[effect];
}

export const GAME_VIEW_AMBIENT_VOLUME: Readonly<Record<GameViewAmbientLevel, number>> = {
  quiet: 0.055,
  building: 0.085,
  danger: 0.12,
};

export const GAME_VIEW_EFFECT_VOLUME: Readonly<Record<GameViewSoundEffect, number>> = {
  referee_whistle: 0.15,
  ball_strike: 0.18,
  crowd_swell: 0.14,
  goal_roar: 0.22,
};

const EFFECT_COOLDOWN_MS: Readonly<Record<GameViewSoundEffect, number>> = {
  referee_whistle: 1_200,
  ball_strike: 500,
  crowd_swell: 2_600,
  goal_roar: 0,
};

function resolvePressureAmbientLevel(scene: GameViewScene): GameViewAmbientLevel {
  const pressure = scene.pressure ?? scene.zone;
  if (pressure === 'danger' || pressure === 'high_danger') return 'danger';
  if (pressure === 'attack') return 'building';
  return 'quiet';
}

function resolveSetPieceSoundPlan(sourceAction: string | undefined): GameViewSoundPlan {
  switch (sourceAction) {
    case 'corner':
      return soundPlan('danger', ['ball_strike', 'crowd_swell']);
    case 'free_kick':
      return soundPlan('danger', ['referee_whistle']);
    case 'penalty':
      return soundPlan('danger', ['referee_whistle', 'crowd_swell']);
    case 'throw_in':
      return soundPlan('building');
    case 'goal_kick':
      return soundPlan('building', ['ball_strike']);
    default:
      // An unknown set-piece label is not permission to guess a whistle or
      // kick. It still lifts the bed slightly because the scene itself is a
      // grounded stoppage near the action.
      return soundPlan('building');
  }
}

function resolveShotSoundPlan(sourceOutcome: string | undefined): GameViewSoundPlan {
  if (sourceOutcome?.toLowerCase() === 'blocked') {
    return soundPlan('danger', ['ball_strike']);
  }
  return soundPlan('danger', ['ball_strike', 'crowd_swell']);
}

function soundPlan(
  ambientLevel: GameViewAmbientLevel,
  effects: readonly GameViewSoundEffect[] = [],
): GameViewSoundPlan {
  return { ambientLevel, effects };
}
