import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/**
 * Persistence for the Solana layer of the Playful Economy (see
 * docs/prds/playful_economy.md, "Solana Layer" and docs/plans/playful-economy-v1.md,
 * item 8): the claim -> devnet NFT mint pipeline.
 *
 * V1 architecture change from the POC: there is no server-custodial user
 * wallet anymore. The mobile app obtains the user's wallet address from
 * Privy social login client-side and passes it straight into the claim
 * request. The server only ever holds ONE keypair -- the mint payer (see
 * `payer.ts`) -- which sponsors fees and acts as the mint authority. Claims
 * are keyed by the caller-supplied `walletAddress`, not a server-side user
 * record.
 *
 * Mirrors the `SqliteIngestionStore` pattern: `node:sqlite` DatabaseSync,
 * idempotent `CREATE TABLE IF NOT EXISTS`, and prepared statements.
 */

interface SqliteRunResult {
  changes?: number | bigint;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): SqliteRunResult;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

export type EconomyClaimStatus = 'pending' | 'minted' | 'failed';

export interface EconomyClaimRecord {
  claimId: string;
  walletAddress: string;
  fixtureId: string;
  itemId: string;
  quantity: number;
  /** Match minute the drop is tied to, when known (carried into mint metadata). */
  minute?: number;
  sourceEventId: string;
  status: EconomyClaimStatus;
  mintAddress?: string;
  txSignature?: string;
  error?: string;
  /** Number of mint attempts made so far, for capped-retry accounting. */
  attempts: number;
  createdAt: string;
  updatedAt: string;
  mintedAt?: string;
}

export interface CreateEconomyClaimInput {
  claimId: string;
  walletAddress: string;
  fixtureId: string;
  itemId: string;
  quantity: number;
  minute?: number;
  sourceEventId: string;
  createdAt: string;
}

export interface MarkClaimMintedInput {
  claimId: string;
  mintAddress: string;
  txSignature: string;
  mintedAt: string;
}

export interface MarkClaimFailedInput {
  claimId: string;
  error: string;
}

interface EconomyClaimRow {
  claim_id: string;
  wallet_address: string;
  fixture_id: string;
  item_id: string;
  quantity: number;
  minute: number | null;
  source_event_id: string;
  status: EconomyClaimStatus;
  mint_address: string | null;
  tx_signature: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  minted_at: string | null;
}

