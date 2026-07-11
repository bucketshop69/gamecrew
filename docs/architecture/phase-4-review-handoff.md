# Phase 4 Review Handoff

## Product direction

GameCrew is building one shared, source-grounded match-intelligence backend for two consumers:

1. Match Pulse commentary facts.
2. A probable stick-player match simulation.

The consumers must not interpret raw TxLINE independently. Exact coordinates, ball tracking and unsupported causal links are outside the truth model.

## Review boundary

Phase 3 is commit `7a03a77`. Review the Phase 4 commit immediately after it:

```bash
git diff 7a03a77..HEAD
```

Phase 4 expands the shared engine from the Seq 209–234 vertical slice to regulation-match lifecycle coverage for fixture `18179759`.

## What Phase 4 adds

- A sanitized 164-record lifecycle corpus selected from all 886 source records.
- Official StatusId 1–5 regulation phases plus ready/live distinctions from confirmed kickoffs.
- Phase-scoped live clock, occurrence clocks and preservation of the last playing time across final clock reset.
- Confirmed, provisional and final score separation.
- Lineup player resolution through normative IDs.
- Deterministic active-player recomputation for ten substitutions and one red card.
- Player discipline from late-enriched yellow/red card incidents.
- Explicit VAR + var_end family reconciliation without linking VAR to a later card.
- Explicit action_discarded handling for the observed provisional throw-in retraction.
- Global possible-event state where TxLINE supplies no participant.
- Deterministic same-sequence conflict selection and out-of-order replay.

## Expected final replay

```text
phase: finalised
confirmed/final score: Mexico 2–0 Ecuador
last playing clock: 98:43 (5923 seconds)
goals: 2, each enriched once with its scorer
substitutions: 10
yellow cards: 3
red cards: 1
active players: Mexico 11, Ecuador 10
open possible-event flags: 0
integrity warnings: 0
```

## Important files

- `packages/core/src/match-engine/replay.ts`
- `packages/core/src/match-engine/types.ts`
- `packages/core/tests/match-engine-lifecycle.test.mjs`
- `packages/core/tests/fixtures/txline-18179759-lifecycle.json`
- `packages/core/scripts/replay-match-engine-lifecycle.mjs`

## Verification

```bash
pnpm --filter @gamecrew/core test
pnpm typecheck
pnpm --filter @gamecrew/core demo:match-engine
pnpm --filter @gamecrew/core demo:match-lifecycle
```

Expected: 45 tests pass, workspace typecheck passes, both demos report zero integrity warnings.

## Review focus

- Stable identity and sparse revision merging.
- No duplicate goals, score commits, cards or substitutions.
- No shot-to-goal or VAR-to-card inference without an explicit source relationship.
- Direct facts versus derived probable simulation zones.
- Clock non-regression for late detail, but explicit clock_adjustment support.
- Determinism under duplicate, conflicting and out-of-order delivery.
- Correct active-player and discipline reconciliation.
- Preservation of every Phase 3 acceptance behavior.

Please report findings by severity with file and line references. Do not implement fixes unless requested.

## Known unsupported cases

Fixture `18179759` contains no evidence for `action_amend`, penalties, extra time, shootouts, second-yellow dismissal, confirmed-incident discard or player-attributed shots. Phase 4 preserves these as explicit validation gaps and does not guess their behavior.
