import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLiveMatchStatus,
  isTakeoverSceneKind,
  mapSourceActionToCardVariant,
  mapSourceActionToSetPieceVariant,
  resolveGameViewLoadState,
  resolveScoreRailScore,
  selectPlaybackModeForMatchStatus,
  shouldSetPieceUseFullVignette,
  shouldTakeoverOnCompleteAdvancePlayback,
} from '../src/screens/game-view/game-view-screen-logic.ts';

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

test('selectPlaybackModeForMatchStatus: live fixtures select live mode', () => {
  assert.equal(selectPlaybackModeForMatchStatus('live'), 'live');
});

test('selectPlaybackModeForMatchStatus: finished/upcoming/hosted fixtures select replay', () => {
  assert.equal(selectPlaybackModeForMatchStatus('finished'), 'replay');
  assert.equal(selectPlaybackModeForMatchStatus('replayable'), 'replay');
  assert.equal(selectPlaybackModeForMatchStatus('upcoming'), 'replay');
  assert.equal(selectPlaybackModeForMatchStatus('hosted'), 'replay');
});

test('isLiveMatchStatus: true only for live', () => {
  assert.equal(isLiveMatchStatus('live'), true);
  assert.equal(isLiveMatchStatus('finished'), false);
  assert.equal(isLiveMatchStatus('upcoming'), false);
  assert.equal(isLiveMatchStatus('hosted'), false);
  assert.equal(isLiveMatchStatus('replayable'), false);
});

// ---------------------------------------------------------------------------
// View-state mapping
// ---------------------------------------------------------------------------

test('resolveGameViewLoadState: loading session with no scenes yet is loading', () => {
  assert.deepEqual(resolveGameViewLoadState('loading', false), { status: 'loading', isStale: false });
});

test('resolveGameViewLoadState: loading session even with some scenes already built stays loading', () => {
  // A backfill in progress (session status stays 'loading' while paging) --
  // still surfaced as loading, not ready, until the session settles.
  assert.deepEqual(resolveGameViewLoadState('loading', true), { status: 'loading', isStale: false });
});

test('resolveGameViewLoadState: error with no scenes at all is the error state', () => {
  assert.deepEqual(resolveGameViewLoadState('error', false), { status: 'error', isStale: false });
});

test('resolveGameViewLoadState: settled session with no scenes is empty', () => {
  assert.deepEqual(resolveGameViewLoadState('complete', false), { status: 'empty', isStale: false });
  assert.deepEqual(resolveGameViewLoadState('live', false), { status: 'empty', isStale: false });
});

test('resolveGameViewLoadState: live session with scenes is ready, not stale', () => {
  assert.deepEqual(resolveGameViewLoadState('live', true), { status: 'ready', isStale: false });
});

test('resolveGameViewLoadState: complete session with scenes is ready, not stale', () => {
  assert.deepEqual(resolveGameViewLoadState('complete', true), { status: 'ready', isStale: false });
});

test('resolveGameViewLoadState: stale session with scenes stays ready, flagged stale', () => {
  assert.deepEqual(resolveGameViewLoadState('stale', true), { status: 'ready', isStale: true });
});

test('resolveGameViewLoadState: error after scenes already existed holds the board, flagged stale', () => {
  assert.deepEqual(resolveGameViewLoadState('error', true), { status: 'ready', isStale: true });
});

// ---------------------------------------------------------------------------
// Takeover-advancement ownership
// ---------------------------------------------------------------------------

test('isTakeoverSceneKind: true for every scene kind the takeover dispatcher renders', () => {
  for (const kind of [
    'goal_sequence',
    'card',
    'set_piece',
    'var_review',
    'goal_retracted',
    'phase_break',
    'restart',
  ]) {
    assert.equal(isTakeoverSceneKind(kind), true, `expected ${kind} to be a takeover kind`);
  }
});

test('isTakeoverSceneKind: false for ambient board scene kinds and undefined', () => {
  assert.equal(isTakeoverSceneKind('ambient'), false);
  assert.equal(isTakeoverSceneKind('shot'), false);
  assert.equal(isTakeoverSceneKind('substitution'), false);
  assert.equal(isTakeoverSceneKind(undefined), false);
});

test('shouldTakeoverOnCompleteAdvancePlayback: never advances playback in any mode', () => {
  // PlaybackEngine (its replay timer, or live-buffer recompute) is the sole
  // owner of playhead advancement -- see this function's doc comment.
  for (const mode of ['live', 'paused', 'scrubbing', 'replay']) {
    assert.equal(shouldTakeoverOnCompleteAdvancePlayback(mode), false);
  }
});

// ---------------------------------------------------------------------------
// sourceAction -> takeover variant mapping
// ---------------------------------------------------------------------------

test('mapSourceActionToCardVariant maps yellow_card/red_card', () => {
  assert.equal(mapSourceActionToCardVariant('yellow_card'), 'yellow');
  assert.equal(mapSourceActionToCardVariant('red_card'), 'red');
});

test('mapSourceActionToCardVariant returns undefined for unrecognized or missing sourceAction', () => {
  assert.equal(mapSourceActionToCardVariant(undefined), undefined);
  assert.equal(mapSourceActionToCardVariant('second_yellow'), undefined);
  assert.equal(mapSourceActionToCardVariant(''), undefined);
});

test('mapSourceActionToSetPieceVariant maps every known set-piece action', () => {
  assert.equal(mapSourceActionToSetPieceVariant('corner'), 'corner');
  assert.equal(mapSourceActionToSetPieceVariant('free_kick'), 'free_kick');
  assert.equal(mapSourceActionToSetPieceVariant('throw_in'), 'throw_in');
  assert.equal(mapSourceActionToSetPieceVariant('penalty'), 'penalty');
});

