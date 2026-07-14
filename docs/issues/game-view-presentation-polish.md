# Game View: presentation polish

**Status:** Deferred until Phase B (`game-view-board-and-presentation.md`) proves the choreography on device. Phase C of `docs/prds/game_view.md`.

## Objective

The cosmetic and monetization-adjacent layers on top of the working board: navigation within the match, the commentary caption, the overlay slot system that later hosts sponsor placements and playful-bet prompts, and sound.

## Work list

| Order | Work item | Status |
|---|---|---|
| C1 | Seek bar with goal/card chapter markers; jump to any moment live or finished | Deferred |
| C2 | Commentary caption synced to scenes from existing Match Pulse entries | Deferred |
| C3 | Overlay slot system (perimeter strip, corner lockup, break interstitial) with placeholder content | Deferred |
| C4 | Sound: pressure-driven crowd bed, takeover stingers (cuttable) | Deferred |

## Notes

- Slots are groundwork for the advertising direction discussed in the vision (broadcast-native placements, sponsored moments, phase-break interstitials) — the slot system ships with placeholder content; ad logic is a separate later decision.
- Captions reuse Match Pulse commentary entries; no parallel copy generation.
- Sound attaches to scenes (kind, pressure, lifecycle already on the scene model); cutting it changes nothing else.
- Playful-bet prompts will compete with sponsor content for ambient-mode attention; define a slot-priority rule (bets during play, ads during breaks) when this phase starts.
