# Game View: realism experiment (toward 6.5)

**Status:** In progress. Started 2026-07-15. Supersedes the order in `game-view-presentation-polish.md` for the visual layers; seek/caption/slots remain in that doc.

## Objective

Push Game View from the legible abstract board (~3/10 against FIFA-grade) toward a dramatized match view (~6/10): a real-looking pitch, stylized player silhouettes clustered around the action, a ball that travels, and a quiet foley layer. Built in stages so every stage is valuable if the experiment stops early.

## The gate (agreed with product)

After all stages land we judge the whole thing together (including neutral eyes): "does this look like a match, or does it look fake?" If it fails, the player-cluster layer is removed, ball motion + sound + pitch stay (a strong ~5), and screen weight shifts toward commentary. The director/data pipeline is unaffected either way.

## Honesty rule (unchanged)

Real events anchor everything. The cluster dramatizes around true state (possession, zone, set piece, shot, goal); it never claims real positions. No coordinates from source exist; none are implied as data.

## Work list (product-directed order: ground → players → connection → sound → judge)

| Order | Work item | Status |
|---|---|---|
| R1 | Pitch upgrade: broadcast-dark turf, chalk lines (boxes, arcs, spots, goal mouths), zone chrome integrated, and stadium-style perimeter ad boards (slot component, GameCrew wordmark placeholder — C3's perimeter slot pulled forward) | Done (uncommitted polish in tree) |
| R2 | Player characters: stylized silhouettes, team colors, pose set (run, strike, keeper, celebrate), dev-only gallery for taste review | Done |
| R3 | Taste checkpoint: screenshots reviewed by product before wiring | Done — verdicts in "Settled decisions" below |
| R4 | Action cluster + ball motion: 5-6 silhouettes (both teams) + traveling ball driven by director scenes (passes, shots at goal, corners swung in, celebrations) | In progress |
| R5 | Sound | Deferred — designed as its own conversation after the visuals are judged; expo-audio dependency approved in principle (verified 2026-07-15: no audio library in the project today) |
| R6 | Integrated judgment vs the gate; keep, tune, or reduce weightage | Planned — Bibhu judges directly on localhost once R4 lands |

## Settled decisions (product grill, 2026-07-15 — REVISED same day after seeing it live)

**Product verdict on the small-group cluster: 1–2/10.** Bibhu watched the built version and rejected it; the picture in product's head was always the classic top-down 2D tactical view (Football Manager 2D / broadcast tactical camera): **all 22 players as thin stickmen, both teams in formation, whole pitch at a glance.** A mockup confirmed the target look and was approved. Lesson recorded: look-and-feel decisions get made from mockups, not from word descriptions.

- **View framing (revised):** full-pitch top-down, 22 figures — two 11-player formation blocks (cosmetic default shapes, e.g. 4-3-3 vs 4-4-2; never claimed as real lineups) that slide and compress with the real facts (possession, zone, pressure). The 4–5 players nearest the ball do the engaged action (passing knot, corner swing, shot, celebration); the rest hold formation with short line-shifts. Positions are honest theater: they may never contradict a known fact, and no real player name/number ever appears on an invented figure.
- **Character style (revised):** thin stickman (head + line limbs) at ~20px, per the approved mockup. The 32px floor was a finding about the chunky token style and dies with it.
- **Cluster makeup (unchanged in spirit):** the engaged group around the ball is 2–3 possession figures + 1–2 pressers — now drawn from the nearest formation slots rather than existing alone on an empty pitch.
- **Open-play tempo:** calm baseline (holding, moving, occasional passes); passing quickens and the cluster slides toward the dangerous edge as real pressure rises. Tempo on screen follows real match tension, always.
- **Honesty grammar:** the ball never crosses a zone boundary without a real cue (zone change, possession change, set piece, shot, goal, restart). Turnovers are staged as an interception — the possession change is a fact, the tackle is theater.
- **Goal choreography:** players celebrate immediately on `goal_pending` (like real players, before the referee confirms) — scoreline untouched; on confirmation the full takeover plays, figures run to a randomly chosen corner, then both teams reset to kickoff positions; on retraction the celebration cuts off and play resumes with a neutral restart (never an invented restart type).
- **Replay compression:** shorter ambient scenes get *fewer* passes, never faster ones — sped-up passing reads as fast-forward and breaks the illusion.
- **Complete-flow replay (revised 2026-07-16):** finished-match playback retains every source-derived scene in sequence—no ambient bucket sampling or highlight selection. Replay acceleration changes wall-clock duration only; it never removes a possession change, zone transition, or incident, and contains no fixture-specific script.
- **Gate protocol:** build first; Bibhu runs it on localhost and judges. Fallback unchanged: if it looks fake, the figure layer goes, ball motion + pitch stay, screen weight shifts to commentary.

## Board cleanup decisions (2026-07-15, after first live viewing)

- **Players never leave the pitch.** Stoppages (throw-in, free kick, card, VAR, substitution, retraction) freeze the formation in place under a compact badge/banner; when play resumes the players walk to their next arrangement, never teleport. Unrecognized set-piece types default to the quiet badge — only a recognized penalty may own the screen.
- **Cards are banners, not takeovers.** A small yellow/red card chip + team + name pill over the visible match. Detail belongs to the commentary layer.
- **No full-screen break cards.** Kickoff: both elevens walk into their lineup and settle. Half-time/full-time: both teams walk off to their touchline benches (home left, away right). A quiet pill labels the moment ("HALF TIME · 1-0") until the commentary lower-third takes over that job.
- **Zone chrome retired.** The "DANGER / ATTACKING / MIDFIELD / OWN THIRD" band labels and divider hairlines are gone — with 22 players and a ball, the match itself shows where the danger is. The semantic zones still drive all staging logic invisibly.
- **Turf is green.** Dark desaturated broadcast green with mowing stripes (`#0F2415`/`#15301C`); the black-shell rule now applies around the board, not to the grass.
- **Goal ends are color-coded, not labeled.** Each goal mouth is painted in its defending team's color (frame + translucent netting wash) instead of the "FRANCE GOAL" text.
- **Ad boards doubled** to 24px stadium-furniture scale; the pitch gives up the room on all edges.
- **Coming next (commentary phase):** a lower-third commentary overlay (bottom-left, reusing Match Pulse entries) carries the words for events; Game View proceeds with commentary as its narration layer.

## Constraints

- No new dependencies for the visual layers; code-native Views/Animated/Reanimated only (react-native-reanimated 4.5 is already in the project; no Lottie/media assets). Sound is deferred; when it returns, adding expo-audio plus bundled short audio files is pre-approved (verified 2026-07-15: no audio API exists in the project today).
- Reduce-motion: cluster and ball animation reduce to state changes; takeover information stays complete.
- Performance: the board must stay smooth on device; cluster is capped at ~5 figures.
- All pure decision logic unit-tested; visual layers behind the existing scene contract.
