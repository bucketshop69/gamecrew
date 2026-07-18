import type {
  EconomyBalances,
  EconomyEvent,
  EconomyItemId,
  EconomyUserAction,
  MatchEngineParticipant,
} from '@gamecrew/core';

import type { EconomyChatMessage } from './economy-stream';

/**
 * A single, global, device-scoped store for the local user's Playful Economy
 * state (see docs/prds/playful_economy.md, docs/plans/playful-economy-poc.md).
 * Unlike `EconomySession` (one per fixture, refcounted), there is exactly one
 * `UserPileStore` per device: coolness and the junk pile are cross-match per
 * the PRD's Profile section, so this store is not keyed by fixtureId.
 *
 * It owns two kinds of raw, persisted state -- balances are *never* stored,
 * only ever folded from these logs via `foldEconomyBalances`:
 *
 * 1. The local user's own action log per fixture (`gift_claimed`,
 *    `bet_taken`), which `EconomySession` feeds into `buildEconomyTimeline`
 *    as `options.actions`. This is the write path for claim/take.
 * 2. A cached copy of each fixture's last-known `EconomyEvent[]` log, so
 *    `useUserPile()` (the Profile surface) can report a cross-match total
 *    without every fixture's `EconomySession` being mounted simultaneously.
 *    `EconomySession` pushes its latest event log into this cache as it
 *    changes; this store never re-derives events itself.
 *
 * Persistence is via injected storage deps (`UserPileStorage`), matching the
 * injected-deps convention used by `MatchSessionDeps`. No native dependency
 * is introduced here: `apps/mobile/package.json` does not currently depend
 * on `@react-native-async-storage/async-storage`, so the default export is a
 * plain in-memory store. Wiring a real AsyncStorage-backed `UserPileStorage`
 * later is a drop-in: same interface, no changes to this module.
 *
 * `foldEconomyBalances` itself is taken as an injected dependency
 * (`UserPileStoreDeps.foldBalances`) rather than imported at module scope:
 * this file has no runtime import of `@gamecrew/core`, matching the
 * constraint documented in `match-session.ts`/`playback-engine.ts` (their
 * package's `src/index.ts` re-exports modules by extensionless specifier,
 * which the mobile package's plain `node --experimental-strip-types` test
 * runner cannot resolve at runtime -- only type-only imports, erased before
 * execution, are safe here). Only the React hook layer (`use-economy.ts`)
 * imports the real function.
 */

export interface UserPileStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
}

/** In-memory default: persists for the process lifetime only. Real persistence is a later drop-in via `UserPileStorage`. */
export function createInMemoryUserPileStorage(): UserPileStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

const ACTIONS_KEY_PREFIX = 'gamecrew:economy:actions:';
const EVENTS_KEY_PREFIX = 'gamecrew:economy:events:';
const CHAT_KEY_PREFIX = 'gamecrew:economy:chat:';
const DEVICE_USER_KEY = 'gamecrew:economy:device-user-id';
/** Cross-fixture (device-wide), not per-fixture: "has this device ever seen the welcome gift popup, on any match, ever." See UX ruling in docs/plans/playful-economy-v1-ux-review.md section 7 -- the popup is a once-ever onboarding beat, not a per-match reset. */
const WELCOME_POPUP_SEEN_KEY = 'gamecrew:economy:welcome-popup-seen';

/** CHAT-004: a message longer than this is rejected outright rather than truncated (see `recordChatMessage`'s doc comment for the reasoning). */
export const CHAT_MESSAGE_MAX_LENGTH = 500;

export interface UserPileStoreDeps {
  storage: UserPileStorage;
  /** Injectable id generator for the device-local user id (tests supply a fixed value). */
  generateUserId?: () => string;
  /** Injectable id generator for chat message ids (tests supply a fixed/sequential value). */
  generateChatMessageId?: () => string;
  /** `foldEconomyBalances` from `@gamecrew/core`, injected -- see the module header comment for why. */
  foldBalances: (events: readonly EconomyEvent[]) => EconomyBalances;
}

