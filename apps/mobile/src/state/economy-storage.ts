/**
 * Production storage backend shared by `UserPileStore` and `WalletStore`:
 * both take a `{ getItem, setItem }` interface shaped identically
 * (`UserPileStorage` / `WalletStorage`), so one adapter over
 * `@react-native-async-storage/async-storage` covers both rather than
 * duplicating the wrapper.
 *
 * This module is only imported by the React hook layer (`use-economy.ts` /
 * `use-wallet.ts`), never by `user-pile-store.ts`/`wallet-store.ts`
 * themselves and never by a plain-Node test file: `@react-native-async-storage`
 * is a native module and cannot load under the mobile package's plain
 * `node --experimental-strip-types` test runner (no RN host). Tests
 * continue to use `createInMemoryUserPileStorage` / `createInMemoryWalletStorage`.
 *
 * `setItem` failures (PERS-010: disk full / AsyncStorage throws) are caught
 * and swallowed here rather than propagated: the store's in-memory state
 * already updated synchronously before the write was attempted, so a
 * persistence failure degrades to "this session only" rather than crashing
 * the app. `getItem` failures are also caught and treated as "no persisted
 * value" (same effect as a fresh install) for the same reason.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
}

export function createAsyncStorageBackedStorage(): KeyValueStorage {
  return {
    getItem: async (key) => {
      try {
        return await AsyncStorage.getItem(key);
      } catch {
        // Corrupt/unavailable storage (PERS-003, PERS-010): behave as if the
        // key was never set rather than throwing past the caller.
        return null;
      }
    },
    setItem: async (key, value) => {
      try {
        await AsyncStorage.setItem(key, value);
      } catch {
        // Write failure: in-memory state already reflects the change: swallow
        // rather than crash (PERS-010).
      }
    },
  };
}
