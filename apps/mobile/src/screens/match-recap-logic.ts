import type { EconomyEvent, EconomyItemId } from '@gamecrew/core';

/**
 * Pure builder for the full-time board's match recap row (demo-lockdown item
 * 14): "one row for the signed-in user -- coolness earned this match, calls
 * won/lost, pool share if a split happened, and a claim-your-item affordance
 * if unclaimed." Sourced entirely from data the existing hooks already
 * produce for the match screen (useEconomy's `streamEvents`/`poolSplit`/
 * `pile`, useWallet's `claims`) -- no new store or backend call. No
 * React/native imports so this is exercised directly by the plain-Node test
 * runner; the FT board wires it via a small selector in gamecrew-screens.tsx.
 */

export interface MatchRecapPoolItemDelta {
  itemId: EconomyItemId;
  quantity: number;
}

export interface MatchRecapModel {
  /** True once the user has done anything at all this match (a call, or the pool split resolved) -- a fully-zero recap for a user who did nothing still renders (spec: "graceful zeros"), this just flags it for a softer empty-state copy if the caller wants one. */
  hasActivity: boolean;
  coolnessEarned: number;
  callsWon: number;
  callsLost: number;
  /** Undefined until the gift pool has actually split for this match (distinct from "split, but the user got nothing"). */
  poolShare: readonly MatchRecapPoolItemDelta[] | undefined;
  /** True when at least one item in the user's pile for this match has never been claimed on-chain. */
  hasUnclaimedItem: boolean;
}

/** Minimal claim shape this builder needs -- mirrors (a subset of) useWallet's ClaimView. */
export interface MatchRecapClaimInput {
  itemId: EconomyItemId;
  status: 'sending' | 'pending' | 'minted' | 'failed' | 'not_sent';
}

/** Minimal pile-entry shape this builder needs -- mirrors EconomyPileEntry. */
export interface MatchRecapPileEntry {
  itemId: EconomyItemId;
  quantity: number;
}

function countCallOutcomes(events: readonly EconomyEvent[]): { won: number; lost: number } {
  let won = 0;
  let lost = 0;
  for (const event of events) {
    if (event.kind === 'bet_settled_win') won += 1;
    else if (event.kind === 'bet_settled_loss') lost += 1;
  }
  return { won, lost };
}

/**
 * An item counts as unclaimed when the user actually holds a positive
 * quantity of it in this match's pile AND no claim exists for that item id
 * with a "claimed" or "in flight" status -- a `failed` claim still counts as
 * unclaimed (spec: "claim your item" should keep inviting a retry), matching
 * `itemClaimStatus`'s existing 'failed' -> retry-affordance treatment in
 * global-chat-logic.ts.
 */
function hasAnyUnclaimedItem(
  pile: readonly MatchRecapPileEntry[],
  claims: readonly MatchRecapClaimInput[],
): boolean {
  return pile.some((entry) => {
    if (entry.quantity <= 0) return false;
    const latest = [...claims].reverse().find((claim) => claim.itemId === entry.itemId);
    if (!latest) return true;
    return latest.status === 'failed' || latest.status === 'not_sent';
  });
}

/**
 * Builds the recap model from this match's economy state. `coolnessEarned`
 * is taken directly from `useEconomy(fixtureId, ...)`'s `coolness` (already
 * scoped to this one fixture, unlike the cross-match `useUserPile` total).
 * `poolShare` mirrors `poolSplit` verbatim (undefined until settled, and a
 * settled-but-empty array is a real, distinct "split happened, you got
 * nothing" result -- not the same as "hasn't split yet").
 */
export function buildMatchRecapModel({
  claims,
  coolnessEarned,
  pile,
  poolSplit,
  streamEvents,
}: {
  claims: readonly MatchRecapClaimInput[];
  coolnessEarned: number;
  pile: readonly MatchRecapPileEntry[];
  poolSplit: readonly MatchRecapPoolItemDelta[] | undefined;
  streamEvents: readonly EconomyEvent[];
}): MatchRecapModel {
  const { won, lost } = countCallOutcomes(streamEvents);
  const hasUnclaimedItem = hasAnyUnclaimedItem(pile, claims);

  return {
    hasActivity: coolnessEarned > 0 || won > 0 || lost > 0 || (poolSplit?.length ?? 0) > 0,
    coolnessEarned,
    callsWon: won,
    callsLost: lost,
    poolShare: poolSplit,
    hasUnclaimedItem,
  };
}
