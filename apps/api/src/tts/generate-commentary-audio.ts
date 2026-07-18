import { createHash } from 'node:crypto';
import type { MatchPulseCommentaryEntry } from '@gamecrew/core';
import { TtsRequestError, type TtsClient } from './tts-client.js';
import type { SqliteCommentaryAudioStore } from './commentary-audio-store.js';
import { decorateCommentaryTimeline } from './decorate-commentary-text.js';

/**
 * Orchestrates commentary -> speech generation for a batch of
 * `MatchPulseCommentaryEntry` values (see
 * docs/qa/commentary-tts-backend-test-cases.md, "TEXT" / "GEN" / "RETRY" /
 * "CONC"). Idempotent: an entry is only sent to the `TtsClient` when its
 * voiced text or the target voice changed since the last run
 * (`store.hasCurrentAudio`), so re-running against an unchanged fixture
 * makes zero API calls.
 */

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 500;

export type CommentaryAudioOutcome = 'generated' | 'regenerated' | 'skipped' | 'emptySkipped' | 'failed';

export interface CommentaryAudioProgressEvent {
  entryId: string;
  outcome: CommentaryAudioOutcome;
}

export interface CommentaryAudioFailure {
  entryId: string;
  message: string;
}

export interface CommentaryAudioSummary {
  generated: number;
  regenerated: number;
  skipped: number;
  emptySkipped: number;
  failed: CommentaryAudioFailure[];
}

export interface GenerateCommentaryAudioOptions {
  store: Pick<SqliteCommentaryAudioStore, 'getAudio' | 'hasCurrentAudio' | 'upsertAudio'>;
  client: TtsClient;
  entries: readonly MatchPulseCommentaryEntry[];
  voiceId: string;
  /** Playback speed multiplier passed straight through to the TTS request; a speed change regenerates every entry. */
  speed: number;
  /**
   * Applies deterministic speech-tag decoration (`[breath]`, `[pause]`,
   * `<emphasis>`, `<soft>`) to the voiced text before hashing and
   * synthesizing, so changing this flag (or the decoration rules) is itself
   * a text change that regenerates only the affected lines. Defaults to
   * true; set false to voice the raw selected text exactly as before
   * decoration was introduced.
   */
  decorate?: boolean;
  concurrency?: number;
  maxAttempts?: number;
  /** Injectable for tests -- the fake resolves immediately instead of really waiting. */
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (event: CommentaryAudioProgressEvent) => void;
}

/** `entry.voiceLine` if present and non-empty after trim, else `entry.commentary`, trimmed. Empty when both are blank. */
export function selectVoicedText(entry: Pick<MatchPulseCommentaryEntry, 'voiceLine' | 'commentary'>): string {
  const voiceLine = entry.voiceLine?.trim();
  if (voiceLine) return voiceLine;
  return (entry.commentary ?? '').trim();
}

export function hashVoicedText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function generateCommentaryAudio(
  options: GenerateCommentaryAudioOptions,
): Promise<CommentaryAudioSummary> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep = options.sleep ?? defaultSleep;

  const summary: CommentaryAudioSummary = {
    generated: 0,
    regenerated: 0,
    skipped: 0,
    emptySkipped: 0,
    failed: [],
  };

  let cursor = 0;
  const entries = options.entries;
  const decorate = options.decorate ?? true;
  // Decoration is computed once over the whole ordered timeline (the
  // post-goal "soft" window depends on replay-order position across
  // entries), then looked up per entry inside the worker pool below.
  const decoratedByEntryId = decorate ? decorateCommentaryTimeline(entries) : undefined;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) return;
      await processEntry(entries[index]!);
    }
  }

  async function processEntry(entry: MatchPulseCommentaryEntry): Promise<void> {
    const voicedText = decoratedByEntryId?.get(entry.id) ?? selectVoicedText(entry);
    if (!voicedText) {
      summary.emptySkipped += 1;
      options.onProgress?.({ entryId: entry.id, outcome: 'emptySkipped' });
      return;
    }

    const textHash = hashVoicedText(voicedText);
    const alreadyExisted = Boolean(options.store.getAudio(entry.id));
    if (options.store.hasCurrentAudio(entry.id, textHash, options.voiceId, options.speed)) {
      summary.skipped += 1;
      options.onProgress?.({ entryId: entry.id, outcome: 'skipped' });
      return;
    }

    try {
      const result = await synthesizeWithRetry(
        options.client,
        { text: voicedText, voiceId: options.voiceId, speed: options.speed },
        maxAttempts,
        sleep,
      );
      options.store.upsertAudio({
        entryId: entry.id,
        fixtureId: entry.fixtureId,
        voiceId: options.voiceId,
        speed: options.speed,
        textHash,
        sourceText: voicedText,
        codec: result.codec,
        sampleRate: result.sampleRate,
        bitRate: result.bitRate,
        byteLength: result.audio.length,
        audio: result.audio,
      });
      const outcome: CommentaryAudioOutcome = alreadyExisted ? 'regenerated' : 'generated';
      summary[outcome] += 1;
      options.onProgress?.({ entryId: entry.id, outcome });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.failed.push({ entryId: entry.id, message });
      options.onProgress?.({ entryId: entry.id, outcome: 'failed' });
    }
  }

  const workerCount = Math.min(concurrency, Math.max(entries.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return summary;
}

async function synthesizeWithRetry(
  client: TtsClient,
  request: { text: string; voiceId: string; speed: number },
  maxAttempts: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ audio: Uint8Array; codec: string; sampleRate: number; bitRate: number }> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await client.synthesize(request);
    } catch (error) {
      if (!isRetryable(error) || attempt >= maxAttempts) throw error;
      await sleep(backoffDelayMs(attempt));
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof TtsRequestError)) return false;
  return error.status === 429 || (error.status >= 500 && error.status < 600);
}

function backoffDelayMs(attempt: number): number {
  return DEFAULT_BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
