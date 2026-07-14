# Game View: board and presentation

**Status:** Implemented 2026-07-14 (pending on-device review). The scripted demo is deleted from the product path; Game View renders exclusively from director scenes via the match session and playback engine. Scope was deliberately narrowed to the backend-to-screen connection; cosmetics live in `game-view-presentation-polish.md` (Phase C) and start only after the choreography is approved on device.

Known assumption to watch on device: `GameCrewMatch` carries no explicit home/away-to-engine-participant mapping, so the screen assumes participant 1 = home (same assumption the debug panel and board direction default use). If a fixture ever renders with flipped colors/directions, thread the core's `Participant1IsHome` signal through the match payload.

## Objective

Replace the scripted demo with a real renderer: the ambient zone board and moment takeover graphics drawn from director scenes delivered by the match session/playback engine. A finished fixture replays end to end on device through the same path a live match will use. Ends with the hand-authored demo timeline removed from the product path.

## Confirmed decisions (from the PRD)

- Ambient board: zone pitch, team-colored possession presence, pressure-driven intensity. Drift inside a zone is presentation, not data.
- Takeovers are bold, brief, typography-led; goal sequence plays tension → celebration → reset; VAR retraction is a visible takeback.
- Stylized silhouettes only inside staged vignettes; no continuous player simulation, no pitch coordinates.
- Black shell; team/country colors carry all meaning. Reduce-motion preserves all takeover information.
- Live and replay share one renderer; replay is the judging demo path.

## Work list

| Order | Work item | Status |
|---|---|---|
| B1 | Ambient board renderer: zone pitch + possession presence, scene transitions, reduce-motion | Implemented |
| B2 | Takeover renderers: goal sequence (tension/celebration/reset), card, set-piece vignette, VAR takeback, phase break, restart | Implemented |
| B3 | View states: loading, empty, error, stale in the black shell | Implemented |
| B4 | Integration: Game View tab renders playback-engine output (replay + live modes); demo timeline retired from the product path | Implemented |

## Out of scope (moved to Phase C)

- Seek bar and chapter markers.
- Commentary caption overlay.
- Overlay slot system / sponsor placements.
- Sound.
- Voice, chat, bets.

## Acceptance criteria

- [ ] Game View renders exclusively from director scenes; the demo timeline file is no longer imported by product code.
- [ ] The stored Mexico–Ecuador replay plays start to finish on device: ambient flow between zones, both goals as full takeover sequences, cards and phase breaks rendered.
- [ ] Possession presence flips sides and zones as scenes change; pressure raises visual intensity.
- [ ] Provisional goal shows tension treatment only; confirmed shows celebration; a goal retraction plays the takeback.
- [ ] Loading, empty, error, and stale states exist in the black shell.
- [ ] Reduce-motion keeps goal/card/score information fully readable.
- [ ] Mobile tests and workspace typecheck pass; visual check at 432/444 widths.

## Verification

- Replay walkthrough on device/simulator, including tab switching mid-playback.
- Simulated-live check (fake clock or slowed replay) confirming smooth takeover sequencing on cue bursts.
- Accessibility pass: reduce motion, screen-reader labels on takeovers.
