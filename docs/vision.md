# GameCrew Vision

GameCrew is a mobile-first live match companion for football fans watching with a phone in hand.

The product is not a generic scoreboard, news feed, fantasy app, or betting app. It is the place a fan opens during a match to choose a game, understand what is happening, follow the live pulse, and join the conversation around that match.

The simplest version of the idea:

**Pick a match. Follow the pulse. Talk with the room.**

## Product Thesis

Most fans already use a second screen while watching football. They check the score, scroll chat, look for key moments, and try to understand what changed in the match.

Those experiences are usually split across too many places:

- score apps show the facts but feel passive
- chats are social but unstructured
- feeds are noisy and detached from the live match
- betting products use the match as a market, not a fan experience

GameCrew should combine the useful parts without becoming any of those things.

It should feel like a match poster, a live timeline, and a watch party in one mobile flow.

## Current Experience Direction

GameCrew starts from the match, not from a dashboard.

The home screen is a large match carousel. Each match owns the screen visually through its teams or countries. The app shell stays black and white; the match brings the color.

When a user taps a match, they should not go through another lobby or decision step. They should land directly inside the match detail screen, with tabs:

1. **Match Pulse** - the default view
2. **Chat** - the watch-party conversation

This keeps the flow short:

1. Home: choose a match.
2. Match detail: follow the match pulse.
3. Chat tab: join the watch-party layer.

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
- Hosted

The home screen should not become a news dashboard. If we add supporting content, it should stay quiet and match-oriented, such as recent games or replayable games.

## Match Detail

The match detail screen is where the product begins.

It should keep the same visual language:

- compact match header
- team/country colors only in the header
- black and white content shell
- tabs for the main modes

The default tab is **Match Pulse**.

### Match Pulse

Match Pulse is the live factual layer.

It should show the match as a vertical timeline from kick-off to the current minute. The user should be able to scan what happened without reading a dense stats page.

Examples:

- `67m Corner - Portugal wins another corner from the left side.`
- `64m Pressure - Argentina keep the ball around the box.`
- `63m Yellow card - Argentina booked after stopping the break.`
- `58m Goal - Portugal equalise.`

This view is for the passive fan as much as the active fan. A user who does not care about watch parties should still get value here.

### Chat

Chat is the watch-party layer.

It should feel tied to the match, not like a generic group chat. Messages, reactions, and system moments should sit around the live game.

Users should be able to:

- read the room conversation
- send messages
- react quickly
- see system moments like confirmed goals, cards, corners, and phase changes

Chat is where private rooms, public hosted rooms, and creator-hosted rooms can grow later.

## Watch Parties

Watch parties are the social extension of the match detail screen.

There are two likely room types:

- **Private rooms** for friends
- **Hosted rooms** for streamers, communities, bars, campuses, or fan groups

The first product pass does not need complex room management. The important thing is that the app can show how a match becomes social without forcing every user to participate.

Passive user:

- opens the match
- reads Match Pulse
- maybe checks Chat

Engaged user:

- joins the room
- reacts
- makes calls
- climbs a match leaderboard

## Points And Calls

GameCrew can use match points as a gamification layer, but this should come after the core match detail experience feels right.

The current direction:

- every user gets a fixed number of points for a match
- points are used for quick match calls
- correct calls earn points
- wrong calls lose points
- leaderboards show who read the match best

Examples of calls:

- `Goal from this attack?`
- `Next corner: Portugal or Argentina?`
- `Card before half-time?`
- `Who controls the next five minutes?`
- `Will this pressure become a shot?`

This must not use betting language.

Avoid:

- bet
- wager
- stake
- odds boost
- payout
- cash out

Use:

- call
- points
- streak
- room leaderboard
- match receipt
- verified moment

## TxLINE Boundary

GameCrew should stay inside TxLINE's data boundary for the live product.

TxLINE can power:

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
- watch-party chat
- reactions
- match calls
- points
- room leaderboards
- replay mode
- demo-ready flow

We should avoid anything that depends on:

- match video
- official sports marks or unlicensed assets
- real-money betting
- editorial news unless a separate licensed/source-backed feed is added later

## First Version

The first version should focus on one polished mobile flow:

1. Open the home screen.
2. Swipe through live, upcoming, or replayable matches.
3. Tap a match poster.
4. Land directly on Match Pulse.
5. Switch to Chat.
6. See live/replay events drive the timeline and room context.

The MVP should not try to solve everything. It should prove that a live match can become a beautiful, responsive, social mobile experience.

## Demo Goal

The demo should make the product clear in the first minute.

Judges should see:

- a match-driven home screen
- team/country colors shaping the match poster
- a live or replayed match detail screen
- Match Pulse updating from TxLINE data
- Chat connected to match moments
- a clear explanation of how TxLINE powers the flow

Because live matches may not be active during judging, replay mode matters. Historical TxLINE data should let us replay a past match as if it is live.

The demo message:

**GameCrew turns TxLINE live football data into a mobile match companion fans would actually keep open during a game.**

## Long-Term Direction

If the first version works, GameCrew can grow into:

- private crew rooms
- public hosted watch parties
- creator-hosted match rooms
- bar and fan-zone leaderboards
- match points and call-based games
- replay challenges
- post-match receipts
- sponsored room prompts
- tournament-wide fan rankings

The long-term opportunity is not to own scores. It is to own the interactive layer around live football.
