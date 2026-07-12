# Match Pulse VPS + SQLite Architecture

Match Pulse V1 runs on a GameCrew-controlled VPS. TxLINE remains the source of match facts, while the GameCrew server persists raw source evidence, canonical match state, semantic frames, and the saved commentary feed in SQLite. Match Pulse and the probable game simulation consume the same shared match engine. Clients read GameCrew-owned projections through the API; they do not process TxLINE directly.

```mermaid
flowchart TD
  subgraph External["External Services"]
    TX["TxLINE API"]
    LLM["MiniMax M3"]
  end

  subgraph VPS["GameCrew VPS"]
    Caddy["Caddy / HTTPS Reverse Proxy"]
    API["GameCrew API<br/>Hono + TypeScript"]
    Worker["Fixture Ingestion<br/>SSE + recovery"]
    Engine["Shared Match Engine<br/>canonical state + semantic frames"]
    Commentary["Match Pulse Consumer"]
    Simulation["Probable Simulation Consumer"]
    DB[("SQLite DB<br/>evidence + projections")]
    Docs["Developer Docs<br/>static Starlight site"]
  end

  subgraph Clients["Clients"]
    Mobile["Expo Mobile App"]
    WebDocs["Developers / Docs Users"]
  end

  Mobile -->|GET saved feed| Caddy
  WebDocs -->|read docs| Caddy

  Caddy -->|api.gamecrew.app| API
  Caddy -->|docs.gamecrew.app| Docs

  Worker -->|stream, history, snapshot, recovery| TX
  Worker -->|append raw evidence| DB
  Worker --> Engine
  Engine -->|checkpoint + frames| DB
  Engine --> Commentary
  Engine --> Simulation
  Commentary -->|grounded fallback context| LLM
  LLM -->|presentation-only enrichment| Commentary
  Commentary -->|save same entry| DB

  API -->|read matches/feed| DB
  API -->|optional direct TxLINE debug/admin| TX
```

Core ownership rule:

```text
TxLINE is the source of external match facts.
SQLite is GameCrew's durable source of evidence and product projections.
The shared match engine interprets each source event once for both consumers.
The LLM may improve presentation but never changes match truth.
The client never processes TxLINE.
The client only reads saved state, frames, and commentary from the API.
```

Live match flow:

```mermaid
sequenceDiagram
  participant TX as TxLINE
  participant W as Match Pulse Worker
  participant DB as SQLite
  participant LLM as MiniMax M3
  participant API as GameCrew API
  participant App as Mobile App

  W->>TX: Stream fixture with history/recovery fallback
  TX-->>W: Source updates
  W->>DB: Append durable raw evidence
  W->>W: Replay shared match engine
  W->>DB: Commit canonical state + semantic frames
  W->>DB: Insert grounded fallback commentary
  W->>LLM: Enrich presentation from saved facts
  LLM-->>W: Natural commentary
  W->>DB: Update same commentary row
  App->>API: Fetch match feed
  API->>DB: Read saved entries
  DB-->>API: Persisted commentary feed
  API-->>App: Match Pulse entries
```

Persistence direction:

```text
File store today = proof
SQLite store next = V1 production
Postgres/Supabase later = scale-up option
```

Recovery and finalisation rules:

```text
A snapshot baseline is temporary recovery state when GameCrew starts late.
If complete history from Seq 0 becomes available, the engine replaces the
baseline and rebuilds the fixture from the full timeline.

After game_finalised, ingestion remains open for a bounded correction window
(15 minutes by default, configured by TXLINE_FINALISATION_CORRECTION_MS).
Corrections inside that window are persisted and projected. Any correction that
rewrites earlier projection history advances the generation; consumers reset
their prior generation before applying that corrected replay.
```

Runtime note:

```text
The current SQLite implementation uses Node's built-in node:sqlite module.
Run the VPS API/worker on Node 24 or newer, and expect an experimental warning
until Node marks this module stable. If that becomes unacceptable, replace the
driver behind the same store interface with a stable SQLite package.
```
