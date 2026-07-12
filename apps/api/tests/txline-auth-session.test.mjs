import assert from 'node:assert/strict';
import test from 'node:test';

import { TxlineAuthSession } from '../src/ingestion/txline-auth-session.ts';

test('caches one guest JWT across successful requests', async () => {
  let starts = 0;
  const session = new TxlineAuthSession({
    async startGuestSession() {
      starts += 1;
      return { jwt: `jwt-${starts}` };
    },
  });
  assert.equal(await session.request(async (jwt) => jwt), 'jwt-1');
  assert.equal(await session.request(async (jwt) => jwt), 'jwt-1');
  assert.equal(starts, 1);
});

test('refreshes once on 401 and retries with the new JWT', async () => {
  let starts = 0;
  const seen = [];
  const session = new TxlineAuthSession({
    async startGuestSession() {
      starts += 1;
      return { jwt: `jwt-${starts}` };
    },
  });
  const result = await session.request(async (jwt) => {
    seen.push(jwt);
    if (jwt === 'jwt-1') throw Object.assign(new Error('expired'), { status: 401 });
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(seen, ['jwt-1', 'jwt-2']);
  assert.equal(starts, 2);
});

test('coalesces concurrent 401 refreshes and does not refresh other statuses', async () => {
  let starts = 0;
  const session = new TxlineAuthSession({
    async startGuestSession() {
      starts += 1;
      return { jwt: `jwt-${starts}` };
    },
  });
  await session.getJwt();
  const operation = async (jwt) => {
    if (jwt === 'jwt-1') throw Object.assign(new Error('expired'), { status: 401 });
    return jwt;
  };
  assert.deepEqual(await Promise.all([session.request(operation), session.request(operation)]), ['jwt-2', 'jwt-2']);
  assert.equal(starts, 2);
  await assert.rejects(
    session.request(async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); }),
    /forbidden/,
  );
  assert.equal(starts, 2);
});
