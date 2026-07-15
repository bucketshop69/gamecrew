import assert from 'node:assert/strict';
import test from 'node:test';

import {
  darkenColor,
  facingRotationDeg,
  mirrorLimbTransform,
  PLAYER_ASPECT_RATIO,
  PLAYER_POSES,
  poseLimbSet,
  resolveMirrored,
  runCycleFrame,
} from '../src/screens/game-view-players/player-pose-logic.ts';

test('poseLimbSet returns a complete, finite transform set for every declared pose', () => {
  for (const pose of PLAYER_POSES) {
    const limbs = poseLimbSet(pose);
    for (const key of ['leftArm', 'rightArm', 'leftLeg', 'rightLeg']) {
      const limb = limbs[key];
      assert.ok(limb, `${pose}.${key} should exist`);
      assert.equal(typeof limb.rotateDeg, 'number');
      assert.ok(Number.isFinite(limb.rotateDeg), `${pose}.${key}.rotateDeg should be finite`);
      assert.ok(Number.isFinite(limb.translateXFraction), `${pose}.${key}.translateXFraction should be finite`);
      assert.ok(Number.isFinite(limb.translateYFraction), `${pose}.${key}.translateYFraction should be finite`);
    }
    assert.ok(Number.isFinite(limbs.bodyRotateDeg), `${pose}.bodyRotateDeg should be finite`);
    assert.ok(Number.isFinite(limbs.bodyLeanDeg), `${pose}.bodyLeanDeg should be finite`);
  }
});

test('poseLimbSet falls back to a neutral (all-zero) set for an unrecognized pose', () => {
  const limbs = poseLimbSet('not_a_real_pose');
  assert.equal(limbs.leftArm.rotateDeg, 0);
  assert.equal(limbs.rightArm.rotateDeg, 0);
  assert.equal(limbs.leftLeg.rotateDeg, 0);
  assert.equal(limbs.rightLeg.rotateDeg, 0);
  assert.equal(limbs.bodyRotateDeg, 0);
  assert.equal(limbs.bodyLeanDeg, 0);
});

test('PLAYER_POSES lists the full product-required pose set exactly once each', () => {
  const expected = [
    'idle',
    'run_a',
    'run_b',
    'strike',
    'header',
    'keeper_dive_left',
    'keeper_dive_right',
    'celebrate',
    'wall_stance',
  ];
  assert.deepEqual([...PLAYER_POSES].sort(), [...expected].sort());
  assert.equal(new Set(PLAYER_POSES).size, PLAYER_POSES.length);
});

test('run_a and run_b are opposite strides: arms negate side-for-side, legs swap sides', () => {
  const a = poseLimbSet('run_a');
  const b = poseLimbSet('run_b');
  // Arms: same side negates between frames (an arm swinging forward becomes
  // the arm swinging back).
  assert.equal(a.leftArm.rotateDeg, -b.leftArm.rotateDeg);
  assert.equal(a.rightArm.rotateDeg, -b.rightArm.rotateDeg);
  // Legs: the drive-leg/plant-leg shapes swap which side they're on (not a
  // same-side negation), so a stride reads as a genuine alternation rather
  // than a limp mirror.
  assert.deepEqual(a.leftLeg, b.rightLeg);
  assert.deepEqual(a.rightLeg, b.leftLeg);
  assert.notDeepEqual(a.leftLeg, a.rightLeg);
});

test('keeper_dive_left and keeper_dive_right rotate the whole body in opposite directions', () => {
  const left = poseLimbSet('keeper_dive_left');
  const right = poseLimbSet('keeper_dive_right');
  assert.ok(left.bodyRotateDeg < 0, 'dive left should rotate negative (toward left)');
  assert.ok(right.bodyRotateDeg > 0, 'dive right should rotate positive (toward right)');
  assert.equal(left.bodyRotateDeg, -right.bodyRotateDeg);
});

