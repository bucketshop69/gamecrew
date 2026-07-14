import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLiveMatchStatus,
  isTakeoverSceneKind,
  mapSourceActionToCardVariant,
  mapSourceActionToSetPieceVariant,
  resolveGameViewLoadState,
  selectPlaybackModeForMatchStatus,
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
