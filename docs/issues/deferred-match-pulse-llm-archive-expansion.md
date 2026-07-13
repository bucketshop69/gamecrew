# Deferred: expand the Match Pulse LLM archive

## Status

Deferred until after the hackathon demo. The current two-match archive is enough for the demo.

## What is ready now

Both curated fixtures are stored in the same SQLite database and are available as replayable matches:

- `18179759` — Mexico 2–0 Ecuador: 139 commentary beats, 85 LLM-enriched, 54 grounded fallbacks, 0 pending.
- `18209181` — France 2–0 Morocco: 130 commentary beats, 84 LLM-enriched, 46 grounded fallbacks, 0 pending.

Database: `apps/api/.data/match-ingestion-18179759.sqlite`

The database filename is historical; it contains records for multiple fixtures keyed by `fixture_id`.

## Deferred work

1. Select the remaining recent historical fixtures we want users to revisit, targeting roughly 10–12 curated matches.
2. Materialize those fixtures through the operator-only archive command.
3. Review representative routine, pressure, goal, card, and final-whistle commentary in the UI before accepting each batch.
4. Keep rejected LLM output on the deterministic source-grounded fallback.
5. Add automatic live-fixture discovery and processing separately; client requests must never trigger LLM generation.
6. Rename the shared SQLite file to a fixture-neutral name before VPS deployment.

## Operator command

```bash
pnpm --filter @gamecrew/api commentary:materialize -- <fixture-id> \
  --database="$PWD/apps/api/.data/match-ingestion-18179759.sqlite"
```

Use explicit fixture IDs. A fixture already published with the same model, prompt bundle, projection generation, and revision must be skipped without provider calls.

## Guardrails

- TxLINE remains the source of match truth.
- All fixtures share the canonical ingestion, semantic-frame, and commentary pipeline.
- LLM output may improve presentation but cannot change teams, players, actions, score, clock, or match lifecycle.
- Historical team names must come from the dated fixture snapshot or grounded lineup metadata; synthetic `Participant ####` labels must not be published.
- A fixture remains hidden while its materialization status is `running`, `prepared`, or `failed`.
- Only `ready` and `ready_with_fallback` fixtures are exposed to clients.
- Provider usage, prompt/model provenance, and materialization ownership remain durable across restarts.

## Acceptance criteria for resuming this issue

- Every selected fixture has complete historical ingestion and an aligned finalised projection.
- Every commentary entry is settled with zero `pending` entries.
- Team names and home/away orientation are verified before enrichment.
- A rerun produces zero provider calls for unchanged completed fixtures.
- Representative saved lines are reviewed in the client UI.
- Core tests, API tests, workspace typecheck, ingestion smoke, commentary smoke, and `git diff --check` pass.

## Immediate next step

Move forward with Match Pulse UI validation and refinement using the two completed demo fixtures. Game simulation and bulk archive expansion remain later phases.
