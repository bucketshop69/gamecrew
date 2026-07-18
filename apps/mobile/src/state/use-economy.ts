import {
  buildEconomyTimeline,
  buildLeaderboard,
  foldEconomyBalances,
  type EconomyBetPrompt,
  type EconomyEvent,
  type EconomyItemId,
  type LeaderboardRow,
  type MatchEngineParticipant,
  type SemanticFrame,
} from '@gamecrew/core';
import { useEffect, useMemo, useRef, useState } from 'react';

import { createMatchSessionDefaultDeps } from './match-session-defaults';
import { acquireMatchSession } from './match-session';
import type { MatchSessionStatus } from './match-session';
import { acquireEconomySession, type EconomySessionHandle } from './economy-session';
import {
  EconomyStreamGate,
  mergeEconomyStream,
  type EconomyChatMessage,
  type EconomyStreamRow,
} from './economy-stream';
import { createAsyncStorageBackedStorage } from './economy-storage';
import { CHAT_MESSAGE_MAX_LENGTH, getUserPileStore } from './user-pile-store';

// This file is only consumed by React screens (bundled by Metro), never by
// the mobile package's plain-Node test runner, so static imports of the real
// director from @gamecrew/core and the real session deps are safe here --
// same constraint documented in use-playback-engine.ts.

export interface EconomyPileEntry {
  itemId: EconomyItemId;
  quantity: number;
}

/**
 * The frozen `useEconomy` contract (V1). Extends the POC shape with V1
 * additions:
 * - `sendMessage` / `EconomyStreamRow`-shaped `streamRows` for user chat
 *   input (CHAT-001..011). `streamEvents` (engine-only, gated) is kept
 *   unchanged for existing callers (`global-chat-logic.ts`'s
 *   `buildGlobalChatRows` consumes it directly) -- `streamRows` is additive,
 *   not a replacement.
 * - `poolSeed`/`poolSplit` surfaced from the engine's `pool_seeded`/
 *   `pool_split` events (now real `EconomyEventKind` members in
 *   `packages/core`, confirmed landed).
 */
export interface UseEconomyResult {
  pendingGift: boolean;
  claimGift: () => void;
  streamEvents: readonly EconomyEvent[];
  /** V1: engine events merged with the user's own local chat messages, in correct interleaved order (CHAT-001). Never gates/reorders `streamEvents` itself -- see economy-stream.ts's `mergeEconomyStream`. */
  streamRows: readonly EconomyStreamRow[];
  /** V1: send a local chat message. No-op (returns false) on empty/whitespace-only or over-`CHAT_MESSAGE_MAX_LENGTH` input (CHAT-002/003/004). */
  sendMessage: (text: string) => boolean;
  openPrompts: readonly EconomyBetPrompt[];
  /** `pickedParticipant` is required for a `who_scores_next` call (the team pick, 1 | 2) and must be omitted for every other call type. */
  takeBet: (promptId: string, itemId: EconomyItemId, pickedParticipant?: MatchEngineParticipant) => void;
  coolness: number;
  pile: readonly EconomyPileEntry[];
  status: MatchSessionStatus;
  /** V1: this fixture's seeded Gift Pool contents (from `pool_seeded`), undefined until the engine has emitted it. */
  poolSeed: readonly EconomyPileEntry[] | undefined;
  /** V1: this local user's share of the full-time pool split (from `pool_split`), undefined until settled. May be an empty array (no winning call this match). */
  poolSplit: readonly EconomyPileEntry[] | undefined;
}

export interface UseUserPileResult {
  coolness: number;
  pile: readonly EconomyPileEntry[];
}

/** Frozen contract for the leaderboard sheet (LB-001..008). */
export interface UseLeaderboardResult {
  rows: readonly LeaderboardRow[];
}

function pileToEntries(pile: Readonly<Record<string, number>>): readonly EconomyPileEntry[] {
  return Object.entries(pile)
    .filter(([, quantity]) => quantity > 0)
    .map(([itemId, quantity]) => ({ itemId: itemId as EconomyItemId, quantity }));
}

function itemDeltasToEntries(deltas: readonly { item: EconomyItemId; delta: number }[]): readonly EconomyPileEntry[] {
  return deltas.filter((d) => d.delta > 0).map((d) => ({ itemId: d.item, quantity: d.delta }));
}

