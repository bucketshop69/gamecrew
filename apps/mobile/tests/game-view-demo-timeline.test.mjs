import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GAME_VIEW_DEMO_DURATION_MS,
  GAME_VIEW_DEMO_FINAL_HOLD_START_MS,
  GAME_VIEW_DEMO_SCORE_COMMIT_AT_MS,
  GAME_VIEW_DEMO_SHOT_ARRIVAL_MS,
  gameViewDemoActors,
  gameViewDemoBallEvents,
  gameViewDemoBeats,
  gameViewDemoCamera,
  gameViewDemoReducedMotionSnapshot,
  gameViewDemoTeamShapes,
  getGameViewDemoActorPoint,
  validateGameViewDemoTimeline,
} from '../src/screens/game-view-demo-timeline.ts';

test('keeps the authored demo timeline internally valid', () => {
  assert.deepEqual(validateGameViewDemoTimeline(), []);
});

test('runs once for the forty-second narration window', () => {
  assert.ok(GAME_VIEW_DEMO_DURATION_MS >= 38_000);
  assert.ok(GAME_VIEW_DEMO_DURATION_MS <= 42_000);
  assert.equal(gameViewDemoBeats.at(-1)?.id, 'celebration');
  assert.equal(gameViewDemoCamera.at(-1)?.atMs, GAME_VIEW_DEMO_DURATION_MS);
  assert.equal(gameViewDemoTeamShapes.at(-1)?.atMs, GAME_VIEW_DEMO_DURATION_MS);
});

test('choreographs one continuous ball journey', () => {
  assert.equal(gameViewDemoBallEvents[0]?.fromMs, 0);
  assert.equal(gameViewDemoBallEvents.at(-1)?.toMs, GAME_VIEW_DEMO_DURATION_MS);

  for (let index = 1; index < gameViewDemoBallEvents.length; index += 1) {
    assert.equal(
      gameViewDemoBallEvents[index].fromMs,
      gameViewDemoBallEvents[index - 1].toMs,
    );
  }
});

test('commits the score only after the shot reaches the goal', () => {
  assert.ok(GAME_VIEW_DEMO_SCORE_COMMIT_AT_MS >= GAME_VIEW_DEMO_SHOT_ARRIVAL_MS);
  const shot = gameViewDemoBallEvents.find((event) => event.kind === 'shot');
  assert.equal(shot?.toMs, GAME_VIEW_DEMO_SHOT_ARRIVAL_MS);
});

test('holds the final celebration instead of visibly looping', () => {
  assert.ok(GAME_VIEW_DEMO_FINAL_HOLD_START_MS < GAME_VIEW_DEMO_DURATION_MS);

  const celebrants = gameViewDemoActors.filter((actor) =>
    actor.keyframes.at(-1)?.pose === 'celebrate');
  assert.ok(celebrants.length >= 3);
  for (const actor of celebrants) {
    assert.equal(actor.keyframes.at(-1)?.atMs, GAME_VIEW_DEMO_DURATION_MS);
  }

  const finalBall = gameViewDemoBallEvents.at(-1);
  assert.equal(finalBall?.kind, 'settled');
  assert.deepEqual(finalBall?.from, finalBall?.to);

  const finalHoldActor = gameViewDemoActors.find((actor) => actor.id === 'h8');
  assert.deepEqual(
    finalHoldActor?.keyframes.at(-2)?.point,
    finalHoldActor?.keyframes.at(-1)?.point,
  );
});

test('keeps the focal winger clear of his marker at narrow recording width', () => {
  const availableWidth = 432 - 26;
  const availableHeight = 634 - 26;

  for (let atMs = 0; atMs <= 33_000; atMs += 250) {
    const winger = getGameViewDemoActorPoint('h11', atMs);
    const marker = getGameViewDemoActorPoint('a11', atMs);
    assert.ok(winger && marker);

    const horizontalSeparation = Math.abs(winger.x - marker.x) * availableWidth;
    const verticalSeparation = Math.abs(winger.y - marker.y) * availableHeight;
    assert.ok(
      horizontalSeparation >= 22 || verticalSeparation >= 32,
      `h11 and a11 overlap at ${atMs}ms`,
    );
  }
});

test('provides a safe static frame when reduced motion is enabled', () => {
  assert.ok(gameViewDemoReducedMotionSnapshot.atMs >= 0);
  assert.ok(gameViewDemoReducedMotionSnapshot.atMs <= GAME_VIEW_DEMO_DURATION_MS);
  assert.ok(gameViewDemoReducedMotionSnapshot.ball.x >= 0);
  assert.ok(gameViewDemoReducedMotionSnapshot.ball.x <= 1);
  assert.ok(gameViewDemoReducedMotionSnapshot.ball.y >= 0);
  assert.ok(gameViewDemoReducedMotionSnapshot.ball.y <= 1);
  assert.ok(gameViewDemoBeats.some(
    (beat) => beat.id === gameViewDemoReducedMotionSnapshot.beatId,
  ));
});
