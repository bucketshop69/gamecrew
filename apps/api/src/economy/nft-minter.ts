import { create } from '@metaplex-foundation/mpl-core';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  createSignerFromKeypair,
  generateSigner,
  publicKey,
  signerIdentity,
  type Umi,
} from '@metaplex-foundation/umi';
import type { Keypair as Web3Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Devnet NFT minting for claimed Playful Economy gifts (see
 * docs/prds/playful_economy.md, "Solana Layer"). Minting is injectable so
 * routes/workers can run against a fake minter in tests and never touch
 * devnet outside the one manual verification script.
 *
 * Minted assets are plain transferable mpl-core assets (product decision,
 * Bibhu 2026-07-18): gifts are only ever acquired free in-app, so secondary
 * trading is the owner's business. Revisit if in-app purchases of stakeable
 * items ever enter the product (see the PRD's Solana Layer boundary note).
 */

export interface MintGiftInput {
  /** Recipient wallet address (base58), supplied by the client via Privy -- never server-custodial. */
  ownerAddress: string;
  fixtureId: string;
  itemId: string;
  quantity: number;
  minute?: number;
}

export interface MintGiftResult {
  mintAddress: string;
  txSignature: string;
}

export interface NftMinter {
  mint(input: MintGiftInput): Promise<MintGiftResult>;
}

/** Builds the on-chain display name, e.g. "GameCrew: 24 Bananas — 58'". */
export function buildGiftAssetName(input: Pick<MintGiftInput, 'itemId' | 'quantity' | 'minute'>): string {
  const label = itemLabel(input.itemId);
  const minuteSuffix = input.minute === undefined ? '' : ` — ${input.minute}'`;
  return `GameCrew: ${input.quantity} ${label}${minuteSuffix}`;
}

/**
 * Builds an inline `data:` URI metadata JSON document carrying the moment
 * (fixture, item, quantity, minute) -- the provenance is the collectible,
 * per the PRD. No external metadata host is stood up for this POC.
 */
export function buildGiftMetadataDataUri(input: MintGiftInput): string {
  const name = buildGiftAssetName(input);
  const metadata = {
    name,
    description: `A GameCrew gift claimed on-chain: ${input.quantity} ${itemLabel(input.itemId)} from fixture ${input.fixtureId}${input.minute === undefined ? '' : ` at minute ${input.minute}`}.`,
    image: PLACEHOLDER_IMAGE_URI,
    attributes: [
      { trait_type: 'fixtureId', value: input.fixtureId },
      { trait_type: 'item', value: input.itemId },
      { trait_type: 'quantity', value: input.quantity },
      ...(input.minute === undefined ? [] : [{ trait_type: 'minute', value: input.minute }]),
    ],
    properties: {
      category: 'image',
      gamecrew: {
        fixtureId: input.fixtureId,
        item: input.itemId,
        quantity: input.quantity,
        minute: input.minute ?? null,
      },
    },
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString('base64')}`;
}

// 1x1 transparent PNG, inlined so the POC never depends on an external asset host.
const PLACEHOLDER_IMAGE_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function itemLabel(itemId: string): string {
  return itemId
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export interface RealNftMinterOptions {
  rpcUrl: string;
  payer: Web3Keypair;
}

/**
 * Real devnet minter using @metaplex-foundation/mpl-core over umi. One
 * `Umi` instance is built per minter and reused across mints (the payer
 * keypair never changes at runtime).
 */
export function createRealNftMinter(options: RealNftMinterOptions): NftMinter {
  const umi = createUmi(options.rpcUrl);
  const payerSigner = createSignerFromKeypair(umi, {
    publicKey: publicKey(options.payer.publicKey.toBase58()),
    secretKey: options.payer.secretKey,
  });
  umi.use(signerIdentity(payerSigner, true));

  return {
    async mint(input: MintGiftInput): Promise<MintGiftResult> {
      const asset = generateSigner(umi);
      const owner = publicKey(input.ownerAddress);
      const name = buildGiftAssetName(input);
      const uri = buildGiftMetadataDataUri(input);

      const { signature } = await create(umi, {
        asset,
        name,
        uri,
        owner,
      }).sendAndConfirm(umi);

      return {
        mintAddress: asset.publicKey.toString(),
        txSignature: bs58.encode(Buffer.from(signature)),
      };
    },
  };
}

export function explorerUrlForSignature(txSignature: string): string {
  return `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;
}

// Re-exported for callers that only need typing, e.g. tests constructing fakes.
export type { Umi };
