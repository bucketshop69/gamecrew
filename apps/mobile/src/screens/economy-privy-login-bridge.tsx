import { useLoginWithOAuth, usePrivy, useEmbeddedSolanaWallet } from '@privy-io/expo';
import { useEffect, useRef, type RefObject } from 'react';

type SolanaWalletState = ReturnType<typeof useEmbeddedSolanaWallet>;

/**
 * Bridges Privy's real React hooks (`useLoginWithOAuth`,
 * `useEmbeddedSolanaWallet`) into a single imperative `login(provider)`
 * function the pile sheet can call, without the parent screen
 * (`gamecrew-screens.tsx`) ever calling a Privy hook directly.
 *
 * Why this indirection exists: `useLoginWithOAuth`/`useEmbeddedSolanaWallet`
 * only work inside a mounted `PrivyProvider` (see app/_layout.tsx), and
 * `PrivyProvider` itself is conditionally mounted on whether
 * `EXPO_PUBLIC_PRIVY_APP_ID`/`_CLIENT_ID` are configured -- calling those
 * hooks unconditionally in `MatchDetailScreen` would throw whenever Privy
 * isn't configured. React's rules of hooks forbid calling a hook
 * conditionally *within* one component, but conditionally mounting a whole
 * *component* is fine -- so this component is only ever rendered when
 * `PRIVY_AVAILABLE` is true (gamecrew-screens.tsx), and it hands its
 * `login` function up to the parent via `onReady` once mounted, exactly
 * once, so the parent can store it in a ref and call it from the pile
 * sheet's `onStartLogin` prop.
 *
 * Login sequence (per docs/plans/playful-economy-v1-ux.md section 6):
 * 1. `useLoginWithOAuth().login({ provider })` launches the social flow;
 *    resolves `undefined` on cancel/error (Privy's own contract), a `User`
 *    on success.
 * 2. On success, the embedded Solana wallet may not exist yet
 *    (`status === 'not-created'`) -- call `.create()` to provision one.
 *    `.create()` resolves a low-level `EmbeddedSolanaWalletProvider`
 *    (message/transaction signing only -- it does not expose the address
 *    directly, per `@privy-io/js-sdk-core`'s own types), so the address
 *    itself is read from `useEmbeddedSolanaWallet()`'s own `wallets[0].address`
 *    once that hook's state re-renders to `'connected'` -- `waitForConnectedWallet`
 *    below polls the ref for that transition with a short timeout rather
 *    than assuming a single render is enough.
 */
const CONNECT_POLL_INTERVAL_MS = 150;
const CONNECT_POLL_TIMEOUT_MS = 8000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `walletRef` (kept current every render by the caller) until
 * `useEmbeddedSolanaWallet()`'s state reaches `'connected'` with at least
 * one wallet, returning its address -- or `undefined` if it never connects
 * within `CONNECT_POLL_TIMEOUT_MS` (treated as a failed login by the
 * caller, retryable, same as a cancellation).
 */
async function waitForConnectedAddress(walletRef: RefObject<SolanaWalletState>): Promise<string | undefined> {
  const deadline = Date.now() + CONNECT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = walletRef.current;
    if (current.status === 'connected' && current.wallets[0]) {
      return current.wallets[0].address;
    }
    if (current.status === 'error') {
      return undefined;
    }
    await delay(CONNECT_POLL_INTERVAL_MS);
  }
  return undefined;
}
export function PrivyLoginBridge({
  onReady,
}: {
  onReady: (login: (provider: 'google' | 'apple') => Promise<string | undefined>) => void;
}) {
  const { login } = useLoginWithOAuth();
  const solanaWallet = useEmbeddedSolanaWallet();
  usePrivy();

  // Keep the latest wallet state in a ref so the stable `login` callback
  // below always reads current state without needing to be re-created (and
  // re-handed to the parent) every time solanaWallet's object identity
  // changes across renders.
  const solanaWalletRef = useRef(solanaWallet);
  solanaWalletRef.current = solanaWallet;

  useEffect(() => {
    onReady(async (provider) => {
      const user = await login({ provider });
      if (!user) {
        // Cancelled or errored -- Privy's own contract resolves undefined,
        // never throws, for a user-cancelled flow.
        return undefined;
      }

      if (solanaWalletRef.current.status === 'not-created') {
        const provisioned = await solanaWalletRef.current.create();
        if (!provisioned) return undefined;
      }

      return waitForConnectedAddress(solanaWalletRef);
    });
    // onReady is expected to be a stable callback (useCallback in the
    // parent); login/solanaWallet themselves are read via the ref above so
    // this effect intentionally does not need to re-run when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReady]);

  return null;
}