/** True when a `welcome_gift_offered` has landed for this fixture but the gift has not yet been granted (i.e. the local user hasn't claimed it for this fixture yet). */
function isGiftUnclaimed(events: readonly EconomyEvent[]): boolean {
  return events.some((e) => e.kind === 'welcome_gift_offered') && !events.some((e) => e.kind === 'gift_granted');
}

/** Derives currently-open prompts (offered, not yet expired/taken/settled) from the released event log. */
function deriveOpenPrompts(events: readonly EconomyEvent[]): readonly EconomyBetPrompt[] {
  const open = new Map<string, EconomyBetPrompt>();
  for (const event of events) {
    if (event.kind === 'prompt_offered' && event.promptId) {
      open.set(event.promptId, {
        id: event.promptId,
        fixtureId: event.fixtureId,
        trigger: '',
        predicate: event.betPredicate ?? 'goal_in_first_half',
        sourceFrameId: event.sourceFrameId,
        copy: event.text ?? '',
      });
    } else if (
      event.promptId
      && (event.kind === 'prompt_expired' || event.kind === 'bet_taken' || event.kind === 'bet_settled_win' || event.kind === 'bet_settled_loss')
    ) {
      open.delete(event.promptId);
    }
  }
  return [...open.values()];
}

/** V1: the most recent `pool_seeded` event's contents, or undefined if the engine hasn't emitted one yet for this fixture. */
function derivePoolSeed(events: readonly EconomyEvent[]): readonly EconomyPileEntry[] | undefined {
  let latest: EconomyEvent | undefined;
  for (const event of events) {
    if (event.kind === 'pool_seeded') latest = event;
  }
  if (!latest?.poolItemDeltas) return undefined;
  return itemDeltasToEntries(latest.poolItemDeltas);
}

/** V1: this local user's `pool_split` share, or undefined if the pool hasn't split yet. Empty array is a valid, distinct result (no winning call this match). */
function derivePoolSplit(events: readonly EconomyEvent[]): readonly EconomyPileEntry[] | undefined {
  let latest: EconomyEvent | undefined;
  for (const event of events) {
    if (event.kind === 'pool_split') latest = event;
  }
  if (!latest) return undefined;
  return itemDeltasToEntries(latest.poolItemDeltas ?? []);
}

function createDefaultUserPileStore() {
  return getUserPileStore({ storage: createAsyncStorageBackedStorage(), foldBalances: foldEconomyBalances });
}

/**
 * React adapter over `EconomySession` + `EconomyStreamGate` + `UserPileStore`
 * for one fixture. Mirrors `usePlaybackEngine`'s hand-rolled
 * useState/useEffect style. Acquires a shared, refcounted `EconomySession`
 * in an effect and releases it on cleanup; the underlying `MatchSession`
 * frame poller is shared with Match Pulse/Game View exactly as today.
 *
 * PERS-007 fix (V1): the POC version of this hook acquired the
 * `EconomySession` (which synchronously runs the engine once in its
 * constructor) in the same tick as firing off `store.hydrateFixture()`,
 * without waiting for hydration to resolve. For a returning user, that raced
 * the engine's first build against the persisted `gift_claimed` action
 * being restored -- if hydration hadn't finished yet, the first build saw an
 * empty local-actions array and emitted `welcome_gift_offered` with no
 * matching `gift_granted`, incorrectly flagging `pendingGift: true`, and
 * nothing ever re-triggered a rebuild afterward (the session only rebuilds
 * on a new frame or an explicit `notifyActionsChanged()`), so the gift popup
 * could reappear for a user who already claimed. This version awaits
 * `hydrateFixture` before acquiring the session, closing that race.
 */
