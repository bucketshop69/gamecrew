# PRD: Match Pulse Timeline

## Status

Draft

## Objective

Turn Match Pulse from a raw TxLINE event list into a live match companion timeline that reads like commentary and helps the user understand the tactical shape of the match.

The timeline should make a fan feel oriented within seconds:

> What just happened, who is pushing, and why does it matter?

This PRD covers the timeline experience inside Match Detail. It also defines the product and data boundary that later supports the abstract match board and voice narration.

## Product Direction

Match Pulse should feel like a blend of:

- live commentary
- tactical assistant

It should not feel like:

- a generic scoreboard event log
- a raw API debug view
- a betting tracker
- a news feed
- a full tactical analysis product that claims certainty beyond the data

The current implementation proves that TxLINE score history and updates can reach the UI. The next version should turn those signals into a commentary stream that feels live, source-grounded, and useful even when the match is between major events.

## User Job

When a user opens Match Pulse during a live match, they are trying to answer:

> What is happening in this match right now?

Secondary jobs:

- catch up after looking away
- understand which team has momentum
- understand whether pressure is building or fading
- see confirmed major events clearly
- follow the match without needing video
- later, hear or replay the same match pulse in another mode

## Entry Point

The user lands on Match Detail after tapping a match poster from Home.

The default active tab is `Match Pulse`.

The match header and tabs remain fixed. Only the pulse list scrolls.

## Core Product Object

The timeline should render `MatchPulseCommentaryEntry` objects as the primary feed, not raw TxLINE events.

TxLINE events remain the source data. A `MatchPulseCommentaryEntry` is the consumer-facing commentary output produced from a small batch of normalized TxLINE facts, usually aligned with one polling window or a short source-event range.

Expected fields:

- `id`
- `fixtureId`
- `batchId`
- `fromSeq`
- `toSeq`
- `period`
- `clock`
- `sortTimestamp`
- `kind`
- `team`
- `opponent`
- `scoreAtMoment`
- `sourceEvents`
- `commentary`
- `voiceLine`
- `intensity`
- `momentumSide`
- `confidence`
- `generation`
- `fallbackCommentary`
- `enrichmentStatus`
- `boardHint`

`MatchPulseMoment` remains useful as a secondary object for major events, grouped pressure sequences, replay chapters, future match-board hints, and visual emphasis. It should not force V1 into a sparse highlights-only feed.

### Kind

Initial commentary entry kinds:

- `commentary`
- `goal`
- `shot`
- `corner`
- `free_kick`
- `throw_in`
- `danger`
- `card`
- `substitution`
- `injury`
- `var`
- `phase_change`
- `momentum`
- `system`

### Intensity

Use intensity to control visual weight and later voice urgency.

Suggested values:

- `quiet`
- `building`
- `danger`
- `major`

### Confidence

The product must distinguish source-backed facts from interpretation.

Suggested values:

- `verified`: direct confirmed TxLINE signal
- `inferred`: source-backed interpretation from one or more TxLINE signals
- `low`: weak or partial source context; use cautious copy

### Generation

Suggested values:

- `raw`: direct source commentary with minimal formatting
- `rule_based`: deterministic fallback or safety-generated commentary
- `llm`: LLM-enriched commentary from bounded source context

## V1 Ownership

V1 should make the API responsible for returning timeline-ready `MatchPulseCommentaryEntry[]`.

The mobile app should not decide source batching, LLM prompts, compression windows, or source confidence. It should render the product commentary stream returned by the API and handle view states.

Expected V1 ownership:

- `packages/core`: source models, commentary entry models, coverage/batching rules, fallback builders, validation helpers
- `apps/api`: TxLINE fetch, snapshot assembly, LLM enrichment, validation, persistence/cache, response shaping
- `apps/mobile`: timeline rendering, live-update behavior, loading/error/stale states

The current raw event response can remain as an internal fallback during migration, but the product contract for this PRD is an enriched commentary stream.

For V1, GameCrew should stay closely in sync with the API response shape and learn from real fixtures. The PRD defines the intended boundary, but event density, prompt behavior, and persistence details can be tuned once the real TxLINE snapshot payloads and LLM outputs are observed together.

## Data Source Principle

The TxLINE API snapshot leads assumptions.

GameCrew can enrich the experience, but it must not outrank the source data. If the snapshot and generated interpretation disagree, the snapshot wins.

Allowed source context:

- fixture identity
- home and away teams
- match phase
- match clock
- score snapshot
- score updates as the primary event feed
- score history as fallback/debug/replay verification when updates is empty or incomplete
- event confirmation state
- participant/team ownership where available
- replay/history data
- odds movement only as contextual signal, not betting UX

Avoid depending on:

