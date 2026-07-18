import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createIngestionRuntime } from './ingestion/ingestion-runtime.js';
import { createEconomyRuntime } from './economy/economy-runtime.js';
import { SqliteCommentaryAudioStore } from './tts/commentary-audio-store.js';

const config = loadConfig();
const ingestion = createIngestionRuntime(config);
const economy = createEconomyRuntime(config);
const commentaryAudio = new SqliteCommentaryAudioStore(config.commentaryAudioSqlitePath);
const app = createApp(config, ingestion, economy, commentaryAudio);
void ingestion.restore();

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    console.log(`GameCrew API listening on http://${info.address}:${info.port}`);
    console.log('TxLINE source: live');
  },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      .then(() => {
        ingestion.close();
        economy.close();
        commentaryAudio.close();
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  });
}
