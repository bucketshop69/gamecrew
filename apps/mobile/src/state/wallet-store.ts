import type { EconomyItemId } from '@gamecrew/core';

/**
 * Device-scoped store for the Solana claim flow (see docs/prds/playful_economy.md,
 * docs/plans/playful-economy-v1.md "On-chain claim"). One `WalletStore` per
 * device: it does NOT provision a wallet itself -- V1 replaces the POC's
 * server-side custodial keypair with **Privy social login**, which resolves
 * a wallet address client-side (Google/Apple) and hands it to this store via
 * `setWalletAddress()`. This store's job is purely the local claim ledger:
 * submit-with-idempotency, poll-with-backoff, persist-across-restart.
 *
 * Like `UserPileStore`, this module has no *runtime* import of
 * `@gamecrew/core` or of `../api/gamecrew` -- both the backend fetchers and
 * id generators are injected (`WalletStoreDeps`), so this file stays
 * importable by the mobile package's plain `node --experimental-strip-types`
 * test runner (the one `EconomyItemId` import below is `import type`, erased
 * at compile time, so it adds no runtime dependency). Only the React hook
 * layer (`use-wallet.ts`) wires in the real API client, real Privy SDK, and
 * real timers.
 *
 * Idempotency (CLAIM-008/009, the QA catalogue's #0 risk area): `claimItem`
 * is keyed by `sourceEventId`. Before creating a new local claim record, it
 * looks for an existing record for the same `sourceEventId` that is still in
 * a non-terminal state (`sending`/`pending`) or already terminally succeeded
 * (`minted`) -- in either case it returns that existing record's `localId`
 * unchanged rather than creating a second one or re-sending the request.
 * Only a previously `failed` (or `not_sent`, i.e. never actually sent while
 * offline) claim for the same `sourceEventId` is allowed to create a new
 * record, which is the explicit "retry" path (CLAIM-007): the retry still
 * carries the identical `sourceEventId`, so even if this client-side guard
 * were somehow bypassed, the server's `(userId, sourceEventId)` unique index
 * is the second line of defense per the PRD/QA catalogue.
 *
 * Degradation: no wallet address yet -> status stays `'no_wallet'` (this is
 * the expected state for every user until they first tap "Claim on-chain" --
 * CLAIM-012, no wallet concept is ever surfaced before that). Once an
 * address is set, `createClaim`/`fetchClaim` network failures flip status to
 * `'offline'` rather than throwing -- the rest of the Playful Economy is
 * fully client-side and must keep working with no chain connectivity at all
 * (CLAIM-005). Claims attempted while offline (or before a wallet address is
 * set) are recorded locally as `'not_sent'` rather than dropped, so the UI
 * can still show the user attempted the claim, and retrying later (once
 * online / address is set) re-attempts the same record.
 */

export type WalletStatus = 'no_wallet' | 'ready' | 'offline';

export type LocalClaimStatus = 'sending' | 'pending' | 'minted' | 'failed' | 'not_sent';

/** In-flight statuses: a claim already tracked here for the same sourceEventId must not be duplicated (CLAIM-008/009). */
const IN_FLIGHT_OR_DONE_STATUSES: ReadonlySet<LocalClaimStatus> = new Set(['sending', 'pending', 'minted']);

export interface WalletClaimInput {
  fixtureId: string;
  itemId: EconomyItemId;
  quantity: number;
  sourceEventId: string;
}

export interface WalletClaimSnapshot {
  /** Stable local key, always present. Equal to the server claimId once known. */
  localId: string;
  claimId?: string;
  fixtureId: string;
  itemId: EconomyItemId;
  quantity: number;
  sourceEventId: string;
  status: LocalClaimStatus;
  mintAddress?: string;
  txSignature?: string;
  explorerUrl?: string;
}

export interface WalletStoreSnapshot {
  walletAddress: string | null;
  status: WalletStatus;
  claims: readonly WalletClaimSnapshot[];
}

export type WalletStoreListener = () => void;

export interface WalletStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
}

/** In-memory default: persists for the process lifetime only, mirroring `createInMemoryUserPileStorage`. */
export function createInMemoryWalletStorage(): WalletStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

