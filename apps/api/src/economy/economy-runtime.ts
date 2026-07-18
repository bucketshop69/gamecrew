import { randomUUID } from 'node:crypto';
import { Connection } from '@solana/web3.js';
import type { ApiConfig } from '../config.js';
import { ensurePayerFunded, loadOrCreatePayerKeypair } from './payer.js';
import { createRealNftMinter, explorerUrlForSignature, type NftMinter } from './nft-minter.js';
import {
  SqliteEconomyStore,
  type EconomyClaimRecord,
} from './sqlite-economy-store.js';

/**
 * Orchestrates the Playful Economy Solana layer (see
 * docs/prds/playful_economy.md, "Solana Layer" and
 * docs/plans/playful-economy-v1.md item 8): claim intake, idempotency, and
 * the async mint-sweep worker that consumes pending claims and mints them
 * to devnet.
 *
 * Mirrors `createIngestionRuntime`'s factory shape: wires stores/services
 * together and returns a plain object of operations, with a `close()` for
 * clean shutdown (used by tests and `server.ts`).
 */

const MAX_MINT_ATTEMPTS = 5;
const SWEEP_INTERVAL_MS = 4_000;

export interface CreateClaimInput {
  walletAddress: string;
  fixtureId: string;
  itemId: string;
  quantity: number;
  minute?: number;
  sourceEventId: string;
}

export interface ClaimView {
  claimId: string;
  status: EconomyClaimRecord['status'];
  mintAddress?: string;
  txSignature?: string;
  explorerUrl?: string;
  error?: string;
}

export interface EnsurePayerFundedFn {
  (): Promise<{ funded: boolean; balanceLamports: number; reason?: string }>;
}

export interface EconomyRuntimeOptions {
  /** Injectable for tests -- never hit devnet outside the real minter / manual verification script. */
  minter?: NftMinter;
  /**
   * Injectable payer-funding check, defaulting to a real devnet airdrop
   * check. Tests inject a fake to exercise offline/rate-limited RPC
   * degradation without any network access. Implicitly stubbed to "always
   * funded" whenever a fake `minter` is supplied and no explicit fn is given,
   * so tests never accidentally hit devnet RPC.
   */
  ensurePayerFundedFn?: EnsurePayerFundedFn;
  /** Disables the background sweep timer (tests drive sweeps manually via `runSweepOnce`). */
  autoSweep?: boolean;
  sweepIntervalMs?: number;
  maxMintAttempts?: number;
}

export function createEconomyRuntime(config: ApiConfig, options: EconomyRuntimeOptions = {}) {
  const store = new SqliteEconomyStore(config.economySqlitePath);
  const payer = loadOrCreatePayerKeypair(config.economyPayerPath);
  const minter = options.minter ?? createRealNftMinter({ rpcUrl: config.solanaRpcUrl, payer });
  const maxAttempts = options.maxMintAttempts ?? MAX_MINT_ATTEMPTS;
  const ensurePayerFundedFn: EnsurePayerFundedFn = options.ensurePayerFundedFn
    ?? (options.minter
      ? async () => ({ funded: true, balanceLamports: 0 })
      : async () => ensurePayerFunded(new Connection(config.solanaRpcUrl, 'confirmed'), payer));

  let payerFunded = false;
  const fundPayer = async () => {
    const result = await ensurePayerFundedFn();
    payerFunded = result.funded;
    if (!result.funded) {
      console.error(JSON.stringify({ event: 'economy_payer_funding_failed', reason: result.reason }));
    }
    return result;
  };

  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;

  async function runSweepOnce(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
      if (!payerFunded) {
        await fundPayer();
        if (!payerFunded) return; // stay offline-safe; claims remain pending, retried next sweep
      }

      const pending = await store.listPendingClaims();
      for (const claim of pending) {
        await attemptMint(claim);
      }
    } finally {
      sweeping = false;
    }
  }

  async function attemptMint(claim: EconomyClaimRecord): Promise<void> {
    const now = new Date().toISOString();
    // Compare-and-swap the attempt count so a claim already picked up (and
    // possibly already minted) by a concurrent/prior sweep is never
    // re-attempted -- this is the interrupted-mint recovery guard: on
    // restart, listPendingClaims only ever returns claims still 'pending',
    // and a claim that reached 'minted' before a crash is skipped entirely.
    const claimed = await store.beginMintAttempt(claim.claimId, now);
    if (!claimed || claimed.status !== 'pending') return;

    if (claimed.attempts > maxAttempts) {
      await store.markClaimFailed({
        claimId: claim.claimId,
        error: `Exceeded maximum mint attempts (${maxAttempts}).`,
      });
      return;
    }

    try {
      const result = await minter.mint({
        ownerAddress: claimed.walletAddress,
        fixtureId: claimed.fixtureId,
        itemId: claimed.itemId,
        quantity: claimed.quantity,
        ...(claimed.minute === undefined ? {} : { minute: claimed.minute }),
      });
      await store.markClaimMinted({
        claimId: claim.claimId,
        mintAddress: result.mintAddress,
        txSignature: result.txSignature,
        mintedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (claimed.attempts >= maxAttempts) {
        await store.markClaimFailed({ claimId: claim.claimId, error: message });
      } else {
        await store.recordTransientFailure(claim.claimId, message, new Date().toISOString());
      }
    }
  }

  function toClaimView(claim: EconomyClaimRecord): ClaimView {
    return {
      claimId: claim.claimId,
      status: claim.status,
      ...(claim.mintAddress === undefined ? {} : { mintAddress: claim.mintAddress }),
      ...(claim.txSignature === undefined ? {} : { txSignature: claim.txSignature }),
      ...(claim.txSignature === undefined ? {} : { explorerUrl: explorerUrlForSignature(claim.txSignature) }),
      ...(claim.error === undefined ? {} : { error: claim.error }),
    };
  }

  if (options.autoSweep ?? true) {
    void fundPayer();
    sweepTimer = setInterval(() => {
      void runSweepOnce();
    }, options.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  return {
    async createClaim(input: CreateClaimInput): Promise<ClaimView> {
      const claim = await store.createClaim({
        claimId: randomUUID(),
        walletAddress: input.walletAddress,
        fixtureId: input.fixtureId,
        itemId: input.itemId,
        quantity: input.quantity,
        ...(input.minute === undefined ? {} : { minute: input.minute }),
        sourceEventId: input.sourceEventId,
        createdAt: new Date().toISOString(),
      });
      return toClaimView(claim);
    },
    async getClaim(claimId: string): Promise<ClaimView | undefined> {
      const claim = await store.getClaim(claimId);
      return claim ? toClaimView(claim) : undefined;
    },
    async listClaimsForWallet(walletAddress: string): Promise<readonly ClaimView[]> {
      const claims = await store.listClaimsForWallet(walletAddress);
      return claims.map(toClaimView);
    },
    /** Exposed for tests to drive the sweep deterministically without a timer. */
    runSweepOnce,
    close(): void {
      if (sweepTimer) clearInterval(sweepTimer);
      store.close();
    },
  };
}

export type EconomyRuntime = ReturnType<typeof createEconomyRuntime>;
