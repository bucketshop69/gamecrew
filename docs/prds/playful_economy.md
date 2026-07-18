# PRD: Playful Economy

## Status

Active. Revised 2026-07-18 to the stake-and-lose model (see Implementation Status for the delta against the built V1).

## Objective

Define the playful economy that lives inside Global Chat: free gifts from GameCrew, calls staked with those gifts against real TxLINE match events, and coolness — a score that only ever goes up.

The economy exists to make a fan want to keep the match screen open. It is a retention layer built on top of live football data — playful, surprising, and social.

The one-line intent:

> We hand you a gift before the match, you stake it on what happens next, and the real match decides — win and your coolness climbs, lose and the gift is gone.

## Product Direction

The playful economy should feel like:

- a gift waiting for you every match
- real risk with toy objects: staking your bananas actually costs you your bananas
- a score you can only build, never lose
- a rowdy room reacting to who won and who went bust

It should not feel like:

- a real-money betting product (no deposits, no cash-out, no odds pricing, no purchases of stakeable items)
- a progression grind (no XP, no levels)
- a generic daily-reward app mechanic detached from the football

## The Playful Rule

Gifts are the ammo, coolness is the trophy.

- **Gifts are only ever acquired free**, granted by GameCrew (pre-match gift, match-moment drops, call rewards, pool shares). There is no purchase path into the stake loop — this is the line that keeps the whole product clear of real-money betting.
- **Staking is real**: a call stakes a gift. Lose the call, lose the gift — it moves into that match's Gift Pool.
- **Coolness only ever increases.** Wins add coolness; losses never subtract it. Losing costs you ammo — the means to score — never the score itself.
- Betting *language* is allowed because the stakes are free toys. Real-money mechanics are banned.

The rule in one line:

**Free gifts in, real stakes on real matches, coolness only climbs, zero real money.**

## Naming

Canonical product vocabulary (user-facing copy must use these):

- **Gift** — the playful items (bananas, dust, a lambo). Never "junk" in copy.
- **Stash** — a user's collection: gifts with quantities, plus coolness.
- **Call** — a system-offered prediction ("Make your call: goal in the next 5 minutes?"). Replaces "bet" in all copy.
- **Gift Pool** — the per-match prize pot: seeded by GameCrew, fattened by lost stakes, split at full time among winning callers.
- **Trophies** — claimed gifts, retired from play and minted on-chain.
- **Coolness** — unchanged.

Code identifiers introduced before this naming pass (e.g. `EconomyBetPrompt`) may keep their names; new code uses the new vocabulary.

## Entry Point And The Gift Window

The economy surfaces inside **Global Chat**, a tab in Match Detail alongside Match Pulse and Game View.

**The gift window**: from ~6 hours before kickoff, a user opening that match's detail screen is checked — have they received this match's gift?

- Not yet → the gift popup lands: "We've got a gift for you — want to see what you got?" Claim plays the reveal; skipping still banks it silently.
- Already granted → no popup, ever, for that match.

The gift is **per match**, not once per lifetime. This is also the comeback floor: no matter how badly yesterday went, the next match hands you fresh ammo. A user can never be locked out of playing.

## Core Product Objects

### Gift

A playful item granted free to a user.

Fields: `id`, `userId`, `fixtureId`, `item`, `quantity`, `rarity` (sizes rewards, never a price), `reason` (`match_gift`, `match_moment`, `call_reward`, `pool_share`), `sourceFrameId`, `clock`/`phase`, `onChain`, `mintRef`.

Gifts are cosmetic and free. Rarity and quantity make them braggable; nothing is priced or purchasable.

### Coolness

The user's score. Monotonic — it only goes up.

- earned by winning calls (and select celebratory moments)
- never decreased, never spent, never cashed out
- feeds the leaderboard
- because it cannot fall, taking a call never threatens status — only ammo

### Call

A stake of a gift on a match outcome, against the house.

