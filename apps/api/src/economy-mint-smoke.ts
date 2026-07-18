import { Keypair } from '@solana/web3.js';
import { Connection } from '@solana/web3.js';
import { ensurePayerFunded, loadOrCreatePayerKeypair } from './economy/payer.js';
import { createRealNftMinter, explorerUrlForSignature } from './economy/nft-minter.js';
import { loadConfig } from './config.js';

/**
 * ONE real manual devnet verification: provision a payer (reusing/creating
 * `apps/api/.economy-payer.json`), fund it via airdrop if needed, mint one
 * GameCrew gift NFT to a throwaway devnet keypair, and print the explorer
 * URL. This is intentionally NOT part of the automated test suite --
 * `pnpm test` never touches devnet; this script is the one exception, run
 * by hand.
 *
 * Usage: pnpm --filter @gamecrew/api economy:mint-smoke
 */

async function main() {
  const config = loadConfig();
  const payer = loadOrCreatePayerKeypair(config.economyPayerPath);
  const connection = new Connection(config.solanaRpcUrl, 'confirmed');

  console.log(JSON.stringify({ event: 'payer_ready', address: payer.publicKey.toBase58() }));

  const funding = await ensurePayerFunded(connection, payer, { retries: 5, retryDelayMs: 2_000 });
  console.log(JSON.stringify({ event: 'payer_funding_result', ...funding }));
  if (!funding.funded) {
    console.error(JSON.stringify({
      event: 'blocked_devnet_airdrop_rate_limited',
      reason: funding.reason,
      note: 'Could not fund the payer after retries. This is a devnet faucet rate-limit, not a code bug. Re-run later or fund the payer address manually via https://faucet.solana.com.',
      payerAddress: payer.publicKey.toBase58(),
    }));
    process.exitCode = 1;
    return;
  }

  const throwawayRecipient = Keypair.generate();
  console.log(JSON.stringify({ event: 'throwaway_recipient', address: throwawayRecipient.publicKey.toBase58() }));

  const minter = createRealNftMinter({ rpcUrl: config.solanaRpcUrl, payer });
  const result = await minter.mint({
    ownerAddress: throwawayRecipient.publicKey.toBase58(),
    fixtureId: 'smoke-test-fixture',
    itemId: 'bananas',
    quantity: 24,
    minute: 58,
  });

  console.log(JSON.stringify({
    event: 'mint_succeeded',
    mintAddress: result.mintAddress,
    txSignature: result.txSignature,
    explorerUrl: explorerUrlForSignature(result.txSignature),
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'economy_mint_smoke_failed', reason: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
