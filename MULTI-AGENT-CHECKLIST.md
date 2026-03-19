# Multi-Agent Run Checklist

## Goal
Ensure concurrent agent sessions stay isolated, time-bounded, and recoverable.

## Safety Gates

- [ ] **Isolated terminals** — assign each agent its own PTY via `hop_create_terminal`; never share a session between agents.
- [ ] **Destructive-command approval** — gate every `rm -rf`, force-push, or `DROP TABLE` behind explicit user confirmation, regardless of autonomy level.
- [ ] **Per-command timeouts** — enforce `idle_ms` and `max_wait_ms` on every `hop_wait_terminal` call; escalate or kill on deadline breach.

## Execution Loop

1. **Create session** — one `hop_create_terminal` per agent.
2. **Validate prompt** — use `hop_wait_terminal(until_prompt=true, start_from="latest")` before the first command.
3. **Preferred turn helper** — use `hopx_agent_turn` or `hopx_send_and_wait` for normal multi-turn work.
4. **Manual fallback** — drop to `hop_write_terminal` + `hop_wait_terminal` only when you need custom wait conditions or lower-level control.
5. **Assert state** — verify expected output before continuing.
6. **Repeat** the loop; never write into a terminal that is still busy.

Recommended defaults:

- `capture="readable_raw"`
- `start_from="latest"` for prompt waits, `start_from="cursor"` for deltas
- explicit `max_wait_ms`
- explicit `idle_ms` when using raw wait conditions

## Recovery

| Step | Action |
|------|--------|
| 1 | Send `ctrl_c` via `hop_send_key` or `control="interrupt"` via `hopx_agent_turn` |
| 2 | If still running, continue waiting or poll an async wait job instead of blind-resending |
| 3 | If unresponsive after deadline, `hop_close_terminal(killSession=true)` |
| 4 | On orchestrator crash, close all child terminals and verify there are no orphaned sessions |

**Rule:** Never skip escalation. Always tear down — never leave orphaned sessions.
