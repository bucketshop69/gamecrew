# PRD: Home Screen

## Status

Draft

## Objective

Create the first GameCrew screen: a mobile match-selection experience where a fan can quickly choose a live, upcoming, replayable, or hosted match.

The home screen should make the match feel like the product. It should not feel like a sports dashboard, news feed, or generic list of fixtures.

## User Job

When a user opens GameCrew, they are trying to answer:

> Which match do I want to follow right now?

Secondary jobs:

- see what is live
- see what is coming next
- find replayable matches
- find hosted match rooms later

## Entry Point

The home screen is the default app entry after launch.

For the first version, assume the user lands here after any required app boot/auth/loading step. Wallet and TxLINE activation flows are not part of this screen PRD.

## Primary Actions

The user can:

- swipe through match posters
- switch between match filters
- tap a match poster to open Match Detail

The default tap target is the full active match poster.

## Screen Structure

### Header

The header should be quiet and minimal:

- centered `GameCrew` wordmark
- account/avatar control on the right
- optional small section label such as `Live Matches`

Do not add bottom navigation for the first version.

### Match Poster Carousel

The main surface is a large match poster that takes most of the screen.

The poster should show:

- home team or country flag
- score if live
- start time if upcoming
- replay status if finished/replayable
- match phase or minute if live
- competition or round
- away team or country flag

The poster should feel embedded into the black app background, not like a bordered card.

### Filters

Below the poster, show simple filter tabs:

- `Live`
- `Upcoming`
- `Replay`
- `Hosted`

The selected filter changes which matches appear in the carousel.

### Supporting Strip

Below the filters, show a quiet supporting strip only if useful.

Initial direction:

- recent games
- replayable games
- hosted rooms later

This strip must not become a news feed.

## Content And Data

### TxLINE Data

The home screen should be designed around TxLINE-shaped data.

Expected data needs:

- fixture id
- home team / country
- away team / country
- competition
- match start time
- match phase
- score
- live minute or clock
- status: live, upcoming, finished, replayable
- replay availability if known

Likely TxLINE sources:

- fixtures snapshot for match discovery
- score snapshot for live state
- historical score availability for replay mode

### Sample Data

Until the backend is integrated, use TxLINE-shaped sample data.

Sample match states should include:

- live match with score and minute
- upcoming match with start time
- finished match with replay available
- hosted match placeholder

## Visual Rules

The GameCrew shell is black and white.

Use:

- black background
- white text
- gray dividers
- quiet panels only when needed
- team or country colors from the match
- flag-inspired visual fields
- subtle glow around flags or match identity

Avoid:

- invented app color names
- decorative gradients unrelated to teams
- bordered sports cards
- dense scoreboard tables
- generic dashboard sections
- fake news modules
- betting-style CTAs

Core rule:

**GameCrew is black and white. The match brings the color.**

## Navigation

Tapping the active match poster opens Match Detail directly.

The user should not pass through an intermediate match lobby.

Expected flow:

```text
Home Screen
  -> tap match poster
Match Detail
  -> default tab: Match Pulse
```

## States

### Live

Show:

- score
- live minute or phase
- competition
- team/country flags

Example:

- Portugal vs Argentina
- `1 - 1`
- `Live 67'`
- `World Cup Group Stage`

### Upcoming

Show:

- scheduled start time
- competition
- team/country flags

Do not show an empty score.

### Replay

Show:

- final score
- replay availability
- competition
- team/country flags

### Hosted

Hosted is a filter placeholder for now.

It may later show matches with public or creator-hosted rooms. For the first implementation, it can reuse the match poster format and show room availability if sample data exists.

### Loading

Show a black shell with a minimal skeleton or placeholder poster.

Avoid busy spinners unless needed.

### Empty

If a filter has no matches, show a simple empty state:

> No matches here yet.

Offer another filter, not a full onboarding explanation.

### Error

If match data fails, show:

> Could not load matches.

Allow retry.

Do not expose raw TxLINE or network errors to the user.

## Out Of Scope

This PRD does not include:

- Match Detail
- Match Pulse timeline
- Chat
- watch-party room creation
- match points
- calls/prompts
- leaderboard
- wallet connection
- TxLINE subscription activation
- notifications
- user profiles
- real team logos or licensed assets
- editorial news
- real-money betting features

## Acceptance Criteria

- The home screen shows a large match poster as the primary visual surface.
- The screen works on a mobile viewport without bottom navigation.
- The active match poster can represent live, upcoming, and replayable states.
- The user can switch between `Live`, `Upcoming`, `Replay`, and `Hosted` filters.
- Tapping the active match poster is the primary path to Match Detail.
- No intermediate match lobby is introduced.
- The design uses black/white app shell and match-specific colors only.
- The screen does not use betting language.
- The screen does not include a news feed.
- The design can be implemented with TxLINE-shaped fixture and score data.

## Open Questions

- Should the carousel show one full poster at a time or partial next/previous peeks?
- Should the supporting strip show recent games, replayable games, or hosted rooms first?
- How should upcoming matches display time across time zones?
- What is the minimum data required before showing a match poster?
- How much of hosted-room availability should appear on home versus inside Match Detail?
