import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMENTARY_VOICE_PREFETCH_WINDOW,
  decideCommentaryVoiceQueueAction,
  isBigMomentKind,
  resolveCommentaryVoicePrefetchWindow,
} from '../src/screens/game-view/commentary-voice-logic.ts';

function clip(entryId, kind) {
  return { entryId, kind };
}

test('idle player always plays the incoming clip', () => {
  assert.equal(decideCommentaryVoiceQueueAction(undefined, clip('e1', 'goal')), 'play');
  assert.equal(decideCommentaryVoiceQueueAction(undefined, clip('e1', 'pressure')), 'play');
});

test('busy + big moment interrupts whatever is currently speaking', () => {
  const current = clip('e1', 'pressure');
  assert.equal(decideCommentaryVoiceQueueAction(current, clip('e2', 'goal')), 'interrupt');
  assert.equal(decideCommentaryVoiceQueueAction(current, clip('e2', 'penalty')), 'interrupt');
  assert.equal(decideCommentaryVoiceQueueAction(current, clip('e2', 'card')), 'interrupt');
  assert.equal(decideCommentaryVoiceQueueAction(current, clip('e2', 'var')), 'interrupt');
});

test('busy + routine drops the incoming clip rather than queuing it', () => {
  const current = clip('e1', 'goal');
  assert.equal(decideCommentaryVoiceQueueAction(current, clip('e2', 'pressure')), 'drop');
  assert.equal(decideCommentaryVoiceQueueAction(current, clip('e2', 'shot')), 'drop');
  assert.equal(decideCommentaryVoiceQueueAction(current, clip('e2', 'momentum')), 'drop');
});

test('a big moment currently speaking is itself interrupted by another big moment', () => {
  const current = clip('e1', 'goal');
  assert.equal(decideCommentaryVoiceQueueAction(current, clip('e2', 'penalty')), 'interrupt');
});

test('unknown/unrecognized kind is treated as routine, never as a big moment', () => {
  assert.equal(isBigMomentKind('substitution'), false);
  assert.equal(isBigMomentKind('injury'), false);
  assert.equal(isBigMomentKind('momentum'), false);
  const current = clip('e1', 'pressure');
  assert.equal(decideCommentaryVoiceQueueAction(current, clip('e2', 'substitution')), 'drop');
});

test('the same entry id already playing is dropped, not replayed', () => {
  const current = clip('e1', 'goal');
  assert.equal(decideCommentaryVoiceQueueAction(current, clip('e1', 'goal')), 'drop');
});

test('recognized big-moment kinds are exactly goal, penalty, card, var', () => {
  assert.equal(isBigMomentKind('goal'), true);
  assert.equal(isBigMomentKind('penalty'), true);
  assert.equal(isBigMomentKind('card'), true);
  assert.equal(isBigMomentKind('var'), true);
  assert.equal(isBigMomentKind('shot'), false);
  assert.equal(isBigMomentKind('danger'), false);
});

test('prefetch window at the start of the list warms the first N ids', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(resolveCommentaryVoicePrefetchWindow(ids, undefined), ['a', 'b', 'c']);
  assert.equal(COMMENTARY_VOICE_PREFETCH_WINDOW, 3);
});

test('prefetch window advances from the current entry id', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(resolveCommentaryVoicePrefetchWindow(ids, 'b'), ['c', 'd', 'e']);
});

test('prefetch window at the end of the list returns fewer than the window size', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(resolveCommentaryVoicePrefetchWindow(ids, 'd'), ['e']);
  assert.deepEqual(resolveCommentaryVoicePrefetchWindow(ids, 'e'), []);
});

test('an unknown current entry id (not in the list) warms from the front', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(resolveCommentaryVoicePrefetchWindow(ids, 'not-in-list'), ['a', 'b', 'c']);
});

test('an empty manifest never warms anything', () => {
  assert.deepEqual(resolveCommentaryVoicePrefetchWindow([], undefined), []);
  assert.deepEqual(resolveCommentaryVoicePrefetchWindow([], 'a'), []);
});

test('a custom window size is honored and a non-positive size warms nothing', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(resolveCommentaryVoicePrefetchWindow(ids, undefined, 1), ['a']);
  assert.deepEqual(resolveCommentaryVoicePrefetchWindow(ids, undefined, 0), []);
});
