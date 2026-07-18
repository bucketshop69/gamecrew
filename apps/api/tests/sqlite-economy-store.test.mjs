import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SqliteEconomyStore } from '../src/economy/sqlite-economy-store.ts';

const walletAddress = '3xQ9jH9y4b9m9wYVvLxwqR1nQeD3f1u1c1x1x1x1x1x1';
const createdAt = '2026-07-17T10:00:00.000Z';

test('createClaim is idempotent on (walletAddress, sourceEventId)', async () => {
  const store = new SqliteEconomyStore(':memory:');
  try {
    const first = await store.createClaim({
      claimId: 'claim-1',
      walletAddress,
      fixtureId: '18179759',
      itemId: 'bananas',
      quantity: 24,
      minute: 58,
      sourceEventId: 'event-abc',
      createdAt,
    });
    assert.equal(first.claimId, 'claim-1');
    assert.equal(first.status, 'pending');
    assert.equal(first.attempts, 0);

    // A retry with the same (walletAddress, sourceEventId) but a different
    // claimId must return the ORIGINAL claim, not create a second row --
    // this is the double-mint guard the claim endpoint relies on.
    const retry = await store.createClaim({
      claimId: 'claim-2-should-be-ignored',
      walletAddress,
      fixtureId: '18179759',
      itemId: 'bananas',
      quantity: 24,
      minute: 58,
      sourceEventId: 'event-abc',
      createdAt,
    });
    assert.deepEqual(retry, first);

    const claims = await store.listClaimsForWallet(walletAddress);
    assert.equal(claims.length, 1);
  } finally {
    store.close();
  }
});

test('a different sourceEventId for the same wallet creates a distinct claim', async () => {
  const store = new SqliteEconomyStore(':memory:');
  try {
    await store.createClaim({
      claimId: 'claim-1', walletAddress, fixtureId: 'f1', itemId: 'dust',
      quantity: 5, sourceEventId: 'event-1', createdAt,
    });
    await store.createClaim({
      claimId: 'claim-2', walletAddress, fixtureId: 'f1', itemId: 'lambo',
      quantity: 1, sourceEventId: 'event-2', createdAt,
    });
    const claims = await store.listClaimsForWallet(walletAddress);
    assert.equal(claims.length, 2);
  } finally {
    store.close();
  }
});

test('getClaim and getClaimByWalletAndSourceEvent round-trip minute and optional fields', async () => {
  const store = new SqliteEconomyStore(':memory:');
  try {
    await store.createClaim({
      claimId: 'claim-1', walletAddress, fixtureId: 'f1', itemId: 'pizza',
      quantity: 3, sourceEventId: 'event-1', createdAt,
    });
    const byId = await store.getClaim('claim-1');
    assert.equal(byId.minute, undefined);
    assert.equal(byId.mintAddress, undefined);

    const bySource = await store.getClaimByWalletAndSourceEvent(walletAddress, 'event-1');
    assert.deepEqual(bySource, byId);
    assert.equal(await store.getClaimByWalletAndSourceEvent(walletAddress, 'missing'), undefined);
  } finally {
    store.close();
  }
});

test('beginMintAttempt bumps attempts and only claims pending rows', async () => {
  const store = new SqliteEconomyStore(':memory:');
  try {
    await store.createClaim({
      claimId: 'claim-1', walletAddress, fixtureId: 'f1', itemId: 'bananas',
      quantity: 24, sourceEventId: 'event-1', createdAt,
    });

    const attempt1 = await store.beginMintAttempt('claim-1', '2026-07-17T10:01:00.000Z');
    assert.equal(attempt1.attempts, 1);
    assert.equal(attempt1.status, 'pending');

    await store.markClaimMinted({
      claimId: 'claim-1', mintAddress: 'mintAddr123', txSignature: 'sig123',
      mintedAt: '2026-07-17T10:02:00.000Z',
    });

    // Once minted, a resumed sweep must not be able to "begin" another
    // attempt on it -- this is the interrupted-mint recovery guard.
    const attemptAfterMint = await store.beginMintAttempt('claim-1', '2026-07-17T10:03:00.000Z');
    assert.equal(attemptAfterMint.status, 'minted');
    assert.equal(attemptAfterMint.attempts, 1, 'attempts must not increment once no longer pending');
  } finally {
    store.close();
  }
});

test('markClaimFailed and resetClaimToPending transition status and clear/set error', async () => {
  const store = new SqliteEconomyStore(':memory:');
  try {
    await store.createClaim({
      claimId: 'claim-1', walletAddress, fixtureId: 'f1', itemId: 'jetski',
      quantity: 1, sourceEventId: 'event-1', createdAt,
    });
    await store.markClaimFailed({ claimId: 'claim-1', error: 'devnet unreachable' });
    let claim = await store.getClaim('claim-1');
    assert.equal(claim.status, 'failed');
    assert.equal(claim.error, 'devnet unreachable');

    await store.resetClaimToPending('claim-1');
    claim = await store.getClaim('claim-1');
    assert.equal(claim.status, 'pending');
    assert.equal(claim.error, undefined);
  } finally {
    store.close();
  }
});

test('listPendingClaims only returns pending claims, ordered by createdAt', async () => {
  const store = new SqliteEconomyStore(':memory:');
  try {
    await store.createClaim({
      claimId: 'claim-1', walletAddress, fixtureId: 'f1', itemId: 'dust',
      quantity: 5, sourceEventId: 'event-1', createdAt: '2026-07-17T10:00:00.000Z',
    });
    await store.createClaim({
      claimId: 'claim-2', walletAddress, fixtureId: 'f1', itemId: 'lambo',
      quantity: 1, sourceEventId: 'event-2', createdAt: '2026-07-17T09:00:00.000Z',
    });
    await store.markClaimMinted({
      claimId: 'claim-1', mintAddress: 'a', txSignature: 'b', mintedAt: createdAt,
    });

    const pending = await store.listPendingClaims();
    assert.deepEqual(pending.map((claim) => claim.claimId), ['claim-2']);
  } finally {
    store.close();
  }
});

test('claims survive a filesystem close and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-economy-'));
  const path = join(directory, 'economy.sqlite');
  try {
    const first = new SqliteEconomyStore(path);
    await first.createClaim({
      claimId: 'claim-1', walletAddress, fixtureId: 'f1', itemId: 'boombox',
      quantity: 2, sourceEventId: 'event-1', createdAt,
    });
    first.close();

    const reopened = new SqliteEconomyStore(path);
    const claim = await reopened.getClaim('claim-1');
    assert.equal(claim.itemId, 'boombox');
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
