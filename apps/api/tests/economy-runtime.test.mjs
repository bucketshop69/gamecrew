import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createEconomyRuntime } from '../src/economy/economy-runtime.ts';

function baseConfig(overrides = {}) {
  return {
    economySqlitePath: ':memory:',
    economyPayerPath: overrides.economyPayerPath,
    solanaRpcUrl: 'https://example.invalid',
    ...overrides,
  };
}

async function tmpPayerPath() {
  const directory = await mkdtemp(join(tmpdir(), 'gamecrew-economy-payer-'));
  return join(directory, '.economy-payer.json');
}

function fakeMinter({ shouldFail = false, failTimes = 0 } = {}) {
  let calls = 0;
  let failuresLeft = failTimes;
  return {
    calls: () => calls,
    mint: async (input) => {
      calls += 1;
      if (shouldFail) throw new Error('mint permanently failing in test');
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('transient mint failure in test');
      }
      return {
        mintAddress: `mint-${input.itemId}-${calls}`,
        txSignature: `sig-${calls}`,
      };
    },
  };
}

// CLAIM-019: pending claims actually get minted when the sweep runs.
test('CLAIM-019: runSweepOnce mints a pending claim and transitions it to minted', async () => {
  const payerPath = await tmpPayerPath();
  const minter = fakeMinter();
  const runtime = createEconomyRuntime(baseConfig({ economyPayerPath: payerPath }), {
    minter, autoSweep: false,
  });
  try {
    const claim = await runtime.createClaim({
      walletAddress: 'WalletA', fixtureId: 'f1', itemId: 'bananas', quantity: 24,
      minute: 58, sourceEventId: 'event-1',
    });
    assert.equal(claim.status, 'pending');

    await runtime.runSweepOnce();

    const after = await runtime.getClaim(claim.claimId);
    assert.equal(after.status, 'minted');
    assert.ok(after.mintAddress);
    assert.ok(after.txSignature);
    assert.equal(after.explorerUrl, `https://explorer.solana.com/tx/${after.txSignature}?cluster=devnet`);
    assert.equal(minter.calls(), 1);
  } finally {
    runtime.close();
    await rm(join(payerPath, '..'), { recursive: true, force: true });
  }
});

test('a claim never picked up by createClaim leaves listPendingClaims/sweep with nothing to do', async () => {
  const payerPath = await tmpPayerPath();
  const minter = fakeMinter();
  const runtime = createEconomyRuntime(baseConfig({ economyPayerPath: payerPath }), {
    minter, autoSweep: false,
  });
  try {
    await runtime.runSweepOnce();
    assert.equal(minter.calls(), 0);
  } finally {
    runtime.close();
    await rm(join(payerPath, '..'), { recursive: true, force: true });
  }
});

// CLAIM-011 (server-side half): interrupted-mint recovery -- a claim that
// reaches 'minted' must never be re-minted by a subsequent sweep, simulating
// a process restart that resumes pending work from sqlite.
test('CLAIM-011: a resumed sweep after a claim already minted does not double-mint', async () => {
  const payerPath = await tmpPayerPath();
  const minter = fakeMinter();
  const runtime = createEconomyRuntime(baseConfig({ economyPayerPath: payerPath }), {
    minter, autoSweep: false,
  });
  try {
    const claim = await runtime.createClaim({
      walletAddress: 'WalletA', fixtureId: 'f1', itemId: 'lambo', quantity: 1, sourceEventId: 'event-1',
    });
    await runtime.runSweepOnce();
    assert.equal((await runtime.getClaim(claim.claimId)).status, 'minted');
    assert.equal(minter.calls(), 1);

    // Simulate the process restarting and running the sweep again: the
    // claim is no longer 'pending', so it must be skipped entirely.
    await runtime.runSweepOnce();
    assert.equal(minter.calls(), 1, 'sweep must not re-mint an already-minted claim');
  } finally {
    runtime.close();
    await rm(join(payerPath, '..'), { recursive: true, force: true });
  }
});

// CLAIM-011: a claim stuck mid-mint (attempts bumped, minter never resolved
// because the process died) must be retried, not stuck forever, and must
// not be treated as already succeeded.
test('CLAIM-011: a claim interrupted before the mint resolved is retried on the next sweep, not skipped', async () => {
  const payerPath = await tmpPayerPath();
  const minter = fakeMinter({ failTimes: 1 });
  const runtime = createEconomyRuntime(baseConfig({ economyPayerPath: payerPath }), {
    minter, autoSweep: false,
  });
  try {
    const claim = await runtime.createClaim({
      walletAddress: 'WalletA', fixtureId: 'f1', itemId: 'pizza', quantity: 3, sourceEventId: 'event-1',
    });

    // First sweep: simulated transient failure (stand-in for "process died
    // mid-mint" -- the attempt was begun but did not reach markClaimMinted).
    await runtime.runSweepOnce();
    let after = await runtime.getClaim(claim.claimId);
    assert.equal(after.status, 'pending', 'a transient failure must leave the claim pending for retry');

    // Second sweep succeeds.
    await runtime.runSweepOnce();
    after = await runtime.getClaim(claim.claimId);
    assert.equal(after.status, 'minted');
    assert.equal(minter.calls(), 2);
  } finally {
    runtime.close();
    await rm(join(payerPath, '..'), { recursive: true, force: true });
  }
});

