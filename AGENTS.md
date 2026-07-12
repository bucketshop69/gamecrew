# GameCrew Agent Guidance

## Product direction

- Build one shared, source-grounded football match-intelligence backend.
- Match Pulse commentary and the probable stick-player simulation must consume the same canonical match state and semantic frames.
- TxLINE owns external match facts. SQLite owns GameCrew's durable evidence and projections.
- The LLM may improve presentation, but it must not invent or alter match truth.
- Clients consume GameCrew APIs and must not interpret TxLINE directly.

## Parent-orchestrated workflow

- Keep the main agent responsible for product context, decisions, planning, integration, and the final response to the user.
- Use sub-agents for concrete, independent, bounded work that benefits from parallelism, such as focused implementation, dataset inspection, test analysis, or read-only review.
- Do not create separate user-owned Codex tasks for internal delegation. Spawn sub-agent threads beneath the current task and consolidate their results in the main thread.
- Before delegation, give every sub-agent exact scope, allowed files, expected tests, and whether it may edit. Avoid overlapping write ownership.
- Prefer no more than three simultaneous sub-agents so the main agent retains one coordination slot.
- Sub-agents should return concise findings and verification summaries instead of large logs. The main agent must inspect important diffs and remains accountable for the integrated result.
- Use follow-up audits after integration when changes cross subsystem boundaries. Read-only reviewers must not modify files.

## Collaboration with the user

- Work in explicit phases. Brief the user in plain language before starting a new phase and provide a concise handoff after completion.
- Keep the user informed of product decisions, architecture changes, blockers, and review findings without requiring them to coordinate sub-agents.
- Do not silently broaden scope. Stop for direction when a decision materially changes product behavior.

## Quality and token discipline

- Add focused regression tests for reported defects before or alongside fixes.
- During implementation, run targeted tests and suppress routine successful output. Run full package tests, workspace typechecks, and the fixture smoke check once at the acceptance gate.
- Do not repeatedly reread or print the complete 886-record fixture unless the dataset itself is under investigation.
- Preserve existing user changes and keep unrelated edits out of the phase.
- A passing test suite is necessary but does not replace semantic review of recovery, correction, and consumer-consistency behavior.

## Current acceptance commands

```bash
pnpm --filter @gamecrew/core test
pnpm --filter @gamecrew/api test
pnpm typecheck
pnpm --filter @gamecrew/api ingestion:smoke -- 18179759
pnpm --filter @gamecrew/api commentary:smoke -- 18179759
git diff --check
```

The project-scoped Codex configuration pins the main task and inherited sub-agents to GPT-5.6 Luna with high reasoning. Use a different model or effort only when the user explicitly requests it.
