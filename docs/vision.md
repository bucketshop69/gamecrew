# GameCrew Vision

GameCrew is a mobile-first live match companion for football fans watching with a phone in hand.

The product is not a generic scoreboard, news feed, fantasy app, or real-money betting app. It is the place a fan opens during a match to choose a game, understand what is happening, watch the play unfold, and mess around with friends and the crowd while it happens.

The simplest version of the idea:

**Pick a match. Follow the pulse. Watch the play. Bet your Lambo (playfully).**

## Product Thesis

Most fans already use a second screen while watching football. They check the score, scroll chat, look for key moments, and try to understand what changed in the match.

Those experiences are usually split across too many places:

- score apps show the facts but feel passive
- chats are social but unstructured
- feeds are noisy and detached from the live match
- betting products use the match as a market, not a fan experience

GameCrew combines the useful parts without becoming any of those things.

It should feel like a match poster, a live timeline, a stylized broadcast, and a rowdy group of friends in one mobile flow.

## Confirmed Feature Set

This is the committed scope for the current push (TxODDS World Cup hackathon, targeting first place). Everything below is confirmed direction, not exploration:

1. **Match Pulse** — grounded live commentary timeline (built, wired to real API).
2. **Game View** — top-down animated visualization of the play. Currently a scripted demo built for the video submission; the confirmed work is driving it from the backend semantic frames.
3. **Global Game Chat** — one global chat per match. Everyone watching that game is in the same room. No private rooms for now.
4. **Playful Asset Bets** — the way friends bet: "I'm betting my house", "my Lambo", "my bike". Users receive playful assets as gifts for joining/watching games, and stake them on match moments against the room. Assets live and circulate inside GameCrew only — no real money, no cash value. Implemented the Solana way: assets can be small NFTs / on-chain tokens, which is the product's crypto layer.
5. **Coolness Points** — GameCrew's score for a user. You earn coolness, you show off coolness. It is deliberately playful, not a currency.
6. **Leaderboard** — some form of ranking built on coolness points / winning playful bets.
7. **Banger landing screen** — the current marketing site was a rushed overnight build; it needs to become a genuinely strong landing page.
8. **Solana dApp Store submission** — the app gets submitted to the Solana dApp Store for credibility and distribution.

The MVP core is **Game View + Global Chat + Playful Bets working together in one match screen**.

## Current Experience Direction

GameCrew starts from the match, not from a dashboard.

The home screen is a large match carousel. Each match owns the screen visually through its teams or countries. The app shell stays black and white; the match brings the color.

When a user taps a match, they land directly inside the match detail screen — no lobby, no extra decision step — with modes:

1. **Match Pulse** — the default view, the factual live timeline
2. **Game View** — the animated top-down look at the play
3. **Global Chat** — the room for that game, where playful bets happen

This keeps the flow short:

1. Home: choose a match.
2. Match detail: follow the pulse, watch the play.
3. Chat: talk with the room and throw down a playful bet.

## Visual Direction

GameCrew should be almost colorless until a match starts.

The app shell:

- black background
- white typography
- gray dividers and quiet panels
- no invented brand palette
- no decorative dashboard colors

The match layer:

- country or team colors
- flag-inspired fields
- subtle glow around flags or team identity
- strong score/time typography
- match-specific atmosphere

This keeps the product from feeling generic. The color should come from the football context, not from abstract token names.

The rule:

**GameCrew is black and white. The match brings the color.**

## Home Screen

The home screen is for choosing a match.

The primary surface is a large match poster, taking most of the screen. It should not feel like a bordered UI card. It should feel embedded into the black background.

For a live match, the poster can show:

- home team or country flag
- score
- live minute
- competition or round
- away team or country flag

Below the match poster, the user can switch between simple filters:

- Live
- Upcoming
- Replay

The home screen should not become a news dashboard. If we add supporting content, it should stay quiet and match-oriented, such as recent games or replayable games.

## Match Detail

The match detail screen is where the product begins.

It should keep the same visual language:

- compact match header
- team/country colors only in the header
- black and white content shell
- tabs/modes for Match Pulse, Game View, and Global Chat

### Match Pulse

Match Pulse is the live factual layer.

It shows the match as a vertical timeline from kick-off to the current minute. The user should be able to scan what happened without reading a dense stats page.

Examples:

- `67m Corner - Portugal wins another corner from the left side.`
- `64m Pressure - Argentina keep the ball around the box.`
- `63m Yellow card - Argentina booked after stopping the break.`
- `58m Goal - Portugal equalise.`