- video-derived ball location
- invented player names
- invented formations
- invented tactical certainty
- unlicensed editorial data
- betting mechanics or betting language

## LLM Enrichment

V1 should include LLM enrichment.

This is not optional polish for V1. Rule-based rendering has already proved the data path; the next product step is LLM-enriched commentary with deterministic guardrails.

The LLM is responsible for turning each new normalized source batch into clear timeline copy:

- one compact commentary entry, usually one to three lines
- live commentary tone
- tactical assistant framing
- speakable copy for future voice
- richer summaries when multiple events in the batch form pressure or momentum

The LLM must not be responsible for deciding what source facts are safe to use without guardrails.

Deterministic rules should handle:

- source event normalization
- source event batching
- coverage policy
- must-show events
- confidence downgrade
- fallback copy
- deduping
- repeated-source handling
- source conflict handling
- stale or missing data handling

LLM enrichment should run smartly, not blindly on every request. The system should enrich only new source batches, reuse cached commentary when the relevant source range has not changed, and avoid blocking the live UI when enrichment is slow.

## Source Coverage And Batching

Raw TxLINE events should not automatically appear as raw rows in the timeline.

The timeline should show commentary entries generated from normalized source facts. A commentary entry may be created from one event, multiple events, or a snapshot-level state change.

Coverage has two layers:

1. Deterministic rules normalize, dedupe, order, and batch source facts.
2. The LLM writes a commentary entry within that source boundary.

### Must Cover

Always show these when available:

- goals
- red cards
- yellow cards
- VAR-style checks or decisions
- penalties if available
- half-time
- full-time
- game finalised
- confirmed score changes

### Usually Cover

Usually include these in commentary batches when they are recent, repeated, or tactically meaningful:

- shots
- corners
- free kicks in attacking context
- danger possession
- high danger possession
- injury stoppages
- substitutions

### Usually Compress

Compress low-value events into the surrounding commentary instead of showing them as mechanical raw rows:

- isolated throw-ins
- low-context possession changes
- duplicate unconfirmed updates
- repeated quiet events within a short window

Example:

Three Portugal corners and danger possession over four minutes can become one stronger commentary entry:

> Portugal are pinning Argentina back with repeated set pieces.

The underlying events remain attached through `sourceEvents`.

### Initial Coverage Rules

Use these rules as the first build target. Tune after testing with real TxLINE fixtures.

- Process each poll as a source batch keyed by fixture, source, sequence range, snapshot timestamp, and source event ids.
- Do not require every raw event to become its own row; do require meaningful source changes to have commentary coverage over time.
- Never collapse a goal, red card, VAR decision, penalty, half-time, full-time, or confirmed score change into a hidden-only source event.
- If a must-show event is part of a commentary batch, the commentary entry must clearly surface it and may also create a secondary major `MatchPulseMoment` for emphasis.
- Deduplicate events by action, clock seconds, participant, score state, and confirmation status.
- Prefer confirmed events over unconfirmed duplicates.
- Prefer score updates over historical events when both sources contain the same logical event.
- Group repeated corners, danger possession, high danger possession, and shots for the same team into a richer commentary batch when they form pressure.
- Compress repeated quiet events into one calm commentary line or skip the batch only when there is genuinely no user-facing change.
- Avoid flooding: if several quiet batches arrive back-to-back, merge or replace them rather than emitting robotic filler.
- Use score, clock, phase, and participant from the latest TxLINE snapshot even if older source events contain partial values.
- If source ordering is ambiguous, sort by sequence first, timestamp second, and clock seconds third.

## Timeline Structure

The timeline is newest first.

For live matches, the top may include a compact `Now` commentary entry when there is enough fresh context.

Each row should include:

- minute or phase
- team/color signal where available
- commentary text
- intensity state
- confirmation or confidence affordance when needed

The design should stay aligned with the existing Penpot direction:

- black shell
- fixed score/header/tabs
- team colors as match signals
- no bordered sports-card stack
- quiet timeline rail
- stronger visual treatment only for high-intensity moments

The current reference board is `Match Detail - Pulse v0`. Implementation should align with its fixed match header, tabs, timeline rail, pulse dots, minute labels, compact row rhythm, and black shell. If the design changes, it should be revised as a successor to this board rather than drifting independently in code.

## Live Update Behavior

The app currently polls. This PRD does not require SSE.

When new commentary entries arrive:

- If the user is near the top of the list, insert new entries at the top.
- If the user has scrolled down, preserve scroll position and show a compact `New moments` control.
- Tapping `New moments` returns to the top and clears the indicator.
- Pull-to-refresh should request the latest pulse stream without clearing existing rows first.
- Retry belongs in the error or stale state, not inside every timeline row.
- `Now` is the first row, not a sticky overlay, for V1.
- Stale status should appear near the top of the list or header area without shifting the fixed match header.

