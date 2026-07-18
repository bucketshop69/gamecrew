import type { MatchEngineParticipant, MatchEnginePhase, SemanticFrame, SimulationCue } from './types';

/**
 * The Playful Economy engine (see docs/prds/playful_economy.md and
 * docs/plans/playful-economy-v1.md). A pure, deterministic director over a
 * `SemanticFrame[]` stream, copying the `buildGameViewTimeline` pattern in
 * `game-view.ts`: frames are sorted by seq first, duplicate/out-of-order
 * frames are tolerated, and no wall-clock or `Math.random` state is read.
 *
 * Unlike Game View, this director also takes the local user's own actions
 * (`EconomyTimelineOptions.actions`) as an input, because settlement is a
 * function of both the frame stream (what happened in the match) and what
 * the user staked. Everything the engine emits is an **event**, never a
 * mutable balance: `coolnessDelta` / `itemDeltas` are folded by
 * `foldEconomyBalances` to produce the current coolness and pile. This is
 * the data-layer insurance called for in the POC plan so that lifting this
 * output into a server-side projection later (Option B) is a storage change,
 * not a re-derivation of the rules.
 *
 * V1 naming (docs/prds/playful_economy.md, "Naming"): user-facing copy says
 * Gift / Stash / Call / Gift Pool / Coolness -- never "junk" or "bet". Code
 * identifiers introduced before the naming pass (`EconomyBetPrompt`,
 * `bet_taken`, etc.) intentionally keep their old names per the PRD; only
 * strings this module produces for the chat stream follow the new copy.
 */

// ---------------------------------------------------------------------------
// Item catalogue
// ---------------------------------------------------------------------------

export type EconomyItemId =
  | 'dust'
  | 'bananas'
  | 'rubber_duck'
  | 'traffic_cone'
  | 'pizza'
  | 'boombox'
  | 'jetski'
  | 'lambo';

export interface EconomyItemDefinition {
  id: EconomyItemId;
  label: string;
  emoji: string;
  /** Higher weight = more common. Sizes payouts; never a price. */
  rarityWeight: number;
  /** 1 (most common) .. N (rarest), derived from rarityWeight ordering. */
  rarityTier: number;
}

/**
 * ~8 junk categories, dust most common through lambo rarest. Weights are
 * relative (not required to sum to any total) and only ever used to bias
 * random selection and to size junk payouts -- never a price.
 */
export const ECONOMY_ITEM_CATALOGUE: readonly EconomyItemDefinition[] = [
  { id: 'dust', label: 'Dust', emoji: '✨', rarityWeight: 100, rarityTier: 1 },
  { id: 'bananas', label: 'Bananas', emoji: '🍌', rarityWeight: 60, rarityTier: 2 },
  { id: 'rubber_duck', label: 'Rubber Duck', emoji: '🦆', rarityWeight: 40, rarityTier: 3 },
  { id: 'traffic_cone', label: 'Traffic Cone', emoji: '🚧', rarityWeight: 28, rarityTier: 4 },
  { id: 'pizza', label: 'Pizza', emoji: '🍕', rarityWeight: 18, rarityTier: 5 },
  { id: 'boombox', label: 'Boombox', emoji: '📻', rarityWeight: 10, rarityTier: 6 },
  { id: 'jetski', label: 'Jetski', emoji: '🚤', rarityWeight: 5, rarityTier: 7 },
  { id: 'lambo', label: 'Lambo', emoji: '🏎️', rarityWeight: 2, rarityTier: 8 },
];

const ITEM_BY_ID: ReadonlyMap<EconomyItemId, EconomyItemDefinition> = new Map(
  ECONOMY_ITEM_CATALOGUE.map((item) => [item.id, item]),
);

/** Total rarityWeight across the catalogue, used to normalize weighted draws. */
const TOTAL_ITEM_WEIGHT = ECONOMY_ITEM_CATALOGUE.reduce((sum, item) => sum + item.rarityWeight, 0);

export function getEconomyItemDefinition(itemId: EconomyItemId): EconomyItemDefinition {
  const def = ITEM_BY_ID.get(itemId);
  if (!def) throw new Error(`Unknown economy item id: ${itemId}`);
  return def;
}

// ---------------------------------------------------------------------------
// Deterministic seeded RNG (FNV-1a hash -> mulberry32 PRNG). No Math.random.
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash of a delimited seed string. Deterministic, no collisions from unescaped concatenation. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, deterministic 32-bit PRNG seeded from a single uint32. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds a deterministic, replay-stable RNG for one drop decision. Seed is
 * always the delimited triple `${fixtureId}:${userId}:${frameId}` (never raw
 * concatenation, which risks collisions across differently-lengthed ids) plus
 * an explicit `salt` so multiple independent draws against the same frame
 * (e.g. picking an item, then its quantity) don't reuse the same stream.
 */
export function createEconomyRng(
  fixtureId: number | string,
  userId: string,
  frameId: string,
  salt: string,
): () => number {
  const seed = `${fixtureId}:${userId}:${frameId}:${salt}`;
  return mulberry32(fnv1a32(seed));
}

/** Weighted-random item draw using rarityWeight, driven by an injected rng() in [0, 1). */
function drawWeightedItem(rng: () => number): EconomyItemDefinition {
  let roll = rng() * TOTAL_ITEM_WEIGHT;
  for (const item of ECONOMY_ITEM_CATALOGUE) {
    roll -= item.rarityWeight;
    if (roll <= 0) return item;
  }
  return ECONOMY_ITEM_CATALOGUE[ECONOMY_ITEM_CATALOGUE.length - 1]!;
}

