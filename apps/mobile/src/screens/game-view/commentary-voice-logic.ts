import type { MatchPulseCommentaryEntryKind } from '@gamecrew/core';

/**
 * Pure decision layer for the commentary voice player (no React/audio
 * imports -- see use-commentary-voice.ts for the adapter that consumes
 * this). Mirrors the separation already used for sound
 * (game-view-sound-logic.ts / use-game-view-soundscape.ts): the plan is
 * computed here, side effects live in the hook.
 */

/** Big moments that must never wait behind whatever is currently speaking. */
const INTERRUPT_KINDS: ReadonlySet<MatchPulseCommentaryEntryKind> = new Set([
  'goal',
  'penalty',
  'card',
  'var',
]);

export interface CommentaryVoiceClip {
  entryId: string;
  kind: MatchPulseCommentaryEntryKind;
}

export type CommentaryVoiceQueueDecision = 'play' | 'interrupt' | 'drop';

/**
 * Decides what happens when a new commentary entry fires while `current`
 * (the clip presently speaking, if any) is playing. Never queues a backlog:
 * a routine line that arrives while the player is busy is dropped outright
 * rather than held for later, so stale commentary can't pile up behind the
 * live moment. Big moments (goal/penalty/card/var -- an unrecognized kind is
 * treated as routine, not as a big moment) always interrupt whatever is
 * currently speaking, including another big moment.
 */
export function decideCommentaryVoiceQueueAction(
  current: CommentaryVoiceClip | undefined,
  incoming: CommentaryVoiceClip,
): CommentaryVoiceQueueDecision {
  if (!current) return 'play';
  if (current.entryId === incoming.entryId) return 'drop';
  return isBigMomentKind(incoming.kind) ? 'interrupt' : 'drop';
}

export function isBigMomentKind(kind: MatchPulseCommentaryEntryKind): boolean {
  return INTERRUPT_KINDS.has(kind);
}

/** Number of upcoming clips to keep warm ahead of the current position. */
export const COMMENTARY_VOICE_PREFETCH_WINDOW = 3;

/**
 * Given the ordered list of entry ids that have voiced audio and the id
 * most recently fired (undefined before anything has fired), returns the
 * next few ids -- in order -- worth prefetching. Handles the start of the
 * list (currentEntryId undefined or not found: warm from the front), the
 * end of the list (fewer than the window remaining: returns however many
 * are left), and an unknown id (treated the same as "not found").
 */
export function resolveCommentaryVoicePrefetchWindow(
  orderedEntryIdsWithAudio: readonly string[],
  currentEntryId: string | undefined,
  windowSize: number = COMMENTARY_VOICE_PREFETCH_WINDOW,
): readonly string[] {
  if (orderedEntryIdsWithAudio.length === 0 || windowSize <= 0) return [];

  const currentIndex = currentEntryId === undefined
    ? -1
    : orderedEntryIdsWithAudio.indexOf(currentEntryId);
  const startIndex = currentIndex + 1;
  return orderedEntryIdsWithAudio.slice(startIndex, startIndex + windowSize);
}