const WALLET_ADDRESS_KEY = 'gamecrew:economy:wallet-address';
const CLAIMS_KEY = 'gamecrew:economy:wallet-claims';

export interface CreateClaimResult {
  claimId: string;
  status: 'pending' | 'minted' | 'failed';
  mintAddress?: string;
  txSignature?: string;
  explorerUrl?: string;
}

export interface FetchClaimResult {
  claimId: string;
  status: 'pending' | 'minted' | 'failed';
  mintAddress?: string;
  txSignature?: string;
  explorerUrl?: string;
}

export interface WalletStoreDeps {
  storage: WalletStorage;
  /** Injectable id generator for local claim ids (tests supply a fixed/sequential value). */
  generateLocalClaimId?: () => string;
  createClaim: (
    input: { walletAddress: string; fixtureId: string; itemId: string; quantity: number; sourceEventId: string },
    options: { signal?: AbortSignal },
  ) => Promise<CreateClaimResult>;
  fetchClaim: (claimId: string, options: { signal?: AbortSignal }) => Promise<FetchClaimResult>;
  isAbortError: (error: unknown) => boolean;
  /** setTimeout-alike, injectable for tests. */
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Base poll interval for a claim's status; backoff doubles this up to a cap. */
  pollIntervalMs?: number;
  pollBackoffCapMs?: number;
  pollMaxAttempts?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_BACKOFF_CAP_MS = 15_000;
const DEFAULT_POLL_MAX_ATTEMPTS = 12;

function defaultGenerateLocalClaimId(): string {
  return `local-claim-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

interface ClaimRecord extends WalletClaimSnapshot {
  attempts: number;
  timerHandle?: unknown;
}

/**
 * Owns the wallet address (set by Privy, via `setWalletAddress`) and the
 * local claim ledger. Not refcounted like `EconomySession`/`MatchSession` --
 * there is exactly one wallet per device, mirroring `UserPileStore`'s "one
 * per device" shape, so a single shared singleton (`getWalletStore`) is
 * exposed for the hook layer.
 */
export class WalletStore {
  private storage: WalletStorage;
  private generateLocalClaimId: () => string;
  private deps: WalletStoreDeps;
  private listeners = new Set<WalletStoreListener>();

  private walletAddress: string | null = null;
  private status: WalletStatus = 'no_wallet';

  private claims = new Map<string, ClaimRecord>();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private disposed = false;

  constructor(deps: WalletStoreDeps) {
    this.storage = deps.storage;
    this.generateLocalClaimId = deps.generateLocalClaimId ?? defaultGenerateLocalClaimId;
    this.deps = deps;
  }

  subscribe(listener: WalletStoreListener): () => void {
    this.listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
    };
  }

  private emit() {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  getSnapshot(): WalletStoreSnapshot {
    return {
      walletAddress: this.walletAddress,
      status: this.status,
      claims: [...this.claims.values()].map(toClaimSnapshot),
    };
  }

  /**
   * Restores the persisted wallet address (if Privy previously resolved one
   * this device) and every persisted claim (CLAIM-010), then resumes polling
   * for any claim still `pending` when the app closed (CLAIM-011) rather
   * than leaving it stuck. Idempotent: safe to call from multiple hook
   * mounts.
   */
  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    const [rawAddress, rawClaims] = await Promise.all([
      this.storage.getItem(WALLET_ADDRESS_KEY),
      this.storage.getItem(CLAIMS_KEY),
    ]);

    if (typeof rawAddress === 'string' && rawAddress.length > 0) {
      this.walletAddress = rawAddress;
      this.status = 'ready';
    }

    if (typeof rawClaims === 'string' && rawClaims.length > 0) {
      try {
        const parsed = JSON.parse(rawClaims) as WalletClaimSnapshot[];
        for (const snapshot of parsed) {
          this.claims.set(snapshot.localId, { ...snapshot, attempts: 0 });
        }
      } catch {
        // Corrupt/incompatible persisted payload: start with an empty ledger rather than throw (PERS-003-equivalent for claims).
      }
    }

    this.loaded = true;
    this.emit();

    // CLAIM-011: a claim still `pending` when the app closed needs its
    // polling resumed, not left stuck on "minting..." forever.
    for (const record of this.claims.values()) {
      if (record.status === 'pending' && record.claimId) {
        this.schedulePoll(record.localId, record.claimId, 0);
      }
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Called once Privy resolves a wallet address (social login success).
   * Flips status to `ready` and flushes any claims that were queued locally
   * as `not_sent` while there was no wallet yet, so a claim attempted before
   * login (should not happen per CLAIM-012, but defensive) still completes
   * once the user does log in.
   */
  setWalletAddress(address: string): void {
    this.walletAddress = address;
    this.status = 'ready';
    void this.storage.setItem(WALLET_ADDRESS_KEY, address);
    this.emit();

    for (const [localId, record] of this.claims.entries()) {
      if (record.status === 'not_sent') {
        void this.sendClaim(localId, {
          fixtureId: record.fixtureId,
          itemId: record.itemId,
          quantity: record.quantity,
          sourceEventId: record.sourceEventId,
        });
      }
    }
  }

  /** CLAIM-004: login cancelled mid-claim -- explicitly reverts any `not_sent` claims back out of the ledger so the pile item returns to `unclaimed`, retryable. */
  cancelPendingLogin(): void {
    let changed = false;
    for (const [localId, record] of this.claims.entries()) {
      if (record.status === 'not_sent') {
        this.claims.delete(localId);
        changed = true;
      }
    }
    if (changed) {
      void this.persistClaims();
      this.emit();
    }
  }

  /**
   * Fire-and-forget: submits the claim, tracks it locally, and (if online
   * and a wallet address exists) begins polling for its resolution.
   *
   * Idempotency (CLAIM-008/009): if a claim for this exact `sourceEventId`
   * already exists and is `sending`/`pending`/`minted`, returns that
   * existing record's `localId` unchanged -- no new record, no new network
   * call. A `failed` (or `not_sent`) prior claim for the same
   * `sourceEventId` is allowed to create a fresh record (the retry path,
   * CLAIM-007), appended rather than mutating the old one, so
   * `itemClaimStatus`'s "last claim for that item wins" contract still
   * resolves to the new attempt.
   */
  claimItem(input: WalletClaimInput): string {
    const existing = [...this.claims.values()].find((record) => record.sourceEventId === input.sourceEventId);
    if (existing && IN_FLIGHT_OR_DONE_STATUSES.has(existing.status)) {
      return existing.localId;
    }

    const localId = this.generateLocalClaimId();
    const base: ClaimRecord = {
      localId,
      fixtureId: input.fixtureId,
      itemId: input.itemId,
      quantity: input.quantity,
      sourceEventId: input.sourceEventId,
      // Gated on `walletAddress` presence, not the store's current `status`:
      // `status` can independently reflect a transient offline blip from an
      // earlier failed attempt while the Privy-resolved address itself is
      // still perfectly valid -- a retry (CLAIM-007) must always get a
      // fresh attempt as long as an address exists, not stay wedged at
      // `not_sent` because of a previous unrelated claim's failure.
      status: this.walletAddress ? 'sending' : 'not_sent',
      attempts: 0,
    };
    this.claims.set(localId, base);
    void this.persistClaims();
    this.emit();

    if (base.status === 'not_sent') {
      return localId;
    }

    void this.sendClaim(localId, input);
    return localId;
  }

  private async sendClaim(localId: string, input: WalletClaimInput): Promise<void> {
    if (this.disposed) return;
    const record = this.claims.get(localId);
    if (!record) return;

    if (!this.walletAddress) {
      record.status = 'not_sent';
      void this.persistClaims();
      this.emit();
      return;
    }

    try {
      const result = await this.deps.createClaim(
        {
          walletAddress: this.walletAddress,
          fixtureId: input.fixtureId,
          itemId: input.itemId,
          quantity: input.quantity,
          sourceEventId: input.sourceEventId,
        },
        {},
      );
      if (this.disposed) return;
      const current = this.claims.get(localId);
      if (!current) return;
      current.claimId = result.claimId;
      current.status = result.status;
      current.mintAddress = result.mintAddress;
      current.txSignature = result.txSignature;
      current.explorerUrl = result.explorerUrl;
      // A successful round-trip (regardless of the claim's own status)
      // proves the API is reachable again -- clear any prior offline flag.
      if (this.status === 'offline') this.status = 'ready';
      void this.persistClaims();
      this.emit();

      if (result.status === 'pending') {
        this.schedulePoll(localId, result.claimId, 0);
      }
    } catch (error) {
      if (this.deps.isAbortError(error)) return;
      if (this.disposed) return;
      const current = this.claims.get(localId);
      if (!current) return;
      // CLAIM-005: API unreachable -- surface `failed` (with retry), and
      // flip the store to `offline` so the rest of the UI can show the
      // wallet-offline state without the economy loop itself breaking.
      current.status = 'failed';
      this.status = 'offline';
      void this.persistClaims();
      this.emit();
    }
  }

  private schedulePoll(localId: string, claimId: string, attempt: number): void {
    const record = this.claims.get(localId);
    if (!record) return;

    const maxAttempts = this.deps.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;
    if (attempt >= maxAttempts) {
      // Give up polling; leave status as whatever it last was (pending) so
      // the UI can still show it, without spinning forever.
      return;
    }

    const base = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const cap = this.deps.pollBackoffCapMs ?? DEFAULT_POLL_BACKOFF_CAP_MS;
    const delayMs = Math.min(base * 2 ** attempt, cap);

    record.timerHandle = this.deps.setTimer(() => {
      record.timerHandle = undefined;
      void this.pollClaim(localId, claimId, attempt);
    }, delayMs);
  }

  private async pollClaim(localId: string, claimId: string, attempt: number): Promise<void> {
    if (this.disposed) return;
    const record = this.claims.get(localId);
    if (!record) return;

    try {
      const result = await this.deps.fetchClaim(claimId, {});
      if (this.disposed) return;
      const current = this.claims.get(localId);
      if (!current) return;

      current.status = result.status;
      current.mintAddress = result.mintAddress;
      current.txSignature = result.txSignature;
      current.explorerUrl = result.explorerUrl;
      void this.persistClaims();
      this.emit();

      if (result.status === 'pending') {
        this.schedulePoll(localId, claimId, attempt + 1);
      }
      // 'minted' / 'failed': terminal, stop polling.
    } catch (error) {
      if (this.deps.isAbortError(error)) return;
      if (this.disposed) return;
      // Transient poll failure: keep the claim's last-known status and retry
      // with backoff rather than marking it failed outright.
      this.schedulePoll(localId, claimId, attempt + 1);
    }
  }

  private async persistClaims(): Promise<void> {
    const snapshots = [...this.claims.values()].map(toClaimSnapshot);
    await this.storage.setItem(CLAIMS_KEY, JSON.stringify(snapshots));
  }

  /** Test/debug helper: number of claims currently tracked. */
  claimCount(): number {
    return this.claims.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const record of this.claims.values()) {
      if (record.timerHandle !== undefined) {
        this.deps.clearTimer(record.timerHandle);
      }
    }
    this.listeners.clear();
  }
}

function toClaimSnapshot(record: ClaimRecord): WalletClaimSnapshot {
  return {
    localId: record.localId,
    claimId: record.claimId,
    fixtureId: record.fixtureId,
    itemId: record.itemId,
    quantity: record.quantity,
    sourceEventId: record.sourceEventId,
    status: record.status,
    mintAddress: record.mintAddress,
    txSignature: record.txSignature,
    explorerUrl: record.explorerUrl,
  };
}

let sharedStore: WalletStore | undefined;

/**
 * Module-level singleton, mirroring `getUserPileStore`: `deps` is only
 * consulted on the first call for the process lifetime. The React hook layer
 * (`use-wallet.ts`) is the only caller that supplies the real API client
 * functions and real storage/timers. Tests should construct `WalletStore`
 * directly instead of going through this singleton.
 */
export function getWalletStore(deps: WalletStoreDeps): WalletStore {
  if (!sharedStore) {
    sharedStore = new WalletStore(deps);
  }
  return sharedStore;
}

/** Test-only helper: force a fresh singleton between test cases. */
export function __resetWalletStoreForTests(): void {
  sharedStore = undefined;
}
