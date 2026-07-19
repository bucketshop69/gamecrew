---
title: From TxLINE to your phone
description: The GameCrew pipeline — TxLINE live data, a match engine, LLM-enriched commentary, Grok voice, and a playful Solana economy.
---

Everything you see in GameCrew is the end of a pipeline that starts with real
match data. The full code is open source, so this page stays at the "how does
it actually work?" altitude — no internals required.

## 1. TxLINE is the source of truth

GameCrew consumes three things from the **TxLINE API**:

| Endpoint | What it gives us |
| --- | --- |
| `/auth/guest/start` | A guest session to talk to the feed |
| `/api/fixtures/snapshot` | The fixture list — this powers the home screen carousel |
| `/api/scores/stream` | The live per-match event stream — goals, cards, VAR, set pieces, pressure |

No scraping, no invented data. If TxLINE didn't say it, GameCrew doesn't show
it.

## 2. The engine turns events into semantic frames

Our ingestion engine listens to the live stream and projects it into
**semantic frames** — a running, replayable description of the match:
possession, zone, pressure, set pieces, shots, goals, VAR states.

These frames are what [Game View](/journey/game-view/) animates, and they're
why the board can honestly claim that every visible state change traces back
to a real match fact. They're also stored, which is how a finished match
replays exactly like it ran live.

## 3. An LLM writes the commentary

Raw events read like a log. To get the broadcaster voice in
[Match Pulse](/journey/match-pulse/), the engine batches each minute's events
and hands them to an **LLM** (served over an OpenAI-compatible endpoint),
which writes the commentary entries — grounded strictly in the events it was
given, with source references kept on every entry.

Enrichment runs **offline, behind the timeline**: if the LLM is slow or
unavailable, a grounded fallback line renders instead. The pulse never blocks
on AI.

## 4. Grok gives it a voice

Each commentary entry also gets a spoken line, generated through the
**xAI (Grok) voice API** and stored as pre-rendered audio. The app plays
these clips in sync with the match — that's the radio-commentary voice mode
in Game View, and it's why what you hear always matches what you read.

## 5. The real match settles the economy

The [Playful Economy](/journey/playful-economy/) runs on the same event
stream: calls settle only on confirmed events, VAR retractions void them, and
the Gift Pool splits at the full-time frame. Trophies you claim are minted as
**Metaplex Core NFTs on Solana devnet** — see
[The Solana Layer](/how-it-works/solana-layer/).

---

Want to go deeper? The full source is open on
[GitHub](https://github.com/bucketshop69/gamecrew).
