# Match Pulse match memory and dynamic enthusiasm

**Status:** Implemented on 2026-07-14 (uncommitted, on `main`). Verified by unit tests (116 api / 83 core, workspace typecheck clean) and an isolated smoke replay of both stored fixtures. Real-LLM sample regeneration pending: requires the local model server (`MATCH_PULSE_LLM_BASE_URL`) to be running. Stored fixture commentary has NOT been regenerated, per guardrail.

## Problem

The commentary LLM is amnesiac by design. The prompt receives only the current beat, team names, a clock label, and the last four spoken lines. It has no match memory, so it cannot say things the data already proves:

- "That's Ecuador's fourth yellow" / "he was already booked - second yellow, red card" / "down to ten men"
- "Equaliser!" / "Mexico complete the comeback" / "late winner in stoppage time"
- "That's his second - he's on a brace"
- "Fourth corner in eight minutes"

Separately, the scan found a live bug: **three of four stored goals failed LLM enrichment and fell back to the flat template** (`Goal for Mexico, scored by Quinones Quinones, Julian Andres. It is 1-0.`). The validator requires the goal line to reproduce the scorer name and exact score; raw source names like `Quinones Quinones, Julian Andres` make that echo fragile. Our biggest moments currently read the flattest.

Finally, there is no enthusiasm dial. Beat importance only changes the word budget, and the system prompt says "do not manufacture drama." A stoppage-time equaliser and a routine throw-in get the same register.

## Principle

**The LLM never counts or infers match facts. We compute memory deterministically; the LLM narrates it.**

Every memory item is passed to the prompt as a grounded fact with the same trust level as source events, so the closed-world validator accepts it instead of rejecting it as invention. The honesty architecture does not weaken; the model's world gets bigger.

## Confirmed decisions

- Memory is computed from `CanonicalMatchState` plus prior beat/entry history in `commentaryEntryFromBeat` (`apps/api/src/ingestion/commentary-projection-consumer.ts`), which already has both in scope.
- Memory is injected as a `narrative` block on `currentBeat` in `buildCommentaryEnrichmentPrompt` (`apps/api/src/match-pulse-llm.ts`).
- Memory is **relevance-gated**, not a data dump: beat kind selects which memory slices ride along (card beat gets the discipline ledger; goal gets score story and player memory; corner gets set-piece counts). No slice attaches to every beat.
- The enthusiasm dial is deterministic: a computed moment class (for example `comeback_goal`, `late_equaliser`, `second_yellow_red`) selects the tone instruction in the system prompt. The LLM follows the register; it never chooses it.
- Validator changes go in both directions: normalize player-name matching so grounded goals stop failing, and whitelist grounded memory claims; truth validation for teams, score, clock, actions, and lifecycle stays as strict as today or stricter.
- Score context becomes available on all beats (not only `score_commit` beats) so lead/trail/level language stops being structurally banned from non-goal commentary.
- Fallback templates for goals get score-story variants ("doubles the lead", "back level") so even validation failures read like football.
- New memory fields live in `packages/core` on the commentary entry model so Game View can reuse them later (captions and takeover framing read the same `scoreEvent` classification). No Game View work happens in this issue.

## Work list

| Order | Work item | Status |
|---|---|---|
| 1 | Fix goal enrichment failures: normalize name matching in validation, humanize scorer names, add score-story fallback templates | Implemented |
| 2 | Match memory: compute score story, discipline ledger, player memory, momentum counts, and time context; attach relevance-gated `narrative` block to the prompt as grounded facts | Implemented |
| 3 | Dynamic enthusiasm: classify moment class from memory, select tone instruction per class, extend validation to permit grounded memory claims | Implemented |

Also landed alongside item 1: enrichment failure reasons are now persisted (`match_pulse_commentary_enrichment_jobs.last_error`) instead of vanishing into `console.warn`, fixing an ordering bug where terminal-failure job rows were deleted before the reason could be recorded.

## 1. Goal enrichment fix

- Diagnose the three failed goal enrichments in the stored fixtures and confirm the rejection reasons from logs/validation.
- Normalize name comparison (token order, duplicates, diacritics) so a correct scorer reference in natural order passes.
- Provide the model a display-friendly scorer name while keeping the source name for validation.
- Rework goal fallback copy to use score story where available.
- Re-run enrichment on an isolated sample before touching stored fixtures.

## 2. Match memory

Memory slices, all derived from existing state:

- **Score story**: score before the moment, classified `scoreEvent` (`opener`, `equaliser`, `extends_lead`, `comeback`, `lead_change`, `late_winner`), lead-change count.
- **Discipline ledger**: per-team card totals, per-player prior bookings, second-yellow flag, players-remaining flag.
- **Player memory**: scorer's goal count this match (brace, hat-trick), scored-after-substitution.
- **Momentum memory**: current pressure-spell length, set-piece counts in the recent window.
- **Time context**: stoppage time, closing stages, just before half-time, just after restart.

Rules:

- Each slice attaches only to beat kinds where it is relevant.
- Each memory fact carries its derivation inputs so it is auditable like any grounded fact.
- Prompt size stays bounded; memory is compact structured fields, not prose.

## 3. Dynamic enthusiasm

- Compute a moment class deterministically from beat kind plus memory (for example: `goal` + `comeback` + `late` yields the highest register).
- Map moment classes to a small set of tone instructions in the system prompt; default register remains the current calm one.
- Extend validation so grounded memory claims are speakable and register-appropriate exclamation is not rejected, while keeping the ban on invented atmosphere the source cannot support.
- Reflection step checks the register matches the moment class.

## Out of scope

- Game View director, scenes, or renderer work.
- New data sources or TxLINE fields.
- Voice/TTS.
- The broader editorial voice program in `deferred-match-pulse-llm-quality.md` (that issue remains open; this issue only adds context and fixes the goal bug).
- Regenerating stored fixtures before the new version is approved on an isolated sample (guardrail inherited from the deferred issue).

## Acceptance criteria

- [ ] All goals in the evaluation sample pass LLM enrichment or fail for reasons unrelated to name echo.
- [ ] Goal fallback copy uses score story when available and never reads as a raw data template.
- [ ] A second yellow to the same player produces commentary that names the escalation.
- [ ] A team's cumulative card count is speakable on card beats.
- [ ] An equaliser and a comeback goal are described as such, with score-before context.
- [ ] Lead/trail/level language is available on non-goal beats without validation rejection.
- [ ] A stoppage-time goal reads at a visibly higher register than a routine first-half goal.
- [ ] No memory fact reaches the prompt without a deterministic derivation from canonical state.
- [ ] Truth validation for teams, players, score, clock, actions, and lifecycle is unchanged or stricter.
- [ ] Memory fields live on the core entry model, reusable by Game View later.

## Verification

- Unit tests for each memory computation against constructed state histories.
- Replay the Mexico-Ecuador and France-Morocco fixtures through the new pipeline on an isolated sample database; review goal, card, and pressure lines side by side with current output.
- Confirm validator accepts grounded memory claims and still rejects invented ones (negative tests).
- Run API tests and workspace typecheck.
