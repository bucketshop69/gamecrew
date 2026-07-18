import type { EconomyItemId } from '@gamecrew/core';
import { useEffect, useMemo, useState } from 'react';

import { createEconomyClaim, fetchEconomyClaim, isAbortError } from '../api/gamecrew';
import { createAsyncStorageBackedStorage } from './economy-storage';
import {
  getWalletStore,
  type WalletClaimInput,
  type WalletStatus,
} from './wallet-store';

// This file is only consumed by React screens (bundled by Metro), never by
// the mobile package's plain-Node test runner -- same constraint documented
// in use-economy.ts. It is the only module that wires the real API client,
// real AsyncStorage, and real timers into WalletStore.
//
// V1 note: Privy itself (the social-login SDK call that resolves a wallet
// address) is NOT wired here -- per the coordinator's brief, the UI layer
// owns triggering Privy's login flow and will call this hook's
// `setWalletAddress(address)` once Privy resolves an address, or
// `cancelLogin()` if the user backs out mid-flow (CLAIM-004). This hook's
// job is everything after an address exists: submit-with-idempotency,
// poll-with-backoff, persist-across-restart. `EXPO_PUBLIC_PRIVY_APP_ID` and
// the Privy SDK integration itself are UI-layer concerns (see
// docs/plans/playful-economy-v1.md).

export interface ClaimView {
  localId: string;
  claimId?: string;
  itemId: EconomyItemId;
  quantity: number;
  status: 'sending' | 'pending' | 'minted' | 'failed' | 'not_sent';
  explorerUrl?: string;
  txSignature?: string;
  mintAddress?: string;
}

export interface UseWalletResult {
  walletAddress: string | null;
  walletStatus: WalletStatus;
  claims: readonly ClaimView[];
  claimItem: (input: WalletClaimInput) => void;
  /** Called by the UI once Privy resolves a wallet address (social login success). */
  setWalletAddress: (address: string) => void;
  /** Called by the UI if the user backs out of the Privy login prompt mid-claim (CLAIM-004). */
  cancelLogin: () => void;
}

function createDefaultWalletStore() {
  return getWalletStore({
    storage: createAsyncStorageBackedStorage(),
    createClaim: (input, options) => createEconomyClaim(input, options),
    fetchClaim: (claimId, options) => fetchEconomyClaim(claimId, options),
    isAbortError,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}

/**
 * React adapter over `WalletStore` -- the frozen contract for the Solana
 * claim flow UI (see docs/prds/playful_economy.md). Loads any persisted
 * wallet address + claim ledger on mount (CLAIM-010, resuming polling for
 * anything still `pending`, CLAIM-011), then exposes claim submission +
 * live status for every claim. Does not provision or prompt for a wallet
 * itself -- CLAIM-012 (no wallet/login concept surfaced before the user
 * taps "Claim on-chain") is satisfied by this hook staying inert
 * (`walletStatus: 'no_wallet'`) until the UI calls `setWalletAddress`.
 */
export function useWallet(): UseWalletResult {
  const store = useMemo(() => createDefaultWalletStore(), []);
  const [snapshot, setSnapshot] = useState(() => store.getSnapshot());

  useEffect(() => {
    void store.load();
    const unsubscribe = store.subscribe(() => setSnapshot(store.getSnapshot()));
    setSnapshot(store.getSnapshot());
    return unsubscribe;
  }, [store]);

  const claimItem = useMemo(
    () => (input: WalletClaimInput) => {
      store.claimItem(input);
    },
    [store],
  );

  const setWalletAddress = useMemo(
    () => (address: string) => {
      store.setWalletAddress(address);
    },
    [store],
  );

  const cancelLogin = useMemo(() => () => store.cancelPendingLogin(), [store]);

  const claims = useMemo<readonly ClaimView[]>(
    () =>
      snapshot.claims.map((claim) => ({
        localId: claim.localId,
        claimId: claim.claimId,
        itemId: claim.itemId,
        quantity: claim.quantity,
        status: claim.status,
        explorerUrl: claim.explorerUrl,
        txSignature: claim.txSignature,
        mintAddress: claim.mintAddress,
      })),
    [snapshot.claims],
  );

  return {
    walletAddress: snapshot.walletAddress,
    walletStatus: snapshot.status,
    claims,
    claimItem,
    setWalletAddress,
    cancelLogin,
  };
}
