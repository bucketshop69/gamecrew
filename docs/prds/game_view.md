# PRD: Game View

## Status

Draft

## Objective

Turn Game View from a hand-scripted demo animation into a live, source-grounded match board that visualizes the real match from TxLINE semantic frames.

Game View should make a fan feel like they are watching a stylized broadcast of the match:

> Where is the play, who is pushing, and what just happened?

This PRD covers the Game View experience inside Match Detail: the scene model, the director that builds scenes from semantic frames, the renderer, and the playback behavior for live and replay. It defines the visual honesty boundary that keeps Game View consistent with the rest of the product.

## Product Direction

Game View should feel like a blend of:

- a stylized top-down broadcast board
- a living match atmosphere

It should not feel like:

- a video game replay claiming real player positions
- a raw data dashboard
- a static diagram that only changes on goals
- a betting tracker

The current implementation is a scripted 40-second demo built for a video submission. It proved the visual direction and playback machinery. The next version must be driven entirely by backend semantic frames so that what the user sees is the real match, illustrated.

## The Honesty Rule

TxLINE provides sparse semantic events, not player tracking. The engine's own model states that `probableZone` is a semantic band for animation, never an asserted pitch coordinate.

Therefore:

- Game View renders a full 22-player top-down tactical view (Football Manager-2D style): two 11-figure formation blocks of thin stickmen whose shapes slide and compress with the true facts (possession, zone, pressure), with the players nearest the ball staging the engaged action. *(Amended 2026-07-15, second revision: product rejected both the abstract-presence board and the small-cluster version after seeing them; the 22-figure look was approved from a mockup. See `docs/issues/game-view-realism-experiment.md`.)*
- Every figure position is honest theater, never data: formations are cosmetic defaults (never claimed lineups), invented movement may never contradict a known fact, and no real player name or number ever appears on an invented figure. Player identity appears only in takeover typography where the source provides it.
- The ball never crosses a zone boundary without a real cue (zone change, possession change, set piece, shot, goal, restart). A turnover may be staged as a defender's interception because the possession change itself is a fact.
- Staged vignettes (corner, penalty, celebration) remain allowed as recognizable scenes.
- Every visible state change must trace back to a semantic frame fact or simulation cue.

The rule in one line:

**Game View illustrates what TxLINE says. Staging may dramatize inside the truth; it never contradicts or outruns it.**

## User Job

When a user opens Game View during a live match, they are trying to answer:

> Where is the play right now, and how dangerous is it?

Secondary jobs:

- feel the match momentum without reading text
- see major moments (goals, cards, VAR) as satisfying visual events
- keep the match "on" ambiently while doing something else
- replay a finished match as if it were live

## Entry Point

The user lands on Match Detail after tapping a match poster from Home.

Game View is a mode/tab inside Match Detail alongside Match Pulse. The match header stays fixed; Game View owns the content area below it.

## Core Product Objects

### GameViewScene

The renderer never interprets semantic frames directly. It plays `GameViewScene` objects produced by the director.

Expected fields:

- `id`
- `fixtureId`
- `kind`
- `startRevision` / `sourceFrameIds`
- `team` / `participant` (when team-owned)
- `zone` (semantic band, when relevant)
- `pressure` (when relevant)
- `player` (only when source provides it)
- `scoreAtMoment`
- `clock` / `phase`
- `durationHint` (playback pacing, not a source claim)
- `commentaryEntryId` (optional link to the synced Match Pulse caption)
- `lifecycle` (provisional / confirmed / retracted where applicable)

### Scene kinds

Initial scene taxonomy:

- `ambient` — continuous play: possession presence in a zone with pressure intensity
- `set_piece` — corner, free kick, throw-in, penalty vignette
- `shot` — shot attempt and outcome treatment
- `goal_sequence` — the multi-beat goal choreography (see below)
- `goal_retracted` — VAR/overturn takeback treatment
- `card` — yellow/red card takeover with player when available
- `substitution` — player in/out banner
- `var_review` — review-in-progress tension state
- `phase_break` — kickoff, half-time, full-time, extra-time transitions
- `restart` — play resuming after goal or phase break

