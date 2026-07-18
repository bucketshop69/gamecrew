import type {
  EconomyBetPredicate,
  EconomyBetPrompt,
  EconomyEvent,
  EconomyItemId,
  MatchEngineParticipant,
} from '@gamecrew/core';

import type { EconomyStreamRow } from '../state/economy-stream';

/**
 * Pure derivation layer for the Global Chat tab: turns the economy engine's
 * append-only `EconomyEvent[]` (plus the currently open prompts and the
 * user's pile) into render-ready row models, and picks which item a
 * single-tap "Stake" button auto-selects. No React here -- see
 * game-view-screen-logic.ts for the sibling pattern this follows -- so this
 * is unit-testable with plain node:test and stays reusable if the state
 * layer changes shape later.
 *
 * Only *types* are imported from `@gamecrew/core` and from `../state/*`
 * (matching game-view-screen-logic.ts's convention of type-only imports from
 * `../../state/match-session`), never runtime values: the item catalogue
 * lookup (`getEconomyItemDefinition`) is taken as an injected function
 * argument instead of imported directly, so this module has zero runtime
 * dependency on the core package or the state layer, and its plain
 * node:test file needs no bundler/loader resolution for a workspace package.
 *
 * Naming (docs/prds/playful_economy.md "Naming"): user-facing copy in this
 * module says Gift/Stash/Call/Gift Pool, never "junk"/"bet" -- the engine's
 * own event/type identifiers (`EconomyBetPrompt`, `bet_taken`, etc.) keep
 * their pre-rename names per the PRD, and this module's `copy`/prompt text
 * simply passes the engine's already-renamed `copy` strings through
 * (e.g. "Make your call: ...") rather than re-deriving them.
 */

/** Shape of `getEconomyItemDefinition` from `@gamecrew/core`, injected rather than imported at runtime. */
export interface EconomyItemLookup {
  (itemId: EconomyItemId): { label: string; emoji: string; rarityTier: number };
}

// ---------------------------------------------------------------------------
// Row models
// ---------------------------------------------------------------------------

export type GlobalChatRow =
  | { id: string; kind: 'chatter'; text: string }
  | { id: string; kind: 'match_moment'; text: string }
  | {
    id: string;
    kind: 'gift_reveal';
    text: string;
    itemDeltas: readonly { itemId: EconomyItemId; quantity: number }[];
  }
  | {
    id: string;
    kind: 'prompt';
    promptId: string;
    copy: string;
    /** The call's predicate, e.g. `'who_scores_next'` -- lets the feed render a team-pick card instead of the default single stake button (QA HIGH: who-scores-next was previously untakeable, having no UI at all). */
    predicate: EconomyBetPredicate;
    stakeItemId: EconomyItemId;
    stakeCoolness: number;
    isOpen: boolean;
    /**
     * UX spec section 2's state table: `'open'` (stake button live),
     * `'taken'` (user staked, awaiting settlement -- static "You called it"
     * pill replaces the button), `'closed'` (expired with no take, never
     * actionable). The engine has no distinct "settling" event between
     * `bet_taken` and its settlement, so a brief settling window is not
     * independently observable here -- `'taken'` covers that whole waiting
     * period (documented deviation, see gift-reveal/leaderboard build notes).
     */
    state: 'open' | 'taken' | 'closed';
    /** Set only when `state === 'taken'`: the item the user actually staked (echoes the `bet_taken` event, not necessarily `stakeItemId` if the pile changed since). */
    takenItemId?: EconomyItemId;
    /** Set only when `state === 'taken'` and `predicate === 'who_scores_next'`: which team the user actually picked (echoes the `bet_taken` event's `pickedParticipant`). */
    takenParticipant?: MatchEngineParticipant;
  }
  | { id: string; kind: 'social_proof'; text: string }
  | { id: string; kind: 'settlement_win'; text: string; itemDeltas: readonly { itemId: EconomyItemId; quantity: number }[] }
  | { id: string; kind: 'settlement_loss'; text: string }
  | { id: string; kind: 'settlement_voided'; text: string }
  /** V1: the local user's own sent message (UX spec section 5) -- plain text, right-aligned, no bubble. */
  | { id: string; kind: 'user_chat'; text: string }
  /** V1: the once-per-match Gift Pool seed announcement (UX spec section 3), always the first row when present. */
  | { id: string; kind: 'pool_seeded'; text: string }
  /**
   * V1: the full-time Gift Pool split (UX spec section 3) -- the one other
   * moment (besides a Call win) allowed the spring/particle celebration
   * grammar. `itemDeltas` is the local user's own share (may be empty, the
   * deterministic no-winner-for-this-user case); `noWinners` distinguishes
   * "nobody in the whole room won" (its own plain, non-bursting copy) from
   * "the room had winners but not this user."
   */
  | {
    id: string;
    kind: 'pool_split';
    text: string;
    itemDeltas: readonly { itemId: EconomyItemId; quantity: number }[];
    noWinners: boolean;
  };