Fields: `id`, `fixtureId`, `userId`, `promptId`, `stakeItem` + `stakeQuantity` (the gift at risk — really at risk), `rewardItem` + `rewardQuantity` (shown up front: "stake your bananas → win a lambo"), `coolnessGain` (on win), `predicate`, `window`, `sourceFrameId`, `confidence`, `lifecycle` (`open` / `settled_win` / `settled_loss` / `voided`), `settlementFrameId`.

Settlement outcomes:

- **Win** → stake returns, reward gift lands, coolness climbs. Celebrated in the room.
- **Loss** → the staked gift moves to the match's Gift Pool. Coolness untouched. Quiet.
- **Void** (e.g. VAR wipes the settling goal, or a who-scores-next call open at full time) → stake returns, nothing else, silent.

### CallPrompt

A system-generated offer surfaced to the room; taking it creates a Call. Fields: `id`, `fixtureId`, `trigger`, `predicate`/`window`, `rewardItem`/`rewardQuantity` (the prize is part of the offer), `confidence`, `expiresAt`.

## The Call Set

System-generated calls lead; user-created challenges are out of scope. Prompts are event/phase-triggered off live match state, so they feel caused by the football, not a timer. The V1 set — basic, universally understood, cleanly settleable from confirmed events:

1. **"A goal in the first half?"** — offered at kickoff, closes at half-time.
2. **"Who scores next?"** — team pick, offered after kickoff and re-offered after each goal. Open at full time with no further goal → voided, stake returned silently.
3. **"A goal in the next 5 minutes?"** — offered on big moments (corners, dangerous attacks).
4. **"A card in the next 10 minutes?"** — offered when the match heats up.

The catalogue grows from whatever the frame stream can cleanly settle. Reward sizing: the reward's rarity scales with the staked item's rarity and the unlikeliness of the outcome — stake dust, win bananas; stake a lambo on a long shot, win legendary. Exact ladder lives in the engine and is deterministic.

## Gift Pool

Each match opens with a Gift Pool **seeded by GameCrew** ("tonight's pool: 500 bananas, 2 lambos") and **fattened by every lost stake** during the match — losses are productive for the room. At full time it splits among users with at least one winning call.

Split rules (deterministic, replay-safe):

- **One share per user**, regardless of how many calls they won.
- **Eligibility computed after corrections** — a VAR-voided call is not a win.
- **Indivisible remainders** floor-divide, leftovers assigned by a seeded deterministic draw among winners.
- **No winners → pool returns to the house**, one quiet stream line. No rollover.

Calls settle against the house, so the loop works in an empty room and in replay.

## How Calls Settle

Settlement is gated by data confidence: a prompt is only shown if GameCrew can cleanly settle it.

- **Discrete-event calls** (goal, card, within-window variants) settle off clean confirmed TxLINE events. These are the backbone.
- **Momentum calls** are offered only when the semantic-frame layer is confident enough to judge them; low confidence → not offered.

Every settlement traces to a `settlementFrameId`, mirroring the grounding discipline of Game View and Match Pulse. A retracted incident (`incident_retracted`) voids or re-settles affected calls, returning stakes and reversing rewards exactly.

## The Loop

Identical live or in replay:

