import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { buildGameViewTimeline } from '../src/match-engine/index.ts';

/**
 * Real-data regression coverage for the Game View director (work item 5,
 * docs/issues/game-view-director-and-playback.md). The fixtures under
 * tests/fixtures/game-view-*.trimmed.json are trimmed-but-faithful subsets
 * of the real `match_engine_frames` rows recorded for two stored fixtures:
 *
 * - 18179759: Mexico-Ecuador, finishes 2-0.
 * - 18209181: France-Morocco, finishes 2-0.
 *
 * Trimming strategy: every frame within +/-3 seq of a "notable" cue (goal
 * lifecycle, score commit, retraction, card, substitution, var, phase
 * change) is kept in full, plus the very first and last frame of the match
 * and every 12th otherwise-untouched frame for ambient coverage. Seq order
 * and frame/cue ids are preserved exactly as recorded. This was chosen over
 * a full-DB-only integration test because:
 *   - The three real-data bugs this suite guards against (duplicate goal
 *     sequences from a later goal_confirmed revision, late_winner clock
 *     misclassification, missing scorer identity) all reproduce correctly
 *     against the trimmed fixture (verified by comparing trimmed-fixture
 *     output to full-DB output while writing this test), because trimming
 *     kept every seq touching a goal/score/retraction cue rather than
 *     sampling those windows.
 *   - A checked-in fixture keeps this suite runnable in CI and for anyone
 *     without a copy of the local sqlite DB, at ~370 KB combined -- far
 *     under the ~1MB budget -- versus the multi-MB source databases.
 * A full-DB env-guarded companion test is intentionally not added on top:
 * with the trimmed fixture already verified against the full DB's output
 * during fixture extraction, a skip-when-absent full-DB test would mostly
 * duplicate this file's assertions while adding a second fixture path to
 * maintain. If the trimming ever needs re-verification against the live DB,
 * rerun the extraction script referenced in
 * docs/issues/game-view-director-and-playback.md work item 5 rather than
 * re-adding that second path.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFrames(fixtureId) {
  const raw = readFileSync(path.join(FIXTURES_DIR, `game-view-${fixtureId}.trimmed.json`), 'utf8');
  return JSON.parse(raw);
}

const FIXTURES = [
  // rawRetractionCount = all incident_retracted cues in the source frames;
  // goalRetractionSceneCount = only goal retractions become goal_retracted
  // scenes (Mexico's single retraction is a throw-in, France keeps one
  // genuinely disallowed goal out of three retractions).
  { id: '18179759', label: 'Mexico-Ecuador', rawRetractionCount: 1, goalRetractionSceneCount: 0 },
  { id: '18209181', label: 'France-Morocco', rawRetractionCount: 3, goalRetractionSceneCount: 1 },
];

for (const { id, label, rawRetractionCount, goalRetractionSceneCount } of FIXTURES) {
  test(`${label} (${id}): exactly 2 confirmed goal_sequence scenes with correct running score and no duplicates`, () => {
    const frames = loadFrames(id);
    const scenes = buildGameViewTimeline(frames);

    const confirmedGoals = scenes.filter((scene) => scene.kind === 'goal_sequence' && scene.lifecycle === 'confirmed');
    assert.equal(confirmedGoals.length, 2, 'post-dedupe there must be exactly one scene per real goal, not one per goal_confirmed revision');
    assert.deepEqual(confirmedGoals[0].scoreAtMoment, { participant1: 1, participant2: 0 });
    assert.deepEqual(confirmedGoals[1].scoreAtMoment, { participant1: 2, participant2: 0 });
  });

  test(`${label} (${id}): scorer identity is attached wherever the source frames provide it`, () => {
    const frames = loadFrames(id);
    const scenes = buildGameViewTimeline(frames);
    const confirmedGoals = scenes.filter((scene) => scene.kind === 'goal_sequence' && scene.lifecycle === 'confirmed');

    for (const goal of confirmedGoals) {
      assert.ok(goal.player, `goal_sequence scene ${goal.id} must carry scorer identity when the source frames supplied it`);
      assert.ok(goal.player.sourcePreferredName, 'scorer must have a name');
      const celebration = goal.beats?.find((beat) => beat.kind === 'celebration');
      assert.ok(celebration?.player, 'the celebration beat must also carry the scorer once known');
    }
  });

  test(`${label} (${id}): only goal retractions become goal_retracted scenes`, () => {
    const frames = loadFrames(id);
    const scenes = buildGameViewTimeline(frames);

    const rawRetractionCues = frames.flatMap((frame) => frame.simulationCues ?? []).filter((cue) => cue.kind === 'incident_retracted');
    assert.equal(rawRetractionCues.length, rawRetractionCount, 'sanity check on the fixture itself: raw retraction cue count must match the documented baseline');

    const retractedScenes = scenes.filter((scene) => scene.kind === 'goal_retracted');
    assert.equal(retractedScenes.length, goalRetractionSceneCount, 'minor-incident retractions (throw-ins, corners) must not produce goal_retracted takeovers');
  });

  test(`${label} (${id}): deterministic under shuffled input`, () => {
    const frames = loadFrames(id);
    const inOrder = buildGameViewTimeline(frames);
    const shuffled = [...frames].sort(() => Math.random() - 0.5);
    const fromShuffled = buildGameViewTimeline(shuffled);

    assert.deepEqual(fromShuffled, inOrder, 'shuffling input frame order must not change the resulting timeline');
  });

  test(`${label} (${id}): every scene carries at least one sourceFrameId`, () => {
    const frames = loadFrames(id);
    const scenes = buildGameViewTimeline(frames);

    assert.ok(scenes.length > 0);
    for (const scene of scenes) {
      assert.ok(Array.isArray(scene.sourceFrameIds) && scene.sourceFrameIds.length > 0, `scene ${scene.id} (${scene.kind}) is missing sourceFrameIds`);
    }
  });

  test(`${label} (${id}): runs in well under 100ms`, () => {
    const frames = loadFrames(id);
    const start = performance.now();
    buildGameViewTimeline(frames);
    const elapsedMs = performance.now() - start;

    assert.ok(elapsedMs < 100, `expected buildGameViewTimeline to finish in under 100ms, took ${elapsedMs.toFixed(1)}ms`);
  });
}

test('France-Morocco (18209181): 60th-minute French opener is not misclassified as late_winner', () => {
  const frames = loadFrames('18209181');
  const scenes = buildGameViewTimeline(frames);
  const confirmedGoals = scenes.filter((scene) => scene.kind === 'goal_sequence' && scene.lifecycle === 'confirmed');

  const opener = confirmedGoals[0];
  assert.deepEqual(opener.scoreAtMoment, { participant1: 1, participant2: 0 });
  assert.ok(opener.scoreEvents?.includes('opener'), 'first goal of the match should be classified as opener');
  assert.ok(!opener.scoreEvents?.includes('late_winner'), 'a goal roughly 14 minutes into the second half must never be classified late_winner');
});

const REPLAY_FIXED_KINDS = new Set(['goal_sequence', 'goal_retracted', 'card', 'var_review', 'phase_break']);

test('replay pacing: major moments keep their durationHint, flexible scenes compress, offsets tile without gaps', () => {
  const frames = loadFrames('18179759');
  const scenes = buildGameViewTimeline(frames, { pacing: { mode: 'replay' } });

  assert.ok(scenes.length > 0);
  let runningOffset = 0;
  for (const scene of scenes) {
    assert.ok(scene.playback, `scene ${scene.id} must carry computed playback timing when pacing is requested`);
    assert.equal(scene.playback.playbackOffsetMs, runningOffset, 'scenes must tile back-to-back with no gaps or overlaps');
    assert.ok(scene.playback.playbackDurationMs > 0, 'every scene must occupy positive playback time');
    if (REPLAY_FIXED_KINDS.has(scene.kind)) {
      assert.equal(scene.playback.playbackDurationMs, scene.durationHint.minMs, 'major-moment scenes must keep their full durationHint, never compressed');
    }
    runningOffset += scene.playback.playbackDurationMs;
  }

  const ambientDurations = scenes.filter((scene) => scene.kind === 'ambient').map((scene) => scene.playback.playbackDurationMs);
  assert.ok(ambientDurations.length > 0);
  const cap = 2500; // DEFAULT_REPLAY_AMBIENT_CAP_MS
  for (const duration of ambientDurations) {
    assert.ok(duration <= cap, `ambient stretch duration ${duration}ms exceeded the compression cap ${cap}ms`);
  }
});

test('replay pacing: a full match fits the default ~5 minute target while majors keep full screen time', () => {
  const frames = loadFrames('18179759');
  const scenes = buildGameViewTimeline(frames, { pacing: { mode: 'replay' } });
  const last = scenes[scenes.length - 1];
  const totalMs = last.playback.playbackOffsetMs + last.playback.playbackDurationMs;
  // Floors on ~900 flexible scenes can push slightly past the 300s target; it
  // must land in a watchable window, nowhere near the unscaled ~35 minutes.
  assert.ok(totalMs <= 420_000, `replay must be watchable, got ${(totalMs / 1000).toFixed(0)}s`);
  assert.ok(totalMs >= 120_000, `replay should not collapse below a tellable story, got ${(totalMs / 1000).toFixed(0)}s`);
});

test('replay pacing: targetDurationMs null disables scaling and every takeover keeps durationHint', () => {
  const frames = loadFrames('18179759');
  const scenes = buildGameViewTimeline(frames, { pacing: { mode: 'replay', targetDurationMs: null } });
  for (const scene of scenes) {
    if (scene.kind !== 'ambient') {
      assert.equal(scene.playback.playbackDurationMs, scene.durationHint.minMs);
    }
  }
});

test('buildGameViewTimeline without pacing options omits playback timing entirely', () => {
  const frames = loadFrames('18179759');
  const scenes = buildGameViewTimeline(frames);
  for (const scene of scenes) {
    assert.equal(scene.playback, undefined, 'playback timing is opt-in via options.pacing');
  }
});

test('card and set_piece scenes carry the source incident action for renderer variants', () => {
  const frames = loadFrames('18179759');
  const scenes = buildGameViewTimeline(frames);
  const cards = scenes.filter((scene) => scene.kind === 'card');
  assert.ok(cards.length >= 3, 'fixture must contain card scenes');
  for (const card of cards) {
    assert.ok(['yellow_card', 'red_card'].includes(card.sourceAction), `card scene must carry yellow_card/red_card, got ${card.sourceAction}`);
  }
  assert.ok(cards.some((card) => card.sourceAction === 'red_card'), 'the 95\' red card must be distinguishable');
  const setPieces = scenes.filter((scene) => scene.kind === 'set_piece');
  assert.ok(setPieces.length > 0 && setPieces.every((scene) => typeof scene.sourceAction === 'string'), 'set_piece scenes must carry their action');
});