The taxonomy may grow, but every kind must map to source cue kinds that already exist in the engine (`set_piece`, `possession_change`, `possession_pressure`, `shot_attempt`, `shot_outcome`, `goal_pending`, `goal_confirmed`, `score_commit`, `restart`, `card`, `substitution`, `var`, `incident_retracted`, `phase_change`).

### Ambient scene semantics

The ambient scene is the default state and covers most of the match:

- the pitch is divided into semantic zones aligned with engine pressure bands (defensive / midfield / attack / danger / high danger)
- both teams are always on the board as 11-figure formation blocks; the possessing team's block pushes toward the ball's true zone and the defending block compresses goal-side of it *(amended 2026-07-15, realism experiment, second revision)*
- the 2–3 possession figures nearest the ball knock it between them, with 1–2 opponents pressing; the other figures hold formation with short line-shifts
- the baseline is calm — occasional passes; rising pressure quickens the tempo and pushes both blocks toward the dangerous end
- possession changes are staged as an interception: an opposing figure takes the ball and both formations turn over

## Two Layers Of Graphics

Game View has exactly two presentation layers, and every scene belongs to one:

1. **Ambient progression** — the board state between events. Driven by possession, zone, and pressure cues. Always active unless a takeover owns the screen.
2. **Moment takeovers** — staged graphics for specific events: goal sequence, cards, VAR, substitutions, phase breaks, set-piece vignettes. A takeover interrupts ambient, plays its beats, and returns to ambient at the new match state.

### Goal sequence choreography

The goal sequence is the flagship takeover and is fully cue-driven:

1. `goal_pending` → tension beat: the players begin celebrating immediately (as real players do before the referee confirms) while the board shows the checking treatment ("GOAL?"). The scoreline does not change.
2. `goal_confirmed` / `score_commit` → celebration beat: team color takeover, scorer when source provides it, new scoreline. The figures run to a randomly chosen corner (left or right) and the team joins them.
3. `restart` (after_goal) → reset beat: both teams jog back and line up in their own halves for kickoff; ambient play resumes at the new score.
4. `incident_retracted` → the takeback: the celebration cuts off, a distinct overturn treatment visibly removes the goal and restores the prior score, and play resumes with a neutral restart (the source does not always say which restart the referee gave, so none is invented). This is a product moment, not an error state — it proves the grounding.

Provisional versus confirmed lifecycle must be visually distinct: pending shows on-pitch celebration plus the checking treatment only; the scoreline change and the full typographic takeover are reserved for confirmation. *(Amended 2026-07-15: on-pitch celebration during pending is deliberate — it mirrors real players and makes the takeback beat land harder.)*

## Director And Renderer Split

### Director

The director is pure logic with no rendering. It lives in `packages/core`.

Responsibilities:

- consume ordered `SemanticFrame` objects (facts + simulation cues)
- emit an ordered, timed `GameViewScene` list
- pacing: compress long quiet stretches in replay; keep real-time feel in live
- sequencing: assemble multi-cue choreography (goal sequence, VAR flows) from individual cues
- priority: a takeover may not be dropped; overlapping cues resolve by severity (goal > card > set piece > ambient)
- lifecycle: carry provisional/confirmed/retracted through to scenes
- determinism: the same frame input always yields the same scene timeline

The director must be fully testable against recorded fixtures without any UI.

### Renderer

The renderer lives in `apps/mobile`. It plays whatever scene the director produced.

Responsibilities:

- render each scene kind (ambient board, takeover graphics, vignettes)
- transitions between scenes
- reduced-motion and accessibility behavior consistent with the rest of the app
- view states (loading, error, stale)

The renderer makes zero match-interpretation decisions. If the renderer needs a fact, the scene must carry it.

### Playback

