/**
 * Pure scroll decisions for the chat feed (demo-lockdown round 5, item 2):
 * "live chat" scrolling standard instead of the old unconditional
 * `onContentSizeChange -> scrollToEnd`, which yanked the list on ANY new row
 * (including simulated chatter) even while the user was reading scrolled up,
 * and made reaction sends visibly jump the feed.
 *
 * No React/RN here -- same split as match-chat-sheet-logic.ts -- so this is
 * testable with plain `node:test` (see tests/global-chat-scroll-logic.test.mjs).
 *
 * Behavior:
 * - The user is considered "at bottom" when within `AT_BOTTOM_THRESHOLD_PX`
 *   of the true end (see `isScrollAtBottom`).
 * - New content (any row count increase) auto-scrolls ONLY when the user was
 *   already at bottom before the new rows landed.
 * - The user's OWN sent message always scrolls to bottom, regardless of
 *   scroll position -- the caller detects this via a `lastOwnMessageId` that
 *   changed since the previous row set (see `shouldAutoScrollOnContentChange`).
 * - When scrolled up and new rows arrive without the user having sent one,
 *   a floating "New messages" pill should show; it hides once the user is
 *   back at bottom (see `resolveNewMessagesPillVisible`).
 */

export const AT_BOTTOM_THRESHOLD_PX = 40;

/** Minimal shape of RN's `NativeScrollEvent.contentOffset`/`contentSize`/`layoutMeasurement`, enough to derive "at bottom" without importing react-native. */
export interface ScrollMetrics {
  contentOffsetY: number;
  contentHeight: number;
  layoutHeight: number;
}

/**
 * Whether the given scroll position is at (or within `AT_BOTTOM_THRESHOLD_PX`
 * of) the true bottom of scrollable content.
 */
export function isScrollAtBottom(metrics: ScrollMetrics): boolean {
  const distanceFromBottom = metrics.contentHeight - metrics.layoutHeight - metrics.contentOffsetY;
  return distanceFromBottom <= AT_BOTTOM_THRESHOLD_PX;
}

export interface AutoScrollDecisionInput {
  /** Row count before the latest content change (undefined on first render -- never auto-scrolls). */
  previousRowCount: number | undefined;
  /** Row count after the latest content change. */
  nextRowCount: number;
  /** Whether the user was at bottom immediately before this content change landed. */
  wasAtBottom: boolean;
  /** The id of the most recently sent-by-the-user message, if any row change is due to one. */
  lastOwnMessageId: string | undefined;
  /** The `lastOwnMessageId` as of the previous content change, to detect a NEW own send (not a stale one still in scope). */
  previousLastOwnMessageId: string | undefined;
}

/**
 * Decides whether a content-size change (new row(s) landed) should trigger
 * an auto-scroll to the bottom. Three independent triggers, any one is
 * sufficient:
 * - first render (no previous row count) -- lands at the bottom initially,
 *   matching the old unconditional behavior for the very first paint;
 * - the user was already at bottom when the new content arrived;
 * - the user's own message just landed (a fresh `lastOwnMessageId`, distinct
 *   from the previous one), regardless of scroll position -- sending always
 *   snaps the sender back to their own message.
 *
 * No row-count change at all (`previousRowCount === nextRowCount`) never
 * triggers a scroll -- this function is only meaningful when content grew.
 */
export function shouldAutoScrollOnContentChange(input: AutoScrollDecisionInput): boolean {
  const {
    previousRowCount,
    nextRowCount,
    wasAtBottom,
    lastOwnMessageId,
    previousLastOwnMessageId,
  } = input;

  if (previousRowCount === undefined) return true;
  if (nextRowCount <= previousRowCount) return false;

  const ownMessageJustSent = lastOwnMessageId !== undefined && lastOwnMessageId !== previousLastOwnMessageId;
  if (ownMessageJustSent) return true;

  return wasAtBottom;
}

/**
 * Whether the floating "New messages" pill should show: new rows arrived
 * (row count grew) while the user was scrolled away from the bottom, and
 * they still aren't at the bottom now. Once the user scrolls back down (or
 * taps the pill, which itself scrolls to bottom), the caller re-derives this
 * as false since `isAtBottom` becomes true.
 */
export function resolveNewMessagesPillVisible(input: {
  previousRowCount: number | undefined;
  nextRowCount: number;
  isAtBottom: boolean;
}): boolean {
  const { previousRowCount, nextRowCount, isAtBottom } = input;
  if (isAtBottom) return false;
  if (previousRowCount === undefined) return false;
  return nextRowCount > previousRowCount;
}