/** Deterministic, non-random social-proof line variants, keyed by prompt id so the same take always renders the same line. */
const SOCIAL_PROOF_TEMPLATES: readonly ((n: number) => string)[] = [
  (n) => `you and ${n} others staked`,
  (n) => `${n} others are in on this too`,
  (n) => `the room's split -- ${n} others took it`,
];

function socialProofCountFor(promptId: string): number {
  // Small deterministic spread (3-9) derived from the prompt id's char codes
  // -- flavor only, matches the "simulated room ambience" non-goal in the
  // POC plan. Not a security-relevant hash, just a stable pseudo-count.
  let hash = 0;
  for (let i = 0; i < promptId.length; i += 1) hash = (hash * 31 + promptId.charCodeAt(i)) >>> 0;
  return 3 + (hash % 7);
}

function socialProofLineFor(promptId: string): string {
  const count = socialProofCountFor(promptId);
  const templateIndex = promptId.length % SOCIAL_PROOF_TEMPLATES.length;
  return SOCIAL_PROOF_TEMPLATES[templateIndex]!(count);
}

function itemDeltasFromEvent(event: EconomyEvent): readonly { itemId: EconomyItemId; quantity: number }[] {
  return event.itemDeltas
    .filter((delta) => delta.delta > 0)
    .map((delta) => ({ itemId: delta.item, quantity: delta.delta }));
}

function poolItemDeltasFromEvent(event: EconomyEvent): readonly { itemId: EconomyItemId; quantity: number }[] {
  return (event.poolItemDeltas ?? [])
    .filter((delta) => delta.delta > 0)
    .map((delta) => ({ itemId: delta.item, quantity: delta.delta }));
}

/** UX spec section 3: the once-per-match seed announcement, e.g. "Tonight's Gift Pool: 500 bananas, 2 lambos -- split among every winning call at full time." Falls back to the engine's own `text` (already close to this phrasing) if the pool seed is somehow empty. */
function poolSeededText(
  poolItems: readonly { itemId: EconomyItemId; quantity: number }[],
  lookupItem: EconomyItemLookup,
  fallback: string | undefined,
): string {
  if (poolItems.length === 0) return fallback ?? "Tonight's Gift Pool is being set.";
  const summary = poolItems.map(({ itemId, quantity }) => `${quantity} ${lookupItem(itemId).emoji}`).join(', ');
  return `Tonight's Gift Pool: ${summary} -- split among every winning call at full time.`;
}

/**
 * UX spec section 3: distinguishes "nobody in the whole room won" from "the
 * room had winners but not this user." Previously this parsed the engine's
 * literal `text` prose (a fragile coupling flagged by both QA and UX
 * review) -- `pool_split` events now carry a structural `poolOutcome`
 * field (`'split' | 'no_winners'`) set directly by `emitPoolSplit` in
 * `packages/core/src/match-engine/economy.ts`, so this reads that instead.
 */
function isNoWinnersPoolSplit(event: EconomyEvent): boolean {
  return event.poolOutcome === 'no_winners';
}

function poolSplitText(event: EconomyEvent, poolItems: readonly { itemId: EconomyItemId; quantity: number }[], lookupItem: EconomyItemLookup): string {
  if (isNoWinnersPoolSplit(event)) {
    // UX review must-fix 1: the engine deterministically returns the pool to
    // the house on no winners -- it never rolls over to the next match. The
    // copy must say what actually happens, not the spec's original
    // (incorrect) rollover assumption.
    return 'No winning calls tonight -- the Gift Pool goes back to GameCrew.';
  }
  if (poolItems.length === 0) {
    return event.text ?? "Gift Pool split -- you didn't have a winning call this time.";
  }
  const summary = poolItems.map(({ itemId, quantity }) => `+${quantity} ${lookupItem(itemId).emoji}`).join(', ');
  return `Gift Pool split! You split tonight's pool: ${summary} each.`;
}

