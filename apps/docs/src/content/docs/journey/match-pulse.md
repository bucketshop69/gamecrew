---
title: Match Pulse — follow the story
description: A live commentary timeline that reads like a broadcaster, grounded in real match events.
sidebar:
  label: Match Pulse
---

Match Pulse is the default tab when you open a match. It answers, within
seconds:

> **What is happening in this match right now?**

![Match Pulse at full time — commentary entries with match clocks, a goal entry, and the checkpoint strip along the bottom](/screens/match-pulse.png)

## Commentary, not a log

Raw match events read like a debug view. Match Pulse turns them into a
**commentary stream** — short entries that read like a broadcaster, produced
from small batches of real match events:

- **goals, shots, corners, cards** land as clear, confirmed moments
- **momentum and pressure** entries tell you who is pushing between the big
  events
- every entry carries the score at that moment, the match clock, and a link
  back to the source events that produced it

Looked away for ten minutes? Scroll the pulse and you're caught up.

## Grounded, always

Every commentary entry is generated from **real TxLINE match events** — never
invented. Each entry keeps its source references, so anything the timeline
says can be traced back to the data that caused it. If enrichment isn't
available, a grounded fallback line renders instead — the timeline never
blocks on AI.

## It talks, too

Commentary entries carry voice lines. With voice enabled, Match Pulse becomes
**radio commentary for your match** — generated offline per entry and played
in sync as the match unfolds. The same pulse powers the captions in
[Game View](/journey/game-view/), so what you see and what you hear agree.

## For the curious

The whole pipeline behind the pulse — TxLINE events, LLM enrichment, Grok
voice — is explained in [From TxLINE to your phone](/how-it-works/pipeline/).
