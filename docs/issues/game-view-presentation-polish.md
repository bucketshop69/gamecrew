# Game View: presentation polish

**Status:** Active partial implementation. Commentary, the perimeter slot, and the first permanent sound slice are in place; navigation and remaining overlay slots stay deferred. Phase C of `docs/prds/game_view.md`.

## Objective

The cosmetic and monetization-adjacent layers on top of the working board: navigation within the match, the commentary caption, the overlay slot system that later hosts sponsor placements and playful-bet prompts, and sound.

## Work list

| Order | Work item | Status |
|---|---|---|
| C1 | Seek bar with goal/card chapter markers; jump to any moment live or finished | Deferred |
| C2 | Commentary caption synced to scenes from existing Match Pulse entries | Done (uncommitted, 2026-07-16) |
| C3 | Overlay slot system (perimeter strip, corner lockup, break interstitial) | In progress — ecosystem perimeter showcase implemented; corner/break slots deferred |
| C4 | Sound: pressure-driven crowd bed, grounded event effects | First slice done (2026-07-17); TTS deferred |

## Notes

- Slots are groundwork for the advertising direction discussed in the vision (broadcast-native placements, sponsored moments, phase-break interstitials) — the slot system ships with placeholder content; ad logic is a separate later decision.
- **Perimeter ad trial (2026-07-16, revised after screenshot review):** a quiet startup treatment holds for five seconds (GAMECREW on the far/top face, dim LED segments on the sides), then a Solana ecosystem showcase (Solana, Jupiter, $ANSEM, Phoenix, and Meteora) travels across one shared Reanimated clock. Solana, Jupiter, and Meteora use their official transparent icon marks over dual-tone, LED-textured panels; $ANSEM and Phoenix remain restrained wordmark treatments until verified assets are available. These names are presentation creative only and do not imply sponsorship or partnership. The approved physical treatment uses inward-facing LED walls on the far/top and both touchline sides, with dark lips/end caps for depth; the near/bottom edge remains an uninterrupted black shell and carries no ad creative. There is no targeting, tracking, interaction, or production sponsor model.
- Captions reuse Match Pulse commentary entries; no parallel copy generation.
- The lower-left transcript follows durable source-frame sequence, not a second timer. It keeps the current line plus the two immediately preceding reached lines, accepts both enriched and grounded-fallback copy, survives delayed clock corrections without flicker, and withholds confirmed-goal wording until the celebration beat.
- **Immediate-event revision (2026-07-16):** Match Pulse planner v3 emits one grounded caption for every meaningful semantic moment instead of replacing routine play with 90-second pressure summaries. Same-frame incidents are split into distinct cue-specific captions, while a goal and its score commit remain one moment. Game View scenes now retain the same cue IDs, so captions sharing a TxLINE frame activate on their own ordered visual scene rather than appearing together. Throw-ins, goal kicks, possession changes, pressure-zone changes, set pieces, shots, cards, substitutions, VAR, goals, restarts, and phase changes are retained; only repeated identical possession state, lifecycle duplicates, retracted minor incidents, and technical noise are removed. France–Spain now projects 730 immediate entries with 128/128 final visual incidents covered and cue-aligned exactly once.
- **Sound slice (2026-07-17):** bundled royalty-free local clips provide one low crowd bed plus referee-whistle, ball-strike, crowd-swell, and goal-roar punctuation. The bed crossfades across quiet/building/danger levels from the real scene pressure. Effects key from PlaybackEngine's unique active-scene window (and the tension/celebration goal beat), so React rerenders cannot double-fire them; short cooldowns suppress dense secondary chatter. Sound is opt-in, session-persistent across tab remounts, respects silent mode, mixes with other apps, pauses in the background, and always plays at natural speed. Voice/TTS remains a separate later layer.
- Playful-bet prompts will compete with sponsor content for ambient-mode attention; define a slot-priority rule (bets during play, ads during breaks) when this phase starts.