1. **Gift window** → this match's gift lands (popup first time, silent grant if skipped).
2. **Match moments** → occasional drops land; the room sees them.
3. **Prompt** → a call card appears inline: predicate, window, and the prize ("stake 🍌 24 → win 🏎️ 1").
4. **Take** → one tap (plus a team pick on who-scores-next); the stake leaves the stash; social proof line.
5. **Settle** → win: stake back + reward + coolness, loud. Loss: stake slides into the Gift Pool, quiet. Void: stake back, silent.
6. **Full time** → the Gift Pool (seed + everyone's lost stakes) splits among winning callers.
7. **Claim** → a gift can be retired to a **Trophy**: minted on-chain, out of the playable stash forever.
8. **Leaderboard** → ranked purely on coolness, which only ever grew.

## Calls And Chat Are One Stream

The call lifecycle *is* chat content — prompts as actionable inline cards, takes as social-proof lines, settlements as result lines, interleaved with user messages and the same system match moments Match Pulse shows. One surface, not two features bolted together.

## Stash: The Flex Surface

The stash shows coolness, every gift with its quantity, calls won, and trophies (on-chain claims). It is a trophy shelf plus an ammo box — nothing on it is priced or purchasable.

## Solana Layer

The approach is **mint smart, feel on-chain**:

- **Everyday gifts and all call state stay off-chain app state** — snappy, reliable, replay-safe, chain never in the hot path.
- **Claiming retires a gift into a Trophy**: it leaves the playable stash permanently and mints as a real NFT (Metaplex Core asset on-chain; metadata carries the moment — fixture, minute, item, quantity). Keep it as ammo, or immortalize it: a genuine decision. Claiming also resolves any "I lost the item but hold its NFT" contradiction — a claimed gift can no longer be staked or lost.
- **Transferability — decided (2026-07-18): trophies are plain transferable NFTs.** What owners do on outside marketplaces is their business. The defensible line is the acquisition side: every stakeable gift is free, so there is no paid entry into the stake loop. If in-app purchases of stakeable items are ever added, revisit this — paid-in + staked-on-matches + tradeable-out together would constitute a real-money betting loop.
- **Wallets arrive via social login at the claim moment** (Privy embedded wallets, social logins only). Until first claim, the economy is chain-free. GameCrew sponsors all fees — the user never needs SOL, never signs, never sees gas.
- The **Solana dApp Store submission** carries distribution and credibility.

No custom on-chain program is required for this scope: minting composes the audited Metaplex Core program via the server. A custom program (Rust/Anchor) enters only if on-chain logic is ever wanted (e.g. trustless pool escrow) — roadmap, not V1.

## Boundaries

- Betting language lives **only** in the playful-economy surface (Global Chat prompts and calls).
- Match Pulse remains a clean factual timeline with no betting copy (`packages/core/src/txline/validation.ts`, `enrichment.ts`, `apps/api/src/match-pulse-llm.ts`).
- Game View remains free of call mechanics; it only reserves an overlay slot a call prompt could later fill. Rendering calls inside Game View is a separate future decision.

## Data Source Principle

The semantic frame stream leads all call logic. Allowed: discrete facts and simulation cues from `SemanticFrame`, possession/pressure/phase for confidence, score/clock/phase from canonical state, incident lifecycle (a retracted goal must void or re-settle). Avoid: pitch coordinates, timing precision beyond frames, any real-money or odds-priced construct. If frames and local state disagree, frames win.

## Ownership

- `packages/core`: economy models, the pure call engine (frames + user actions → prompts, settlements, pool, leaderboard), confidence gating, deterministic gift selection, fixture-driven tests.
- `apps/api`: the mint/claim path (claims store, devnet minter, sweep worker); future server-side settlement lift.
- `apps/mobile`: Global Chat stream + composer, call cards, gift popup, stash, leaderboard, Privy claim UX.

One data spine (TxLINE events + semantic frames), three surfaces.

## Out Of Scope

- buying or selling gifts in-app (no purchase path into the stake loop — see Solana Layer for why this is load-bearing)
- user-created calls / peer-to-peer challenges
- pool or 1v1 call structures (against-the-house only)
- progression systems (XP, levels, upgrades)
- real-money mechanics of any kind (deposits, cash-out, money-odds pricing, payouts)
- private/hosted/creator rooms
- an in-app marketplace or trading surface (outside marketplaces are the owner's business, not a product surface)
- rendering call mechanics inside Game View or Match Pulse

## Acceptance Criteria

- Call prompts are generated only from event/phase triggers on the semantic frame stream; no timer-only prompts.
- Only cleanly-settleable prompts are shown; each settlement traces to a `settlementFrameId`.
- Every call shows its reward up front; reward rarity scales with stake rarity deterministically.
- A lost call removes the staked gift from the stash and adds it to the match's Gift Pool.
- A won call returns the stake, grants the reward gift, and increases coolness.
- Coolness never decreases under any event, including voids and retraction corrections.
- A voided call (VAR, or who-scores-next open at full time) returns the stake exactly, silently.
- The per-match gift window works: first visit in the window offers the gift; it is granted at most once per match per user; skipping still banks it.
- The Gift Pool = house seed + lost stakes; full-time split follows the one-share/corrected-eligibility/seeded-remainder rules; no winners → house, quietly.
- The full loop runs identically in live and replay, deterministically against a recorded fixture.
- Claiming retires the gift from the playable stash permanently and mints a transferable NFT; a claim never blocks the core loop; claimed gifts cannot be staked.
- The user never needs SOL, never signs, never sees gas; wallet appears only at first claim via Privy social login.
- Match Pulse and Game View remain free of betting language and call mechanics.
- Gifts are only ever acquired free; no purchase path exists anywhere in the product.

## Scenario Acceptance Criteria

- Given a corner cue, a "goal in the next 5 minutes?" card appears showing stake and reward; a confirmed goal in the window settles win: stake returned, reward granted, coolness up.
- Given the same call with no goal in the window, it settles loss: the staked gift leaves the stash and appears in the Gift Pool; coolness unchanged.
- Given a confirmed goal later retracted by VAR, a call settled on it re-settles: reward and coolness gain reversed, stake restored — coolness never net-decreases below its pre-call value.
- Given a who-scores-next call still open at full time, it voids and the stake returns silently.
- Given a user losing every gift mid-match, the next match's gift window re-arms them.
- Given full time with three winners and 2 lambos in the pool, each item floor-divides and the leftover lambo is assigned by seeded draw.
- Given a user claiming a gift, it disappears from the playable stash, mints on devnet, and shows an explorer link; it can no longer be staked.
- Given an empty room, the against-the-house model still lets one user run the entire loop.

## Product Decisions

- Stakes are real: losing a call loses the gift. Real risk is what makes winning feel like something.
- Coolness is monotonic. Your public score can never fall, so taking a call never threatens status — only ammo. Kills rank-camping outright.
- Lost stakes feed the match's Gift Pool, so losses are productive for the room and the pot grows during the match.
- Gifts are per-match via the gift window — the built-in comeback floor. Nobody is ever locked out.
- The reward is part of the offer ("stake bananas → win a lambo"), making every call legible at a glance.
- Claiming retires the gift into a transferable on-chain Trophy — a real decision (ammo vs. immortality), and the reason lost items and owned NFTs can never contradict.
- Gifts are free-only. This single constraint is what keeps transferable NFTs and staking legally and ethically clean; it is revisited only if purchases are ever proposed.
- Calls settle against the house; the engine is pure and deterministic in `packages/core` on the same frame spine as Game View and Match Pulse.
- System-generated calls lead; settlement is confidence-gated; the chain stays off the hot path.

## Implementation Status

The V1 build in the working tree (engine, API mint path, mobile state + UI — all tested) implements the **previous** model. Deltas to reach this PRD, for the next build round:

1. Engine settle rules: stake = item (removed on loss → pool), coolness win-only, reward-item ladder shown at offer time, void returns stake item.
2. Gift popup: per-match gift window (currently once-ever per device).
3. Pool: add lost stakes to the pot (currently seed-only).
4. Claim: retire the claimed gift from the playable stash (currently stash is untouched by claims).
5. Copy: cards show the reward; loss lines reference the lost gift, not a coolness dip.

Already matching this PRD: the four call types, pool split rules, leaderboard, chat stream + composer, persistence, Privy claim flow, transferable devnet mints, sponsored fees.