## Copy Rules

The tone should be immediate, useful, and source-grounded.

Good:

- `Portugal are forcing corners and keeping Argentina pinned near their box.`
- `Argentina's pressure has cooled after the yellow card stoppage.`
- `The equaliser changes the room: Portugal are back level at 1-1.`

Avoid:

- `Portugal are tactically superior.`
- `Argentina will concede soon.`
- `Ronaldo is drifting inside.`
- `Betting momentum is shifting.`

Use cautious language when confidence is low:

- `pressure may be building`
- `the snapshot suggests`
- `the last few events point toward`

## Visual States

### Live

Show live enriched commentary entries, newest first.

The first visible item may be a `Now` entry summarizing the current match pulse if the source data is fresh.

### Replay

Replay uses the same commentary entry model.

Later, replay can group moments by:

- first half
- half-time
- second half
- extra time
- full-time

### Loading

Show a quiet black-shell loading state.

Copy:

> Building Match Pulse.

### Empty

If no source events or useful source changes exist:

> Match Pulse will appear when TxLINE has enough match signal.

### Error

If data fails:

> Match Pulse is unavailable.

Allow retry. Do not expose raw API errors in user-facing copy.

### Stale Data

If polling has not returned fresh data within the expected window, keep the latest commentary entries visible and mark the feed as stale.

Copy:

> Waiting for the next match update.

### Low Confidence

Low-confidence generated entries should be visually quieter and use cautious language.

Do not present low-confidence interpretation as fact.

Low-confidence UX:

- show softer body copy first, not an alarming warning label
- match a commentator's confidence style: confident on facts, careful on reads, never mechanical
- use language that sounds like two or three commentators discussing the match from the available signal
- include a small `Source limited` affordance only when the interpretation may affect trust
- avoid showing low-confidence entries as `Now`
- never use major-event styling for low-confidence generated interpretation

## API And Data Requirements

The API should return a timeline-ready response rather than requiring the mobile app to understand raw TxLINE event rules.

Expected endpoint direction:

```text
GET /matches/:fixtureId/pulse
```

The response should eventually contain:

- match summary
- freshness metadata
- source snapshot references
- ordered `MatchPulseCommentaryEntry[]`
- optional highlighted `MatchPulseMoment[]` for major events, pressure chapters, and future board hooks
- raw fallback where useful for debugging or safety

The mobile app should remain a renderer of product commentary.

For V1, `/matches/:fixtureId/pulse` should return enriched commentary entries. If enrichment is unavailable, the endpoint should still return validated fallback commentary rather than shifting enrichment logic to mobile.

Live and replay should use one combined response model. Replay should read stored commentary for a fixture rather than regenerating a different interpretation every time a user returns.

Persistence direction:

- store enriched commentary entries per fixture
- key generated output to source batch id, source snapshot/version, and source event ids
- reuse stored commentary when the same replay or unchanged live source batch is requested
- generate only when a new source batch has not already been processed
- keep enough metadata to audit which source events produced each commentary entry

## LLM Guardrails

The enrichment layer must:

- use only the provided source context
- preserve source event ids
- preserve current score and clock from snapshot
- return structured JSON
- include confidence
- include generation metadata
- include fallback commentary
- avoid player names unless the source context includes them
- avoid certainty about tactics when the source only implies pressure
- avoid betting language

If the LLM result fails validation, use deterministic fallback commentary.

### Validation Contract

The LLM must return structured JSON that matches the server-owned schema.

Required validation:

- `fixtureId` must match the requested fixture.
- `sourceEvents` must reference provided source events.
- `clock`, `phase`, and `scoreAtMoment` must not contradict the source snapshot.
- `team` and `opponent` must be known fixture participants.
- `kind`, `intensity`, `confidence`, and `generation` must be allowed enum values.
- `commentary` and `voiceLine` must not include player names unless source context includes them.
- copy must not include betting language.
- generated entries must include fallback copy.
- low-confidence entries must use cautious language.

Rejected LLM outputs:

- invented players, formations, locations, or video-like ball position
- score, clock, phase, or team mismatch
- source event ids not provided to the model
- unsupported entry kind
- betting language
- empty commentary
- duplicate major event headline already represented by a must-show entry or highlighted moment

On validation failure:

1. patch only fields that are safe to patch from the snapshot, such as score, clock, and phase
2. reject unsafe or invented content
3. render deterministic fallback commentary for affected source events
4. log validation failures for prompt and rule tuning

## Commentary Model

Match Pulse should feel like a small commentary desk, not a single robotic narrator.