export class SqliteEconomyStore {
  private readonly db: SqliteDatabase;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    }

    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (databasePath: string) => SqliteDatabase;
    };
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS economy_claims (
        claim_id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        fixture_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        minute INTEGER,
        source_event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        mint_address TEXT,
        tx_signature TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        minted_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_economy_claims_wallet_source_event
        ON economy_claims (wallet_address, source_event_id);

      CREATE INDEX IF NOT EXISTS idx_economy_claims_wallet
        ON economy_claims (wallet_address, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_economy_claims_status
        ON economy_claims (status, created_at ASC);
    `);
  }

  /**
   * Idempotent on (walletAddress, sourceEventId): a retry (e.g. a double-tap
   * on "Claim on-chain" that races the client-side guard) returns the
   * existing claim instead of inserting a duplicate row -- this is the
   * double-mint guard the claim flow relies on.
   */
  async createClaim(input: CreateEconomyClaimInput): Promise<EconomyClaimRecord> {
    this.db.prepare(`
      INSERT OR IGNORE INTO economy_claims (
        claim_id, wallet_address, fixture_id, item_id, quantity, minute,
        source_event_id, status, attempts, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(
      input.claimId,
      input.walletAddress,
      input.fixtureId,
      input.itemId,
      input.quantity,
      input.minute ?? null,
      input.sourceEventId,
      input.createdAt,
      input.createdAt,
    );

    const existing = await this.getClaimByWalletAndSourceEvent(input.walletAddress, input.sourceEventId);
    if (!existing) {
      throw new Error(`Failed to create economy claim for wallet ${input.walletAddress}.`);
    }
    return existing;
  }

  async getClaimByWalletAndSourceEvent(
    walletAddress: string,
    sourceEventId: string,
  ): Promise<EconomyClaimRecord | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM economy_claims WHERE wallet_address = ? AND source_event_id = ?
    `).get(walletAddress, sourceEventId) as EconomyClaimRow | undefined;
    return row ? claimFromRow(row) : undefined;
  }

  async getClaim(claimId: string): Promise<EconomyClaimRecord | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM economy_claims WHERE claim_id = ?
    `).get(claimId) as EconomyClaimRow | undefined;
    return row ? claimFromRow(row) : undefined;
  }

  async listClaimsForWallet(walletAddress: string): Promise<readonly EconomyClaimRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM economy_claims WHERE wallet_address = ? ORDER BY created_at ASC
    `).all(walletAddress) as EconomyClaimRow[];
    return rows.map(claimFromRow);
  }

  async listPendingClaims(): Promise<readonly EconomyClaimRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM economy_claims WHERE status = 'pending' ORDER BY created_at ASC
    `).all() as EconomyClaimRow[];
    return rows.map(claimFromRow);
  }

  /**
   * Claims a pending claim for a mint attempt by bumping its attempt count.
   * Returns the updated record, or undefined if the claim is no longer
   * pending (e.g. it was already picked up and minted by a prior sweep) --
   * callers must check this before starting a mint so a resumed sweep after
   * a restart never re-mints a claim that already succeeded.
   */
  async beginMintAttempt(claimId: string, updatedAt: string): Promise<EconomyClaimRecord | undefined> {
    this.db.prepare(`
      UPDATE economy_claims
      SET attempts = attempts + 1, updated_at = ?
      WHERE claim_id = ? AND status = 'pending'
    `).run(updatedAt, claimId);
    return this.getClaim(claimId);
  }

  async markClaimMinted(input: MarkClaimMintedInput): Promise<void> {
    this.db.prepare(`
      UPDATE economy_claims
      SET status = 'minted', mint_address = ?, tx_signature = ?, error = NULL,
          minted_at = ?, updated_at = ?
      WHERE claim_id = ?
    `).run(input.mintAddress, input.txSignature, input.mintedAt, input.mintedAt, input.claimId);
  }

  async markClaimFailed(input: MarkClaimFailedInput): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE economy_claims
      SET status = 'failed', error = ?, updated_at = ?
      WHERE claim_id = ?
    `).run(input.error, now, input.claimId);
  }

  /** Leaves a claim in 'pending' after a transient failure so the next sweep retries it. */
  async recordTransientFailure(claimId: string, error: string, updatedAt: string): Promise<void> {
    this.db.prepare(`
      UPDATE economy_claims
      SET error = ?, updated_at = ?
      WHERE claim_id = ? AND status = 'pending'
    `).run(error, updatedAt, claimId);
  }

  /** Resets a 'failed' claim back to 'pending' so it is retried on the next sweep. */
  async resetClaimToPending(claimId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE economy_claims
      SET status = 'pending', error = NULL, updated_at = ?
      WHERE claim_id = ?
    `).run(now, claimId);
  }

  close(): void {
    this.db.close();
  }
}

function claimFromRow(row: EconomyClaimRow): EconomyClaimRecord {
  return {
    claimId: row.claim_id,
    walletAddress: row.wallet_address,
    fixtureId: row.fixture_id,
    itemId: row.item_id,
    quantity: row.quantity,
    ...(row.minute === null ? {} : { minute: row.minute }),
    sourceEventId: row.source_event_id,
    status: row.status,
    ...(row.mint_address === null ? {} : { mintAddress: row.mint_address }),
    ...(row.tx_signature === null ? {} : { txSignature: row.tx_signature }),
    ...(row.error === null ? {} : { error: row.error }),
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.minted_at === null ? {} : { mintedAt: row.minted_at }),
  };
}
