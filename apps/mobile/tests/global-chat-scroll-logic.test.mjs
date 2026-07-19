import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AT_BOTTOM_THRESHOLD_PX,
  isScrollAtBottom,
  resolveNewMessagesPillVisible,
  shouldAutoScrollOnContentChange,
} from '../src/screens/global-chat-scroll-logic.ts';

// ---------------------------------------------------------------------------
// isScrollAtBottom
// ---------------------------------------------------------------------------

test('isScrollAtBottom is true exactly at the bottom', () => {
  assert.equal(
    isScrollAtBottom({ contentOffsetY: 400, contentHeight: 1000, layoutHeight: 600 }),
    true,
  );
});

test('isScrollAtBottom is true within the threshold', () => {
  assert.equal(
    isScrollAtBottom({
      contentOffsetY: 400 - AT_BOTTOM_THRESHOLD_PX,
      contentHeight: 1000,
      layoutHeight: 600,
    }),
    true,
  );
});

test('isScrollAtBottom is false just past the threshold', () => {
  assert.equal(
    isScrollAtBottom({
      contentOffsetY: 400 - AT_BOTTOM_THRESHOLD_PX - 1,
      contentHeight: 1000,
      layoutHeight: 600,
    }),
    false,
  );
});

test('isScrollAtBottom is false when scrolled well up', () => {
  assert.equal(
    isScrollAtBottom({ contentOffsetY: 0, contentHeight: 2000, layoutHeight: 600 }),
    false,
  );
});

// ---------------------------------------------------------------------------
// shouldAutoScrollOnContentChange
// ---------------------------------------------------------------------------

test('shouldAutoScrollOnContentChange auto-scrolls on first render', () => {
  assert.equal(
    shouldAutoScrollOnContentChange({
      previousRowCount: undefined,
      nextRowCount: 5,
      wasAtBottom: false,
      lastOwnMessageId: undefined,
      previousLastOwnMessageId: undefined,
    }),
    true,
  );
});

test('shouldAutoScrollOnContentChange does not scroll when row count is unchanged', () => {
  assert.equal(
    shouldAutoScrollOnContentChange({
      previousRowCount: 5,
      nextRowCount: 5,
      wasAtBottom: true,
      lastOwnMessageId: undefined,
      previousLastOwnMessageId: undefined,
    }),
    false,
  );
});

test('shouldAutoScrollOnContentChange auto-scrolls when new rows land while at bottom', () => {
  assert.equal(
    shouldAutoScrollOnContentChange({
      previousRowCount: 5,
      nextRowCount: 6,
      wasAtBottom: true,
      lastOwnMessageId: undefined,
      previousLastOwnMessageId: undefined,
    }),
    true,
  );
});

test('shouldAutoScrollOnContentChange does NOT auto-scroll when new rows land while scrolled up (the core fix)', () => {
  assert.equal(
    shouldAutoScrollOnContentChange({
      previousRowCount: 5,
      nextRowCount: 6,
      wasAtBottom: false,
      lastOwnMessageId: undefined,
      previousLastOwnMessageId: undefined,
    }),
    false,
  );
});

test('shouldAutoScrollOnContentChange always scrolls when the user just sent their own message, even scrolled up', () => {
  assert.equal(
    shouldAutoScrollOnContentChange({
      previousRowCount: 5,
      nextRowCount: 6,
      wasAtBottom: false,
      lastOwnMessageId: 'msg-2',
      previousLastOwnMessageId: 'msg-1',
    }),
    true,
  );
});

test('shouldAutoScrollOnContentChange does not treat an unchanged lastOwnMessageId as a fresh send', () => {
  // Row count grew (e.g. simulated chatter arrived) but lastOwnMessageId is
  // the SAME as before -- this is not a new send, so scrolled-up should win.
  assert.equal(
    shouldAutoScrollOnContentChange({
      previousRowCount: 5,
      nextRowCount: 6,
      wasAtBottom: false,
      lastOwnMessageId: 'msg-1',
      previousLastOwnMessageId: 'msg-1',
    }),
    false,
  );
});

test('shouldAutoScrollOnContentChange treats the very first own message as fresh even with no previous id', () => {
  assert.equal(
    shouldAutoScrollOnContentChange({
      previousRowCount: 5,
      nextRowCount: 6,
      wasAtBottom: false,
      lastOwnMessageId: 'msg-1',
      previousLastOwnMessageId: undefined,
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// resolveNewMessagesPillVisible
// ---------------------------------------------------------------------------

test('resolveNewMessagesPillVisible is false at bottom', () => {
  assert.equal(
    resolveNewMessagesPillVisible({ previousRowCount: 5, nextRowCount: 6, isAtBottom: true }),
    false,
  );
});

test('resolveNewMessagesPillVisible is false on first render even if not at bottom', () => {
  assert.equal(
    resolveNewMessagesPillVisible({ previousRowCount: undefined, nextRowCount: 6, isAtBottom: false }),
    false,
  );
});

test('resolveNewMessagesPillVisible is false when scrolled up but no new rows landed', () => {
  assert.equal(
    resolveNewMessagesPillVisible({ previousRowCount: 5, nextRowCount: 5, isAtBottom: false }),
    false,
  );
});

test('resolveNewMessagesPillVisible is true when scrolled up and new rows landed', () => {
  assert.equal(
    resolveNewMessagesPillVisible({ previousRowCount: 5, nextRowCount: 7, isAtBottom: false }),
    true,
  );
});