/** Deterministic integer in [min, max] inclusive, driven by an injected rng(). */
function drawIntInRange(rng: () => number, min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Welcome gift and match-moment drops grant between 2 and 4 distinct items. */
const GIFT_ITEM_COUNT_MIN = 2;
const GIFT_ITEM_COUNT_MAX = 4;
const GIFT_ITEM_QUANTITY_MIN = 1;
const GIFT_ITEM_QUANTITY_MAX = 24;

/** Fixed single-tap stake amount (no stake picker in V1). */
export const ECONOMY_FIXED_STAKE_COOLNESS = 10;
/** Fixed coolness gain on a winning call, before the gift payout. */
export const ECONOMY_WIN_COOLNESS_GAIN = 15;
/** Fixed, quiet coolness dip on a losing call. The staked item always survives. */
export const ECONOMY_LOSS_COOLNESS_DIP = 5;
/** Starting coolness granted alongside the welcome gift. */
export const ECONOMY_STARTING_COOLNESS = 20;

/** Call resolution windows, in match-clock seconds. */
const FIRST_HALF_GOAL_WINDOW_SECONDS = 45 * 60;
/** ENG-008: goal-in-5 (formerly the POC's 2-minute corner-only window) is 5 minutes from the triggering big-moment cue. */
const BIG_MOMENT_GOAL_WINDOW_SECONDS = 5 * 60;
/** card-in-10: 10 minutes from the triggering "match heats up" cue. */
const CARD_CALL_WINDOW_SECONDS = 10 * 60;
const HALF_TIME_APPROACH_WINDOW_SECONDS = 5 * 60;

/**
 * Gift Pool seed ranges, per item (POOL-001): "tonight's pool: 500 bananas,
 * 2 lambos" style. Only a subset of the catalogue seeds the pool (the
 * common/mid items in bulk, plus a sprinkle of the rarest item as the
 * headline prize) -- deliberately not every item, so the pool announcement
 * reads as a curated prize, not a dump of the whole catalogue.
 */
const POOL_SEED_RANGES: ReadonlyArray<{ item: EconomyItemId; min: number; max: number }> = [
  { item: 'bananas', min: 200, max: 500 },
  { item: 'rubber_duck', min: 20, max: 60 },
  { item: 'lambo', min: 1, max: 3 },
];

/** Default simulated room member count for Leaderboard/Gift Pool eligibility when the caller doesn't specify one. */
const DEFAULT_SIMULATED_MEMBER_COUNT = 6;

/** Canned deterministic name pool for simulated room members (picked without replacement, per fixture). */
const SIMULATED_MEMBER_NAMES: readonly string[] = [
  'ace', 'blitz', 'cosmo', 'dax', 'echo', 'fizz', 'goose', 'hux',
  'iris', 'jinx', 'kilo', 'luna', 'milo', 'nova', 'orbit', 'pixel',
];

// ---------------------------------------------------------------------------
// Public types: EconomyEvent (event-sourced log) and prompts/bets
// ---------------------------------------------------------------------------

export type EconomyBetPredicate =
  | 'goal_in_first_half'
  | 'goal_within_window'
  | 'score_before_half_time'
  | 'who_scores_next'
  | 'card_within_window';

export interface EconomyItemDelta {
  item: EconomyItemId;
  /** Positive = granted/paid out, negative = reversed by a void/correction. Never negative on an ordinary loss (the item survives). */
  delta: number;
}

export interface EconomyBetPrompt {
  id: string;
  fixtureId: number | string;
  trigger: string;
  predicate: EconomyBetPredicate;
  /** Match-clock seconds the window opened and closes, when known. */
  windowStartSeconds?: number;
  windowEndSeconds?: number;
  sourceFrameId: string;
  copy: string;
}

export type EconomyEventKind =
  | 'welcome_gift_offered'
  | 'gift_granted'
  | 'drop_granted'
  | 'prompt_offered'
  | 'prompt_expired'
  | 'bet_taken'
  | 'bet_settled_win'
  | 'bet_settled_loss'
  | 'bet_voided'
  | 'room_chatter'
  | 'match_moment'
  | 'pool_seeded'
  | 'pool_split';

/**
 * One entry in the append-only economy event log. Every event carries a
 * stable, derived `id` (dedupe key -- replaying the same frames/actions must
 * reproduce the identical id, never a fresh random one), the `seq` and
 * `sourceFrameId`/`stateRevision` of the frame that caused it (mirroring
 * `SemanticFrame`), and **deltas** rather than balances: `coolnessDelta` and
 * `itemDeltas` are folded by `foldEconomyBalances`, never read as running
 * totals from engine state. Settlement/void events additionally carry
 * `causationId`, pointing back at the `bet_taken` event they resolve or
 * correct, so a later correction can be traced without re-deriving intent.
 */
export interface EconomyEvent {
  id: string;
  kind: EconomyEventKind;
  fixtureId: number | string;
  userId: string;
  seq: number;
  sourceFrameId: string;
  stateRevision: number;
  coolnessDelta: number;
  itemDeltas: readonly EconomyItemDelta[];
  /** Present on bet_taken (echoes promptId), bet_settled_win/loss, bet_voided (points at the bet_taken event), and pool_split (points at pool_seeded). */
  causationId?: string;
  promptId?: string;
  betPredicate?: EconomyBetPredicate;
  stakedItem?: EconomyItemId;
  /** who_scores_next `bet_taken` only: the team the user picked. */
  pickedParticipant?: MatchEngineParticipant;
  /** who_scores_next settlement events only: the team that actually scored (or would need to score to settle the picked team's win). */
  scoringParticipant?: MatchEngineParticipant;
  /** Copy for the chat stream (chatter/match-moment lines, prompt/settlement text). */
  text?: string;
  /** pool_seeded only: the seeded Gift Pool contents. pool_split only: this user's/member's share (may be empty). */
  poolItemDeltas?: readonly EconomyItemDelta[];
  /**
   * pool_split only: `'no_winners'` when nobody (user or simulated member)
   * had a winning call and the pool returned to the house; `'split'`
   * otherwise, including when the pool split among winners but this
   * particular user wasn't one of them (their `poolItemDeltas` is empty
   * either way, so this field is the structural signal the UI branches on
   * instead of string-matching `text` -- see docs/qa/playful-economy-v1-validation.md
   * and docs/plans/playful-economy-v1-ux-review.md).
   */
  poolOutcome?: 'split' | 'no_winners';
}

/** Echo of a user's local claim/take action, supplied to the engine as an input alongside frames. */
export interface EconomyGiftClaimedAction {
  kind: 'gift_claimed';
  /** Anchor frame id the claim is attached to for pacing (e.g. the first frame seen), and idempotency. */
  anchorFrameId: string;
  /** Wall-clock claim timestamp; presentation-only, never used to gate settlement logic. */
  claimedAt: number;
}

export interface EconomyBetTakenAction {
  kind: 'bet_taken';
  promptId: string;
  itemId: EconomyItemId;
  /** Required for who_scores_next calls: which team the user picked. Ignored for other predicates. */
  pickedParticipant?: MatchEngineParticipant;
}

export type EconomyUserAction = EconomyGiftClaimedAction | EconomyBetTakenAction;

export interface EconomyTimelineOptions {
  userId: string;
  actions?: readonly EconomyUserAction[];
  /**
   * Number of simulated room members whose deterministic win eligibility
   * feeds the Gift Pool split (POOL-002/POOL-008) alongside the real user.
   * Defaults to `DEFAULT_SIMULATED_MEMBER_COUNT`. Independent of `userId`
   * (POOL-002: the pool seed and the simulated roster are per-fixture, so
   * every user watching the same fixture sees the identical pool contents
   * and the identical simulated-member roster/eligibility).
   */
  simulatedMemberCount?: number;
}

/** A simulated room participant, deterministic per fixture (see `deriveSimulatedRoomMembers`). Not a real user account. */
export interface SimulatedRoomMember {
  id: string;
  name: string;
}

/** One simulated member's deterministically-derived match outcome, used for Gift Pool eligibility and the Leaderboard. */
export interface SimulatedRoomMemberOutcome {
  member: SimulatedRoomMember;
  /** Whether this simulated member is modeled as having won at least one call this match (POOL eligibility input). */
  hasWinningCall: boolean;
  /** Deterministic final coolness for this member, for the Leaderboard. */
  coolness: number;
}

// ---------------------------------------------------------------------------
// Balance folding
// ---------------------------------------------------------------------------

export interface EconomyBalances {
  coolness: number;
  pile: Readonly<Record<EconomyItemId, number>>;
}

/** One ranked row in the Leaderboard (LB-001). */
export interface LeaderboardRow {
  id: string;
  name: string;
  coolness: number;
  isUser: boolean;
  rank: number;
}

/**
 * Folds an economy event log into current coolness and pile balances. Pure:
 * balances are never stored, only ever derived by folding
 * `coolnessDelta`/`itemDeltas` over the log, so a correction (bet_voided)
 * that reverses a prior payout is just another event in the same fold.
 */
export function foldEconomyBalances(events: readonly EconomyEvent[]): EconomyBalances {
  let coolness = 0;
  const pile: Record<string, number> = {};
  for (const event of events) {
    coolness += event.coolnessDelta;
    for (const itemDelta of event.itemDeltas) {
      pile[itemDelta.item] = (pile[itemDelta.item] ?? 0) + itemDelta.delta;
    }
  }
  return { coolness, pile: pile as Record<EconomyItemId, number> };
}

// ---------------------------------------------------------------------------
// Gift Pool (POOL-001..015)
// ---------------------------------------------------------------------------

/**
 * Seeds the per-match Gift Pool. POOL-001/POOL-002: deterministic from
 * `fixtureId` alone (never `userId`), so every user watching the same
 * fixture -- and a replay of the same fixture -- sees byte-identical pool
 * contents. Never random per user, never funded by stakes (the PRD: "seeded,
 * not funded by stakes").
 */
export function computeGiftPoolSeed(fixtureId: number | string): readonly EconomyItemDelta[] {
  return POOL_SEED_RANGES.map(({ item, min, max }) => {
    const rng = createEconomyRng(fixtureId, 'pool', 'seed', item);
    return { item, delta: drawIntInRange(rng, min, max) };
  });
}

/**
 * POOL-005/POOL-006: splits one pool item's quantity evenly among winners,
 * floor-dividing per winner with any leftover units assigned by a seeded
 * deterministic draw (without replacement) among the winners -- the same
 * seeded-RNG discipline as gift drops (never `Math.random`, replay-stable).
 * Returns a Map from winnerId to the quantity of this item they receive.
 */
function splitPoolItemAmongWinners(
  fixtureId: number | string,
  item: EconomyItemId,
  quantity: number,
  winnerIds: readonly string[],
): Map<string, number> {
  const allocation = new Map<string, number>();
  if (winnerIds.length === 0) return allocation;
  const share = Math.floor(quantity / winnerIds.length);
  const leftover = quantity - share * winnerIds.length;
  for (const winnerId of winnerIds) allocation.set(winnerId, share);

  if (leftover > 0) {
    // Deterministic draw without replacement: shuffle winnerIds with the
    // seeded RNG (Fisher-Yates driven by createEconomyRng), then hand the
    // leftover units to the first `leftover` winners in that shuffled order.
    const rng = createEconomyRng(fixtureId, 'pool', 'split', `leftover:${item}`);
    const shuffled = [...winnerIds];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = shuffled[i]!;
      shuffled[i] = shuffled[j]!;
      shuffled[j] = tmp;
    }
    for (let i = 0; i < leftover; i += 1) {
      const winnerId = shuffled[i]!;
      allocation.set(winnerId, (allocation.get(winnerId) ?? 0) + 1);
    }
  }
  return allocation;
}

