import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { CommentaryAudioManifestEntry, CommentaryAudioRecord } from './commentary-audio-store.js';

/**
 * HTTP routes for serving generated commentary audio (see
 * docs/qa/commentary-tts-backend-test-cases.md, "ROUTE"). Mounted under
 * `/matches/:fixtureId/pulse/commentary/audio` by `app.ts`.
 */

const AUDIO_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export interface CommentaryAudioRoutesStore {
  listManifest(fixtureId: string): readonly CommentaryAudioManifestEntry[] | Promise<readonly CommentaryAudioManifestEntry[]>;
  getAudio(entryId: string): CommentaryAudioRecord | undefined | Promise<CommentaryAudioRecord | undefined>;
}

export function createCommentaryAudioRoutes(store: CommentaryAudioRoutesStore): Hono {
  const routes = new Hono();

  routes.get('/matches/:fixtureId/pulse/commentary/audio', async (context) => {
    const fixtureId = context.req.param('fixtureId');
    const manifest = await store.listManifest(fixtureId);
    return context.json({
      fixtureId,
      entries: manifest.map((entry) => ({
        entryId: entry.entryId,
        voiceId: entry.voiceId,
        speed: entry.speed,
        textHash: entry.textHash,
        byteLength: entry.byteLength,
      })),
    });
  });

  routes.get('/matches/:fixtureId/pulse/commentary/audio/:entryId', async (context) => {
    const fixtureId = context.req.param('fixtureId');
    const entryId = context.req.param('entryId');
    const record = await store.getAudio(entryId);
    if (!record || record.fixtureId !== fixtureId) {
      return context.json({ error: 'Commentary audio not found.' }, 404);
    }

    const etag = audioEtag(record);
    context.header('Content-Type', 'audio/mpeg');
    context.header('Cache-Control', AUDIO_CACHE_CONTROL);
    context.header('ETag', etag);
    return context.body(toArrayBuffer(record.audio), 200);
  });

  return routes;
}

/** Deterministic ETag derived from textHash + voiceId + speed: stable across requests, changes when any of the three change (ROUTE-004). */
function audioEtag(record: CommentaryAudioRecord): string {
  const digest = createHash('sha1').update(`${record.textHash}:${record.voiceId}:${record.speed}`).digest('hex');
  return `"${digest}"`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
