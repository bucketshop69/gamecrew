import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GAME_VIEW_AMBIENT_DUCK_FACTOR,
  GAME_VIEW_AMBIENT_VOLUME,
  canPlayGameViewSoundEffect,
  gameViewSoundEventKey,
  resolveGameViewAmbientDuckedVolume,
  resolveGameViewSoundPlan,
} from '../src/screens/game-view/game-view-sound-logic.ts';

function scene(overrides = {}) {
  return {
    id: 'scene-1',
    fixtureId: 'fixture-1',
    kind: 'ambient',
    startRevision: 1,
    sourceFrameIds: ['fixture-1:1'],
    sourceCueIds: ['cue-1'],
    durationHint: { minMs: 0, maxMs: 0 },
    ...overrides,
  };
}

test('ambient bed follows only grounded scene pressure', () => {
  assert.equal(resolveGameViewSoundPlan(scene({ pressure: 'safe' }), undefined).ambientLevel, 'quiet');
  assert.equal(resolveGameViewSoundPlan(scene({ pressure: 'attack' }), undefined).ambientLevel, 'building');
  assert.equal(resolveGameViewSoundPlan(scene({ pressure: 'danger' }), undefined).ambientLevel, 'danger');
  assert.equal(resolveGameViewSoundPlan(scene({ pressure: 'high_danger' }), undefined).ambientLevel, 'danger');
});

test('stale or absent truth collapses to a quiet bed with no event guess', () => {
  assert.deepEqual(resolveGameViewSoundPlan(undefined, undefined), {
    ambientLevel: 'quiet',
    effects: [],
  });
  assert.deepEqual(resolveGameViewSoundPlan(scene({ kind: 'shot' }), undefined, true), {
    ambientLevel: 'quiet',
    effects: [],
  });
});

// ---------------------------------------------------------------------------
// Playback-activity gate (fix round item 3: a parked finished match must be
// FULLY SILENT, not just "quiet" -- see GameViewAmbientLevel's doc comment
// on why 'silent' (volume 0) is distinct from 'quiet' (a low ambient hum).
// ---------------------------------------------------------------------------

test('playbackActive=false silences the plan outright, regardless of scene/goalBeat', () => {
  assert.deepEqual(
    resolveGameViewSoundPlan(scene({ kind: 'shot', sourceOutcome: 'Blocked' }), undefined, false, false),
    { ambientLevel: 'silent', effects: [] },
  );
  assert.deepEqual(
    resolveGameViewSoundPlan(scene({ kind: 'goal_sequence' }), 'celebration', false, false),
    { ambientLevel: 'silent', effects: [] },
  );
  assert.equal(GAME_VIEW_AMBIENT_VOLUME.silent, 0);
});

test('playbackActive defaults to true -- every existing caller is unaffected', () => {
  assert.deepEqual(
    resolveGameViewSoundPlan(scene({ kind: 'shot', sourceOutcome: 'Blocked' }), undefined),
    { ambientLevel: 'danger', effects: ['ball_strike'] },
  );
});

test('set-piece punctuation is specific and unknown actions stay quiet', () => {
  assert.deepEqual(
    resolveGameViewSoundPlan(scene({ kind: 'set_piece', sourceAction: 'corner' }), undefined),
    { ambientLevel: 'danger', effects: ['ball_strike', 'crowd_swell'] },
  );
  assert.deepEqual(
    resolveGameViewSoundPlan(scene({ kind: 'set_piece', sourceAction: 'free_kick' }), undefined),
    { ambientLevel: 'danger', effects: ['referee_whistle'] },
  );
  assert.deepEqual(
    resolveGameViewSoundPlan(scene({ kind: 'set_piece', sourceAction: 'throw_in' }), undefined),
    { ambientLevel: 'building', effects: [] },
  );
  assert.deepEqual(
    resolveGameViewSoundPlan(scene({ kind: 'set_piece', sourceAction: 'mystery' }), undefined),
    { ambientLevel: 'building', effects: [] },
  );
});

