import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createXaiTtsClient } from './tts/tts-client.js';
import { loadConfig } from './config.js';

/**
 * ONE real live-API verification of the xAI TTS contract: voice a single
 * short fixed line via `createXaiTtsClient` and assert the response is
 * non-empty audio that actually starts with mp3 frame bytes. This is
 * intentionally NOT part of the automated test suite -- `pnpm test` never
 * makes network calls; this script is the one exception, run by hand,
 * specifically so a wrong request contract (e.g. the OpenAI-shaped
 * `/audio/speech` request that 403'd with "Team is not authorized" against
 * xAI) can never silently ship again.
 *
 * Usage: pnpm --filter @gamecrew/api tts:smoke
 */

const SMOKE_TEXT = 'Goal! What a strike from the edge of the box.';
const SMOKE_VOICE_ID = 'atlas';
const SMOKE_SPEED = 1.1;
const OUTPUT_PATH = resolve(process.cwd(), '.data/tts-samples/smoke.mp3');

async function main() {
  const config = loadConfig();
  if (!config.xaiApiKey) {
    throw new Error('XAI_API_KEY is missing. Add it to .env.local before running tts:smoke.');
  }

  const client = createXaiTtsClient({ apiKey: config.xaiApiKey, baseUrl: config.xaiTtsBaseUrl });

  console.log(JSON.stringify({
    event: 'tts_smoke_request',
    voiceId: SMOKE_VOICE_ID,
    speed: SMOKE_SPEED,
    text: SMOKE_TEXT,
  }));

  const result = await client.synthesize({ text: SMOKE_TEXT, voiceId: SMOKE_VOICE_ID, speed: SMOKE_SPEED });

  if (result.audio.length === 0) {
    throw new Error('xAI TTS returned an empty audio payload.');
  }
  if (!looksLikeMp3(result.audio)) {
    throw new Error(
      `xAI TTS response does not start with recognizable mp3 bytes (first bytes: `
      + `${Array.from(result.audio.slice(0, 4)).map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}).`,
    );
  }

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, result.audio);

  console.log(JSON.stringify({
    event: 'tts_smoke_succeeded',
    byteLength: result.audio.length,
    codec: result.codec,
    sampleRate: result.sampleRate,
    bitRate: result.bitRate,
    outputPath: OUTPUT_PATH,
  }));
}

/** True when the buffer starts with an mp3 frame sync (0xFF 0xFB/0xF3/0xF2) or an ID3 tag. */
function looksLikeMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 3) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // 'ID3'
  if (bytes[0] === 0xff) {
    const second = bytes[1];
    return second === 0xfb || second === 0xf3 || second === 0xf2;
  }
  return false;
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'tts_smoke_failed', reason: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
