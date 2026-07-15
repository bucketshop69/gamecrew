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
| R1 | Pitch upgrade: broadcast-dark turf, chalk lines (boxes, arcs, spots, goal mouths), zone chrome integrated, and stadium-style perimeter ad boards (slot component, GameCrew wordmark placeholder — C3's perimeter slot pulled forward) | In progress |
| R2 | Player characters: stylized silhouettes, team colors, pose set (run, strike, keeper, celebrate), dev-only gallery for taste review | In progress |
| R3 | Taste checkpoint: screenshots reviewed by product before wiring | Planned |
| R4 | Action cluster + ball motion: 3-5 silhouettes + traveling ball driven by director scenes (passes, shots at goal, corners swung in, celebrations) | Planned |
| R5 | Sound: ~20% presence foley — kick thuds, referee whistle (cards/VAR/phase), goal crowd lift, optional faint crowd bed | Planned |
| R6 | Integrated judgment vs the gate; keep, tune, or reduce weightage | Planned |

## Constraints

- No new dependencies; code-native Views/Animated only (no Lottie/media assets except bundled short audio files for R5 if the expo-av/audio API already available in the project supports them — verify before adding anything).
- Reduce-motion: cluster and ball animation reduce to state changes; takeover information stays complete.
- Performance: the board must stay smooth on device; cluster is capped at ~5 figures.
- All pure decision logic unit-tested; visual layers behind the existing scene contract.