/**
 * Deterministically derives the simulated room roster and each member's
 * match outcome (POOL-002/POOL-008/LB-004): a fixed name list picked without
 * replacement per fixture, a "won at least one call" bit, and a final
 * coolness value. Everything here is a pure function of `fixtureId` (and the
 * frame stream's shape, so real match events -- more goals/cards/big
 * moments -- still influence the simulated members' derived outcomes,
 * keeping the room feeling caused by the football) -- never per-user, so
 * every user sees the identical simulated roster and outcomes for a given
 * fixture (LB-003's "as the match plays" is satisfied by feeding the actual
 * frame count in, not by any wall-clock or random per-call state).
 */
export function deriveSimulatedRoomMembers(
  fixtureId: number | string,
  frames: readonly SemanticFrame[],
  memberCount: number = DEFAULT_SIMULATED_MEMBER_COUNT,
): readonly SimulatedRoomMemberOutcome[] {
  const count = Math.max(0, Math.min(memberCount, SIMULATED_MEMBER_NAMES.length));
  if (count === 0) return [];

  // A stable "match intensity" signal (goal/card/big-moment cue count) so
  // members' derived win rate and coolness trajectory respond to what
  // actually happened, without depending on wall-clock or true randomness.
  const notableCueCount = frames.reduce((sum, frame) => {
    const cues = frame.simulationCues ?? [];
    return sum + cues.filter((cue) => cue.kind === 'goal_confirmed' || cue.kind === 'card' || isBigMomentCue(cue)).length;
  }, 0);

  const nameOrderRng = createEconomyRng(fixtureId, 'room', 'roster', 'order');
  const shuffledNames = [...SIMULATED_MEMBER_NAMES];
  for (let i = shuffledNames.length - 1; i > 0; i -= 1) {
    const j = Math.floor(nameOrderRng() * (i + 1));
    const tmp = shuffledNames[i]!;
    shuffledNames[i] = shuffledNames[j]!;
    shuffledNames[j] = tmp;
  }

  const outcomes: SimulatedRoomMemberOutcome[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = shuffledNames[i]!;
    const memberId = `${fixtureId}:room:${name}`;
    const winRng = createEconomyRng(fixtureId, memberId, 'outcome', 'has_winning_call');
    // More notable moments in the match give the room more chances to have
    // won something -- deterministic, not a live simulation of individual calls.
    const winProbability = Math.min(0.85, 0.25 + notableCueCount * 0.05);
    const hasWinningCall = winRng() < winProbability;

    const coolnessRng = createEconomyRng(fixtureId, memberId, 'outcome', 'coolness');
    const baseCoolness = ECONOMY_STARTING_COOLNESS + drawIntInRange(coolnessRng, -10, 40);
    const winBonusRng = createEconomyRng(fixtureId, memberId, 'outcome', 'coolness_bonus');
    const coolness = hasWinningCall ? baseCoolness + drawIntInRange(winBonusRng, 5, 30) : baseCoolness;

    outcomes.push({ member: { id: memberId, name }, hasWinningCall, coolness });
  }
  return outcomes;
}

export interface BuildLeaderboardOptions {
  simulatedMemberCount?: number;
}

/**
 * LB-001/LB-002/LB-004: a pure ranking function over the real user's folded
 * balance plus the deterministic simulated roster. Ties break deterministically
 * by member id (stable, never by insertion/render order) so re-rendering the
 * identical inputs never reorders tied rows (LB-002).
 */