function giftRevealText(
  event: EconomyEvent,
  itemDeltas: readonly { itemId: EconomyItemId; quantity: number }[],
  lookupItem: EconomyItemLookup,
): string {
  if (itemDeltas.length === 0) return event.text ?? 'A drop lands.';
  const parts = itemDeltas.map(({ itemId, quantity }) => {
    const def = lookupItem(itemId);
    return `${quantity} ${def.label.toLowerCase()}`;
  });
  return `You got ${parts.join(', ')}.`;
}

/**
 * Picks which item a single-tap prompt card auto-stakes: the user's most
 * plentiful item (ties broken by catalogue order, i.e. the more common
 * item), so the button always has something real to point at. Falls back to
 * the most common catalogue item (`dust`) if the pile is empty so the button
 * still renders sensibly before any gift has landed.
 */
export function pickAutoStakeItem(
  pile: readonly { itemId: EconomyItemId; quantity: number }[],
): EconomyItemId {
  let best: { itemId: EconomyItemId; quantity: number } | undefined;
  for (const entry of pile) {
    if (entry.quantity <= 0) continue;
    if (!best || entry.quantity > best.quantity) best = entry;
  }
  return best?.itemId ?? 'dust';
}

/** Spec section 2, "Won -- exactly how loud": `{Display name or "You"} called it right -- coolness +{n}`. V1 has no other display names surfaced to this module, so this is always the local user's own win row -- always "You". */
function winHeadlineText(coolnessGain: number): string {
  return `You called it right -- coolness +${coolnessGain}`;
}

/** Spec section 2, "Lost -- exactly how quiet": always second-person, never the player's name, since only the loser ever sees this row. */
function lossText(coolnessDip: number): string {
  return `You called it wrong -- coolness -${coolnessDip}.`;
}

/**
 * Spec section 2, "Taken" state copy: `You called it · {emoji} staked` --
 * resolves the emoji via the injected lookup so the row itself never needs
 * the raw catalogue. When a `teamName` is supplied (who-scores-next calls,
 * where the pick itself -- not just the item stake -- is the meaningful
 * confirmation), it's appended so the user can see which team they backed:
 * `You called it · {teamName} · {emoji} staked`.
 */
function takenPillText(stakedItem: EconomyItemId, lookupItem: EconomyItemLookup, teamName?: string): string {
  const teamSuffix = teamName ? ` · ${teamName}` : '';
  return `You called it${teamSuffix} · ${lookupItem(stakedItem).emoji} staked`;
}

/**
 * Builds the ordered list of chat rows from the economy event log, the
 * currently open prompts (for the prompt card's "isOpen"/state derivation --
 * an event log alone can't tell a still-open prompt from one that later
 * expired without also being told what's open right now), and the user's
 * pile (to auto-pick the stake item). Pure: same inputs always produce the
 * same output.
 */
/**
 * Mutable accumulator threaded through `applyEventToRows` so both
 * `buildGlobalChatRows` (events only) and `buildGlobalChatStreamRows`
 * (events + user chat, V1) share one event-handling implementation instead
 * of two copies drifting apart.
 */
interface RowBuilderState {
  rows: GlobalChatRow[];
  /** Tracks, per promptId, the prompt row's array index so a later bet_taken/prompt_expired for the same prompt can flip that row's state in place (spec: "not a card mutation ... the original prompt card is left in its taken state") rather than appending a second row for it. */
  promptRowIndexById: Map<string, number>;
}

