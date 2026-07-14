# Home: integrate recent games into the vertical match surface

## Status

Implemented on 2026-07-13. Pending product review.

The client now partitions the canonical `/matches` response into live/upcoming
featured fixtures and newest-first completed fixtures. The Home Screen uses one
vertical scroll owner with correction-free local navigation state, threshold
hysteresis, reduced-motion behavior, destination focus, duplicate-press
protection, and static team flags with muted team names. The existing backend contract
now discovers the full TxLINE-supported 30-day historical fixture window, while
archival score snapshots are cached so the client's 10-second refresh does not
re-fetch settled results. Recently played fixtures stay fresh for corrections.

## Objective

Turn the Home Screen into one continuous vertical match surface:

- the live or upcoming match poster remains the primary experience at the top
- recent completed games appear directly below it in the same scroll view
- a quiet contextual text control lets the user jump down to recent games and back up to live/upcoming games
- flags remain static so fixture browsing stays calm and visually stable

This is a complete Home Screen layout and navigation change.

## Penpot source of truth

Before designing or implementing this issue, connect to the GameCrew Penpot file and use the Penpot MCP to inspect the current designs. Do not recreate the layout from this written description alone.

On the Penpot page named `Landing`, use these reference frames:

- `Landing - Match Poster v2` — current live/upcoming poster direction
- `Landing - Recent Games v1` — approved minimal recent-games grid direction

The recent-games frame is intentionally simple: small `RECENT GAMES` labeling, flags, score, and date/time. Preserve the existing borderless visual language. Do not turn the fixtures into bordered cards or add archive-style explanatory copy.

## Current problem

The match poster currently occupies the full screen height, so recent completed matches feel like a separate destination and there is no visible invitation to continue down the Home Screen.

Recent games should be discoverable from the primary screen without competing with the featured match or requiring a separate tab or screen.

## Proposed layout

### Featured match section

- Keep the live/upcoming match poster as the dominant first view.
- Reduce the featured section from the entire usable viewport to approximately `90%` of the usable viewport height.
- Calculate the usable height with safe areas and the app header accounted for; do not hard-code the Penpot frame height.
- Use the remaining visible space to reveal a small lower-left navigation affordance: `RECENT GAMES ↓`.
- The affordance should look like quiet text navigation, not a filled or bordered button. Its invisible touch target must still be at least `44 × 44` points.

The small amount of the next section or its navigation visible below the poster should indicate that the page continues vertically.

### Recent games section

- Place recent completed games immediately below the featured section in the same vertical scroll surface.
- Follow `Landing - Recent Games v1`: a clean grid using paired flags, muted team names directly below each flag, the final score, and a small date/time or final-state line.
- Keep the section visually embedded in the black Home Screen shell.
- Do not add bordered fixture cards, heavy panels, decorative containers, `Match Archive`, `Completed Fixtures`, `Newest First`, or similar explanatory copy.
- The Home Screen must have one vertical scroll owner. Do not introduce a nested vertically scrolling recent-games list.

## Contextual jump navigation

The navigation occupies the same visual role at both ends of the interaction and always describes its destination.

### From the featured section

- Show `RECENT GAMES ↓` at the lower left.
- On press, smoothly scroll the Home Screen to the recent-games section.
- Align the recent-games heading and first grid row to a deliberate resting position rather than stopping at an arbitrary offset.

### From the recent-games section

- Change the contextual control to `LIVE & UPCOMING ↑`.
- On press, smoothly return to the featured match section.
- Keep the control position and styling consistent so it feels like one navigation hinge whose direction and destination change.

### Manual scrolling

- Users must also be able to move naturally between both sections by scrolling.
- Update the contextual label and arrow when the user clearly crosses the section boundary.
- Add threshold hysteresis so the label does not flicker when the viewport rests near that boundary.
- Do not force scroll snapping while the user is manually dragging.

## Motion behavior

Motion should only explain the change in location.

### Section movement

- Use native-feeling vertical scrolling; this is not a page replacement or modal transition.
- Keep the contextual control visually stable while its label crossfades or shifts a few pixels and its arrow changes direction.
- Do not animate unrelated Home Screen elements.

### Static flags

- Do not animate featured or recent-game flags.
- Keep every flag stable during manual scrolling, carousel movement, and contextual section jumps.

### Reduced motion

- Respect the operating system's reduced-motion preference.
- With reduced motion enabled, use an immediate or minimally animated section jump.
- Preserve the contextual label and arrow change so navigation remains understandable without animation.

## Interaction and accessibility requirements

- Give both contextual control states clear screen-reader labels, including destination and direction.
- Ensure the text control has a minimum `44 × 44` point touch target without adding a visible button container.
- Do not rely on animation alone to indicate the current section or navigation destination.
- Keep text and arrows readable against the black background.
- Prevent duplicate presses while a programmatic scroll is already in progress.
- After a programmatic jump, leave accessibility focus in a predictable place at the destination.

## Data and product constraints

- The top poster may represent either a live fixture or an upcoming fixture using the existing canonical match state.
- The lower grid contains completed recent fixtures and their final scores.
- Clients must consume GameCrew APIs and must not interpret TxLINE directly.
- Match status, score, teams, timing, and home/away orientation must come from canonical GameCrew match data.
- A completed fixture's visibility must not depend on Match Pulse commentary or engine materialization.
- Motion may emphasize the interface but must never invent or alter match truth.

## Out of scope

- Redesigning the match poster or recent-games visual style
- Adding a separate Recent Games screen or bottom-navigation destination
- Match Detail behavior after selecting a fixture
- Any flag animation
- Goal, card, substitution, or Match Pulse event animation
- Adding panels, borders, archive filters, sorting controls, or editorial content

## Acceptance criteria

- The live/upcoming section uses approximately `90%` of the usable viewport instead of consuming the entire screen.
- `RECENT GAMES ↓` is visible near the lower-left edge of the first view without weakening the featured match hierarchy.
- Recent completed games appear directly below in the same vertical scroll surface.
- The grid includes every completed fixture returned by GameCrew from TxLINE's supported 30-day lookback, not only locally materialized Match Pulse fixtures.
- The recent grid visually follows `Landing - Recent Games v1` and remains borderless.
- Pressing `RECENT GAMES ↓` smoothly lands at the recent-games section.
- At the recent-games section, the navigation becomes `LIVE & UPCOMING ↑` and returns the user to the featured section.
- Manual scrolling works in both directions and updates the contextual navigation without flicker.
- Featured and recent-game flags never animate.
- Each recent-game flag has its canonical team name directly below it in muted text.
- Repeated presses during an active jump do not produce competing scroll or animation sequences.
- Reduced-motion mode minimizes the programmatic movement without removing navigation clarity.
- Both contextual states have accessible labels and at least `44 × 44` point touch targets.
- The implementation introduces no bordered match cards, nested vertical scrolling, or non-canonical match information.

## Verification

- Compare the implementation against both named Penpot frames through the Penpot MCP.
- Verify the layout on short and tall mobile viewports, including safe-area insets.
- Exercise button-driven movement and manual scrolling in both directions.
- Test rapid repeated presses and crossing the section threshold slowly.
- Test live-at-top and upcoming-at-top states.
- Test reduced-motion and screen-reader behavior.
- Confirm that no flag animation occurs during carousel or section navigation.