test('celebrate raises both arms well above the resting idle angle', () => {
  const idle = poseLimbSet('idle');
  const celebrate = poseLimbSet('celebrate');
  assert.ok(Math.abs(celebrate.leftArm.rotateDeg) > Math.abs(idle.leftArm.rotateDeg));
  assert.ok(Math.abs(celebrate.rightArm.rotateDeg) > Math.abs(idle.rightArm.rotateDeg));
  // Raised arms point up-and-out from the resting downward hang: negative
  // translateYFraction on both sides is how this pose table expresses "up".
  assert.ok(celebrate.leftArm.translateYFraction < 0);
  assert.ok(celebrate.rightArm.translateYFraction < 0);
});

test('runCycleFrame alternates run_a/run_b on frame-duration boundaries', () => {
  assert.equal(runCycleFrame(0, 200), 'run_a');
  assert.equal(runCycleFrame(199, 200), 'run_a');
  assert.equal(runCycleFrame(200, 200), 'run_b');
  assert.equal(runCycleFrame(399, 200), 'run_b');
  assert.equal(runCycleFrame(400, 200), 'run_a');
  assert.equal(runCycleFrame(1_000, 200), 'run_b');
});

test('runCycleFrame treats negative elapsed time as frame 0 and guards a zero/negative duration', () => {
  assert.equal(runCycleFrame(-50, 200), 'run_a');
  assert.equal(runCycleFrame(500, 0), 'run_a');
  assert.equal(runCycleFrame(500, -10), 'run_a');
});

test('facingRotationDeg maps each of the four facings to a distinct rotation', () => {
  assert.equal(facingRotationDeg('down'), 0);
  assert.equal(facingRotationDeg('up'), 180);
  assert.equal(facingRotationDeg('left'), -90);
  assert.equal(facingRotationDeg('right'), 90);
});

test('resolveMirrored: explicit mirrored prop always wins over facing', () => {
  assert.equal(resolveMirrored('down', true), true);
  assert.equal(resolveMirrored('down', false), false);
  assert.equal(resolveMirrored('right', true), true);
  assert.equal(resolveMirrored('left', false), false);
});

test('resolveMirrored: without an override, only "left" facing mirrors by default', () => {
  assert.equal(resolveMirrored('left'), true);
  assert.equal(resolveMirrored('right'), false);
  assert.equal(resolveMirrored('up'), false);
  assert.equal(resolveMirrored('down'), false);
});

test('mirrorLimbTransform negates rotation and horizontal translate, keeps vertical translate', () => {
  const transform = { rotateDeg: 30, translateXFraction: 0.1, translateYFraction: -0.2 };
  const mirrored = mirrorLimbTransform(transform);
  assert.equal(mirrored.rotateDeg, -30);
  assert.equal(mirrored.translateXFraction, -0.1);
  assert.equal(mirrored.translateYFraction, -0.2);
});

test('mirrorLimbTransform is its own inverse', () => {
  const transform = { rotateDeg: -46, translateXFraction: -0.05, translateYFraction: 0.03 };
  const twice = mirrorLimbTransform(mirrorLimbTransform(transform));
  assert.deepEqual(twice, transform);
});

test('darkenColor moves each channel toward black by the given fraction', () => {
  assert.equal(darkenColor('#006847', 0), '#006847');
  assert.equal(darkenColor('#FFFFFF', 1), '#000000');
  assert.equal(darkenColor('#FFDD00', 0.5), '#806f00');
});

test('darkenColor leaves an unparseable color unchanged', () => {
  assert.equal(darkenColor('not-a-color', 0.5), 'not-a-color');
  assert.equal(darkenColor('rgba(0,0,0,1)', 0.5), 'rgba(0,0,0,1)');
});

test('PLAYER_ASPECT_RATIO is a sane positive height:width ratio', () => {
  assert.ok(PLAYER_ASPECT_RATIO > 1, 'players should be taller than they are wide');
  assert.ok(Number.isFinite(PLAYER_ASPECT_RATIO));
});
