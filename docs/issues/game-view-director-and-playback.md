# Game View: director and playback

**Status:** Implemented 2026-07-14. All seven work items done and verified (110 core / 33 mobile tests, live endpoint smoke, real-fixture director run). Phase A of `docs/prds/game_view.md`; Phase B (`game-view-board-and-presentation.md`) is next.

## Objective

Make Game View's data pipeline real: semantic frames from the backend become a deterministic scene timeline (the director), owned by a per-fixture match session on mobile, played through a playhead that treats live, pause, rewind, and replay as one mechanism. Ends with a debug-rendered proof that real match data flows end to end. No production graphics in this phase.

## Confirmed decisions (from the PRD)

- Zone-based abstract board; no continuous 22-player simulation. Every scene traces to source frames.
- Strict one-way layers: frame log → director → scenes → renderer. Views never interpret frames.
- The director is a pure, deterministic function in `packages/core`, testable against recorded fixtures without UI.
- One match session per fixture on mobile, owned above the tabs; Match Pulse and Game View are subscribers. Switching tabs never interrupts polling or playback.
- Playhead (where the user watches) is separate from data head (how much is fetched) from day one. Live = playhead tracks head minus a small buffer.
- Goal choreography is cue-driven: `goal_pending` → tension, `goal_confirmed`/`score_commit` → celebration, `restart` → reset; `incident_retracted` → takeback.
- Takeovers are never dropped; overlapping cues resolve by severity (goal > card > set piece > ambient).
- Replay and live share one director and one renderer; replay is the judging demo path.

## Work list

| Order | Work item | Status |
|---|---|---|
| 1 | Frames delivery hardening: full-history + after-revision delta on `/matches/:id/engine/frames`, in-memory response cache | Implemented |
| 2 | `GameViewScene` model and scene-kind taxonomy in `packages/core` | Implemented |
| 3 | Director core: frames → ambient scenes (possession, zones, pressure, flips) | Implemented |
| 4 | Director sequences: goal choreography, VAR takeback, cards, subs, set pieces, phase breaks, severity priority | Implemented |
| 5 | Director pacing: replay quiet-stretch compression, live buffer timing; full-fixture test against stored Mexico–Ecuador frames | Implemented |
| 6 | Match session store on mobile: per-fixture append-only log, polling, shared by both tabs | Implemented |
| 7 | Playback engine: playhead/head separation, replay + live modes, bare debug renderer | Implemented |

Real-data findings folded in during item 5: duplicate `goal_confirmed` cues (second revision carries the resolved player id) now merge into one goal scene; `late_winner` requires genuine closing-stages clock; only goal retractions produce `goal_retracted` scenes (throw-in/corner retractions are dropped). Trimmed real-frame fixtures live in `packages/core/tests/fixtures/`.

## Out of scope

- Ambient board or takeover graphics (Phase B: `game-view-board-and-presentation.md`).
- Seek bar UI, captions, overlay slots, sound.
- SSE; polling stands.
- Changes to Match Pulse rendering or commentary generation.

## Acceptance criteria

- [ ] The director replays the stored Mexico–Ecuador fixture into a stable scene timeline covering both goals, all cards, and phase changes, deterministically (same input → same output).
- [ ] Every scene carries source frame ids and lifecycle where applicable.
- [ ] Provisional goals produce tension scenes; only confirmed goals produce celebration; retraction produces a takeback scene.
- [ ] Frames endpooint serves full history and after-revision deltas; identical concurrent requests hit the cache.
- [ ] The mobile session keeps polling and accumulating while the user switches tabs.
- [ ] The playhead can lag, pause, and rewind while the head advances; a finished fixture plays end to end in the debug view.
- [ ] All new logic is unit-tested; api, core, and mobile suites plus workspace typecheck pass.

## Verification

- Core: fixture-driven director tests (synthetic frames + stored real frames).
- API: endpoint tests for history, delta, and cache behavior.
- Mobile: session/playback unit tests; manual debug-view check in replay and simulated-live modes.
