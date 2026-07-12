import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createIngestionRuntime } from './ingestion/ingestion-runtime.js';

const config = loadConfig();
const ingestion = createIngestionRuntime(config);
const app = createApp(config, ingestion);
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
      .then(() => ingestion.close())
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  });
}
