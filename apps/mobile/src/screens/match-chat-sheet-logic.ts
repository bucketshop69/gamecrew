import type { EconomyBetPrompt, EconomyItemId, MatchEngineParticipant } from '@gamecrew/core';

/**
 * Pure presentation/decision logic for the chat sheet + challenge drop-in
 * (demo-lockdown items 4/9/10/11). Nothing in this file touches React,
 * Reanimated, or any RN API, so it is testable with plain `node:test`
 * assertions (see tests/match-chat-sheet-logic.test.mjs) -- mirrors the
 * existing split between game-view-takeover-logic.ts and its renderers.
 */

// ---------------------------------------------------------------------------
// Drop-in queueing (item 10)
// ---------------------------------------------------------------------------
//
// Round 5/item 1: the ChallengeDropIn card itself was removed from the UI --
// gamecrew-screens.tsx no longer renders it, and no longer owns any queue
// state, timers, or reconcile effect for it (challenges now surface ONLY in
// the chat sheet's pinned strip + feed cards, per the owner's correction).
// The pure queue logic below (and its tests in
// tests/match-chat-sheet-logic.test.mjs) is kept intentionally -- it is
// currently UNUSED by any UI, retained only so the diff stays reversible and
// the decision table it encodes isn't lost. Do not delete these exports or
// their tests; do not wire them back into gamecrew-screens.tsx without an
// explicit product decision to bring the drop-in card back.

export interface DropInQueueState {
  /** The prompt currently shown as a drop-in card, or undefined when nothing is showing. */
  visible: EconomyBetPrompt | undefined;
  /** Prompts that arrived while something else was already showing, oldest first. */
  queued: readonly EconomyBetPrompt[];
}

export const EMPTY_DROP_IN_QUEUE_STATE: DropInQueueState = { visible: undefined, queued: [] };

/**
 * Decides what happens when the set of currently-open prompts changes.
 * `previousPromptIds` is the set of prompt ids the caller already knew about
 * (from the last time this was called) -- any id in `openPrompts` not in that
 * set is treated as newly arrived.
 *
 * Behavior (item 10):
 * - Sheet open: never show a drop-in (the sheet already surfaces prompts via
 *   the pinned strip/feed) -- new prompts are dropped from consideration
 *   entirely rather than queued, so they don't pop the moment the sheet
 *   closes with no other trigger.
 * - Sheet closed, nothing currently visible: the first newly-arrived prompt
 *   (in `openPrompts` order) becomes visible immediately.
 * - Sheet closed, something already visible: newly-arrived prompts are
 *   appended to the queue (oldest first) rather than interrupting the
 *   current card.
 * - A previously-visible or previously-queued prompt that is no longer in
 *   `openPrompts` (taken/expired/settled) is dropped from both `visible` and
 *   `queued` -- see `advanceDropInQueue` for the "currently visible card was
 *   answered/timed out" transition, this function instead handles it
 *   disappearing out from under the queue via an external state change.
 */
export function reconcileDropInQueue(
  state: DropInQueueState,
  openPrompts: readonly EconomyBetPrompt[],
  previousPromptIds: ReadonlySet<string>,
  sheetOpen: boolean,
): DropInQueueState {
  const openIds = new Set(openPrompts.map((prompt) => prompt.id));

  // Drop anything (visible or queued) that's no longer open.
  const stillVisible = state.visible && openIds.has(state.visible.id) ? state.visible : undefined;
  const stillQueued = state.queued.filter((prompt) => openIds.has(prompt.id));

  if (sheetOpen) {
    // Sheet is open: suppress entirely. Clear both visible and queued so a
    // stale drop-in doesn't reappear the instant the sheet closes with no
    // new prompt having arrived.
    return EMPTY_DROP_IN_QUEUE_STATE;
  }

  const newlyArrived = openPrompts.filter((prompt) => !previousPromptIds.has(prompt.id));

  if (!stillVisible) {
    const [next, ...rest] = [...stillQueued, ...newlyArrived];
    return { visible: next, queued: rest };
  }

  return { visible: stillVisible, queued: [...stillQueued, ...newlyArrived] };
}

