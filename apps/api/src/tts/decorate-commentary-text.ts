import type { MatchPulseCommentaryEntry } from '@gamecrew/core';
import { selectVoicedText } from './generate-commentary-audio.js';

/**
 * Programmatic speech-tag decoration for the commentary TTS pipeline
 * (ear-test approved). xAI TTS supports inline tags (`[breath]`, `[pause]`)
 * and wrapping tags (`<emphasis>text</emphasis>`, `<soft>text</soft>`)
 * inside the `text` field of a synthesize request. This module decides,
 * deterministically and per-fixture-replay-order, which lines get which
 * tags -- it never calls the TTS client itself.
 *
 * Rules (see coordinator spec):
 *  - 'goal': prefix "[breath] " and wrap the LAST sentence in <emphasis>.
 *  - the two entries immediately after a goal (replay order): wrap the
 *    whole line in <soft>...</soft> (commentator winding down). A goal that
 *    itself falls inside that window still gets the goal treatment --
 *    the goal rule always wins over the soft-window rule.
 *  - 'var': prefix "[pause] " (suspense).
 *  - 'card': prefix "[pause] ".
 *  - 'phase_change': wrap the whole line in <soft>...</soft>.
 *  - everything else: unchanged.
 *  - Guard: a voiced text that already contains '<' or '[' is returned
 *    unchanged -- decoration is never applied twice.
 */

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;

export function decorateCommentaryTimeline(
  entries: readonly MatchPulseCommentaryEntry[],
): Map<string, string> {
  const decorated = new Map<string, string>();

  // Counts down the remaining entries of the "next two after a goal" soft
  // window as we walk replay order forward. Reset to 2 whenever a goal is
  // seen (even mid-window, so back-to-back goals each start a fresh
  // window); decremented once per entry that consumes a window slot.
  let postGoalWindowRemaining = 0;

  for (const entry of entries) {
    const voicedText = selectVoicedText(entry);
    const isGoal = entry.kind === 'goal';
    const inPostGoalWindow = !isGoal && postGoalWindowRemaining > 0;

    let text = voicedText;
    if (voicedText && !alreadyTagged(voicedText)) {
      if (isGoal) {
        text = decorateGoal(voicedText);
      } else if (inPostGoalWindow) {
        text = wrapSoft(voicedText);
      } else if (entry.kind === 'var' || entry.kind === 'card') {
        text = `[pause] ${voicedText}`;
      } else if (entry.kind === 'phase_change') {
        text = wrapSoft(voicedText);
      }
    }

    decorated.set(entry.id, text);

    if (isGoal) {
      postGoalWindowRemaining = 2;
    } else if (postGoalWindowRemaining > 0) {
      postGoalWindowRemaining -= 1;
    }
  }

  return decorated;
}

function alreadyTagged(text: string): boolean {
  return text.includes('<') || text.includes('[');
}

function decorateGoal(text: string): string {
  const { head, lastSentence } = splitLastSentence(text);
  return `[breath] ${head}${head ? ' ' : ''}<emphasis>${lastSentence}</emphasis>`;
}

function wrapSoft(text: string): string {
  return `<soft>${text}</soft>`;
}

/**
 * Splits `text` into everything before the final sentence (`head`) and the
 * final sentence itself (`lastSentence`), where a sentence boundary is
 * terminal punctuation (`. ! ?`) followed by whitespace, delimiter kept on
 * the sentence it ends. A single-sentence line returns an empty `head` so
 * the whole line ends up wrapped.
 */
function splitLastSentence(text: string): { head: string; lastSentence: string } {
  const sentences = text.split(SENTENCE_SPLIT_RE).filter((part) => part.length > 0);
  if (sentences.length <= 1) {
    return { head: '', lastSentence: text };
  }
  const lastSentence = sentences[sentences.length - 1]!;
  const head = sentences.slice(0, -1).join(' ');
  return { head, lastSentence };
}
