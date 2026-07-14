# Deferred: Match Pulse event animation

**Status:** Deferred by product decision on 2026-07-13.

## Decision

Do not include event illustrations or animation in the current Match Pulse and Game View UI phase. Keep the existing commentary presentation and prioritize the compact score rail, mode transition, and Game View overlay.

The temporary watermarked goal MP4, `expo-video` runtime, playback component, and both UI placements have been removed.

## Preserved research

- The consistent reference family was Eklip Studio's [Soccer Animation Pack](https://iconscout.com/lottie-animation-pack/soccer-animation-pack_293070).
- Production Lottie JSON from that pack requires subscription access.
- The free goal MP4 had an opaque white canvas and a centered watermark. At 62–82 px the watermark was minor, but the white canvas and lack of recoloring/layer control were unsuitable for production.
- Creating an original, consistent GameCrew-owned event set was estimated at roughly 6/10 difficulty, with consistency across the full set being harder than individual card/whistle assets.

## Re-entry conditions

Reconsider this work only after:

1. the compact header and Game View commentary overlay are approved;
2. the team chooses licensed third-party assets or an original GameCrew-owned motion system;
3. source distribution and licensing are confirmed;
4. event selection remains grounded in structured backend categories rather than LLM prose.

No animation asset or runtime dependency should be added before those conditions are met.
