import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLiveMatchStatus,
  isTakeoverSceneKind,
  mapSourceActionToCardVariant,
  mapSourceActionToSetPieceVariant,
  resolveMatchParticipants,
  resolveGameViewLoadState,
  resolvePresentationScene,
  resolveScoreRailScore,
  selectPlaybackModeForMatchStatus,
  shouldSetPieceUseFullVignette,
  shouldTakeoverOnCompleteAdvancePlayback,
} from '../src/screens/game-view/game-view-screen-logic.ts';

// ---------------------------------------------------------------------------
// Authoritative renderer window
// ---------------------------------------------------------------------------

test('resolvePresentationScene applies the active engine window without mutating match truth', () => {
  const scene = {
    id: 'shot-1',
    fixtureId: 'fx-1',
    kind: 'shot',
    startRevision: 8,
    sourceFrameIds: ['f8'],
    participant: 2,
    zone: 'danger',
    durationHint: { minMs: 2500, maxMs: 5000 },
  };
  const result = resolvePresentationScene(scene, {
    instanceKey: '3:shot-1:9',
    sceneId: 'shot-1',
    startedAtMs: 100,
    durationMs: 1400,
    mode: 'replay',
  });

  assert.notEqual(result, scene);
  assert.deepEqual(result.durationHint, { minMs: 1400, maxMs: 1400 });
  assert.equal(result.participant, 2);
  assert.equal(result.zone, 'danger');
  assert.deepEqual(scene.durationHint, { minMs: 2500, maxMs: 5000 });
});

test('resolvePresentationScene ignores a stale window belonging to another scene', () => {
  const scene = {
    id: 'ambient-2',
    fixtureId: 'fx-1',
    kind: 'ambient',
    startRevision: 9,
    sourceFrameIds: ['f9'],
    durationHint: { minMs: 0, maxMs: 0 },
  };
  const result = resolvePresentationScene(scene, {
    instanceKey: '3:ambient-1:8',
    sceneId: 'ambient-1',
    startedAtMs: 100,
    durationMs: 900,
    mode: 'live',
  });

  assert.equal(result, scene);
  assert.equal(resolvePresentationScene(scene, undefined), scene);
  assert.equal(resolvePresentationScene(undefined, undefined), undefined);
});

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
    'substitution',
    'injury',
    'additional_time',
  ]) {
    assert.equal(isTakeoverSceneKind(kind), true, `expected ${kind} to be a takeover kind`);
  }
});

test('isTakeoverSceneKind: false for ambient board scene kinds and undefined', () => {
  assert.equal(isTakeoverSceneKind('ambient'), false);
  assert.equal(isTakeoverSceneKind('shot'), false);
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
  assert.equal(mapSourceActionToSetPieceVariant('goal_kick'), 'goal_kick');
});

test('mapSourceActionToSetPieceVariant returns undefined for unrecognized or missing sourceAction', () => {
  assert.equal(mapSourceActionToSetPieceVariant(undefined), undefined);
  assert.equal(mapSourceActionToSetPieceVariant('mystery'), undefined);
});

test('resolveMatchParticipants follows TxLINE home mapping and keeps the legacy fallback', () => {
  assert.deepEqual(resolveMatchParticipants(true), { home: 1, away: 2 });
  assert.deepEqual(resolveMatchParticipants(false), { home: 2, away: 1 });
  assert.deepEqual(resolveMatchParticipants(undefined), { home: 1, away: 2 });
});

// ---------------------------------------------------------------------------
// Minor set-piece badge vs full vignette (fix #2)
// ---------------------------------------------------------------------------

test('shouldSetPieceUseFullVignette: only penalty keeps the full vignette', () => {
  assert.equal(shouldSetPieceUseFullVignette('penalty'), true);
});

test('shouldSetPieceUseFullVignette: board-staged set pieces render as a compact badge over the visible board', () => {
  // Corner joined the badge set in R4: the swing is staged on the board by
  // the action cluster, so the vignette would hide the delivery itself.
  assert.equal(shouldSetPieceUseFullVignette('corner'), false);
  assert.equal(shouldSetPieceUseFullVignette('throw_in'), false);
  assert.equal(shouldSetPieceUseFullVignette('free_kick'), false);
});

test('shouldSetPieceUseFullVignette: unrecognized or missing sourceAction defaults to the quiet badge, never a full-screen wall', () => {
  assert.equal(shouldSetPieceUseFullVignette(undefined), false);
  assert.equal(shouldSetPieceUseFullVignette('goal_kick'), false);
  assert.equal(shouldSetPieceUseFullVignette(''), false);
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

test('resolveScoreRailScore: a fresh goal scene reads its tension beat pre-goal score without prior local state', () => {
  const scene = goalSequenceScene(
    [
      { kind: 'tension', lifecycle: 'provisional', sourceFrameIds: ['f1'], scoreAtMoment: { participant1: 2, participant2: 1 } },
      { kind: 'celebration', lifecycle: 'confirmed', sourceFrameIds: ['f2'], scoreAtMoment: { participant1: 3, participant2: 1 } },
    ],
    { scoreAtMoment: { participant1: 3, participant2: 1 } },
  );

  const result = resolveScoreRailScore(scene, undefined, 0);
  assert.deepEqual(result, { participant1: 2, participant2: 1 }, 'fresh mount must show neither a false 0-0 nor the post-goal 3-1');
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
