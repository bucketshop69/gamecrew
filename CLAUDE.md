# CLAUDE.md

## Sub-agent policy

When spawning sub-agents (the Agent tool):

- Use **Sonnet 5** (`model: "sonnet"`) with **medium** reasoning effort.
- Spawn **at most 3 sub-agents at a time**. If more work is queued, run in batches of 3 and wait for a batch to finish before starting the next.

## Time estimation

Do not estimate how long work will take. No time estimates, no effort-in-hours/days, no "this should take about X" — skip time and effort estimation entirely and just focus on the work itself.