function applyEventToRows(
  state: RowBuilderState,
  event: EconomyEvent,
  openPromptIds: ReadonlySet<string>,
  openPrompts: readonly EconomyBetPrompt[],
  stakeItemId: EconomyItemId,
  lookupItem: EconomyItemLookup,
): void {
  const { rows, promptRowIndexById } = state;
  switch (event.kind) {
    case 'room_chatter':
      rows.push({ id: event.id, kind: 'chatter', text: event.text ?? '' });
      break;
    case 'match_moment':
      rows.push({ id: event.id, kind: 'match_moment', text: event.text ?? '' });
      break;
    case 'welcome_gift_offered':
      // Surfaced by the gift popup, not the chat stream -- skip here.
      break;
    case 'gift_granted':
    case 'drop_granted': {
      const itemDeltas = itemDeltasFromEvent(event);
      rows.push({
        id: event.id,
        kind: 'gift_reveal',
        text: giftRevealText(event, itemDeltas, lookupItem),
        itemDeltas,
      });
      break;
    }
    case 'prompt_offered': {
      const promptId = event.promptId;
      if (!promptId) break;
      const prompt = openPrompts.find((candidate) => candidate.id === promptId);
      promptRowIndexById.set(promptId, rows.length);
      rows.push({
        id: event.id,
        kind: 'prompt',
        promptId,
        copy: prompt?.copy ?? event.text ?? 'Make your call.',
        // Prefer the live openPrompts entry's predicate; fall back to the
        // prompt_offered event's own betPredicate (both are always set by
        // the engine for this event kind, so this fallback is defensive,
        // not expected to be exercised in practice).
        predicate: prompt?.predicate ?? event.betPredicate ?? 'goal_in_first_half',
        stakeItemId,
        stakeCoolness: 0,
        isOpen: openPromptIds.has(promptId),
        state: openPromptIds.has(promptId) ? 'open' : 'closed',
      });
      break;
    }
    case 'prompt_expired': {
      // No standalone row -- an expired-with-no-take prompt just flips its
      // own existing prompt-card row to 'closed' rather than appending
      // anything new.
      const promptId = event.promptId;
      if (promptId === undefined) break;
      const index = promptRowIndexById.get(promptId);
      if (index === undefined) break;
      const existing = rows[index];
      if (existing?.kind === 'prompt') {
        rows[index] = { ...existing, isOpen: false, state: 'closed' };
      }
      break;
    }
    case 'bet_taken': {
      if (!event.promptId) break;
      // Flip the existing prompt card in place to its 'taken' state (spec:
      // "the original prompt card is left in its taken state") ...
      const index = promptRowIndexById.get(event.promptId);
      if (index !== undefined) {
        const existing = rows[index];
        if (existing?.kind === 'prompt') {
          rows[index] = {
            ...existing,
            isOpen: false,
            state: 'taken',
            takenItemId: event.stakedItem,
            takenParticipant: event.pickedParticipant,
          };
        }
      }
      // ...and separately append the room's social-proof line as its own row.
      rows.push({ id: event.id, kind: 'social_proof', text: socialProofLineFor(event.promptId) });
      break;
    }
    case 'bet_settled_win': {
      const itemDeltas = itemDeltasFromEvent(event);
      rows.push({
        id: event.id,
        kind: 'settlement_win',
        text: winHeadlineText(event.coolnessDelta),
        itemDeltas,
      });
      break;
    }
    case 'bet_settled_loss':
      rows.push({ id: event.id, kind: 'settlement_loss', text: lossText(Math.abs(event.coolnessDelta)) });
      break;
    case 'bet_voided':
      rows.push({ id: event.id, kind: 'settlement_voided', text: event.text ?? 'Call corrected, coolness restored.' });
      break;
    case 'pool_seeded': {
      const poolItems = poolItemDeltasFromEvent(event);
      rows.push({ id: event.id, kind: 'pool_seeded', text: poolSeededText(poolItems, lookupItem, event.text) });
      break;
    }
    case 'pool_split': {
      const poolItems = poolItemDeltasFromEvent(event);
      rows.push({
        id: event.id,
        kind: 'pool_split',
        text: poolSplitText(event, poolItems, lookupItem),
        itemDeltas: poolItems,
        noWinners: isNoWinnersPoolSplit(event),
      });
      break;
    }
    default:
      break;
  }
}

export function buildGlobalChatRows(
  events: readonly EconomyEvent[],
  openPrompts: readonly EconomyBetPrompt[],
  pile: readonly { itemId: EconomyItemId; quantity: number }[],
  lookupItem: EconomyItemLookup,
): readonly GlobalChatRow[] {
  const openPromptIds = new Set(openPrompts.map((prompt) => prompt.id));
  const stakeItemId = pickAutoStakeItem(pile);
  const state: RowBuilderState = { rows: [], promptRowIndexById: new Map() };

  for (const event of events) {
    applyEventToRows(state, event, openPromptIds, openPrompts, stakeItemId, lookupItem);
  }

  return state.rows;
}