test('a claim that fails every attempt is marked failed after exceeding max attempts, with error recorded', async () => {
  const payerPath = await tmpPayerPath();
  const minter = fakeMinter({ shouldFail: true });
  const runtime = createEconomyRuntime(baseConfig({ economyPayerPath: payerPath }), {
    minter, autoSweep: false, maxMintAttempts: 2,
  });
  try {
    const claim = await runtime.createClaim({
      walletAddress: 'WalletA', fixtureId: 'f1', itemId: 'dust', quantity: 5, sourceEventId: 'event-1',
    });

    await runtime.runSweepOnce(); // attempt 1: transient
    assert.equal((await runtime.getClaim(claim.claimId)).status, 'pending');
    await runtime.runSweepOnce(); // attempt 2: hits maxMintAttempts, marked failed
    const after = await runtime.getClaim(claim.claimId);
    assert.equal(after.status, 'failed');
    assert.ok(after.error);

    // Further sweeps must not retry a 'failed' claim.
    const callsBefore = minter.calls();
    await runtime.runSweepOnce();
    assert.equal(minter.calls(), callsBefore);
  } finally {
    runtime.close();
    await rm(join(payerPath, '..'), { recursive: true, force: true });
  }
});

// Offline RPC degradation: the API must stay up and claims must stay
// pending (not crash, not silently mint) when the payer cannot be funded --
// e.g. devnet is unreachable or the airdrop faucet is rate-limited.
test('offline devnet RPC: sweep leaves claims pending and never calls the minter when the payer cannot be funded', async () => {
  const payerPath = await tmpPayerPath();
  const minter = fakeMinter();
  const runtime = createEconomyRuntime(baseConfig({ economyPayerPath: payerPath }), {
    minter,
    autoSweep: false,
    ensurePayerFundedFn: async () => ({ funded: false, balanceLamports: 0, reason: 'devnet unreachable in test' }),
  });
  try {
    const claim = await runtime.createClaim({
      walletAddress: 'WalletA', fixtureId: 'f1', itemId: 'traffic_cone', quantity: 2, sourceEventId: 'event-1',
    });

    await runtime.runSweepOnce();

    const after = await runtime.getClaim(claim.claimId);
    assert.equal(after.status, 'pending');
    assert.equal(minter.calls(), 0);
  } finally {
    runtime.close();
    await rm(join(payerPath, '..'), { recursive: true, force: true });
  }
});

test('recovering from offline: once the payer funds successfully, the next sweep mints the still-pending claim', async () => {
  const payerPath = await tmpPayerPath();
  const minter = fakeMinter();
  let funded = false;
  const runtime = createEconomyRuntime(baseConfig({ economyPayerPath: payerPath }), {
    minter,
    autoSweep: false,
    ensurePayerFundedFn: async () => (funded
      ? { funded: true, balanceLamports: 1_000_000_000 }
      : { funded: false, balanceLamports: 0, reason: 'still offline' }),
  });
  try {
    const claim = await runtime.createClaim({
      walletAddress: 'WalletA', fixtureId: 'f1', itemId: 'rubber_duck', quantity: 1, sourceEventId: 'event-1',
    });

    await runtime.runSweepOnce();
    assert.equal((await runtime.getClaim(claim.claimId)).status, 'pending');
    assert.equal(minter.calls(), 0);

    funded = true;
    await runtime.runSweepOnce();
    assert.equal((await runtime.getClaim(claim.claimId)).status, 'minted');
    assert.equal(minter.calls(), 1);
  } finally {
    runtime.close();
    await rm(join(payerPath, '..'), { recursive: true, force: true });
  }
});

test('listClaimsForWallet reflects claim status after a sweep', async () => {
  const payerPath = await tmpPayerPath();
  const minter = fakeMinter();
  const runtime = createEconomyRuntime(baseConfig({ economyPayerPath: payerPath }), {
    minter, autoSweep: false,
  });
  try {
    await runtime.createClaim({
      walletAddress: 'WalletA', fixtureId: 'f1', itemId: 'boombox', quantity: 2, sourceEventId: 'event-1',
    });
    await runtime.createClaim({
      walletAddress: 'WalletA', fixtureId: 'f1', itemId: 'jetski', quantity: 1, sourceEventId: 'event-2',
    });
    await runtime.runSweepOnce();

    const claims = await runtime.listClaimsForWallet('WalletA');
    assert.equal(claims.length, 2);
    assert.ok(claims.every((claim) => claim.status === 'minted'));
  } finally {
    runtime.close();
    await rm(join(payerPath, '..'), { recursive: true, force: true });
  }
});

// CLAIM-013: claiming never blocks the core loop -- createClaim resolves
// immediately (202-equivalent pending), independent of whether a mint runs.
test('CLAIM-013: createClaim resolves immediately without waiting for a mint', async () => {
  const payerPath = await tmpPayerPath();
  let resolveMint;
  const slowMinter = {
    mint: () => new Promise((resolve) => { resolveMint = resolve; }),
  };
  const runtime = createEconomyRuntime(baseConfig({ economyPayerPath: payerPath }), {
    minter: slowMinter, autoSweep: false,
  });
  try {
    const claim = await runtime.createClaim({
      walletAddress: 'WalletA', fixtureId: 'f1', itemId: 'dust', quantity: 5, sourceEventId: 'event-1',
    });
    assert.equal(claim.status, 'pending');
    // never resolve the mint -- if createClaim had awaited it, this test would hang/timeout.
    void resolveMint;
  } finally {
    runtime.close();
    await rm(join(payerPath, '..'), { recursive: true, force: true });
  }
});