- **Replay**: fetch the full frame history, run the director, play the scene timeline at a compressed, watchable pace with standard playback affordances (at minimum play/restart).
- **Live**: poll the frames endpoint, feed new frames to the director incrementally, and run playback a short buffer behind the newest data so bursts of cues play smoothly instead of jumping.

Live and replay use the same director and the same renderer. Replay is also the demo and judging path.

## Commentary Caption

Game View shows a synced commentary line as a lower-third caption.

- The caption text comes from the existing Match Pulse commentary entries; Game View does not generate its own copy.
- The director links scenes to commentary entries where a clean mapping exists (shared source events / frame ids).
- When no entry maps to the current scene, the caption shows the most recent relevant entry or stays quiet. No invented filler copy.

## Overlay Slot System

The ambient board is built as a slot system from the start, so later layers (sponsor placements, playful-bet prompts) fill slots instead of forcing a redesign.

Initial slots:

- `perimeter` — the pitch-side strip around the board (broadcast LED-board analog)
- `corner_lockup` — small badge/lockup zone on takeover graphics
- `break_interstitial` — full-slot surface during phase breaks (half-time)
- `caption` — the lower-third commentary line

V1 ships the slot structure with neutral/placeholder content. Ad content, sponsorship logic, and bet prompts are out of scope for this PRD; the slots exist so they can arrive without touching the board.

## V1 Ownership

- `packages/core`: `GameViewScene` model, director (frames → scene timeline), pacing/priority/sequencing rules, fixture-driven tests
- `apps/api`: already provides `GET /matches/:fixtureId/engine/frames` (semantic frames after a revision) and `GET /matches/:fixtureId/engine/state`; extend only if frame pagination/windowing proves insufficient
- `apps/mobile`: playback engine, scene renderer, transitions, view states, caption display

The existing scripted demo's playback machinery (beats, actors, timeline player) may be reused where it fits, but hand-authored demo timelines stop being a data source. The demo timeline file is retired from the product path once the director drives Game View.

## Data Source Principle

The semantic frame stream leads all assumptions.

Allowed source context:

- simulation cues and supported facts from `SemanticFrame`
- possession participant, pressure, and `probableZone` bands
- incident lifecycle (provisional, confirmed, retracted)
- score, clock, and phase from the canonical state
- player identity only when the source provides it
- linked Match Pulse commentary entries for captions

Avoid depending on:

- pitch coordinates of any kind
- player positions outside staged vignettes
- invented formations or tactical shapes
- event timing precision beyond what frames carry
- betting mechanics

If frames and any local presentation state disagree, frames win.

## Visual Direction

Game View follows the product visual language:

- black shell; the board is dark and quiet by default
- team/country colors carry all meaning: possession presence, takeover graphics, celebration treatments
- zones are subtle structure, not loud chrome
- takeovers are bold, brief, and typography-led
- no third-party tracker look; the style is GameCrew's own

Reduced motion: with the system reduce-motion setting on, ambient drift and celebration animation reduce to state changes with gentle transitions. Takeover information (goal, card, score) must remain fully available.

## Visual States

### Live

Ambient board playing at near-real-time with the jitter buffer. Takeovers fire as cues arrive.

### Replay

Same board, compressed pacing, playback affordances. A finished fixture plays start to finish as a watchable story.

### Loading

Quiet black-shell loading state.

> Building Game View.

### Empty

If the fixture has no frames yet:

> Game View will appear when TxLINE has enough match signal.

### Error

> Game View is unavailable.

Allow retry. No raw API errors in user-facing copy.

### Stale (live only)

If polling stops returning fresh frames, keep the board at its last state, drop ambient motion to idle, and mark the feed as stale.

> Waiting for the next match update.

## Sound Hook

The first permanent sound slice shipped on 2026-07-17:

