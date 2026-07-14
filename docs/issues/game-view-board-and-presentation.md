# Game View: board and presentation

**Status:** Planned. Starts when `game-view-director-and-playback.md` proves the pipeline. Phase B of `docs/prds/game_view.md`.

## Objective

Replace the scripted demo with the real Game View presentation: the ambient zone board driven by director scenes, moment takeover graphics, seek with chapter markers, view states, the synced commentary caption, the overlay slot system, and (last, cuttable) sound. Ends with the hand-authored demo timeline removed from the product path.

## Confirmed decisions (from the PRD)

- Ambient board: zone pitch, team-colored possession presence, pressure-driven intensity. Drift inside a zone is presentation, not data.
- Takeovers are bold, brief, typography-led; goal sequence plays tension → celebration → reset; VAR retraction is a visible product moment.
- Stylized silhouettes allowed only inside staged vignettes (corner, penalty, celebration).
- Captions reuse Match Pulse commentary entries; no parallel copy generation. Narrative fields (e.g. `scoreEvent`) may style takeovers (a comeback goal looks different).
- Overlay slots (perimeter, corner lockup, break interstitial, caption) ship with placeholder content; ads/bets fill them later without redesign.
- Black shell, team colors carry meaning; reduce-motion preserves all takeover information.
- Sound attaches to scenes (crowd bed follows pressure, stingers on takeovers); cutting it changes nothing else.

## Work list

| Order | Work item | Status |
|---|---|---|
| 8 | Ambient board renderer: zone pitch + possession presence, replaces the scripted demo as default | Planned |
| 9 | Takeover renderers: goal sequence, card, corner vignette, VAR takeback, phase break | Planned |
| 10 | Seek bar with goal/card chapter markers; jump to any moment live or finished | Planned |
| 11 | View states: loading, empty, error, stale; reduce-motion behavior | Planned |
| 12 | Commentary caption synced to scenes from existing Match Pulse entries | Planned |
| 13 | Overlay slot system with placeholder content | Planned |
| 14 | Sound: pressure-driven crowd bed, takeover stingers (cuttable) | Planned |
| 15 | Demo retirement: remove the hand-authored timeline from the product path; update docs/issues | Planned |

## Out of scope

- Ad/sponsor logic, playful bets, chat surfaces (slots only).
- Voice narration / TTS.
- Home screen and Match Pulse changes.

## Acceptance criteria

- [ ] Game View renders exclusively from director scenes; the demo timeline file is no longer imported by product code.
- [ ] The stored Mexico–Ecuador replay plays start to finish as a watchable story with both goals as full takeover sequences.
- [ ] Seek and chapter jumps work on live and finished fixtures.
- [ ] All PRD view states exist in the black shell; reduce-motion keeps goal/card/score information readable.
- [ ] Captions show only existing Match Pulse copy, synced where mapping exists.
- [ ] Slots exist with placeholder content and render across phone widths.
- [ ] Mobile tests and workspace typecheck pass; visual check at 432/444 widths.

## Verification

- Replay walkthrough on device/simulator (primary demo path), including tab switching mid-playback.
- Simulated-live mode with a cue burst to confirm smooth takeover sequencing.
- Accessibility pass: reduce motion, screen reader labels on takeovers.
