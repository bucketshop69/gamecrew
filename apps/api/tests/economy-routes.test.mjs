import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../src/app.ts';

const config = {
  host: '127.0.0.1',
  llmEnabled: false,
  llmBatchSize: 4,
  llmModel: 'disabled',
  llmTimeoutMs: 1000,
  matchPulseStoreDriver: 'sqlite',
  matchPulseStorePath: ':memory:',
  matchPulseSqlitePath: ':memory:',
  port: 0,
  txlineApiToken: 'test-token',
  txlineBaseUrl: 'https://example.invalid',
};

function fakeEconomy(overrides = {}) {
  const claims = new Map();
  return {
    claims,
    async createClaim(input) {
      const existingKey = `${input.walletAddress}:${input.sourceEventId}`;
      const existing = [...claims.values()].find(
        (claim) => claim.walletAddress === input.walletAddress && claim.sourceEventId === input.sourceEventId,
      );
      if (existing) return existing;
      const claim = {
        claimId: `claim-${claims.size + 1}`,
        status: 'pending',
        walletAddress: input.walletAddress,
        sourceEventId: input.sourceEventId,
      };
      claims.set(claim.claimId, claim);
      return claim;
    },
    async getClaim(claimId) {
      return claims.get(claimId);
    },
    async listClaimsForWallet(walletAddress) {
      return [...claims.values()].filter((claim) => claim.walletAddress === walletAddress);
    },
    ...overrides,
  };
}

// CLAIM-018: the claim HTTP endpoint exists and is reachable (not a 404).
test('CLAIM-018: POST /economy/claims returns 202 pending for a valid request', async () => {
  const app = createApp(config, undefined, fakeEconomy());
  const response = await app.request('/economy/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      walletAddress: 'WalletAddr111',
      fixtureId: '18179759',
      itemId: 'bananas',
      quantity: 24,
      minute: 58,
      sourceEventId: 'event-1',
    }),
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.status, 'pending');
  assert.ok(body.claimId);
});

test('POST /economy/claims validates required fields', async () => {
  const app = createApp(config, undefined, fakeEconomy());
  const response = await app.request('/economy/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ walletAddress: 'WalletAddr111' }),
  });
  assert.equal(response.status, 400);
});

test('POST /economy/claims rejects a non-positive-integer quantity', async () => {
  const app = createApp(config, undefined, fakeEconomy());
  const response = await app.request('/economy/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      walletAddress: 'WalletAddr111',
      fixtureId: 'f1',
      itemId: 'bananas',
      quantity: -1,
      sourceEventId: 'event-1',
    }),
  });
  assert.equal(response.status, 400);
});

test('POST /economy/claims rejects malformed JSON', async () => {
  const app = createApp(config, undefined, fakeEconomy());
  const response = await app.request('/economy/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(response.status, 400);
});

// CLAIM-008/CLAIM-009: idempotent on (walletAddress, sourceEventId) -- the
// double-mint guard. The route itself just delegates to the runtime, so this
// asserts the route wiring forwards both fields through unchanged.
test('CLAIM-008/009: repeating the same (walletAddress, sourceEventId) returns the same claim', async () => {
  const app = createApp(config, undefined, fakeEconomy());
  const requestBody = JSON.stringify({
    walletAddress: 'WalletAddr111',
    fixtureId: 'f1',
    itemId: 'bananas',
    quantity: 24,
    sourceEventId: 'event-dup',
  });
  const first = await app.request('/economy/claims', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBody,
  });
  const second = await app.request('/economy/claims', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBody,
  });
  const firstBody = await first.json();
  const secondBody = await second.json();
  assert.equal(firstBody.claimId, secondBody.claimId);
});

test('GET /economy/claims/:claimId returns claim status', async () => {
  const economy = fakeEconomy();
  const app = createApp(config, undefined, economy);
  const createResponse = await app.request('/economy/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      walletAddress: 'WalletAddr111', fixtureId: 'f1', itemId: 'lambo', quantity: 1, sourceEventId: 'event-1',
    }),
  });
  const { claimId } = await createResponse.json();

  const getResponse = await app.request(`/economy/claims/${claimId}`);
  assert.equal(getResponse.status, 200);
  assert.equal((await getResponse.json()).status, 'pending');
});

// CLAIM-003: minted state includes an explorer link.
test('CLAIM-003: GET /economy/claims/:claimId surfaces mintAddress/explorerUrl once minted', async () => {
  const economy = fakeEconomy({
    async getClaim(claimId) {
      if (claimId !== 'minted-claim') return undefined;
      return {
        claimId,
        status: 'minted',
        mintAddress: 'MintAddr111',
        txSignature: 'Sig111',
        explorerUrl: 'https://explorer.solana.com/tx/Sig111?cluster=devnet',
      };
    },
  });
  const app = createApp(config, undefined, economy);
  const response = await app.request('/economy/claims/minted-claim');
  const body = await response.json();
  assert.equal(body.status, 'minted');
  assert.equal(body.mintAddress, 'MintAddr111');
  assert.equal(body.explorerUrl, 'https://explorer.solana.com/tx/Sig111?cluster=devnet');
});

test('GET /economy/claims/:claimId 404s for an unknown claim', async () => {
  const app = createApp(config, undefined, fakeEconomy());
  const response = await app.request('/economy/claims/does-not-exist');
  assert.equal(response.status, 404);
});

test('GET /economy/wallets/:walletAddress/claims lists claims for that wallet only', async () => {
  const economy = fakeEconomy();
  const app = createApp(config, undefined, economy);
  await app.request('/economy/claims', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ walletAddress: 'WalletA', fixtureId: 'f1', itemId: 'dust', quantity: 3, sourceEventId: 'e1' }),
  });
  await app.request('/economy/claims', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ walletAddress: 'WalletB', fixtureId: 'f1', itemId: 'dust', quantity: 3, sourceEventId: 'e2' }),
  });

  const response = await app.request('/economy/wallets/WalletA/claims');
  const body = await response.json();
  assert.equal(body.walletAddress, 'WalletA');
  assert.equal(body.claims.length, 1);
  assert.equal(body.claims[0].walletAddress, 'WalletA');
});

// CLAIM-015: unclaimed drops never touch the chain -- routes only exist for
// explicit claims, there is no endpoint that mints without a POST /economy/claims call.
test('CLAIM-015: economy routes return 503 gracefully when the runtime is unavailable (no crash)', async () => {
  const app = createApp(config, undefined, undefined);
  const postResponse = await app.request('/economy/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ walletAddress: 'w', fixtureId: 'f', itemId: 'dust', quantity: 1, sourceEventId: 'e' }),
  });
  assert.equal(postResponse.status, 503);

  const getResponse = await app.request('/economy/claims/anything');
  assert.equal(getResponse.status, 503);

  const listResponse = await app.request('/economy/wallets/w/claims');
  assert.equal(listResponse.status, 503);
});