The timeline can contain different commentary angles as long as each one remains source-grounded:

- factual call: what happened
- tactical read: why it matters
- momentum read: what the last few events suggest
- room-aware line: how the moment changes the emotional temperature of the match

This does not mean inventing named commentators or fake personalities. It means the copy should have the cadence of real live football commentary: immediate, concise, opinionated only where the source supports it, and cautious when the signal is weak.

## Future Match Board Hook

The abstract board is not part of this PRD.

However, commentary entries and highlighted `MatchPulseMoment` objects should reserve a `boardHint` object so the same source-backed output can later drive a simple top-down match board.

Possible future fields:

- `side`: home, away, neutral
- `zone`: defensive_third, middle_third, attacking_third, box, unknown
- `pressure`: none, building, danger, high_danger
- `ballState`: open_play, set_piece, stopped, unknown
- `direction`: home_to_away, away_to_home, unknown

The board should be abstract and source-honest. It should not imply real ball/player tracking unless TxLINE provides that level of detail.

## Future Voice Hook

Voice is not part of this PRD.

However, timeline copy should be speakable by default. `voiceLine` can be included when the LLM produces a cleaner narration line than the visible body.

Voice should follow the same source and confidence rules as timeline.

## Out Of Scope

This PRD does not include:

- building the simulated pitch board
- voice playback
- Chat implementation
- SSE migration
- push notifications
- betting UX
- real-time player tracking
- licensed video or editorial feeds
- tactical claims beyond source-backed inference
- custom room or hosted-room behavior

## Acceptance Criteria

- Match Pulse renders enriched `MatchPulseCommentaryEntry` rows, not raw event labels only.
- V1 includes LLM-enriched copy behind deterministic source guardrails.
- TxLINE snapshot remains the source of truth for score, clock, phase, and confirmation.
- Must-show events always receive clear commentary coverage when available.
- Low-value events can be compressed into surrounding commentary instead of becoming mechanical rows.
- Every generated entry includes source references, confidence, generation type, and fallback copy.
- The timeline remains newest first.
- The match header and tabs remain fixed while only the pulse list scrolls.
- The UI follows the black shell plus team-color visual direction.
- Loading, empty, error, stale, replay, and low-confidence states are defined.
- The model leaves explicit hooks for future board and voice experiences.

## Scenario Acceptance Criteria

- Given a confirmed goal, the timeline always gives the goal clear commentary coverage and may also create a highlighted goal moment.
- Given three corners and a danger possession for the same team within four match minutes, the timeline can render one richer commentary entry with all source events attached.
- Given an isolated throw-in with no nearby pressure context, the timeline can compress it into surrounding commentary or skip it only when it adds no user-facing change.
- Given duplicate unconfirmed and confirmed versions of the same source event, the confirmed version wins.
- Given an LLM result with a score, clock, team, or source-event mismatch, the API rejects or patches the unsafe fields and returns fallback commentary.
- Given stale polling, the app preserves existing rows and shows a stale state instead of clearing the timeline.
- Given the user has scrolled away from the newest moments, new arrivals do not jump the list; the app shows a `New moments` control.
- Given low-confidence interpretation, the UI uses cautious copy and does not apply major-event styling.
- Given replay mode, the same commentary entry model can render historical entries newest-first in V1 and support phase grouping later.
- Given the current Penpot `Match Detail - Pulse v0` board or its revised successor, the implementation preserves fixed header/tabs, timeline rail, pulse dots, minute labels, and black shell plus team-color direction.

## Product Decisions

- V1 follows the API response closely and tunes event density after observing real TxLINE snapshot plus LLM output behavior.
- Match Pulse should feel like live football commentary plus tactical assistant.
- Source contract: `scores/updates/:fixtureId` is the primary timeline feed, `scores/snapshot/:fixtureId` is truth for current state, and `scores/historical/:fixtureId` is fallback/debug/replay verification rather than the default path.
- V1 uses LLM enrichment as the main product layer. Rules remain normalization, batching, validation, fallback, and safety infrastructure.
- Confidence should be expressed like a commentator: factual certainty for source-backed events, careful language for tactical reads, and visible source caution only when trust could be affected.
- `Now` is not mandatory on every response. It appears when the current API snapshot and LLM prompt can produce a useful live read; otherwise the newest commentary entry leads the feed.
- LLM enrichment should run smartly with caching keyed to source snapshot/version and source event ids.
- LLM enrichment should receive the current source batch plus a small window of previous enriched commentary so the voice feels continuous without inventing unsupported match facts.
- Live and replay use a combined pulse response model.
- Enriched commentary entries should be persisted per fixture so replay can reuse the same generated match story instead of creating a different version later.
