import { pathToFileURL } from 'node:url';
import type { MatchPulseCommentaryEntry, MatchPulseEventClock } from '@gamecrew/core';
import { loadConfig, type ApiConfig } from './config.js';
import { SqliteCommentaryAudioStore } from './tts/commentary-audio-store.js';
import { createXaiTtsClient, type TtsClient } from './tts/tts-client.js';
import { generateCommentaryAudio, type CommentaryAudioSummary } from './tts/generate-commentary-audio.js';
import { SqliteMatchPulseCommentaryStore } from './match-pulse-commentary-store.js';

/**
 * CLI entry point for the offline commentary-to-speech pipeline (see
 * docs/qa/commentary-tts-backend-test-cases.md, "CLI"). Usage:
 *
 *   pnpm --filter @gamecrew/api tts:generate -- --fixture=<id> --voice=<voiceId> [--speed=<n>] [--until-minute=<n>] [--no-decorate]
 *
 * `--speed` is a locked product decision (atlas voices at 1.1x); it defaults
 * to 1.0 and must fall within xAI's documented 0.7-1.5 range. Changing the
 * speed for a fixture regenerates every entry, since speed is part of the
 * store's identity check alongside text and voice.
 *
 * `--until-minute` restricts the batch to entries at or before that match
 * minute (a pilot-run cost guard: voice the first N minutes before paying
 * for a full match). Entries with no derivable clock minute are included
 * when the flag is absent and excluded when it is set.
 *
 * `--no-decorate` disables the deterministic speech-tag decoration
 * (`[breath]`, `[pause]`, `<emphasis>`, `<soft>`) applied by default -- see
 * `tts/decorate-commentary-text.ts`. Toggling decoration changes the voiced
 * text for affected lines, so it regenerates only those lines on the next
 * run.
 *
 * `main()` never runs when this module is only imported (e.g. by tests) --
 * see the `pathToFileURL` guard at the bottom, matching
 * `materialize-match-pulse.ts`.
 */

export interface CommentaryTtsCliArgs {
  fixtureId: string;
  voiceId: string;
  speed: number;
  decorate: boolean;
  untilMinute?: number;
}

const USAGE = 'Usage: tts:generate -- --fixture=<fixtureId> --voice=<voiceId> '
  + '[--speed=<n>] [--until-minute=<n>] [--no-decorate]';
const DEFAULT_SPEED = 1.0;
const MIN_SPEED = 0.7;
const MAX_SPEED = 1.5;

export function parseArgs(argv: readonly string[]): CommentaryTtsCliArgs {
  const fixtureId = argv.find((value) => value.startsWith('--fixture='))?.slice('--fixture='.length);
  const voiceId = argv.find((value) => value.startsWith('--voice='))?.slice('--voice='.length);
  const speedRaw = argv.find((value) => value.startsWith('--speed='))?.slice('--speed='.length);
  const untilMinuteRaw = argv.find((value) => value.startsWith('--until-minute='))?.slice('--until-minute='.length);
  const noDecorate = argv.includes('--no-decorate');

  const missing = [
    ...(fixtureId ? [] : ['--fixture']),
    ...(voiceId ? [] : ['--voice']),
  ];
  if (missing.length > 0) {
    throw new Error(`Missing required argument(s): ${missing.join(', ')}. ${USAGE}`);
  }

  let speed = DEFAULT_SPEED;
  if (speedRaw !== undefined) {
    const parsed = Number(speedRaw);
    if (!Number.isFinite(parsed) || parsed < MIN_SPEED || parsed > MAX_SPEED) {
      throw new Error(
        `--speed must be a number between ${MIN_SPEED} and ${MAX_SPEED} inclusive, got "${speedRaw}". ${USAGE}`,
      );
    }
    speed = parsed;
  }

  let untilMinute: number | undefined;
  if (untilMinuteRaw !== undefined) {
    const parsed = Number(untilMinuteRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--until-minute must be a positive integer, got "${untilMinuteRaw}". ${USAGE}`);
    }
    untilMinute = parsed;
  }

  return {
    fixtureId: fixtureId!,
    voiceId: voiceId!,
    speed,
    decorate: !noDecorate,
    ...(untilMinute === undefined ? {} : { untilMinute }),
  };
}

/** Prefers the clock's numeric `minute`, falling back to `floor(seconds / 60)`, then parsing a leading number from `label`. */
export function deriveClockMinute(clock: MatchPulseEventClock | undefined): number | undefined {
  if (!clock) return undefined;
  if (typeof clock.minute === 'number' && Number.isFinite(clock.minute)) return clock.minute;
  if (typeof clock.seconds === 'number' && Number.isFinite(clock.seconds)) return Math.floor(clock.seconds / 60);
  const match = clock.label?.match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

export function filterEntriesUntilMinute(
  entries: readonly MatchPulseCommentaryEntry[],
  untilMinute: number | undefined,
): readonly MatchPulseCommentaryEntry[] {
  if (untilMinute === undefined) return entries;
  return entries.filter((entry) => {
    const minute = deriveClockMinute(entry.clock);
    return minute !== undefined && minute <= untilMinute;
  });
}

export interface CommentaryTtsCliDependencies {
  commentaryStore: Pick<SqliteMatchPulseCommentaryStore, 'listEntries'>;
  audioStore: Pick<SqliteCommentaryAudioStore, 'getAudio' | 'hasCurrentAudio' | 'upsertAudio' | 'close'>;
  client: TtsClient;
}

export interface RunCommentaryTtsCliResult {
  exitCode: number;
  summary?: CommentaryAudioSummary;
  entryCount: number;
  message?: string;
}

export async function runCommentaryTtsCli(
  args: CommentaryTtsCliArgs,
  deps: CommentaryTtsCliDependencies,
): Promise<RunCommentaryTtsCliResult> {
  const allEntries: readonly MatchPulseCommentaryEntry[] = await deps.commentaryStore.listEntries(args.fixtureId);
  const entries = filterEntriesUntilMinute(allEntries, args.untilMinute);

  if (entries.length === 0) {
    return {
      exitCode: 1,
      entryCount: 0,
      message: allEntries.length === 0
        ? `No commentary entries found for fixture ${args.fixtureId}; nothing to voice.`
        : `No commentary entries at or before minute ${args.untilMinute} for fixture ${args.fixtureId}; nothing to voice.`,
    };
  }

  const summary = await generateCommentaryAudio({
    store: deps.audioStore,
    client: deps.client,
    entries,
    voiceId: args.voiceId,
    speed: args.speed,
    decorate: args.decorate,
  });

  return { exitCode: 0, summary, entryCount: entries.length };
}

function createDependencies(config: ApiConfig): CommentaryTtsCliDependencies {
  if (!config.xaiApiKey) {
    throw new Error('XAI_API_KEY is missing. Add it to .env.local before running tts:generate.');
  }

  return {
    commentaryStore: new SqliteMatchPulseCommentaryStore(config.matchPulseSqlitePath),
    audioStore: new SqliteCommentaryAudioStore(config.commentaryAudioSqlitePath),
    client: createXaiTtsClient({ apiKey: config.xaiApiKey, baseUrl: config.xaiTtsBaseUrl }),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const deps = createDependencies(config);

  try {
    const result = await runCommentaryTtsCli(args, deps);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.exitCode;
  } finally {
    deps.audioStore.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
