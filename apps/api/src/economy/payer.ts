import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * The server-side mint payer: a single Solana keypair that pays devnet
 * transaction fees for NFT mints (see the task brief -- "mint payer: a
 * server keypair persisted to apps/api/.economy-payer.json"). Generated on
 * first boot, persisted locally, and gitignored -- never commit this file.
 *
 * The payer is funded via devnet airdrop on startup when its balance is
 * low. Airdrops are rate-limited by the public devnet faucet, so funding
 * failures are swallowed here and surfaced by the caller (claims stay
 * 'pending' and are retried on the next sweep rather than crashing the API).
 */

const MIN_PAYER_BALANCE_LAMPORTS = 0.2 * LAMPORTS_PER_SOL;
const AIRDROP_AMOUNT_LAMPORTS = 1 * LAMPORTS_PER_SOL;

export interface PayerFile {
  secret: string;
}

export function loadOrCreatePayerKeypair(path: string): Keypair {
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as PayerFile;
    return Keypair.fromSecretKey(bs58.decode(raw.secret));
  }

  const keypair = Keypair.generate();
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify({ secret: bs58.encode(keypair.secretKey) } satisfies PayerFile, null, 2));
  return keypair;
}

export interface EnsurePayerFundedResult {
  funded: boolean;
  balanceLamports: number;
  reason?: string;
}

/**
 * Airdrops devnet SOL into the payer when its balance is below the working
 * minimum. Degrades cleanly: any RPC/airdrop failure (rate limit, network
 * offline) is reported back rather than thrown, so API startup never fails
 * because devnet is unreachable.
 */
export async function ensurePayerFunded(
  connection: Connection,
  payer: Keypair,
  options: { retries?: number; retryDelayMs?: number } = {},
): Promise<EnsurePayerFundedResult> {
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1_500;

  try {
    const balance = await connection.getBalance(payer.publicKey);
    if (balance >= MIN_PAYER_BALANCE_LAMPORTS) {
      return { funded: true, balanceLamports: balance };
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const signature = await connection.requestAirdrop(payer.publicKey, AIRDROP_AMOUNT_LAMPORTS);
        await connection.confirmTransaction(signature, 'confirmed');
        const newBalance = await connection.getBalance(payer.publicKey);
        return { funded: true, balanceLamports: newBalance };
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await sleep(retryDelayMs * attempt);
        }
      }
    }

    return {
      funded: false,
      balanceLamports: balance,
      reason: `Devnet airdrop failed after ${retries} attempts: ${describeError(lastError)}`,
    };
  } catch (error) {
    return {
      funded: false,
      balanceLamports: 0,
      reason: `Unable to reach devnet RPC to check/fund payer balance: ${describeError(error)}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