export type UserPileListener = () => void;

/**
 * Loads/persists the local user's per-fixture action log and cached event
 * logs, and folds them into cross-fixture balances on demand. `load()` must
 * be awaited (or its returned promise observed) before balances reflect
 * persisted state; until then the store behaves as freshly-initialized
 * (empty logs), which is safe for a POC's one-local-user model.
 */
export class UserPileStore {
  private storage: UserPileStorage;
  private generateUserId: () => string;
  private generateChatMessageId: () => string;
  private foldBalances: (events: readonly EconomyEvent[]) => EconomyBalances;
  private listeners = new Set<UserPileListener>();

  private userId: string | undefined;
  /** Local action log, per fixture. */
  private actionsByFixture = new Map<string, EconomyUserAction[]>();
  /** Cached last-known engine event log, per fixture, pushed by EconomySession. */
  private eventsByFixture = new Map<string, readonly EconomyEvent[]>();
  /** Local, user-authored chat messages, per fixture (CHAT-001..011). Never fed into the engine -- see economy-stream.ts. */
  private chatMessagesByFixture = new Map<string, EconomyChatMessage[]>();
  /** Cross-fixture, device-wide: whether the welcome gift popup has ever been shown/claimed on this device. */
  private welcomePopupSeen = false;
  private loaded = false;
  private loadPromise: Promise<void> | undefined;

  constructor(deps: UserPileStoreDeps) {
    this.storage = deps.storage;
    this.generateUserId = deps.generateUserId ?? defaultGenerateUserId;
    this.generateChatMessageId = deps.generateChatMessageId ?? defaultGenerateChatMessageId;
    this.foldBalances = deps.foldBalances;
  }

