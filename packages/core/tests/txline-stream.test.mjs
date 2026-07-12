import assert from 'node:assert/strict';
import test from 'node:test';

import { TxlineApiClient, TxlineTransportError } from '../src/txline/client.ts';
import { TxlineSseDecoder } from '../src/txline/parser.ts';

const encoder = new TextEncoder();

test('incremental SSE decoder preserves id, event, retry, and multiline data', () => {
  const decoder = new TxlineSseDecoder();

  assert.deepEqual(decoder.push('\uFEFF: connected\nid: 1782878179325:0\nevent: heart'), []);
  assert.deepEqual(decoder.push('beat\nretry: 1500\ndata: {"Ts":1782878179325}\n\n'), [
    {
      id: '1782878179325:0',
      event: 'heartbeat',
      retry: 1500,
      data: '{"Ts":1782878179325}',
    },
  ]);
  assert.deepEqual(decoder.push('id: 1782878179325:1\nevent: scores\ndata: {"FixtureId":18179759,\n'), []);
  assert.deepEqual(decoder.push('data: "Seq":1,"Action":"kickoff"}'), []);
  assert.deepEqual(decoder.finish(), [
    {
      id: '1782878179325:1',
      event: 'scores',
      data: '{"FixtureId":18179759,\n"Seq":1,"Action":"kickoff"}',
    },
  ]);
});

test('REST helpers encode official filters and reject rows from another fixture', async () => {
  const requests = [];
  const fetcher = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.includes('/api/fixtures/snapshot')) {
      return jsonResponse([{ FixtureId: 18179759 }]);
    }
    if (url.includes('/api/scores/snapshot/')) {
      return jsonResponse([
        { FixtureId: 18179759, Seq: 10, Action: 'lineups' },
        { FixtureId: 99, Seq: 11, Action: 'goal' },
      ]);
    }
    if (url.includes('/api/scores/updates/20645/2/3')) {
      return textResponse([
        'data: {"FixtureId":18179759,"Seq":12,"Action":"shot"}',
        '',
        'data: {"FixtureId":99,"Seq":13,"Action":"shot"}',
        '',
      ].join('\n'));
    }
    if (url.includes('/api/scores/updates/18179759')) {
      return jsonResponse([
        { FixtureId: 18179759, Seq: 14, Action: 'possession' },
        { FixtureId: 99, Seq: 15, Action: 'possession' },
      ]);
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const client = new TxlineApiClient({
    baseUrl: 'https://txline.example/',
    apiToken: 'api-token',
    fetcher,
  });

  await client.listFixtures('jwt', { startEpochDay: 20645, competitionId: 72 });
  const snapshot = await client.listScoreSnapshot(18179759, 'jwt', { asOf: 1782878400000 });
  const interval = await client.listScoreInterval(20645, 2, 3, 'jwt', { fixtureId: 18179759 });
  const updates = await client.listScoreUpdates(18179759, 'jwt');

  assert.equal(requests[0].url,
    'https://txline.example/api/fixtures/snapshot?startEpochDay=20645&competitionId=72');
  assert.equal(requests[1].url,
    'https://txline.example/api/scores/snapshot/18179759?asOf=1782878400000');
  assert.equal(requests[2].url,
    'https://txline.example/api/scores/updates/20645/2/3?fixtureId=18179759');
  assert.deepEqual(snapshot.map(({ Seq }) => Seq), [10]);
  assert.deepEqual(interval.map(({ Seq }) => Seq), [12]);
  assert.deepEqual(updates.map(({ Seq }) => Seq), [14]);
  assert.equal(requests.every(({ init }) => init.headers.Authorization === 'Bearer jwt'), true);
  assert.equal(requests.every(({ init }) => init.headers['X-Api-Token'] === 'api-token'), true);
});

test('score stream uses a readable body, resumes by event id, and separates score and heartbeat events', async () => {
  const callbacks = [];
  const signal = { aborted: false };
  let request;
  const chunks = [
    'id: 1782878179325:0\nevent: heartbeat\nretry: 1200\ndata: {"Ts":1782878179325}\n\n' +
      'id: 1782878179325:1\nevent: scores\ndata: {"FixtureId":1817',
    '9759,"Seq":837,"Action":"var"}\n\n' +
      'id: 1782878179325:2\nevent: scores\ndata: {"FixtureId":99,"Seq":1,"Action":"goal"}\n\n',
    'event: ready\ndata: {"connected":true}\n\n',
  ].map((chunk) => encoder.encode(chunk));
  const fetcher = async (url, init) => {
    request = { url, init };
    return streamResponse(chunks);
  };
  const client = new TxlineApiClient({
    baseUrl: 'https://txline.example',
    apiToken: 'api-token',
    fetcher,
  });

  const events = [];
  for await (const event of client.streamScoreUpdates(18179759, 'jwt', {
    lastEventId: '1782878179000:9',
    signal,
    onEvent: (value) => callbacks.push(`event:${value.kind}`),
    onScore: (score) => callbacks.push(`score:${score.Seq}`),
    onHeartbeat: (value) => callbacks.push(`heartbeat:${value.timestamp}`),
  })) {
    events.push(event);
  }

  assert.equal(request.url, 'https://txline.example/api/scores/stream?fixtureId=18179759');
  assert.equal(request.init.headers['Last-Event-ID'], '1782878179000:9');
  assert.equal(request.init.headers.Accept, 'text/event-stream');
  assert.equal(request.init.signal, signal);
  assert.deepEqual(events.map(({ kind }) => kind), ['heartbeat', 'score', 'control']);
  assert.equal(events[0].message.id, '1782878179325:0');
  assert.equal(events[0].message.retry, 1200);
  assert.equal(events[1].score.Seq, 837);
  assert.equal(events.some((event) => event.kind === 'score' && event.score.FixtureId === 99), false);
  assert.deepEqual(callbacks, [
    'event:heartbeat',
    'heartbeat:1782878179325',
    'event:score',
    'score:837',
    'event:control',
  ]);
});

test('transport failures expose status and path without owning auth refresh', async () => {
  const client = new TxlineApiClient({
    baseUrl: 'https://txline.example',
    apiToken: 'bad-token',
    fetcher: async () => textResponse('Access denied', 403),
  });

  await assert.rejects(
    client.listScoreUpdates(18179759, 'jwt'),
    (error) => {
      assert.equal(error instanceof TxlineTransportError, true);
      assert.equal(error.status, 403);
      assert.equal(error.path, '/api/scores/updates/18179759');
      return true;
    },
  );
});

function jsonResponse(value, status = 200) {
  return textResponse(JSON.stringify(value), status);
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

function streamResponse(chunks) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    text: async () => {
      throw new Error('A live stream must not be buffered with response.text().');
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          releaseLock() {},
        };
      },
    },
  };
}