export function useEconomy(fixtureId: string, isLive: boolean): UseEconomyResult {
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;

  const store = useMemo(() => createDefaultUserPileStore(), []);
  const [releasedEvents, setReleasedEvents] = useState<readonly EconomyEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<readonly EconomyChatMessage[]>([]);
  const [pendingGift, setPendingGift] = useState(false);
  const [status, setStatus] = useState<MatchSessionStatus>('loading');
  const [balancesVersion, setBalancesVersion] = useState(0);

  const economySessionRef = useRef<EconomySessionHandle | null>(null);
  const gateRef = useRef<EconomyStreamGate | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribeGate: (() => void) | undefined;
    let unsubscribeSession: (() => void) | undefined;

    const gate = new EconomyStreamGate(isLiveRef.current ? 'live' : 'replay');
    gateRef.current = gate;
    unsubscribeGate = gate.subscribe((events) => {
      setReleasedEvents(events);
    });

    // Hydration MUST complete before the EconomySession is acquired: the
    // session's constructor synchronously runs buildEconomyTimeline once,
    // and a returning user's persisted gift_claimed/bet_taken actions must
    // already be in UserPileStore before that first run (see doc comment
    // above -- PERS-007). `store.load()` (the cross-fixture device state,
    // including the welcome-popup-seen flag below) is awaited alongside it
    // for the same reason -- the popup decision must not race a returning
    // device's persisted "already seen" flag.
    void Promise.all([store.hydrateFixture(fixtureId), store.load()]).then(() => {
      if (cancelled) return;
      setChatMessages(store.getChatMessagesForFixture(fixtureId));
      setBalancesVersion((v) => v + 1);

      // Popup gating (UX ruling, docs/plans/playful-economy-v1-ux-review.md
      // section 7): the welcome gift *modal* fires once ever per device, not
      // once per fixture. A returning device (popup already seen on any
      // prior match) still gets the gift for THIS fixture -- the engine's
      // welcome_gift_offered/gift_granted mechanic is per-fixture and
      // unchanged -- but it's granted silently (the same action the popup's
      // "Claim"/"Skip" both already call) so it lands as an ordinary
      // in-stream gift_reveal row instead of re-showing the modal.
      const shouldAutoClaimSilently = store.hasSeenWelcomePopup();

      const session = acquireEconomySession(fixtureId, {
        acquireSession: () => acquireMatchSession(fixtureId, createMatchSessionDefaultDeps(() => isLiveRef.current)),
        director: buildEconomyTimeline,
        userId: store.getUserId(),
        getActions: () => store.getActionsForFixture(fixtureId),
      });
      economySessionRef.current = session;

      const silentlyClaimIfNeeded = (events: readonly EconomyEvent[]) => {
        if (!shouldAutoClaimSilently || !isGiftUnclaimed(events)) return;
        const alreadyClaimedLocally = store.getActionsForFixture(fixtureId).some((a) => a.kind === 'gift_claimed');
        if (alreadyClaimedLocally) return;
        const anchorFrameId = events.find((e) => e.kind === 'welcome_gift_offered')?.sourceFrameId;
        if (!anchorFrameId) return;
        store.recordGiftClaimed(fixtureId, anchorFrameId, Date.now());
        session.notifyActionsChanged();
      };

      unsubscribeSession = session.subscribe((snapshot) => {
        gate.setEvents(snapshot.events);
        setStatus(snapshot.sessionStatus);
        store.cacheEventsForFixture(fixtureId, snapshot.events);
        silentlyClaimIfNeeded(snapshot.events);
        setPendingGift(!shouldAutoClaimSilently && isGiftUnclaimed(snapshot.events));
      });

      const initial = session.getSnapshot();
      gate.setEvents(initial.events);
      setStatus(initial.sessionStatus);
      silentlyClaimIfNeeded(initial.events);
      setPendingGift(!shouldAutoClaimSilently && isGiftUnclaimed(initial.events));
    });

    return () => {
      cancelled = true;
      unsubscribeGate?.();
      unsubscribeSession?.();
      gate.dispose();
      economySessionRef.current?.release();
      economySessionRef.current = null;
      gateRef.current = null;
    };
  }, [fixtureId, store]);

  useEffect(() => {
    gateRef.current?.setMode(isLive ? 'live' : 'replay');
  }, [isLive]);

  const claimGift = useMemo(
    () => () => {
      const anchorFrameId = releasedEvents.find((e) => e.kind === 'welcome_gift_offered')?.sourceFrameId;
      if (!anchorFrameId) return;
      store.recordGiftClaimed(fixtureId, anchorFrameId, Date.now());
      // This is only ever reachable via the popup's Claim/Skip actions
      // (pendingGift is false whenever the popup is auto-claiming silently,
      // so the popup itself never mounts in that case -- see the effect
      // above). Reaching here means this genuinely is the device's
      // first-ever popup showing; mark it seen so no later match shows it
      // again, per the UX ruling.
      store.markWelcomePopupSeen();
      economySessionRef.current?.notifyActionsChanged();
    },
    [fixtureId, releasedEvents, store],
  );

  const takeBet = useMemo(
    () => (promptId: string, itemId: EconomyItemId, pickedParticipant?: MatchEngineParticipant) => {
      store.recordBetTaken(fixtureId, promptId, itemId, pickedParticipant);
      economySessionRef.current?.notifyActionsChanged();
    },
    [fixtureId, store],
  );

  const sendMessage = useMemo(
    () => (text: string): boolean => {
      // CHAT-002/003: reject empty/whitespace before it ever reaches the
      // store (the store also re-checks, but failing fast here means a
      // caller can branch on the boolean return without inspecting state).
      if (text.trim().length === 0 || text.trim().length > CHAT_MESSAGE_MAX_LENGTH) return false;
      const releasedCount = gateRef.current?.getReleasedEvents().length ?? releasedEvents.length;
      const message = store.recordChatMessage(fixtureId, text, releasedCount, Date.now());
      if (!message) return false;
      setChatMessages(store.getChatMessagesForFixture(fixtureId));
      return true;
    },
    [fixtureId, releasedEvents.length, store],
  );

  const openPrompts = useMemo(() => deriveOpenPrompts(releasedEvents), [releasedEvents]);
  const poolSeed = useMemo(() => derivePoolSeed(releasedEvents), [releasedEvents]);
  const poolSplit = useMemo(() => derivePoolSplit(releasedEvents), [releasedEvents]);

  const streamRows = useMemo(
    () => mergeEconomyStream(releasedEvents, chatMessages),
    [releasedEvents, chatMessages],
  );

  const balances = useMemo(() => {
    // balancesVersion forces a re-fold after hydrateFixture resolves.
    void balancesVersion;
    return foldEconomyBalances(releasedEvents);
  }, [releasedEvents, balancesVersion]);

  return {
    pendingGift,
    claimGift,
    streamEvents: releasedEvents,
    streamRows,
    sendMessage,
    openPrompts,
    takeBet,
    coolness: balances.coolness,
    pile: pileToEntries(balances.pile),
    status,
    poolSeed,
    poolSplit,
  };
}