/**
 * Advances the queue after the currently-visible drop-in is answered or times
 * out: the next queued prompt (if any) becomes visible.
 */
export function advanceDropInQueue(state: DropInQueueState): DropInQueueState {
  const [next, ...rest] = state.queued;
  return { visible: next, queued: rest };
}

// ---------------------------------------------------------------------------
// Unread-dot derivation (item 4)
// ---------------------------------------------------------------------------

/**
 * A minimal shape covering just the row kinds that should count toward the
 * floating chat button's unread-ish dot: new prompts and gift reveals (per
 * spec item 4: "unread-ish dot when new prompt/gift rows arrived since last
 * open"). Other row kinds (chatter, social proof, settlement lines, etc.)
 * never trigger the dot.
 */
export interface UnreadSignalRow {
  id: string;
  kind: string;
}

const UNREAD_SIGNAL_KINDS = new Set(['prompt', 'gift_reveal']);

/**
 * Derives whether the floating chat button's dot should show: true when at
 * least one row of an unread-signal kind exists in `rows` with an id not
 * present in `seenRowIds`. Pure set-difference -- the caller owns when
 * `seenRowIds` gets updated (on sheet open, per spec: "simple module/component
 * state -- no persistence needed").
 */
export function hasUnreadSignal(
  rows: readonly UnreadSignalRow[],
  seenRowIds: ReadonlySet<string>,
): boolean {
  return rows.some((row) => UNREAD_SIGNAL_KINDS.has(row.kind) && !seenRowIds.has(row.id));
}

/**
 * Round 5/item 1: with the challenge drop-in card removed, the floating chat
 * button is the one remaining out-of-sheet signal for a new challenge, so it
 * upgrades from a bare dot to a small count badge -- the number of OPEN
 * challenges (`kind === 'prompt'`, `state === 'open'`) not yet seen (as of
 * the last sheet open), per the same `seenRowIds` convention `hasUnreadSignal`
 * already uses. A `'gift_reveal'` row still counts toward `hasUnreadSignal`'s
 * plain dot-would-have-shown semantics elsewhere, but does not inflate this
 * specifically-challenges count -- the badge's number should mean "this many
 * calls are waiting for you," not "this many things happened."
 */
export function countUnseenOpenChallenges(
  rows: readonly PinnedStripSourceRow[],
  seenRowIds: ReadonlySet<string>,
): number {
  return rows.filter((row) => row.kind === 'prompt' && row.state === 'open' && !seenRowIds.has(row.id)).length;
}

// ---------------------------------------------------------------------------
// Pinned-strip filtering (item 11)
// ---------------------------------------------------------------------------

export type PinnedChallengeStatus = 'open' | 'taken';

export interface PinnedChallengeChip {
  promptId: string;
  /** Short-form question text for the chip (already truncated/derived by the caller's copy). */
  shortCopy: string;
  status: PinnedChallengeStatus;
  /** Set when status === 'taken': the item staked. */
  takenItemId?: EconomyItemId;
  /** Set when status === 'taken' and the call was a team pick: which team. */
  takenParticipant?: MatchEngineParticipant;
}

/** Minimal shape of a `prompt`-kind GlobalChatRow, matching global-chat-logic.ts's row union just for the fields this module needs. */
export interface PinnedStripSourceRow {
  id: string;
  kind: string;
  promptId?: string;
  copy?: string;
  state?: 'open' | 'taken' | 'closed';
  takenItemId?: EconomyItemId;
  takenParticipant?: MatchEngineParticipant;
}

