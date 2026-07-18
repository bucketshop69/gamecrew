// Privy SDK polyfills (per @privy-io/expo's README) -- must be imported as
// early as possible, before any Privy/crypto code runs. This file is the
// first app-owned module Metro evaluates after expo-router/entry's own
// bootstrap, so it's the earliest hookable point in this app for them.
import 'fast-text-encoding';
import 'react-native-get-random-values';
import '@ethersproject/shims';

import { PrivyProvider } from '@privy-io/expo';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';

export const unstable_settings = {
  anchor: 'index',
};

/**
 * Playful Economy V1's Privy social-login integration (docs/plans/playful-economy-v1.md
 * "On-chain claim"): `PrivyProvider` must wrap the whole app so
 * `useLoginWithOAuth`/`useEmbeddedSolanaWallet` are callable from anywhere
 * that later triggers a claim (currently the pile sheet in
 * `src/screens/gamecrew-screens.tsx`).
 *
 * Gated on `EXPO_PUBLIC_PRIVY_APP_ID`/`EXPO_PUBLIC_PRIVY_CLIENT_ID`: when
 * either is missing (e.g. no `.env` configured for this build), the app
 * renders without `PrivyProvider` entirely rather than crashing on an empty
 * appId -- the claim UI degrades to a graceful "Claiming unavailable" state
 * (see economy-pile-sheet.tsx's `privyAvailable` prop) and everything else
 * in the app is unaffected. This mirrors the "missing id -> claim shows a
 * graceful unavailable state, everything else unaffected" requirement.
 */
export default function RootLayout() {
  const privyAppId = process.env.EXPO_PUBLIC_PRIVY_APP_ID;
  const privyClientId = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID;

  const app = (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false }} />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );

  if (!privyAppId || !privyClientId) {
    return app;
  }

  return (
    <PrivyProvider appId={privyAppId} clientId={privyClientId}>
      {app}
    </PrivyProvider>
  );
}