This view is for the passive fan as much as the active fan. A user who does not care about chat or bets still gets value here.

### Game View

Game View is the visual layer: a stylized top-down animation of the play — players, ball, movement — built from the same TxLINE-grounded semantic frames that power Match Pulse.

The first version was hand-scripted as a demo for the hackathon video submission. The confirmed direction is that Game View consumes the backend's semantic frames so what the user sees is the real match, illustrated — not choreography.

Game View is the wow-moment of the product and part of the MVP core.

### Global Chat

Global Chat is the social layer: one shared room per game.

Everyone watching a match is in the same conversation. It should feel tied to the match, not like a generic group chat — messages, reactions, and system moments (goals, cards, phase changes) sit around the live game.

Global Chat is also where playful bets surface: challenges thrown to the room, assets on the line, results settled by real match events.

Private rooms, hosted rooms, and creator rooms are explicitly **not** in scope right now. Global chat per game is the model.

## Playful Asset Bets

This is GameCrew's take on how friends actually bet: nobody hands over money, they bet their house, their Lambo, their bike, their dignity.

The direction:

- users receive **playful assets** as gifts — for joining a game, for showing up, for moments ("we're sending you a gift")
- assets are things like a house, a Lambo, a car, a bike — fun, recognizable, braggable
- users stake these assets on match moments against the room ("I'm betting my Lambo there's a goal from this attack")
- winning grows your garage; losing means the room saw you lose your Lambo
- assets exist and circulate **inside GameCrew only** — no real money, no cash-out, no fiat value
- implemented the Solana way: assets can be minted as small NFTs / on-chain tokens, giving them real ownership and giving GameCrew its on-chain layer

The line we hold:

- **playful stakes, real match outcomes, zero real money**
- betting *language* is fine here because the stakes are toys — what is banned is real-money mechanics: deposits, cash-out, odds pricing, payouts

## Coolness Points And Leaderboard

Coolness is GameCrew's status metric.

- users earn **coolness points** through activity: watching, chatting, winning playful bets, reading the match right
- coolness is for showing off, not for spending — it is a flex, not a wallet
- a **leaderboard** ranks users by coolness (per match, and some broader form — exact shape TBD)

The tone stays playful. Coolness points should never feel like a financial balance.

## TxLINE Boundary

GameCrew stays inside TxLINE's data boundary for the live product.

TxLINE powers:

- fixture discovery
- live and upcoming matches
- live scores
- match phase and clock
- goals, cards, corners, substitutions, penalties, VAR-style moments where available
- live score streams or update polling
- historical score replay
- selected stat validation and verification
- odds movement as contextual match signal, not as a betting product

GameCrew adds the consumer layer:

- mobile-first match selection
- match pulse timeline
- game view animation
- global game chat
- playful asset bets settled by real match events
- coolness points and leaderboards
- replay mode
- demo-ready flow

We avoid anything that depends on:

- match video
- official sports marks or unlicensed assets
- real-money betting
- editorial news unless a separate licensed/source-backed feed is added later

## Solana Layer

GameCrew's crypto angle is deliberately light and native to the product:

- playful assets as small NFTs / on-chain tokens, owned by the user, circulating only within GameCrew
- submission to the **Solana dApp Store** as the distribution and credibility channel

Crypto serves the fan experience, not the other way around. No token speculation, no real-money rails.

## Hackathon Goal

GameCrew is being built for the TxODDS World Cup hackathon (Consumer and Fan Experiences track), and the target is **first place** — not second, not third.

The demo should make the product clear in the first minute. Judges should see:

- a match-driven home screen with team/country colors shaping the poster
- Match Pulse updating from real TxLINE data
- Game View animating the actual play from backend semantic frames
- Global Chat with playful bets happening around match moments
- coolness and leaderboard giving the room stakes
- a clear explanation of how TxLINE powers the whole flow

Because live matches may not be active during judging, replay mode matters. Historical TxLINE data lets us replay a past match as if it is live — that is the reliable demo path.

The demo message:

**GameCrew turns TxLINE live football data into a mobile match companion fans would actually keep open during a game — and lets them bet their Lambo on it, playfully.**

## Long-Term Direction

If this version works, GameCrew can grow into:

- private crew rooms and hosted watch parties (creators, bars, campuses, fan groups)
- richer playful-asset economy and gifting
- replay challenges
- post-match receipts
- sponsored room prompts
- tournament-wide fan rankings
- voice narration and richer Game View presentation

The long-term opportunity is not to own scores. It is to own the interactive layer around live football.
