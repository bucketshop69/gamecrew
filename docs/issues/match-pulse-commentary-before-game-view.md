# Match Pulse layout work before Game View integration

**Status:** Demo UI implemented; final device-recording review remains. Scope reset on 2026-07-13.

## Objective

Finish the match-screen layout and the transition between Match Pulse and Game View before connecting live semantic frames to the pitch.

The existing Match Pulse commentary rows should remain visually unchanged for this phase. Event-specific illustrations, Lottie files, and richer category cards are deferred. One code-native, scripted Game View sequence is allowed for the recorded demo; it is not backend integration.

## Confirmed product decisions

- Remove Chat from this match experience.
- Use `Match Pulse | Game View` as the only mode control.
- Keep Match Pulse selected by default.
- Use a compact sticky score rail: home team on the left, away team on the right, each team name below its flag, scores beside the team blocks, and the match clock centered.
- For upcoming matches, show the kickoff date and local time as two deliberate lines; do not show a redundant `KICKOFF` caption.
- Do not show dash score placeholders before a match has started.
- Keep the current commentary-row appearance and information density.
- Game View takes the available screen below the score rail and mode control.
- Game View commentary becomes a bottom overlay showing the latest three or four entries.
- The bottom overlay advances with the match and is not a separately scrollable chat panel.
- Do not label Game View as deterministic, probable, simulated, or a preview.
- No commentary illustrations, external event-animation assets, sound, or haptics in this phase.
- The demo Game View may use code-native player and ball motion to show one attack developing; it must remain clearly isolated from later backend-driven playback.

## Active work list

| Order | Work item | Status |
|---|---|---|
| 1 | Compact the sticky match header and score rail | Implemented |
| 2 | Replace Chat/Preview navigation with `Match Pulse | Game View` | Implemented |
| 3 | Preserve the current Match Pulse commentary presentation | Implemented |
| 4 | Keep one shared header/control shell while Game View fills the remaining content area | Implemented |
| 5 | Add one 40-second demo-only Game View attack sequence | Implemented |
| 6 | Render the latest three existing commentary moments as the Game View bottom overlay | Implemented |
| 7 | Verify 432/444 widths, long team names, match phases, and accessibility | In progress |
| 8 | Connect Game View to backend semantic-frame progression | Later phase |

## 1. Compact match header

- Keep the score rail fixed while content changes below it.
- Put the home identity and score on the left and away identity and score on the right.
- Put each team name directly below its flag while keeping the score beside the flag/name block.
- Keep the clock and match phase centered.
- Split upcoming kickoff information into a one-line date and one-line time so timezone text cannot wrap through the score rail.
- Reduce the current vertical height and remove redundant metadata.
- Avoid layout jumps when the score or phase changes.
- Handle long team names, stoppage time, half-time, full-time, and narrow phone widths.

## 2. Mode control

- Show only `Match Pulse` and `Game View`.
- Keep the active mode visually unambiguous.
- Preserve accessible tab roles, labels, focus order, touch targets, and contrast.
- Switching modes must not imply that backend-driven Game View playback is already complete.

## 3. Commentary preservation

- Keep the existing minute block, commentary copy, metadata, spacing, and tone surfaces.
- Continue using structured backend fields for the content already displayed.
- Do not add event-specific artwork, icons, animation selection, or new visual hierarchy in this phase.
- Do not parse LLM prose to infer an event or visual treatment.

## 4. Demo-only Game View scene

- Run one authored 40-second sequence suitable for the recorded narration; do not loop it.
- Start with the home team building from the back, then show progression, defensive pressure, a switch of play, and a through ball.
- Give the ball, principal attackers, defensive shape, goalkeeper, and camera independent tracks so movement reads as a connected football action rather than a formation slide.
- Finish with a shot, goalkeeper dive, goal-line score commit, and staggered group movement toward the corner.
- Hold the final celebration instead of resetting positions or reverting the score.
- Keep the shared header coherent for the demo passage: a monotonic live clock and one score change after the shot reaches the goal.
- Use the completed match score as the end state when possible, so a 2–0 result is presented as a 1–0 to 2–0 passage rather than becoming 3–0.
- Keep the sequence deterministic and client-owned for the demo only; do not present it as live source data.
- Use the existing code-native pitch, stick players, and ball. Do not add media or animation dependencies.
- For reduced motion, show a deliberate static final-third frame rather than cycling scenes.

## 5. Game View commentary overlay

- Keep the same match header and `Match Pulse | Game View` control visible in both modes.
- Replace only the content below the mode control; do not open a second screen or add another back/Pulse header.
- Let the pitch fill all remaining width and height below the shared controls.
- Reuse the existing commentary-row presentation rather than creating a second visual system.
- Match the existing Match Pulse dark surfaces, minute badge, bold commentary, muted metadata, spacing, and corner radius; do not introduce team-colour strips or a broadcast-panel theme.
- Show only the latest three or four entries.
- Add new entries at the live edge and retire older visible entries automatically.
- Do not give the overlay an independent scroll interaction.
- Keep commentary legible over every area of the pitch.
- Prevent long text, rapid updates, and missing optional metadata from clipping the pitch or screen controls.

## Out of scope

- Lottie, GIF, MP4, or custom event animation assets.
- Richer event-category cards or illustration systems.
- Sound, haptics, or crowd audio.
- Exact ball or player tracking.
- Backend-to-pitch integration, sockets, or new polling infrastructure.
- Changes to LLM commentary generation.
- Screen recording or marketing capture.

## Acceptance criteria

- [x] Chat is absent and leaves no reserved layout space.
- [x] The mode control reads `Match Pulse | Game View`.
- [x] The temporary animation runtime, assets, and demo treatments are removed.
- [x] Match Pulse commentary rows retain their existing appearance.
- [x] Team names sit below their flags, scores sit beside those team blocks, and the match clock stays centered.
- [x] Upcoming matches show a clean date/time pair without a `KICKOFF` caption or wrapped timezone.
- [x] Upcoming and hosted matches do not show meaningless dash score placeholders.
- [x] Game View remains in the same screen shell and fills the remaining content area.
- [x] Game View has no duplicate header or separate Pulse-back control.
- [x] The demo Game View shows one 40-second build-up-to-goal sequence with a corner celebration and no visible loop.
- [x] The demo scene uses only client-owned code-native motion and adds no media dependency.
- [x] Game View uses a monotonic live clock and commits the score only after the shot reaches the goal.
- [x] The compact score rail and Game View are visually verified at 432 × 810 and 444 × 810.
- [ ] Long team names and every match phase fit without layout jumps.
- [x] Game View shows the latest three authored commentary moments in a non-scrollable bottom overlay.
- [x] The overlay remains readable through the authored demo sequence at the target recording widths.
- [ ] Both modes have correct screen-reader labels, focus behavior, and touch targets.
- [x] No animation-specific dependency or remote asset was added to the mobile app.

## Verification

- Run the focused mobile tests and mobile typecheck.
- Run the workspace typecheck.
- Inspect Match Pulse and Game View on narrow and wide phone sizes.
- Exercise long team names, score changes, stoppage time, half-time, and full-time.
- Inspect large text and screen-reader behavior.
- Run `git diff --check` before handoff.

## Next focused item

Record one target-device rehearsal of the full 40-second sequence, then address any timing or legibility feedback from that take. Backend semantic-frame playback remains a later phase.