/**
 * Fixture-independent hook for the Profile/pile sheet: folds every fixture's
 * cached economy event log in `UserPileStore` into one cross-match balance.
 * Does not acquire any `MatchSession`/`EconomySession` -- it only reads what
 * `useEconomy` (mounted elsewhere, or previously) has cached.
 */
export function useUserPile(): UseUserPileResult {
  const store = useMemo(() => createDefaultUserPileStore(), []);
  const [, setTick] = useState(0);

  useEffect(() => {
    void store.load();
    const unsubscribe = store.subscribe(() => setTick((t) => t + 1));
    return unsubscribe;
  }, [store]);

  const balances = store.getBalances();
  return { coolness: balances.coolness, pile: pileToEntries(balances.pile) };
}

/**
 * Frozen V1 hook for the leaderboard sheet (LB-001..008), backed by the real
 * `buildLeaderboard` export from `packages/core` (deterministic simulated
 * room roster + ranking, LB-002/004). Per LB-007, ranks by *this fixture's*
 * coolness (matching the Chat tab's own per-fixture scope), not the
 * Profile's cross-match cumulative total -- callers pass the same
 * `streamEvents` they already got from `useEconomy(fixtureId, ...)` for this
 * fixture to derive `userCoolness`, so no second `EconomySession` is
 * acquired for events. `buildLeaderboard` also takes the fixture's frame log
 * (so simulated members' derived outcomes respond to real match intensity,
 * per its doc comment) -- this hook acquires its own handle on the same
 * shared, refcounted `MatchSession` registry used by `useEconomy`/Match
 * Pulse/Game View, so mounting the leaderboard sheet never starts a second
 * poller for the fixture.
 */
export function useLeaderboard(fixtureId: string, isLive: boolean, streamEvents: readonly EconomyEvent[]): UseLeaderboardResult {
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;

  const store = useMemo(() => createDefaultUserPileStore(), []);
  const [frames, setFrames] = useState<readonly SemanticFrame[]>([]);

  useEffect(() => {
    const session = acquireMatchSession(fixtureId, createMatchSessionDefaultDeps(() => isLiveRef.current));
    const unsubscribe = session.subscribe((snapshot) => setFrames(snapshot.frames));
    setFrames(session.getSnapshot().frames);
    return () => {
      unsubscribe();
      session.release();
    };
  }, [fixtureId]);

  const userCoolness = useMemo(() => foldEconomyBalances(streamEvents).coolness, [streamEvents]);

  const rows = useMemo(
    () => buildLeaderboard(fixtureId, frames, store.getUserId(), userCoolness),
    [fixtureId, frames, store, userCoolness],
  );
  return { rows };
}