/**
 * V1: builds chat-tab rows from the merged `EconomyStreamRow[]` (engine
 * events + the user's own local chat messages, already correctly
 * interleaved by `mergeEconomyStream` in `../state/economy-stream.ts`) rather
 * than from `EconomyEvent[]` alone. Every engine event is handled identically
 * to `buildGlobalChatRows` (same `applyEventToRows`, so prompt-card
 * state/taken-pill/pool/settlement behavior is exactly the same); a `'chat'`
 * row simply becomes a `user_chat` row in the same output position, per the
 * UX spec's "since V1 chat is local-first... they interleave naturally" note
 * (section 5).
 */
export function buildGlobalChatStreamRows(
  streamRows: readonly EconomyStreamRow[],
  openPrompts: readonly EconomyBetPrompt[],
  pile: readonly { itemId: EconomyItemId; quantity: number }[],
  lookupItem: EconomyItemLookup,
): readonly GlobalChatRow[] {
  const openPromptIds = new Set(openPrompts.map((prompt) => prompt.id));
  const stakeItemId = pickAutoStakeItem(pile);
  const state: RowBuilderState = { rows: [], promptRowIndexById: new Map() };

  for (const streamRow of streamRows) {
    if (streamRow.kind === 'chat') {
      state.rows.push({ id: streamRow.message.id, kind: 'user_chat', text: streamRow.message.text });
      continue;
    }
    applyEventToRows(state, streamRow.event, openPromptIds, openPrompts, stakeItemId, lookupItem);
  }

  return state.rows;
}

/** The taken-state pill copy for a `prompt` row (spec section 2: `You called it · {emoji} staked`), resolved at render time from the row's `takenItemId`. Exported so `global-chat-feed.tsx` doesn't need its own emoji lookup for this one string. */
export function promptTakenPillText(takenItemId: EconomyItemId, lookupItem: EconomyItemLookup, teamName?: string): string {
  return takenPillText(takenItemId, lookupItem, teamName);
}

export interface GiftRevealItemRow {
  itemId: EconomyItemId;
  emoji: string;
  label: string;
  quantity: number;
}

/**
 * Finds the most recently emitted `gift_granted` event in the stream and
 * resolves its item deltas into display-ready rows for the gift popup's
 * reveal beat. Returns an empty array if no gift has been granted yet (the
 * popup can still render its offer beat while this stays empty -- the reveal
 * beat only mounts after `claimGift()` has fired). Only `gift_granted` is
 * considered, never `drop_granted`, so a later match-moment drop never
 * overwrites what the popup shows for the original welcome gift.
 */
export function latestGiftRevealItems(
  events: readonly EconomyEvent[],
  lookupItem: EconomyItemLookup,
): readonly GiftRevealItemRow[] {
  let latest: EconomyEvent | undefined;
  for (const event of events) {
    if (event.kind === 'gift_granted') latest = event;
  }
  if (!latest) return [];
  return itemDeltasFromEvent(latest).map(({ itemId, quantity }) => {
    const def = lookupItem(itemId);
    return { itemId, emoji: def.emoji, label: def.label, quantity };
  });
}

// ---------------------------------------------------------------------------
// Rarity presentation tiers (pile sheet)
// ---------------------------------------------------------------------------

export type RarityPresentationTier = 'common' | 'uncommon' | 'rare' | 'legendary';

/**
 * Maps the catalogue's 1..N rarityTier ordering into four coarse visual
 * tiers for the pile sheet's border/glow treatment (per the team's adopted
 * "rarity as border tiers" call -- zero art budget, emoji + a border color
 * do the work rarity art would otherwise do). Tier boundaries are static
 * because the catalogue itself is static (8 items) -- see
 * ECONOMY_ITEM_CATALOGUE in packages/core/src/match-engine/economy.ts.
 */
export function rarityPresentationTier(rarityTier: number): RarityPresentationTier {
  if (rarityTier >= 8) return 'legendary';
  if (rarityTier >= 6) return 'rare';
  if (rarityTier >= 3) return 'uncommon';
  return 'common';
}

export interface PileRow {
  itemId: EconomyItemId;
  emoji: string;
  label: string;
  quantity: number;
  rarityTier: RarityPresentationTier;
}

/**
 * Builds display-ready pile rows for the profile sheet: zero-quantity items
 * are omitted, and rows are ordered rarest-first (a lambo pile, however
 * small, leads the trophy shelf) then by descending quantity.
 */