/**
 * Builds the pinned challenges strip's chip list from the same `prompt`-kind
 * rows the feed already renders (buildGlobalChatStreamRows's output) --
 * reusing that derivation rather than re-deriving from raw events, so the
 * strip and the feed can never disagree about a prompt's state.
 *
 * Per spec item 11: resolved/expired challenges drop off the strip entirely
 * (a `'closed'` row state, or any row that isn't `'open'`/`'taken'`, is
 * excluded). Order is preserved from the input (feed order, oldest first).
 */
export function buildPinnedChallengeStrip(
  rows: readonly PinnedStripSourceRow[],
): readonly PinnedChallengeChip[] {
  const chips: PinnedChallengeChip[] = [];
  for (const row of rows) {
    if (row.kind !== 'prompt' || !row.promptId) continue;
    if (row.state !== 'open' && row.state !== 'taken') continue;
    chips.push({
      promptId: row.promptId,
      shortCopy: shortenChallengeCopy(row.copy ?? ''),
      status: row.state,
      takenItemId: row.takenItemId,
      takenParticipant: row.takenParticipant,
    });
  }
  return chips;
}

const SHORT_COPY_MAX_LENGTH = 40;

/**
 * Item 11 (fix round): the engine's prompt copy leads with a "Make your
 * call: " prefix (see global-chat-logic.ts's `applyEventToRows` doc
 * comment) -- fine as full prose on the prompt card itself, but redundant
 * on a pinned chip where the question alone is already self-evidently a
 * call to action. Case-insensitive, tolerant of the colon being followed by
 * no space, so a differently-cased or -spaced source string still strips
 * cleanly.
 */
const CALL_PREFIX_PATTERN = /^make your call:\s*/i;

/** Truncates a prompt's full copy to a chip-friendly short form -- word-boundary aware, ellipsis appended only when truncated. Drops the "Make your call:" prefix first (item 11) so the question itself is the label. */
export function shortenChallengeCopy(copy: string): string {
  const withoutPrefix = copy.trim().replace(CALL_PREFIX_PATTERN, '');
  const trimmed = withoutPrefix.trim();
  if (trimmed.length <= SHORT_COPY_MAX_LENGTH) return trimmed;
  const slice = trimmed.slice(0, SHORT_COPY_MAX_LENGTH);
  const lastSpace = slice.lastIndexOf(' ');
  const base = lastSpace > 12 ? slice.slice(0, lastSpace) : slice;
  return `${base.trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Reaction-chip send payloads (item 9)
// ---------------------------------------------------------------------------

export interface ReactionChip {
  id: string;
  label: string;
}

/** Predefined reaction phrases (item 9) -- one tap sends the label text verbatim through the same `sendMessage` path the old free-text composer used. */
export const REACTION_PHRASE_CHIPS: readonly ReactionChip[] = [
  { id: 'goal', label: 'What a goal!' },
  { id: 'var', label: 'VAR again?!' },
  { id: 'cook', label: 'Cook them!' },
  { id: 'no-way', label: 'No way!' },
  { id: 'scenes', label: 'Scenes!' },
];

/** Predefined emoji reactions (item 9). */
export const REACTION_EMOJI_CHIPS: readonly ReactionChip[] = [
  { id: 'fire', label: '🔥' },
  { id: 'ball', label: '⚽' },
  { id: 'shock', label: '😱' },
  { id: 'mind-blown', label: '🤯' },
  { id: 'clap', label: '👏' },
  { id: 'skull', label: '💀' },
];

export const REACTION_CHIPS: readonly ReactionChip[] = [...REACTION_PHRASE_CHIPS, ...REACTION_EMOJI_CHIPS];

/** Builds the exact text payload sent through `sendMessage` for a given chip id. Returns undefined for an unknown id (defensive -- every real caller sources the id from REACTION_CHIPS itself). */
export function buildReactionSendPayload(chipId: string): string | undefined {
  return REACTION_CHIPS.find((chip) => chip.id === chipId)?.label;
}