  subscribe(listener: UserPileListener): () => void {
    this.listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
    };
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  /** Idempotent: safe to call from multiple hook mounts; subsequent calls return the same in-flight/completed promise. */
  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    const [storedUserId, storedPopupSeen] = await Promise.all([
      this.storage.getItem(DEVICE_USER_KEY),
      this.storage.getItem(WELCOME_POPUP_SEEN_KEY),
    ]);
    if (typeof storedUserId === 'string' && storedUserId.length > 0) {
      this.userId = storedUserId;
    } else {
      this.userId = this.generateUserId();
      await this.storage.setItem(DEVICE_USER_KEY, this.userId);
    }
    this.welcomePopupSeen = storedPopupSeen === '1';
    this.loaded = true;
    this.emit();
  }

  /** Whether the welcome gift popup has ever been shown/claimed/skipped on this device, across every fixture. `load()` should be awaited first; returns `false` (never seen) if called before load resolves, which is the safe default for a first-ever run. */
  hasSeenWelcomePopup(): boolean {
    return this.welcomePopupSeen;
  }

  /** Marks the welcome popup as seen, device-wide, persisted so it never reappears on a later match or after a restart. Idempotent. */
  markWelcomePopupSeen(): void {
    if (this.welcomePopupSeen) return;
    this.welcomePopupSeen = true;
    void this.storage.setItem(WELCOME_POPUP_SEEN_KEY, '1');
    this.emit();
  }

  /** Synchronous accessor; `load()` should be awaited first, but a stable id is always returned (generated on first access if needed). */
  getUserId(): string {
    if (!this.userId) {
      // Not yet loaded (or load() never called): generate a transient id so
      // callers never crash. This id will be replaced once load() resolves,
      // reading (or writing) the persisted one.
      this.userId = this.generateUserId();
    }
    return this.userId;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  getActionsForFixture(fixtureId: string): readonly EconomyUserAction[] {
    return this.actionsByFixture.get(fixtureId) ?? [];
  }

  /** Appends a local action for this fixture and persists the updated log. Fire-and-forget on the persistence write (raw actions are never load-bearing for this call's synchronous effect). */
  private appendAction(fixtureId: string, action: EconomyUserAction): void {
    const existing = this.actionsByFixture.get(fixtureId) ?? [];
    const next = [...existing, action];
    this.actionsByFixture.set(fixtureId, next);
    void this.persistActions(fixtureId, next);
    this.emit();
  }

  recordGiftClaimed(fixtureId: string, anchorFrameId: string, claimedAt: number): void {
    const already = this.actionsByFixture.get(fixtureId)?.some((a) => a.kind === 'gift_claimed');
    if (already) return;
    this.appendAction(fixtureId, { kind: 'gift_claimed', anchorFrameId, claimedAt });
  }

  /**
   * `pickedParticipant` is required for a `who_scores_next` take (the team
   * pick) and ignored by the engine for every other predicate -- see
   * `EconomyBetTakenAction.pickedParticipant` in `packages/core`. Optional
   * here so every other call type's existing call sites (two-arg) keep
   * compiling unchanged.
   */
  recordBetTaken(
    fixtureId: string,
    promptId: string,
    itemId: EconomyItemId,
    pickedParticipant?: MatchEngineParticipant,
  ): void {
    const already = this.actionsByFixture.get(fixtureId)?.some(
      (a) => a.kind === 'bet_taken' && a.promptId === promptId,
    );
    if (already) return;
    this.appendAction(fixtureId, { kind: 'bet_taken', promptId, itemId, pickedParticipant });
  }

  /** Called by EconomySession whenever its derived event log changes, so cross-fixture balances stay current without every fixture mounted. */
  cacheEventsForFixture(fixtureId: string, events: readonly EconomyEvent[]): void {
    this.eventsByFixture.set(fixtureId, events);
    void this.persistEvents(fixtureId, events);
    this.emit();
  }

  getEventsForFixture(fixtureId: string): readonly EconomyEvent[] {
    return this.eventsByFixture.get(fixtureId) ?? [];
  }

  /**
   * Records a local, user-authored chat message for a fixture (CHAT-001..011).
   * Rejects empty/whitespace-only input (CHAT-002/003) and over-length input
   * (CHAT-004, capped at `CHAT_MESSAGE_MAX_LENGTH`) as a no-op -- returns
   * `undefined` in both cases so the caller can distinguish "sent" from
   * "rejected" without throwing. Trimming happens here once, so a message
   * that is only whitespace never reaches the stream (CHAT-003) and a
   * message with meaningful leading/trailing whitespace is normalized
   * before storage.
   *
   * `releasedEventCountAtSend` is required from the caller (the hook layer,
   * which knows the current `EconomyStreamGate`'s released-event count for
   * this fixture) so `mergeEconomyStream` can interleave this message at the
   * correct position -- see economy-stream.ts.
   */
  recordChatMessage(
    fixtureId: string,
    text: string,
    releasedEventCountAtSend: number,
    sentAtMs: number,
  ): EconomyChatMessage | undefined {
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length > CHAT_MESSAGE_MAX_LENGTH) return undefined;

    const message: EconomyChatMessage = {
      id: this.generateChatMessageId(),
      fixtureId,
      text: trimmed,
      sentAtMs,
      releasedEventCountAtSend,
    };
    const existing = this.chatMessagesByFixture.get(fixtureId) ?? [];
    const next = [...existing, message];
    this.chatMessagesByFixture.set(fixtureId, next);
    void this.persistChatMessages(fixtureId, next);
    this.emit();
    return message;
  }

  getChatMessagesForFixture(fixtureId: string): readonly EconomyChatMessage[] {
    return this.chatMessagesByFixture.get(fixtureId) ?? [];
  }

  /** Folds every cached fixture's event log into one cross-match balance (coolness + pile), per the Profile surface. */
  getBalances(): EconomyBalances {
    const allEvents: EconomyEvent[] = [];
    for (const events of this.eventsByFixture.values()) {
      allEvents.push(...events);
    }
    return this.foldBalances(allEvents);
  }

  /**
   * Restores persisted actions + cached events + chat messages for a fixture
   * from storage (PERS-002/009/011). Callers **must `await` this before
   * acquiring/building that fixture's `EconomySession`** -- see
   * `use-economy.ts`'s effect ordering: building the timeline before
   * hydration completes would run `buildEconomyTimeline` with an empty
   * local-actions array on a returning user, incorrectly re-offering the
   * gift popup (PERS-007) because the persisted `gift_claimed` action
   * hadn't been restored yet when the engine first ran.
   */
  async hydrateFixture(fixtureId: string): Promise<void> {
    const [rawActions, rawEvents, rawChat] = await Promise.all([
      this.storage.getItem(ACTIONS_KEY_PREFIX + fixtureId),
      this.storage.getItem(EVENTS_KEY_PREFIX + fixtureId),
      this.storage.getItem(CHAT_KEY_PREFIX + fixtureId),
    ]);
    if (typeof rawActions === 'string' && rawActions.length > 0) {
      try {
        this.actionsByFixture.set(fixtureId, JSON.parse(rawActions) as EconomyUserAction[]);
      } catch {
        // Corrupt/incompatible persisted payload: start this fixture clean rather than throw (PERS-003).
      }
    }
    if (typeof rawEvents === 'string' && rawEvents.length > 0) {
      try {
        this.eventsByFixture.set(fixtureId, JSON.parse(rawEvents) as EconomyEvent[]);
      } catch {
        // Corrupt/incompatible persisted payload: start this fixture clean rather than throw (PERS-003).
      }
    }
    if (typeof rawChat === 'string' && rawChat.length > 0) {
      try {
        this.chatMessagesByFixture.set(fixtureId, JSON.parse(rawChat) as EconomyChatMessage[]);
      } catch {
        // Corrupt/incompatible persisted payload: start this fixture clean rather than throw (PERS-003).
      }
    }
    this.emit();
  }

  private async persistActions(fixtureId: string, actions: readonly EconomyUserAction[]): Promise<void> {
    await this.storage.setItem(ACTIONS_KEY_PREFIX + fixtureId, JSON.stringify(actions));
  }

  private async persistEvents(fixtureId: string, events: readonly EconomyEvent[]): Promise<void> {
    await this.storage.setItem(EVENTS_KEY_PREFIX + fixtureId, JSON.stringify(events));
  }

  private async persistChatMessages(fixtureId: string, messages: readonly EconomyChatMessage[]): Promise<void> {
    await this.storage.setItem(CHAT_KEY_PREFIX + fixtureId, JSON.stringify(messages));
  }
}

function defaultGenerateUserId(): string {
  return `local-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function defaultGenerateChatMessageId(): string {
  return `chat-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

let sharedStore: UserPileStore | undefined;

/**
 * Module-level singleton, mirroring the shared-registry convention used by
 * MatchSession's per-fixture registry (this one is global, not
 * fixtureId-keyed). `deps` is only consulted on the first call for the
 * process lifetime (mirroring `acquireMatchSession`'s "deps required in full
 * on first acquisition" contract); the React hook layer
 * (`use-economy.ts`) is the only caller that supplies `foldBalances` (the
 * real `foldEconomyBalances` from `@gamecrew/core`) and a real storage
 * backend. Tests should construct `UserPileStore` directly instead of going
 * through this singleton.
 */
export function getUserPileStore(deps: UserPileStoreDeps): UserPileStore {
  if (!sharedStore) {
    sharedStore = new UserPileStore(deps);
  }
  return sharedStore;
}

/** Test-only helper: force a fresh singleton between test cases. */
export function __resetUserPileStoreForTests(): void {
  sharedStore = undefined;
}