export function buildLeaderboard(
  fixtureId: number | string,
  frames: readonly SemanticFrame[],
  userId: string,
  userCoolness: number,
  options: BuildLeaderboardOptions = {},
): readonly LeaderboardRow[] {
  const simulated = deriveSimulatedRoomMembers(fixtureId, frames, options.simulatedMemberCount);
  const entries: Array<{ id: string; name: string; coolness: number; isUser: boolean }> = [
    { id: userId, name: 'You', coolness: userCoolness, isUser: true },
    ...simulated.map((outcome) => ({ id: outcome.member.id, name: outcome.member.name, coolness: outcome.coolness, isUser: false })),
  ];

  entries.sort((left, right) => right.coolness - left.coolness || left.id.localeCompare(right.id));

  // LB-002: standard competition ranking (1, 2, 2, 4) -- tied coolness
  // shares the same rank, and the next distinct coolness value's rank skips
  // ahead by the tie group's size (not a plain 1-2-3-4 position index). The
  // id-based sort above still determines a stable, deterministic row order
  // within a tie group; only the numeric `rank` field is affected here.
  const rows: LeaderboardRow[] = [];
  let previousCoolness: number | undefined;
  let previousRank = 0;
  entries.forEach((entry, index) => {
    const rank = entry.coolness === previousCoolness ? previousRank : index + 1;
    previousCoolness = entry.coolness;
    previousRank = rank;
    rows.push({ ...entry, rank });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Internal director state
// ---------------------------------------------------------------------------

interface OpenBetState {
  promptId: string;
  betTakenEventId: string;
  predicate: EconomyBetPredicate;
  stakedItem: EconomyItemId;
  windowEndSeconds?: number;
  /** who_scores_next only: which team the user picked. */
  pickedParticipant?: MatchEngineParticipant;
  /** Frame id + stateRevision the bet was taken against, for stale-settlement detection on corrected projections. */
  takenAtFrameId: string;
  takenAtStateRevision: number;
}

interface SettledBetRecord {
  settleEventId: string;
  outcome: 'win' | 'loss' | 'voided';
  predicate: EconomyBetPredicate;
  stakedItem: EconomyItemId;
  coolnessDelta: number;
  itemDeltas: readonly EconomyItemDelta[];
  /** The confirmed cue id (goal or card) this settlement traces to. Used so retracting exactly that cue (not "any" goal/card) re-corrects only this settlement -- see `handleIncidentRetracted`. */
  settledByCueId?: string;
  /** Track whether a void has already been emitted for this settlement (idempotency guard). */
  voided: boolean;
}

interface EconomyDirectorState {
  fixtureId: number | string;
  userId: string;
  events: EconomyEvent[];
  /** Emitted event ids seen so far, guarding against duplicate/out-of-order frame replays re-emitting the same event. */
  emittedIds: Set<string>;
  phase?: MatchEnginePhase;
  clockSeconds?: number;
  /** Whether the "goal in the first half" prompt has already been offered (offer-once). */
  firstHalfPromptOffered: boolean;
  /** Whether the "score before the break" prompt has already been offered. */
  halfTimeApproachPromptOffered: boolean;
  /** Big-moment (corner/free_kick/shot_outcome) cue ids already turned into a goal-in-5 prompt (avoid duplicate prompts per incident). */
  bigMomentPromptedCueIds: Set<string>;
  /** Confirmed card cue ids already turned into a card-in-10 prompt (avoid duplicate prompts per incident). */
  cardPromptedCueIds: Set<string>;
  /** Whether a who_scores_next call has ever been offered (kickoff offer-once gate; re-offers after that are goal-driven, see reofferWhoScoresNext). */
  whoScoresNextEverOffered: boolean;
  /** Prompts currently open, keyed by promptId. */
  openPrompts: Map<string, EconomyBetPrompt>;
  /** Every promptId ever offered, kept so a pending bet_taken action can tell "not yet offered" (keep waiting) apart from "expired without being taken" (drop). */
  everOfferedPromptIds: Set<string>;
  /** Bets currently open (taken, not yet settled), keyed by promptId -- one active bet per prompt per user in the POC. */
  openBets: Map<string, OpenBetState>;
  /** Settlement record per promptId, kept so a later incident_retracted can void + reverse it. */
  settledBets: Map<string, SettledBetRecord>;
  /** Bet-taken actions not yet matched to a still-open prompt (consumed once matched). */
  pendingActions: EconomyUserAction[];
  hasClaimedGift: boolean;
  hasOfferedWelcomeGift: boolean;
  /** First frame observed, used as the welcome-gift anchor when the user has not claimed yet. */
  firstFrameId?: string;
  firstFrameSeq?: number;
  firstFrameStateRevision?: number;
  /** Monotonic counter so each who_scores_next re-offer gets a distinct, stable promptId (`${fixtureId}:economy:prompt:who_scores_next:${n}`). */
  whoScoresNextOfferCount: number;
  /** Goal cue ids that have already triggered a who_scores_next re-offer, guarding against a duplicate/re-delivered or multi-revision goal_confirmed cue re-offering more than once for the same real goal. */
  reofferedForGoalCueIds: Set<string>;
  /** Set once `finalised` (or `full_time_pending`) has closed out all calls, guarding against double full-time closure on duplicate phase_change delivery. */
  fullTimeClosed: boolean;
  /** Whether pool_seeded has already been emitted (offer-once, on the first frame). */
  poolSeeded: boolean;
  simulatedMemberCount: number;
  /** Every frame seen so far, kept only so the post-loop Gift Pool split can derive the simulated roster's outcomes from the real match-event count (see `deriveSimulatedRoomMembers`). */
  emittedFrames: SemanticFrame[];
  /** Last frame seen, kept so the post-loop Gift Pool split can attribute its event to a real frame. */
  lastFrame?: SemanticFrame;
}

function compareFrames(left: SemanticFrame, right: SemanticFrame): number {
  return left.seq - right.seq || left.id.localeCompare(right.id);
}

function relevantCues(frame: SemanticFrame): readonly SimulationCue[] {
  return (frame.simulationCues ?? []).filter((cue) =>
    cue.kind === 'phase_change'
    || cue.kind === 'set_piece'
    || cue.kind === 'goal_confirmed'
    || cue.kind === 'score_commit'
    || cue.kind === 'card'
    || cue.kind === 'shot_outcome'
    || cue.kind === 'incident_retracted');
}

/**
 * "Big moment" trigger for the goal-in-5 call (ENG-007): a dangerous dead
 * ball (corner, free kick) or a shot outcome, not corners alone. `set_piece`
 * actions come from the same cue vocabulary Game View reads
 * (`game-view.ts`'s set_piece handling); `shot_outcome` is the confirmed
 * result of a shot attempt (see `SimulationCue['kind']` in types.ts) and is a
 * cleaner "the match just got dangerous" signal than `shot_attempt`, which
 * can be superseded by the same incident's outcome revision.
 */
function isBigMomentCue(cue: SimulationCue): boolean {
  if (cue.kind === 'set_piece') {
    const action = actionOf(cue);
    return action === 'corner' || action === 'free_kick';
  }
  return cue.kind === 'shot_outcome';
}

function phaseOf(cue: SimulationCue): MatchEnginePhase | undefined {
  const value = cue.value as { phase?: unknown } | undefined;
  return typeof value?.phase === 'string' ? (value.phase as MatchEnginePhase) : undefined;
}

function actionOf(cue: SimulationCue): string | undefined {
  const value = cue.value as { action?: unknown } | undefined;
  return typeof value?.action === 'string' ? value.action : undefined;
}

/** Stable, replay-idempotent event id: every component that determines uniqueness is baked in, never a counter or random value. */
function eventId(
  fixtureId: number | string,
  userId: string,
  kind: EconomyEventKind,
  discriminator: string,
): string {
  return `${fixtureId}:economy:${userId}:${kind}:${discriminator}`;
}

function pushEvent(state: EconomyDirectorState, event: EconomyEvent): EconomyEvent {
  if (state.emittedIds.has(event.id)) {
    // Duplicate/out-of-order replay of a frame already processed: idempotent no-op.
    const existing = state.events.find((candidate) => candidate.id === event.id);
    return existing ?? event;
  }
  state.emittedIds.add(event.id);
  state.events.push(event);
  return event;
}

// ---------------------------------------------------------------------------
// Gift / drop granting
// ---------------------------------------------------------------------------

function grantRandomItems(
  fixtureId: number | string,
  userId: string,
  frameId: string,
  salt: string,
): EconomyItemDelta[] {
  const countRng = createEconomyRng(fixtureId, userId, frameId, `${salt}:count`);
  const itemCount = drawIntInRange(countRng, GIFT_ITEM_COUNT_MIN, GIFT_ITEM_COUNT_MAX);
  // Draw distinct items without replacement so a gift is always itemCount
  // *different* categories (re-rolling a repeat rather than merging
  // quantities keeps each item's delta within its intended 1-24 range).
  const chosen = new Map<EconomyItemId, number>();
  let attempt = 0;
  while (chosen.size < itemCount && attempt < itemCount * 8) {
    const itemRng = createEconomyRng(fixtureId, userId, frameId, `${salt}:item:${attempt}`);
    const item = drawWeightedItem(itemRng);
    attempt += 1;
    if (chosen.has(item.id)) continue;
    const quantityRng = createEconomyRng(fixtureId, userId, frameId, `${salt}:qty:${item.id}`);
    const quantity = drawIntInRange(quantityRng, GIFT_ITEM_QUANTITY_MIN, GIFT_ITEM_QUANTITY_MAX);
    chosen.set(item.id, quantity);
  }
  return [...chosen.entries()].map(([item, delta]) => ({ item, delta }));
}

/**
 * Gift payout on a winning call, sized by the rarity of the staked item: the
 * payout item is always `bananas` (the flavor "you called it on a lambo, you
 * win two dozen bananas" from the PRD), scaled by the staked item's
 * rarityTier so rarer stakes pay out a visibly bigger pile. Never priced --
 * purely a quantity scale-up.
 */
function computeWinJunkPayout(stakedItem: EconomyItemId, rng: () => number): EconomyItemDelta {
  const stakedDef = getEconomyItemDefinition(stakedItem);
  const basePayout = drawIntInRange(rng, 4, 8);
  const payoutQuantity = basePayout * stakedDef.rarityTier;
  return { item: 'bananas', delta: payoutQuantity };
}

// ---------------------------------------------------------------------------
// Room chatter / match moment copy (canned, deterministic, keyed to cues)
// ---------------------------------------------------------------------------

const CHATTER_LINES: readonly string[] = [
  'the room is buzzing',
  'someone just called their lambo, brave',
  'anyone else holding bananas rn',
  'this is getting good',
  'coolness on the line, let\'s go',
];

function chatterLineFor(fixtureId: number | string, frameId: string, index: number): string {
  const rng = createEconomyRng(fixtureId, 'room', frameId, `chatter:${index}`);
  const pick = Math.floor(rng() * CHATTER_LINES.length);
  return CHATTER_LINES[pick]!;
}

function matchMomentText(cue: SimulationCue): string | undefined {
  if (cue.kind === 'goal_confirmed') return 'GOAL! the room erupts';
  if (cue.kind === 'card') {
    const action = actionOf(cue);
    return action === 'red_card' ? 'red card shown' : 'yellow card shown';
  }
  if (cue.kind === 'phase_change') {
    const phase = phaseOf(cue);
    if (phase === 'half_time') return 'half-time whistle';
    if (phase === 'second_half') return 'second half underway';
    if (phase === 'finalised') return 'full time';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildFirstHalfPrompt(fixtureId: number | string, frame: SemanticFrame): EconomyBetPrompt {
  return {
    id: `${fixtureId}:economy:prompt:first_half_goal`,
    fixtureId,
    trigger: 'first_half_kickoff',
    predicate: 'goal_in_first_half',
    windowStartSeconds: 0,
    windowEndSeconds: FIRST_HALF_GOAL_WINDOW_SECONDS,
    sourceFrameId: frame.id,
    copy: 'Make your call: a goal in the first half?',
  };
}

/** ENG-007/ENG-008: generalized "big moment" trigger (corner, free kick, or shot outcome), 5-minute window. */
function buildBigMomentPrompt(fixtureId: number | string, frame: SemanticFrame, triggerCue: SimulationCue): EconomyBetPrompt {
  const windowStart = frame.matchClockSeconds ?? 0;
  const trigger = triggerCue.kind === 'shot_outcome' ? 'dangerous_shot' : 'big_moment';
  return {
    id: `${fixtureId}:economy:prompt:big_moment:${triggerCue.id}`,
    fixtureId,
    trigger,
    predicate: 'goal_within_window',
    windowStartSeconds: windowStart,
    windowEndSeconds: windowStart + BIG_MOMENT_GOAL_WINDOW_SECONDS,
    sourceFrameId: frame.id,
    copy: 'Make your call: a goal in the next 5 minutes?',
  };
}

/** ENG-010: offered when a confirmed card cue signals the match "heating up". 10-minute window. */
function buildCardCallPrompt(fixtureId: number | string, frame: SemanticFrame, triggerCueId: string): EconomyBetPrompt {
  const windowStart = frame.matchClockSeconds ?? 0;
  return {
    id: `${fixtureId}:economy:prompt:card_call:${triggerCueId}`,
    fixtureId,
    trigger: 'match_heats_up',
    predicate: 'card_within_window',
    windowStartSeconds: windowStart,
    windowEndSeconds: windowStart + CARD_CALL_WINDOW_SECONDS,
    sourceFrameId: frame.id,
    copy: 'Make your call: a card in the next 10 minutes?',
  };
}

/**
 * ENG-002/ENG-003: team-pick call, offered once after kickoff and re-offered
 * after each confirmed goal. `offerIndex` makes every re-offer's promptId
 * distinct and stable (not reused), so a settlement/void on an earlier offer
 * never collides with a later one's id.
 */
function buildWhoScoresNextPrompt(fixtureId: number | string, frame: SemanticFrame, offerIndex: number): EconomyBetPrompt {
  return {
    id: `${fixtureId}:economy:prompt:who_scores_next:${offerIndex}`,
    fixtureId,
    trigger: offerIndex === 0 ? 'kickoff' : 'goal_confirmed',
    predicate: 'who_scores_next',
    sourceFrameId: frame.id,
    copy: 'Make your call: who scores next?',
  };
}

function buildHalfTimeApproachPrompt(fixtureId: number | string, frame: SemanticFrame): EconomyBetPrompt {
  const windowEnd = frame.matchClockSeconds ?? FIRST_HALF_GOAL_WINDOW_SECONDS;
  return {
    id: `${fixtureId}:economy:prompt:score_before_half_time`,
    fixtureId,
    trigger: 'approaching_half_time',
    predicate: 'score_before_half_time',
    windowStartSeconds: Math.max(0, windowEnd - HALF_TIME_APPROACH_WINDOW_SECONDS),
    windowEndSeconds: windowEnd,
    sourceFrameId: frame.id,
    copy: 'Make your call: score before the break?',
  };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

function settleBetWin(
  state: EconomyDirectorState,
  frame: SemanticFrame,
  open: OpenBetState,
  options?: { settledByCueId?: string; scoringParticipant?: MatchEngineParticipant },
): void {
  const rng = createEconomyRng(state.fixtureId, state.userId, frame.id, `settle:${open.promptId}`);
  const giftPayout = computeWinJunkPayout(open.stakedItem, rng);
  const id = eventId(state.fixtureId, state.userId, 'bet_settled_win', open.promptId);
  const event: EconomyEvent = {
    id,
    kind: 'bet_settled_win',
    fixtureId: state.fixtureId,
    userId: state.userId,
    seq: frame.seq,
    sourceFrameId: frame.id,
    stateRevision: frame.stateRevision,
    coolnessDelta: ECONOMY_WIN_COOLNESS_GAIN,
    itemDeltas: [giftPayout],
    causationId: open.betTakenEventId,
    promptId: open.promptId,
    betPredicate: open.predicate,
    stakedItem: open.stakedItem,
    scoringParticipant: options?.scoringParticipant,
    text: 'Called it! coolness up.',
  };
  pushEvent(state, event);
  state.settledBets.set(open.promptId, {
    settleEventId: id,
    outcome: 'win',
    predicate: open.predicate,
    stakedItem: open.stakedItem,
    coolnessDelta: ECONOMY_WIN_COOLNESS_GAIN,
    itemDeltas: [giftPayout],
    settledByCueId: options?.settledByCueId,
    voided: false,
  });
  state.openBets.delete(open.promptId);
}

function settleBetLoss(
  state: EconomyDirectorState,
  frame: SemanticFrame,
  open: OpenBetState,
): void {
  const id = eventId(state.fixtureId, state.userId, 'bet_settled_loss', open.promptId);
  const event: EconomyEvent = {
    id,
    kind: 'bet_settled_loss',
    fixtureId: state.fixtureId,
    userId: state.userId,
    seq: frame.seq,
    sourceFrameId: frame.id,
    stateRevision: frame.stateRevision,
    coolnessDelta: -ECONOMY_LOSS_COOLNESS_DIP,
    // Losing never removes the staked item -- no negative itemDeltas here.
    itemDeltas: [],
    causationId: open.betTakenEventId,
    promptId: open.promptId,
    betPredicate: open.predicate,
    stakedItem: open.stakedItem,
    text: 'Call missed, quietly. Your gift is safe.',
  };
  pushEvent(state, event);
  state.settledBets.set(open.promptId, {
    settleEventId: id,
    outcome: 'loss',
    predicate: open.predicate,
    stakedItem: open.stakedItem,
    coolnessDelta: -ECONOMY_LOSS_COOLNESS_DIP,
    itemDeltas: [],
    voided: false,
  });
  state.openBets.delete(open.promptId);
}

/**
 * ENG-006: a who_scores_next call still open when the match reaches full
 * time with no further goal is **voided with the stake returned quietly**
 * (PRD "Naming"/call-set section, explicit) -- distinct from an ordinary
 * loss: no coolness dip, no gift payout, just the original stake back. Modeled
 * as its own settlement kind (`bet_voided` with an all-zero net, since the
 * refund event's `coolnessDelta` exactly cancels the `bet_taken` debit) so
 * `foldEconomyBalances` needs no special case: the fold is still a sum of
 * deltas, and here they happen to sum to zero for this call.
 */
function voidOpenBetNoRefundNeeded(
  state: EconomyDirectorState,
  frame: SemanticFrame,
  open: OpenBetState,
): void {
  const id = eventId(state.fixtureId, state.userId, 'bet_voided', open.promptId);
  const event: EconomyEvent = {
    id,
    kind: 'bet_voided',
    fixtureId: state.fixtureId,
    userId: state.userId,
    seq: frame.seq,
    sourceFrameId: frame.id,
    stateRevision: frame.stateRevision,
    // Refund the stake exactly: bet_taken already applied -ECONOMY_FIXED_STAKE_COOLNESS.
    coolnessDelta: ECONOMY_FIXED_STAKE_COOLNESS,
    itemDeltas: [],
    causationId: open.betTakenEventId,
    promptId: open.promptId,
    betPredicate: open.predicate,
    stakedItem: open.stakedItem,
    text: 'No further goal before full time -- your call is voided, stake returned.',
  };
  pushEvent(state, event);
  state.settledBets.set(open.promptId, {
    settleEventId: id,
    outcome: 'voided',
    predicate: open.predicate,
    stakedItem: open.stakedItem,
    coolnessDelta: ECONOMY_FIXED_STAKE_COOLNESS,
    itemDeltas: [],
    voided: true,
  });
  state.openBets.delete(open.promptId);
}

/**
 * Voids/reverses a previously settled bet on `incident_retracted`, emitting a
 * correction event that reverses both the coolness delta and any gift payout
 * explicitly (never a silent balance edit). Idempotent: a settlement already
 * voided is never voided twice.
 */
function voidSettledBet(
  state: EconomyDirectorState,
  frame: SemanticFrame,
  promptId: string,
  settled: SettledBetRecord,
): void {
  if (settled.voided) return;
  const id = eventId(state.fixtureId, state.userId, 'bet_voided', promptId);
  const reversedItemDeltas: EconomyItemDelta[] = settled.itemDeltas.map((itemDelta) => ({
    item: itemDelta.item,
    delta: -itemDelta.delta,
  }));
  const event: EconomyEvent = {
    id,
    kind: 'bet_voided',
    fixtureId: state.fixtureId,
    userId: state.userId,
    seq: frame.seq,
    sourceFrameId: frame.id,
    stateRevision: frame.stateRevision,
    coolnessDelta: -settled.coolnessDelta,
    itemDeltas: reversedItemDeltas,
    causationId: settled.settleEventId,
    promptId,
    text: 'Call corrected: the confirmed goal was overturned.',
  };
  pushEvent(state, event);
  settled.voided = true;
}

// ---------------------------------------------------------------------------
// Director
// ---------------------------------------------------------------------------

function ensureWelcomeGiftOffered(state: EconomyDirectorState, frame: SemanticFrame): void {
  if (state.hasOfferedWelcomeGift) return;
  state.hasOfferedWelcomeGift = true;
  const id = eventId(state.fixtureId, state.userId, 'welcome_gift_offered', frame.id);
  pushEvent(state, {
    id,
    kind: 'welcome_gift_offered',
    fixtureId: state.fixtureId,
    userId: state.userId,
    seq: frame.seq,
    sourceFrameId: frame.id,
    stateRevision: frame.stateRevision,
    coolnessDelta: 0,
    itemDeltas: [],
    text: 'We\'ve got some gifts for you -- want to see what you got?',
  });
}

/** POOL-001: announces the seeded Gift Pool once, early in the stream (alongside the welcome gift offer on the first frame). */
function ensurePoolSeeded(state: EconomyDirectorState, frame: SemanticFrame): void {
  if (state.poolSeeded) return;
  state.poolSeeded = true;
  const seed = computeGiftPoolSeed(state.fixtureId);
  const id = eventId(state.fixtureId, state.userId, 'pool_seeded', frame.id);
  const summary = seed.map((d) => `${d.delta} ${getEconomyItemDefinition(d.item).label.toLowerCase()}`).join(', ');
  pushEvent(state, {
    id,
    kind: 'pool_seeded',
    fixtureId: state.fixtureId,
    userId: state.userId,
    seq: frame.seq,
    sourceFrameId: frame.id,
    stateRevision: frame.stateRevision,
    coolnessDelta: 0,
    itemDeltas: [],
    poolItemDeltas: seed,
    text: `Tonight's Gift Pool: ${summary}.`,
  });
}

/**
 * POOL-003..010/POOL-015: splits the Gift Pool at full time. Eligibility is
 * computed from `state.settledBets` *after* the frame loop (and therefore
 * after every void/correction has been applied -- POOL-015), never from a
 * point-in-time snapshot taken before a retraction could still land. One
 * share per user regardless of how many calls they won (POOL-008/POOL-009):
 * winners are a Set of ids, not a count. No winners returns the pool to the
 * house with a single quiet event (POOL-007) rather than a silent no-op.
 */
function emitPoolSplit(state: EconomyDirectorState, frame: SemanticFrame): void {
  const seed = computeGiftPoolSeed(state.fixtureId);
  const userHasWinningCall = [...state.settledBets.values()].some((settled) => !settled.voided && settled.outcome === 'win');
  const simulated = deriveSimulatedRoomMembers(state.fixtureId, [...state.emittedFrames], state.simulatedMemberCount);

  const winnerIds: string[] = [];
  if (userHasWinningCall) winnerIds.push(state.userId);
  for (const outcome of simulated) {
    if (outcome.hasWinningCall) winnerIds.push(outcome.member.id);
  }

  if (winnerIds.length === 0) {
    const id = eventId(state.fixtureId, state.userId, 'pool_split', 'house');
    pushEvent(state, {
      id,
      kind: 'pool_split',
      fixtureId: state.fixtureId,
      userId: state.userId,
      seq: frame.seq,
      sourceFrameId: frame.id,
      stateRevision: frame.stateRevision,
      coolnessDelta: 0,
      itemDeltas: [],
      poolItemDeltas: [],
      poolOutcome: 'no_winners',
      text: 'No winning calls tonight -- the Gift Pool returns to the house.',
    });
    return;
  }

  const perItemAllocations = seed.map(({ item, delta }) => ({
    item,
    allocation: splitPoolItemAmongWinners(state.fixtureId, item, delta, winnerIds),
  }));

  const userShare: EconomyItemDelta[] = [];
  for (const { item, allocation } of perItemAllocations) {
    const quantity = allocation.get(state.userId) ?? 0;
    if (quantity > 0) userShare.push({ item, delta: quantity });
  }

  const id = eventId(state.fixtureId, state.userId, 'pool_split', state.userId);
  const summary = userShare.length > 0
    ? userShare.map((d) => `${d.delta} ${getEconomyItemDefinition(d.item).label.toLowerCase()}`).join(', ')
    : 'nothing this time';
  pushEvent(state, {
    id,
    kind: 'pool_split',
    fixtureId: state.fixtureId,
    userId: state.userId,
    seq: frame.seq,
    sourceFrameId: frame.id,
    stateRevision: frame.stateRevision,
    coolnessDelta: 0,
    // POOL-014: the pool payout folds into the Stash as ordinary positive
    // item deltas -- no separate "pool balance" concept.
    itemDeltas: userShare,
    poolItemDeltas: userShare,
    poolOutcome: 'split',
    text: userHasWinningCall
      ? `Gift Pool split among ${winnerIds.length} winner${winnerIds.length === 1 ? '' : 's'}: you get ${summary}.`
      : `Gift Pool split among ${winnerIds.length} winner${winnerIds.length === 1 ? '' : 's'} -- you didn't have a winning call this time.`,
  });
}

function grantWelcomeGift(state: EconomyDirectorState, anchorFrameId: string, frame: SemanticFrame): void {
  if (state.hasClaimedGift) return;
  state.hasClaimedGift = true;
  const itemDeltas = grantRandomItems(state.fixtureId, state.userId, anchorFrameId, 'welcome_gift');
  const id = eventId(state.fixtureId, state.userId, 'gift_granted', anchorFrameId);
  pushEvent(state, {
    id,
    kind: 'gift_granted',
    fixtureId: state.fixtureId,
    userId: state.userId,
    seq: frame.seq,
    sourceFrameId: frame.id,
    stateRevision: frame.stateRevision,
    coolnessDelta: ECONOMY_STARTING_COOLNESS,
    itemDeltas,
    text: 'Starter gifts claimed.',
  });
}

function grantMatchMomentDrop(state: EconomyDirectorState, frame: SemanticFrame, cue: SimulationCue): void {
  // Occasional match-moment drops, e.g. on goals -- only after the user has
  // claimed the welcome gift, so an unclaimed user's pile stays predictable.
  if (!state.hasClaimedGift) return;
  const cueId = cue.id;
  const itemDeltas = grantRandomItems(state.fixtureId, state.userId, frame.id, `drop:${cueId}`);
  const id = eventId(state.fixtureId, state.userId, 'drop_granted', `${frame.id}:${cueId}`);
  pushEvent(state, {
    id,
    kind: 'drop_granted',
    fixtureId: state.fixtureId,
    userId: state.userId,
    seq: frame.seq,
    sourceFrameId: frame.id,
    stateRevision: frame.stateRevision,
    coolnessDelta: 0,
    itemDeltas,
    text: 'A gift lands.',
  });
}

function offerPrompt(state: EconomyDirectorState, frame: SemanticFrame, prompt: EconomyBetPrompt): void {
  if (state.openPrompts.has(prompt.id)) return;
  state.openPrompts.set(prompt.id, prompt);
  state.everOfferedPromptIds.add(prompt.id);
  const id = eventId(state.fixtureId, state.userId, 'prompt_offered', prompt.id);
  pushEvent(state, {
    id,
    kind: 'prompt_offered',
    fixtureId: state.fixtureId,
    userId: state.userId,
    seq: frame.seq,
    sourceFrameId: frame.id,
    stateRevision: frame.stateRevision,
    coolnessDelta: 0,
    itemDeltas: [],
    promptId: prompt.id,
    betPredicate: prompt.predicate,
    text: prompt.copy,
  });
}

function expirePrompt(state: EconomyDirectorState, frame: SemanticFrame, promptId: string): void {
  if (!state.openPrompts.has(promptId)) return;
  state.openPrompts.delete(promptId);
  const id = eventId(state.fixtureId, state.userId, 'prompt_expired', promptId);
  pushEvent(state, {
    id,
    kind: 'prompt_expired',
    fixtureId: state.fixtureId,
    userId: state.userId,
    seq: frame.seq,
    sourceFrameId: frame.id,
    stateRevision: frame.stateRevision,
    coolnessDelta: 0,
    itemDeltas: [],
    promptId,
  });
}

/** Attempts to match any pending bet_taken actions against currently-open prompts. */
function tryConsumePendingActions(state: EconomyDirectorState, frame: SemanticFrame): void {
  const remaining: EconomyUserAction[] = [];
  for (const action of state.pendingActions) {
    if (action.kind !== 'bet_taken') {
      remaining.push(action);
      continue;
    }
    if (state.openBets.has(action.promptId) || state.settledBets.has(action.promptId)) {
      // Already taken or already settled: this action is stale, drop it permanently.
      continue;
    }
    const prompt = state.openPrompts.get(action.promptId);
    if (!prompt) {
      if (!state.everOfferedPromptIds.has(action.promptId)) {
        // Not offered yet -- keep waiting for a later frame to open it.
        remaining.push(action);
      }
      // Already offered once and no longer open (expired with no take): drop permanently, nothing to take.
      continue;
    }
    const id = eventId(state.fixtureId, state.userId, 'bet_taken', action.promptId);
    pushEvent(state, {
      id,
      kind: 'bet_taken',
      fixtureId: state.fixtureId,
      userId: state.userId,
      seq: frame.seq,
      sourceFrameId: frame.id,
      stateRevision: frame.stateRevision,
      coolnessDelta: -ECONOMY_FIXED_STAKE_COOLNESS,
      itemDeltas: [],
      promptId: action.promptId,
      betPredicate: prompt.predicate,
      stakedItem: action.itemId,
      pickedParticipant: prompt.predicate === 'who_scores_next' ? action.pickedParticipant : undefined,
      text: `Called it -- ${action.itemId} + ${ECONOMY_FIXED_STAKE_COOLNESS} coolness on the line.`,
    });
    state.openBets.set(action.promptId, {
      promptId: action.promptId,
      betTakenEventId: id,
      predicate: prompt.predicate,
      stakedItem: action.itemId,
      pickedParticipant: prompt.predicate === 'who_scores_next' ? action.pickedParticipant : undefined,
      windowEndSeconds: prompt.windowEndSeconds,
      takenAtFrameId: frame.id,
      takenAtStateRevision: frame.stateRevision,
    });
  }
  state.pendingActions = remaining;
}

/** Settles/expires any open bets or prompts whose window has closed by the given match clock. */
function closeExpiredWindows(state: EconomyDirectorState, frame: SemanticFrame, clockSeconds: number | undefined): void {
  if (typeof clockSeconds !== 'number') return;
  for (const [promptId, prompt] of [...state.openPrompts.entries()]) {
    if (typeof prompt.windowEndSeconds === 'number' && clockSeconds > prompt.windowEndSeconds) {
      expirePrompt(state, frame, promptId);
    }
  }
  for (const [promptId, open] of [...state.openBets.entries()]) {
    if (typeof open.windowEndSeconds === 'number' && clockSeconds > open.windowEndSeconds) {
      // Window closed with no confirmed goal inside it: loss.
      settleBetLoss(state, frame, open);
    }
  }
}

/**
 * ENG-004/ENG-015/ENG-018: goal-settled predicates. `goal_in_first_half`,
 * `goal_within_window`, and `score_before_half_time` settle win on ANY
 * confirmed goal inside their window. `who_scores_next` settles win only if
 * the picked team scored, and loss if the *other* team scored (the call is
 * about which team, so an "any goal" outcome doesn't apply) -- either way it
 * is immediately re-offered (ENG-003) for the next goal, tied to the new
 * frame. `settledByCueId` is recorded on every settlement caused by a
 * specific goal cue, so a later retraction of exactly that goal (not "any"
 * goal) can find and reverse only the settlement(s) it actually caused.
 */
function handleGoalConfirmed(state: EconomyDirectorState, frame: SemanticFrame, cue: SimulationCue): void {
  if (cue.lifecycle !== 'confirmed') return;
  const clockSeconds = frame.matchClockSeconds;
  const scoringParticipant = cue.participant;

  for (const [promptId, open] of [...state.openBets.entries()]) {
    const withinWindow = typeof open.windowEndSeconds !== 'number'
      || typeof clockSeconds !== 'number'
      || clockSeconds <= open.windowEndSeconds;

    if (open.predicate === 'who_scores_next') {
      // who_scores_next has no window -- it resolves on the next goal,
      // whichever team scores it (a goal from an unknown/undefined
      // participant cannot settle a team pick either way; leave it open).
      if (scoringParticipant === undefined) continue;
      if (open.pickedParticipant === scoringParticipant) {
        settleBetWin(state, frame, open, { settledByCueId: cue.id, scoringParticipant });
      } else {
        settleBetLoss(state, frame, open);
        const settled = state.settledBets.get(promptId);
        if (settled) settled.settledByCueId = cue.id;
      }
      state.openPrompts.delete(promptId);
      continue;
    }

    if (!withinWindow) continue;
    if (open.predicate === 'goal_in_first_half' || open.predicate === 'goal_within_window' || open.predicate === 'score_before_half_time') {
      settleBetWin(state, frame, open, { settledByCueId: cue.id, scoringParticipant });
      state.openPrompts.delete(promptId);
    }
  }

  // ENG-003: re-offer who_scores_next immediately after every confirmed
  // goal, tied to the frame that confirmed it. Guarded per distinct goal cue
  // id (`reofferedForGoalCueIds`) so a re-delivered/duplicate frame, or a
  // second revision of the same real goal incident (see game-view.ts's
  // handleGoalConfirmed doc comment on repeated goal_confirmed revisions),
  // re-offers exactly once per real goal rather than once per cue processing.
  if (!state.reofferedForGoalCueIds.has(cue.id)) {
    state.reofferedForGoalCueIds.add(cue.id);
    reofferWhoScoresNext(state, frame);
  }
}

/**
 * Offers a fresh who_scores_next call. Each offer gets its own distinct
 * promptId (`offerIndex`), so ENG-018 falls out for free: a retraction only
 * ever voids a *settlement* whose recorded `settledByCueId` matches the
 * retracted goal exactly (see `handleIncidentRetracted`) -- a freshly
 * re-offered call has no settlement yet (or, once it does settle, a
 * different `settledByCueId` tied to whichever goal actually resolved
 * it), so it is never touched by an earlier goal's retraction.
 */
function reofferWhoScoresNext(state: EconomyDirectorState, frame: SemanticFrame): void {
  const offerIndex = state.whoScoresNextOfferCount;
  state.whoScoresNextOfferCount += 1;
  state.whoScoresNextEverOffered = true;
  const prompt = buildWhoScoresNextPrompt(state.fixtureId, frame, offerIndex);
  offerPrompt(state, frame, prompt);
}

/**
 * ENG-017: only a *goal* retraction voids goal-settled calls. A card
 * retraction (if the source ever emits one) must instead void only
 * card_within_window settlements traced to that exact card cue, leaving goal
 * calls untouched -- the two incident types are handled as separate
 * branches, never a blanket "void every open win".
 *
 * ENG-015/ENG-016/ENG-018: goal-settled calls (`goal_in_first_half`,
 * `goal_within_window`, `who_scores_next`) are only voided when their
 * recorded `settledByCueId` matches the exact retracted cue id -- not
 * "any settled win" -- so a retraction of one goal never disturbs a
 * settlement caused by a different goal (this is what makes ENG-018 safe:
 * a who_scores_next call re-offered after goal A, and settled by goal B, is
 * untouched when goal A is retracted).
 */
function handleIncidentRetracted(state: EconomyDirectorState, frame: SemanticFrame, cue: SimulationCue): void {
  const retractedAction = actionOf(cue);
  const retractedGoalCueId = cue.id;

  if (retractedAction === 'goal' || retractedAction === undefined) {
    for (const [promptId, settled] of state.settledBets.entries()) {
      if (settled.voided) continue;
      const isGoalSettledPredicate = settled.predicate === 'goal_in_first_half'
        || settled.predicate === 'goal_within_window'
        || settled.predicate === 'score_before_half_time'
        || settled.predicate === 'who_scores_next';
      if (!isGoalSettledPredicate) continue;
      if (settled.settledByCueId !== retractedGoalCueId) continue;
      voidSettledBet(state, frame, promptId, settled);
    }
    return;
  }

  if (retractedAction === 'card') {
    // ENG-017: a retracted card only voids card_within_window settlements
    // traced to that exact card cue -- goal-settled calls are untouched.
    for (const [promptId, settled] of state.settledBets.entries()) {
      if (settled.voided) continue;
      if (settled.predicate !== 'card_within_window') continue;
      if (settled.settledByCueId !== retractedGoalCueId) continue;
      voidSettledBet(state, frame, promptId, settled);
    }
  }
}

/** ENG-011/ENG-012: card_within_window settles win on any confirmed card cue inside the window. */
function handleCardConfirmed(state: EconomyDirectorState, frame: SemanticFrame, cue: SimulationCue): void {
  if (cue.lifecycle !== 'confirmed') return;
  const clockSeconds = frame.matchClockSeconds;
  for (const [promptId, open] of [...state.openBets.entries()]) {
    if (open.predicate !== 'card_within_window') continue;
    const withinWindow = typeof open.windowEndSeconds !== 'number'
      || typeof clockSeconds !== 'number'
      || clockSeconds <= open.windowEndSeconds;
    if (!withinWindow) continue;
    settleBetWin(state, frame, open, { settledByCueId: cue.id });
    state.openPrompts.delete(promptId);
  }
}

/**
 * ENG-013/ENG-014: closes every call type deterministically at a phase
 * boundary. `half_time` closes first-half-scoped calls
 * (`goal_in_first_half`, `score_before_half_time`) as a loss if their window
 * hadn't already resolved. `finalised` (full time) closes every remaining
 * open call: `who_scores_next` voids with the stake refunded (ENG-006, the
 * PRD's explicit "no further goal -> voided, stake returned" rule); every
 * other predicate still open at full time (a `goal_within_window` or
 * `card_within_window` whose window simply hadn't elapsed yet when the match
 * ended) settles loss, since its window closing is now moot -- no call
 * survives past full time in an open/ambiguous state.
 */
function handlePhaseChange(state: EconomyDirectorState, frame: SemanticFrame, cue: SimulationCue): void {
  const phase = phaseOf(cue);
  if (phase) state.phase = phase;

  if (phase === 'half_time') {
    for (const [promptId, prompt] of [...state.openPrompts.entries()]) {
      if (prompt.predicate === 'goal_in_first_half' || prompt.predicate === 'score_before_half_time') {
        expirePrompt(state, frame, promptId);
      }
    }
    for (const [promptId, open] of [...state.openBets.entries()]) {
      if (open.predicate === 'goal_in_first_half' || open.predicate === 'score_before_half_time') {
        settleBetLoss(state, frame, open);
      }
    }
  }

  if (phase === 'finalised' && !state.fullTimeClosed) {
    state.fullTimeClosed = true;
    for (const [promptId] of [...state.openPrompts.entries()]) {
      expirePrompt(state, frame, promptId);
    }
    for (const [, open] of [...state.openBets.entries()]) {
      if (open.predicate === 'who_scores_next') {
        voidOpenBetNoRefundNeeded(state, frame, open);
      } else {
        settleBetLoss(state, frame, open);
      }
    }
  }
}

/**
 * Builds the ordered Playful Economy event timeline from a semantic frame
 * stream plus the local user's actions. Pure and deterministic: frames are
 * sorted by seq first (any input order yields the same output), duplicate
 * frames are ignored via the emitted-id guard, and no wall-clock or
 * `Math.random` state is read -- all randomness is the injected seeded RNG.
 *
 * Settlement only ever fires on `confirmed` lifecycle cues.
 * `incident_retracted` voids/re-settles any bet already settled off the
 * retracted goal, emitting an explicit reversal event.  `phase_change` to
 * `half_time` closes open first-half windows.
 */
export function buildEconomyTimeline(
  frames: readonly SemanticFrame[],
  options: EconomyTimelineOptions,
): readonly EconomyEvent[] {
  const ordered = [...frames].sort(compareFrames);
  if (ordered.length === 0) return [];

  const state: EconomyDirectorState = {
    fixtureId: ordered[0]!.fixtureId,
    userId: options.userId,
    events: [],
    emittedIds: new Set(),
    firstHalfPromptOffered: false,
    halfTimeApproachPromptOffered: false,
    bigMomentPromptedCueIds: new Set(),
    cardPromptedCueIds: new Set(),
    whoScoresNextEverOffered: false,
    openPrompts: new Map(),
    everOfferedPromptIds: new Set(),
    openBets: new Map(),
    settledBets: new Map(),
    pendingActions: [...(options.actions ?? [])],
    hasClaimedGift: false,
    hasOfferedWelcomeGift: false,
    whoScoresNextOfferCount: 0,
    reofferedForGoalCueIds: new Set(),
    fullTimeClosed: false,
    poolSeeded: false,
    simulatedMemberCount: options.simulatedMemberCount ?? DEFAULT_SIMULATED_MEMBER_COUNT,
    emittedFrames: [],
  };

  for (const frame of ordered) {
    state.emittedFrames.push(frame);
    state.lastFrame = frame;
    if (frame.matchClockSeconds !== undefined) state.clockSeconds = frame.matchClockSeconds;
    if (state.firstFrameId === undefined) {
      state.firstFrameId = frame.id;
      state.firstFrameSeq = frame.seq;
      state.firstFrameStateRevision = frame.stateRevision;
      ensureWelcomeGiftOffered(state, frame);
      ensurePoolSeeded(state, frame);
    }

    // Apply a gift_claimed action as soon as its anchor frame (or any frame
    // at/after it in seq order) has been reached, so the grant lands no
    // earlier than the moment the user actually claimed.
    for (const action of state.pendingActions) {
      if (action.kind === 'gift_claimed' && !state.hasClaimedGift) {
        grantWelcomeGift(state, action.anchorFrameId, frame);
      }
    }

    const cues = relevantCues(frame);
    for (const cue of cues) {
      switch (cue.kind) {
        case 'phase_change': {
          const phase = phaseOf(cue);
          handlePhaseChange(state, frame, cue);
          if (phase === 'first_half' && !state.firstHalfPromptOffered) {
            state.firstHalfPromptOffered = true;
            offerPrompt(state, frame, buildFirstHalfPrompt(state.fixtureId, frame));
          }
          // ENG-002: who_scores_next is offered once after kickoff (first_half start).
          if (phase === 'first_half' && !state.whoScoresNextEverOffered) {
            reofferWhoScoresNext(state, frame);
          }
          const moment = matchMomentText(cue);
          if (moment) {
            const id = eventId(state.fixtureId, state.userId, 'match_moment', `${frame.id}:${cue.id}`);
            pushEvent(state, {
              id,
              kind: 'match_moment',
              fixtureId: state.fixtureId,
              userId: state.userId,
              seq: frame.seq,
              sourceFrameId: frame.id,
              stateRevision: frame.stateRevision,
              coolnessDelta: 0,
              itemDeltas: [],
              text: moment,
            });
          }
          break;
        }
        case 'set_piece':
        case 'shot_outcome': {
          // ENG-007/ENG-009: any big-moment cue (corner, free kick, or a
          // shot outcome) can trigger goal-in-5, but only one such call is
          // ever open at a time -- a second, *different* big-moment cue
          // arriving mid-window must not stack a duplicate call, matching
          // the per-cue-id guard's intent but extended across cue ids.
          if (isBigMomentCue(cue) && !state.bigMomentPromptedCueIds.has(cue.id)) {
            const alreadyOpen = [...state.openPrompts.values()].some((prompt) => prompt.predicate === 'goal_within_window');
            if (!alreadyOpen) {
              state.bigMomentPromptedCueIds.add(cue.id);
              offerPrompt(state, frame, buildBigMomentPrompt(state.fixtureId, frame, cue));
            } else {
              // Still record the cue id as "seen" so a duplicate/re-delivered
              // copy of this exact cue can't slip through once the window closes.
              state.bigMomentPromptedCueIds.add(cue.id);
            }
          }
          break;
        }
        case 'goal_confirmed': {
          handleGoalConfirmed(state, frame, cue);
          const moment = matchMomentText(cue);
          if (moment) {
            const id = eventId(state.fixtureId, state.userId, 'match_moment', `${frame.id}:${cue.id}`);
            pushEvent(state, {
              id,
              kind: 'match_moment',
              fixtureId: state.fixtureId,
              userId: state.userId,
              seq: frame.seq,
              sourceFrameId: frame.id,
              stateRevision: frame.stateRevision,
              coolnessDelta: 0,
              itemDeltas: [],
              text: moment,
            });
          }
          grantMatchMomentDrop(state, frame, cue);
          break;
        }
        case 'card': {
          // ENG-011/ENG-012: settle any open card_within_window calls before
          // considering whether this same card also opens a new one, so a
          // single card cue can both resolve an existing call and (per the
          // one-open-at-a-time rule below) not immediately reopen a
          // duplicate for itself.
          handleCardConfirmed(state, frame, cue);
          // ENG-010: a confirmed card is the "match heats up" trigger for a
          // fresh card-in-10 call, gated the same one-open-at-a-time way as
          // goal-in-5 (ENG-009's discipline generalizes here too).
          if (cue.lifecycle === 'confirmed' && !state.cardPromptedCueIds.has(cue.id)) {
            const alreadyOpen = [...state.openPrompts.values()].some((prompt) => prompt.predicate === 'card_within_window');
            state.cardPromptedCueIds.add(cue.id);
            if (!alreadyOpen) {
              offerPrompt(state, frame, buildCardCallPrompt(state.fixtureId, frame, cue.id));
            }
          }
          const moment = matchMomentText(cue);
          if (moment) {
            const id = eventId(state.fixtureId, state.userId, 'match_moment', `${frame.id}:${cue.id}`);
            pushEvent(state, {
              id,
              kind: 'match_moment',
              fixtureId: state.fixtureId,
              userId: state.userId,
              seq: frame.seq,
              sourceFrameId: frame.id,
              stateRevision: frame.stateRevision,
              coolnessDelta: 0,
              itemDeltas: [],
              text: moment,
            });
          }
          break;
        }
        case 'incident_retracted':
          handleIncidentRetracted(state, frame, cue);
          break;
        case 'score_commit':
          break;
        default:
          break;
      }
    }

    // Approaching-half-time prompt: fires once, inside the fixed window
    // before FIRST_HALF_GOAL_WINDOW_SECONDS, while still in first_half.
    if (
      !state.halfTimeApproachPromptOffered
      && state.phase === 'first_half'
      && typeof state.clockSeconds === 'number'
      && state.clockSeconds >= FIRST_HALF_GOAL_WINDOW_SECONDS - HALF_TIME_APPROACH_WINDOW_SECONDS
      && state.clockSeconds <= FIRST_HALF_GOAL_WINDOW_SECONDS
    ) {
      state.halfTimeApproachPromptOffered = true;
      offerPrompt(state, frame, buildHalfTimeApproachPrompt(state.fixtureId, frame));
    }

    tryConsumePendingActions(state, frame);
    closeExpiredWindows(state, frame, state.clockSeconds);
  }

  // POOL-015: the split runs strictly after the full frame loop, so every
  // void/correction (including one delivered on or after the `finalised`
  // frame itself) has already been folded into `state.settledBets` before
  // eligibility is computed -- never a pre-void snapshot.
  if (state.fullTimeClosed && state.lastFrame) {
    emitPoolSplit(state, state.lastFrame);
  }

  return state.events;
}