export function buildPileRows(
  pile: readonly { itemId: EconomyItemId; quantity: number }[],
  lookupItem: EconomyItemLookup,
): readonly PileRow[] {
  return pile
    .filter((entry) => entry.quantity > 0)
    .map((entry) => {
      const def = lookupItem(entry.itemId);
      return {
        itemId: entry.itemId,
        emoji: def.emoji,
        label: def.label,
        quantity: entry.quantity,
        rarityTier: rarityPresentationTier(def.rarityTier),
      };
    })
    .sort((a, b) => {
      const rarityOrder = { legendary: 0, rare: 1, uncommon: 2, common: 3 } as const;
      const rarityDiff = rarityOrder[a.rarityTier] - rarityOrder[b.rarityTier];
      if (rarityDiff !== 0) return rarityDiff;
      return b.quantity - a.quantity;
    });
}

/**
 * Economy strip Pool chip copy (UX spec section 1): top 1-2 pool items by
 * rarity, rarest first, e.g. `Pool: 500 🍌 · 2 🏎️`. Returns the em-dash
 * placeholder when the pool hasn't seeded yet (`undefined` -- distinct from
 * an empty array, which shouldn't happen once seeded but is handled the
 * same way defensively). Never wraps/shifts layout -- this is a fixed,
 * single-line strip entry, so callers on narrow devices may further
 * truncate to emoji-only (spec's "let the Pool chip truncate first" note),
 * which this function doesn't need to know about -- it always includes
 * quantities, and the caller decides whether to drop them.
 */
export function poolChipText(
  poolSeed: readonly { itemId: EconomyItemId; quantity: number }[] | undefined,
  lookupItem: EconomyItemLookup,
): string {
  if (!poolSeed || poolSeed.length === 0) return 'Pool: —';
  const ranked = buildPileRows(poolSeed, lookupItem).slice(0, 2);
  const summary = ranked.map((row) => `${row.quantity} ${row.emoji}`).join(' · ');
  return `Pool: ${summary}`;
}

// ---------------------------------------------------------------------------
// On-chain claim status (pile sheet)
// ---------------------------------------------------------------------------

/** Mirrors the frozen `ClaimView` shape from `../state/use-wallet`, kept local so this module has no runtime dependency on that hook. */
export interface ClaimStatusInput {
  claimId?: string;
  localId?: string;
  itemId: EconomyItemId;
  quantity: number;
  status: 'sending' | 'pending' | 'minted' | 'failed' | 'not_sent';
  explorerUrl?: string;
  txSignature?: string;
  mintAddress?: string;
}

export type ItemClaimStatus =
  | { kind: 'unclaimed' }
  | { kind: 'sending' | 'pending' }
  | { kind: 'minted'; explorerUrl?: string }
  | { kind: 'failed' };

/**
 * Picks the claim to show on a pile row for one item: the most recently
 * pushed claim for that item id (last one in the array wins), since a retried
 * claim after a failure appends a new entry rather than mutating the old one
 * -- see `useWallet`'s frozen contract. Items with no claim at all render as
 * 'unclaimed' so the row can offer the initial "Claim on-chain" action.
 *
 * A `'not_sent'` claim (recorded locally before a wallet address exists --
 * see `wallet-store.ts`'s `claimItem`/`cancelPendingLogin`) also renders as
 * 'unclaimed' here: the *login* UI (spec section 6's inline social-login
 * expansion) is driven separately by `walletStatus`, not by per-item claim
 * state, so a not-yet-sent claim shouldn't visually differ from "never
 * tapped Claim on-chain" on the row itself -- tapping it again while
 * `not_sent` is a harmless no-op re-trigger of the same pending login.
 */
export function itemClaimStatus(
  itemId: EconomyItemId,
  claims: readonly ClaimStatusInput[],
): ItemClaimStatus {
  let latest: ClaimStatusInput | undefined;
  for (const claim of claims) {
    if (claim.itemId === itemId) latest = claim;
  }
  if (!latest || latest.status === 'not_sent') return { kind: 'unclaimed' };
  if (latest.status === 'minted') return { kind: 'minted', explorerUrl: latest.explorerUrl };
  if (latest.status === 'failed') return { kind: 'failed' };
  return { kind: latest.status };
}

/**
 * Truncates a wallet address to `first…last` (4 chars each side, matching
 * the wallet-chip convention used elsewhere on-chain) for the pile sheet's
 * wallet row. Short addresses (8 chars or fewer) are returned unchanged --
 * nothing useful to hide.
 */
export function truncateWalletAddress(address: string): string {
  if (address.length <= 8) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