test('shot, referee, and restart scenes receive restrained grounded effects', () => {
  assert.deepEqual(resolveGameViewSoundPlan(scene({ kind: 'shot' }), undefined).effects, [
    'ball_strike',
    'crowd_swell',
  ]);
  assert.deepEqual(resolveGameViewSoundPlan(scene({ kind: 'card' }), undefined).effects, [
    'referee_whistle',
  ]);
  assert.deepEqual(resolveGameViewSoundPlan(scene({ kind: 'restart' }), undefined).effects, [
    'referee_whistle',
    'ball_strike',
  ]);
});

test('shot reactions follow the source outcome instead of treating every attempt as a save', () => {
  assert.deepEqual(resolveGameViewSoundPlan(scene({ kind: 'shot', sourceOutcome: 'Blocked' }), undefined), {
    ambientLevel: 'danger',
    effects: ['ball_strike'],
  });
  assert.deepEqual(resolveGameViewSoundPlan(scene({ kind: 'shot', sourceOutcome: 'OffTarget' }), undefined), {
    ambientLevel: 'danger',
    effects: ['ball_strike', 'crowd_swell'],
  });
  assert.deepEqual(resolveGameViewSoundPlan(scene({ kind: 'shot', sourceOutcome: 'Woodwork' }), undefined), {
    ambientLevel: 'danger',
    effects: ['ball_strike', 'crowd_swell'],
  });
});

test('injury and added-time moments stay restrained while substitutions lift the bed', () => {
  assert.deepEqual(resolveGameViewSoundPlan(scene({ kind: 'injury' }), undefined), {
    ambientLevel: 'quiet',
    effects: ['referee_whistle'],
  });
  assert.deepEqual(resolveGameViewSoundPlan(scene({ kind: 'additional_time' }), undefined), {
    ambientLevel: 'building',
    effects: [],
  });
  assert.deepEqual(resolveGameViewSoundPlan(scene({ kind: 'substitution' }), undefined), {
    ambientLevel: 'building',
    effects: [],
  });
});

test('goal sound advances from tension swell to one confirmation roar', () => {
  const goal = scene({ kind: 'goal_sequence' });
  const tension = resolveGameViewSoundPlan(goal, 'tension');
  const celebration = resolveGameViewSoundPlan(goal, 'celebration');

  assert.deepEqual(tension.effects, ['crowd_swell']);
  assert.deepEqual(celebration.effects, ['goal_roar']);
  assert.equal(gameViewSoundEventKey('window-7', goal, 'tension', tension), 'window-7:tension');
  assert.equal(gameViewSoundEventKey('window-7', goal, 'celebration', celebration), 'window-7:celebration');
});

test('event identity requires an authoritative playback window', () => {
  const shot = scene({ kind: 'shot' });
  const plan = resolveGameViewSoundPlan(shot, undefined);
  assert.equal(gameViewSoundEventKey(undefined, shot, undefined, plan), undefined);
  assert.equal(gameViewSoundEventKey('window-2', shot, undefined, plan), 'window-2:shot');
});

test('effect cooldowns suppress feed chatter but never suppress a later goal roar', () => {
  assert.equal(canPlayGameViewSoundEffect('crowd_swell', undefined, 100), true);
  assert.equal(canPlayGameViewSoundEffect('crowd_swell', 100, 2_000), false);
  assert.equal(canPlayGameViewSoundEffect('crowd_swell', 100, 2_700), true);
  assert.equal(canPlayGameViewSoundEffect('goal_roar', 100, 100), true);
});

test('ambient volume ducks to the fixed factor while commentary voice is speaking', () => {
  assert.equal(resolveGameViewAmbientDuckedVolume(0.12, true), 0.12 * GAME_VIEW_AMBIENT_DUCK_FACTOR);
  assert.equal(GAME_VIEW_AMBIENT_DUCK_FACTOR, 0.35);
});

test('ambient volume is unchanged when commentary voice is not speaking', () => {
  assert.equal(resolveGameViewAmbientDuckedVolume(0.12, false), 0.12);
  assert.equal(resolveGameViewAmbientDuckedVolume(0, false), 0);
});

test('ducking a silent target stays silent', () => {
  assert.equal(resolveGameViewAmbientDuckedVolume(0, true), 0);
});
