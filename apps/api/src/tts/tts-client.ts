/**
 * xAI text-to-speech client for the offline commentary voicing pipeline (see
 * docs/qa/commentary-tts-backend-test-cases.md). The orchestrator
 * (`generate-commentary-audio.ts`) is always driven against an injected
 * `TtsClient` in tests -- this module is the only place that ever performs a
 * real HTTP call, and it is never imported by the automated test suite.
 *
 * Verified live contract (2026-07-18): `POST {baseUrl}/tts` with body
 * `{ text, voice_id, speed, output_format: { codec, sample_rate, bit_rate },
 * language }`. There is no `model` field and no `response_format` string --
 * an OpenAI-shaped `/audio/speech` request 403s with "Team is not
 * authorized" against xAI. See `apps/api/src/tts-smoke.ts` for the one-line
 * live check that guards this contract.
 */

export interface TtsRequest {
  text: string;
  voiceId: string;
  speed: number;
}

export interface TtsResult {
  audio: Uint8Array;
  codec: string;
  sampleRate: number;
  bitRate: number;
}

export interface TtsClient {
  synthesize(request: TtsRequest): Promise<TtsResult>;
}

/** Thrown by `TtsClient.synthesize` on a non-2xx response; carries the HTTP status for retry classification. */
export class TtsRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TtsRequestError';
    this.status = status;
  }
}

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_CODEC = 'mp3';
const DEFAULT_SAMPLE_RATE = 44_100;
const DEFAULT_BIT_RATE = 128_000;

export interface CreateXaiTtsClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export function createXaiTtsClient(options: CreateXaiTtsClientOptions): TtsClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  return {
    async synthesize(request: TtsRequest): Promise<TtsResult> {
      const response = await fetch(`${baseUrl}/tts`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          text: request.text,
          voice_id: request.voiceId,
          speed: request.speed,
          output_format: {
            codec: DEFAULT_CODEC,
            sample_rate: DEFAULT_SAMPLE_RATE,
            bit_rate: DEFAULT_BIT_RATE,
          },
          language: 'en',
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new TtsRequestError(
          response.status,
          `xAI TTS request failed with status ${response.status}${body ? `: ${body}` : ''}.`,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      return {
        audio: new Uint8Array(arrayBuffer),
        codec: DEFAULT_CODEC,
        sampleRate: DEFAULT_SAMPLE_RATE,
        bitRate: DEFAULT_BIT_RATE,
      };
    },
  };
}