test('mapSourceActionToSetPieceVariant returns undefined for unrecognized or missing sourceAction', () => {
  assert.equal(mapSourceActionToSetPieceVariant(undefined), undefined);
  assert.equal(mapSourceActionToSetPieceVariant('goal_kick'), undefined);
});

// ---------------------------------------------------------------------------
// Minor set-piece badge vs full vignette (fix #2)
// ---------------------------------------------------------------------------

test('shouldSetPieceUseFullVignette: corner and penalty keep the full vignette', () => {
  assert.equal(shouldSetPieceUseFullVignette('corner'), true);
  assert.equal(shouldSetPieceUseFullVignette('penalty'), true);
});

test('shouldSetPieceUseFullVignette: throw-in and free kick render as a compact badge instead', () => {
  assert.equal(shouldSetPieceUseFullVignette('throw_in'), false);
  assert.equal(shouldSetPieceUseFullVignette('free_kick'), false);
});

test('shouldSetPieceUseFullVignette: unrecognized or missing sourceAction defaults to the full vignette', () => {
  assert.equal(shouldSetPieceUseFullVignette(undefined), true);
  assert.equal(shouldSetPieceUseFullVignette('goal_kick'), true);
  assert.equal(shouldSetPieceUseFullVignette(''), true);
});

// ---------------------------------------------------------------------------
// No score spoiler (fix #3)
// ---------------------------------------------------------------------------

function goalSequenceScene(beats, overrides = {}) {
  return {
    id: 'goal-1',
    fixtureId: 'fx-1',
    kind: 'goal_sequence',
    startRevision: 1,
    sourceFrameIds: ['f1'],
    durationHint: { minMs: 4000, maxMs: 8000 },
    beats,
    ...overrides,
  };
}

test('resolveScoreRailScore: non-goal_sequence scenes just report their own scoreAtMoment', () => {
  const scene = {
    id: 's1',
    fixtureId: 'fx-1',
    kind: 'ambient',
    startRevision: 1,
    sourceFrameIds: ['f1'],
    durationHint: { minMs: 0, maxMs: 0 },
    scoreAtMoment: { participant1: 1, participant2: 0 },
  };
  const result = resolveScoreRailScore(scene, { participant1: 0, participant2: 0 }, 0);
  assert.deepEqual(result, { participant1: 1, participant2: 0 });
});

test('resolveScoreRailScore: holds the previous score while the active beat is tension', () => {
  const previousScore = { participant1: 0, participant2: 0 };
  const scene = goalSequenceScene(
    [
      { kind: 'tension', lifecycle: 'provisional', sourceFrameIds: ['f1'] },
      { kind: 'celebration', lifecycle: 'confirmed', sourceFrameIds: ['f2'], scoreAtMoment: { participant1: 1, participant2: 0 } },
    ],
    { scoreAtMoment: { participant1: 1, participant2: 0 } },
  );

  const result = resolveScoreRailScore(scene, previousScore, 0);
  assert.deepEqual(result, previousScore, 'tension beat must not leak the post-goal score');
});

test('resolveScoreRailScore: commits the new score once the celebration beat is active', () => {
  const previousScore = { participant1: 0, participant2: 0 };
  const scene = goalSequenceScene(
    [
      { kind: 'tension', lifecycle: 'provisional', sourceFrameIds: ['f1'] },
      { kind: 'celebration', lifecycle: 'confirmed', sourceFrameIds: ['f2'], scoreAtMoment: { participant1: 1, participant2: 0 } },
    ],
    { scoreAtMoment: { participant1: 1, participant2: 0 } },
  );

  const result = resolveScoreRailScore(scene, previousScore, 1);
  assert.deepEqual(result, { participant1: 1, participant2: 0 });
});

test('resolveScoreRailScore: a still-provisional goal (tension-only beats) never commits a score', () => {
  const previousScore = { participant1: 0, participant2: 0 };
  const scene = goalSequenceScene([
    { kind: 'tension', lifecycle: 'provisional', sourceFrameIds: ['f1'] },
  ], { scoreAtMoment: { participant1: 1, participant2: 0 } });

  const result = resolveScoreRailScore(scene, previousScore, 0);
  assert.deepEqual(result, previousScore);
});

test('resolveScoreRailScore: a beat-less goal_sequence scene falls back to its own scoreAtMoment', () => {
  const scene = goalSequenceScene(undefined, { scoreAtMoment: { participant1: 2, participant2: 1 } });
  const result = resolveScoreRailScore(scene, { participant1: 1, participant2: 1 }, 0);
  assert.deepEqual(result, { participant1: 2, participant2: 1 });
});

test('resolveScoreRailScore: clamps an out-of-range beat index to the last beat', () => {
  const scene = goalSequenceScene(
    [
      { kind: 'tension', lifecycle: 'provisional', sourceFrameIds: ['f1'] },
      { kind: 'celebration', lifecycle: 'confirmed', sourceFrameIds: ['f2'], scoreAtMoment: { participant1: 3, participant2: 1 } },
    ],
    { scoreAtMoment: { participant1: 3, participant2: 1 } },
  );
  const result = resolveScoreRailScore(scene, { participant1: 2, participant2: 1 }, 99);
  assert.deepEqual(result, { participant1: 3, participant2: 1 });
});

test('resolveScoreRailScore: a missing/null current scene returns the previous score unchanged', () => {
  const previousScore = { participant1: 1, participant2: 2 };
  assert.deepEqual(resolveScoreRailScore(null, previousScore, 0), previousScore);
  assert.deepEqual(resolveScoreRailScore(undefined, previousScore, 0), previousScore);
});
