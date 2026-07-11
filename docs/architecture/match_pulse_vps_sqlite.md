# Match Pulse VPS + SQLite Architecture

Match Pulse V1 runs on a GameCrew-controlled VPS. TxLINE remains the source of match facts, while the GameCrew server persists the saved commentary feed in SQLite. Clients read the saved feed through the API; they do not process TxLINE directly.

```mermaid
flowchart TD
  subgraph External["External Services"]
    TX["TxLINE API"]
    LLM["MiniMax M3"]
  end

  subgraph VPS["GameCrew VPS"]
    Caddy["Caddy / HTTPS Reverse Proxy"]
    API["GameCrew API<br/>Hono + TypeScript"]
    Worker["Match Pulse Worker<br/>polls live/replay fixtures"]
    DB[("SQLite DB<br/>source of truth")]
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

  Worker -->|poll confirmed updates| TX
  Worker -->|save fallback entries| DB
  Worker -->|send saved entry context| LLM
  LLM -->|enriched commentary| Worker
  Worker -->|update same entry| DB

  API -->|read matches/feed| DB
  API -->|optional direct TxLINE debug/admin| TX
```

Core ownership rule:

```text
TxLINE is the source of match facts.
SQLite is GameCrew's source of truth for the saved Match Pulse feed.
The client never processes TxLINE.
The client only reads saved commentary from the API.
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

  W->>TX: Poll fixture updates
  TX-->>W: Confirmed updates only
  W->>DB: Insert source update + fallback commentary
  W->>LLM: Enrich fallback commentary
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

Runtime note:

```text
The current SQLite implementation uses Node's built-in node:sqlite module.
Run the VPS API/worker on Node 24 or newer, and expect an experimental warning
until Node marks this module stable. If that becomes unacceptable, replace the
driver behind the same store interface with a stable SQLite package.
```