- a crowd bed whose intensity follows ambient pressure
- short, restrained effects grounded in entered scenes (referee whistle, ball strike, crowd swell, goal confirmation roar)
- muted by default, enabled by an explicit Game View switch, respectful of device silent mode, and never active in the background
- natural-speed audio even when a finished match is replayed on a compressed visual clock

Sound consumes the same active playback-window identity as the renderer. Ambient volume may crossfade as pressure changes; a punctuating effect fires at most once when its source scene (or goal beat) is entered, with short per-effect cooldowns to stop dense feeds becoming noisy. No new event detector or director logic exists in the sound layer. TTS remains out of scope.

## Out Of Scope

This PRD does not include:

- ad/sponsor content, targeting, or monetization logic (slots only)
- playful bets, coolness points, or chat surfaces inside Game View
- voice narration or TTS commentary
- SSE migration (polling stands)
- real player tracking or formation display
- home screen or Match Pulse changes
- multi-fixture or picture-in-picture boards

## Acceptance Criteria

- Game View renders exclusively from director-produced scenes; the hand-authored demo timeline is no longer a data source.
- The director is a pure, deterministic function from a semantic frame sequence to a scene timeline, tested against a full recorded fixture.
- Ambient play shows possession as a team-colored presence in a semantic zone with pressure-driven intensity; no continuous 22-player simulation exists.
- Every scene traces to source frame ids; player names appear only when the source provides them.
- The goal sequence plays tension, celebration, and reset beats driven by `goal_pending`, `goal_confirmed`/`score_commit`, and `restart` cues.
- Provisional and confirmed goals are visually distinct; `incident_retracted` produces a visible takeback that restores the prior score.
- Takeovers are never dropped; overlapping cues resolve by defined priority.
- Replay plays a finished fixture end to end at a compressed watchable pace using the same director and renderer as live.
- Live playback runs behind a small buffer so cue bursts play smoothly.
- The commentary caption shows only existing Match Pulse copy, synced where mapping exists.
- The overlay slot system (perimeter, corner lockup, break interstitial, caption) exists with placeholder content.
- Loading, empty, error, and stale states are defined and styled in the black shell.
- Reduced motion preserves all takeover information.

## Scenario Acceptance Criteria

- Given the recorded Mexico–Ecuador fixture, the director produces a stable scene timeline covering both goals, all cards, and phase changes, and the replay plays it without manual intervention.
- Given a `goal_pending` cue followed by `goal_confirmed`, the board plays tension then celebration then reset, and the scoreline updates only on commit.
- Given a confirmed incident later retracted, the board plays the takeback treatment and the score returns to its prior value.
- Given rising `possession_pressure` cues for one team, the ambient presence moves toward the attacking zones and intensifies without any takeover firing.
- Given a corner `set_piece` cue, the board plays the corner vignette and returns to ambient at the correct possession state.
- Given a burst of cues arriving in one poll, live playback plays them in order over the buffer window instead of jumping to the final state.
- Given a quiet 20-minute stretch in replay, pacing compresses it so the viewer is not watching idle drift in real time.
- Given no fresh frames within the expected live window, the board idles and shows the stale state without clearing.
- Given reduce-motion enabled, a goal still presents scorer, team, and score as a readable state change.

## Product Decisions

- Game View is a dramatized zone-based board, not a tracked player simulation: a small action cluster stages the true match state; it never simulates 22 players or claims positions. *(Amended 2026-07-15 — the realism experiment's gate decides whether the cluster keeps this weight or reduces to ball-plus-presence.)*
- Staged vignettes may use stylized silhouettes because they depict scenes, not positions.
- The director lives in `packages/core` so the scene timeline is testable against recorded fixtures without UI, and reusable for future surfaces.
- Live and replay share one director and one renderer; replay is the reliable demo path for judging.
- Captions reuse Match Pulse commentary rather than generating parallel copy, keeping one grounded voice across the product.
- The ambient board ships as a slot system so sponsorship and playful-bet surfaces can arrive later without a redesign.
- Sound is scoped as the final layer and attaches to scenes; cutting it does not change the scene model.
