# Game View: figure identity, immersion layer, and missing moments

**Status:** Core implementation slice complete; follow-ups remain. Created 2026-07-17 from an external UI/UX review discussion. Complements `game-view-realism-experiment.md` (R4/R6 motion + gate) and `game-view-presentation-polish.md` (C1 seek bar, slots). Does not supersede either.

## Baseline

External review rated the current Game View **~5.5/10** against the "does it look like a match" gate: architecture and event grammar are strong (honesty rule, goal-sequence beats, provisional/confirmed distinction); the gaps are figure cosmetics, the unfinished motion layer, and a thin moment vocabulary.

Product direction in this doc came from the same discussion. The mockup-first checkpoint from the realism experiment's recorded lesson is **waived** (hackathon time constraint) — judge directly on localhost per the existing gate protocol. Accepted risk: look-and-feel rework if a direction fails live.

## Work list (suggested priority order)

| Order | Work item | Notes |
|---|---|---|
| I1 | Kit identity system: static kit dictionary for World Cup nations (shirt + shorts + keeper colors), flag-band fallback for unknown teams | Kits are public facts, not invented data — honesty-safe. Two-tone paint on the existing pose table; no geometry changes. |
| I2 | Away-kit clash resolution | When colors collide, the away team uses its away kit — real football grammar fans already understand. Extends existing `getTeamColor` clash context from color-pick to kit-pick. |
| I3 | Depth-of-field focus | Engaged 2–3 figures at full strength; formation block dimmed to ~60%. Removes the 22-way attention competition. |
| I4 | Body-motion pass | ~1px vertical run bob; lean scales with pressure (9° calm → ~14° sprint). Bodies-as-units sell motion better than limb frames at 20px. |
| I5 | Celebration variety | 2–3 distinct celebration poses chosen per goal (arms up, pointing, crouch/slide) so goals stop looking identical. |
| I6 | Haptics | Goal roar + thump; card buzz. Cheapest immersion win on mobile. |
| I7 | Anticipation crowd audio | Hum rises as the ball enters the danger zone; "oooh" on near miss; groan on cheap giveaway. All keyed from existing pressure/scene data — no new detectors. |
| I8 | Signature vignette: penalty frame | Shooter vs keeper alone; everyone else frozen at the box edge. Grounded in the existing penalty cue. Recommended as the one vignette to do brilliantly for judging. |
| I9 | Signature vignette: corner-flag kill | Leading team shielding at the corner flag late (grounded: possession by the winning team in the corner zone after ~85'). |
| I10 | Signature vignette: free-kick wall | Wall lines up when a free kick is in shooting range. |
| I11 | Substitution banner | Dispatcher currently renders `null` for `substitution` scenes; PRD taxonomy expects a player in/out banner. Confirmed code gap. |
| I12 | Shot outcome treatment | Save / miss / woodwork need distinct micro-beats; post-bar hit gets its own sound + crowd reaction. |
| I13 | Momentum visibility | Post-goal spring vs sluggishness for ~1 min; tempo lift late in one-goal games. Driven by real pressure data, never invented. |
| I14 | Camera push-in | Subtle scale toward the box on corners/penalties. One focal point at a time (extends the R4 double-presence lesson into a rule). |
| I15 | Social fusion (GameCrew differentiator) | Chat-reaction crowd wave across the perimeter boards; playful-bet stadium ticker ("37 Lambos riding on France"). Needs the slot-priority rule vs ads already noted in presentation-polish. |
| I16 | First-run expectation microcopy | "Illustrated from live match data" — prevents both over-trust (real tracking?) and dismissal (fake players?). |
| I17 | Replay controls + seek | Pause/speed control; C1 seek bar with goal/card chapters stays owned by presentation-polish — do not duplicate scope here. |
| I18 | Perimeter ad dimming | Dim the traveling LED loop during high-danger play so it never out-competes the ball. |
| I19 | Commentary overlay tap-to-expand | Bridge into full Match Pulse from the lower-third. |
| I20 | 20px legibility pass | Keyline contrast vs turf, ball visibility, on a real phone. |

## Missing moments / flaws found in review (activity vocabulary gaps)

- **Penalty shootout mode** — knockout grammar is different (one taker, one keeper, center stage, rest at the halfway line). No scene kind exists. High risk if a knockout game goes to penalties during judging.
- **Added-time board** — the 4th-official board is iconic; only if frames carry added time. Do not invent it.
- **VAR "goal stands" beat** — `var_review` has tension and `goal_retracted` has the takeback, but the relief beat when VAR confirms has no distinct treatment.
- **Second yellow → red escalation** — not modeled; emotionally different from a straight red.
- **Red-card walk-off** — cards are banners by settled decision; the lonely on-pitch walk under the banner would sell the moment.
- **Injury stoppage** — only if the source carries it.

## Honesty guardrails (unchanged)

- No player names or numbers on invented figures; identity only in takeover typography from source.
- Team identity comes from public kit facts only. Playing style stays emergent from real match data — no hardcoded "Spain = tiki-taka."
- Added-time / injury / offside vignettes only where source data exists.

## Judgment

Gate unchanged: Bibhu judges on localhost. Suggested hackathon demo path: **I1 + keeper colors → I7 anticipation audio → I8 penalty frame**. Three things a judge can feel in 60 seconds beat ten features they have to be told about.

## Implementation record — 2026-07-17

This pass started with regression tests, then changed the canonical director contract, then connected the mobile renderer, and finally exercised the real France–Morocco replay on localhost plus the recorded France–Spain synchronization fixture. The implementation deliberately stops where source truth or adjacent ownership becomes unclear.

### Completed in this slice

| Area | Result |
|---|---|
| I1 kit identity | Added a static World Cup kit dictionary with shirt, shorts, trim, and keeper palettes for the currently supported nations. Unknown teams use existing source colors/flag bands. Stick figures now paint shirt and shorts independently. |
| I2 clash resolution | Home kits are preferred; a visually colliding away side switches to its away palette. Spain–Morocco is covered as a regression case. |
| I3 depth-of-field focus | The grounded 2–3-player possession knot and nearest presser render at full strength; the cosmetic formation context recedes to 58%. Corner, throw-in, shot, goal-kick, and celebration actors are also foregrounded. |
| I4 body motion, partial | Moving figures share one synchronized two-frame cadence plus a 1px body bob. One shared timer drives the group; reduced-motion disables it. Pressure-scaled body lean remains open. |
| I7 source-keyed audio, partial | Existing pressure-driven crowd beds remain the anticipation layer. Shot punctuation now distinguishes blocked attempts from miss/woodwork/on-target reactions; goal kicks, injuries, substitutions, and added time have restrained grounded plans. Giveaway groans remain open. |
| I11 substitution banner | Substitutions now render a compact pitch-preserving banner. Source player-in/player-out ids survive the director, but the UI does not invent names when the source only supplies ids. |
| I12 shot outcomes | `Outcome` survives incident revisions. On-target, off-target, blocked, and woodwork scenes have distinct labels, keeper behavior, and ball endpoints; a miss is no longer illustrated as a save. |
| Missing moments | Added source-grounded injury and additional-time scenes, a settled VAR decision treatment (including “Decision stands”), and goalkeeper-to-teammate goal-kick choreography. Added time remains generic when the cue does not provide a minute count. |
| Red-card continuity | A confirmed red permanently changes later formation counts to 10-v-11 for that projection. The confirmed incident is deduped, and a later source retraction restores the count. |
| Side identity | TxLINE's `Participant1IsHome` now crosses the shared match contract. Game View team ownership and the score rail follow that mapping instead of assuming participant 1 is always home. |

### Deferred deliberately

- I5 celebration variety, I6 haptics, I8 penalty signature frame, I9 corner-flag kill, I10 free-kick wall, I13 momentum after-effects, I14 camera push, I16 first-run copy, I18 perimeter dimming, I19 commentary expansion, and I20 physical-phone legibility still need focused design/acceptance work.
- I15 social fusion stays with the parallel economy/chat work so this issue does not create a second slot-priority implementation.
- I17 replay navigation remains owned by `game-view-presentation-polish.md`.
- Penalty shootouts and extra-time phase grammar require canonical engine support before UI choreography can be honest.
- No haptics dependency was introduced in this pass.

### Test and validation evidence

- Core/fixture/adapter Game View gate: **53/53 passing**.
- Mobile Game View gate: **206/206 passing**.
- Full mobile suite: **333/333 passing**.
- Full `@gamecrew/core` suite: **195/195 passing**.
- Full `@gamecrew/api` suite: **165/165 passing**.
- Workspace typecheck: passing across core, API, mobile, and web.
- Fixture smokes: ingestion and commentary both pass for `18179759`; ingestion confirms 886 durable records, finalised phase, 2–0, and no integrity warnings.
- France–Spain synchronization smoke (`18237038`): **1,027 semantic frames**, **823 Game View scenes**, **730 grounded commentary entries**, and **128/128 final visual incidents** cue-aligned exactly once, with zero duplicate scenes or captions.
- `git diff --check`: passing.
- Localhost: reused the existing API on `:8787`, started mobile web temporarily on `:8081`, loaded fixture `18209181` (France 2–0 Morocco), entered Game View, and visually checked the kit split, keeper contrast, foreground action knot, formation recession, replay clock, score rail, and commentary overlay. The web bundle completed without runtime errors; only existing development/deprecation warnings were logged. The temporary `:8081` process was stopped afterward.

The repository-wide gate briefly exposed two changing economy/chat failures while parallel work was still landing. Their owning work resolved them before the final acceptance run; this pass did not modify those unrelated files.
