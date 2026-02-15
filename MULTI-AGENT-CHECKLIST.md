# Multi-Agent Run Checklist

## Goal
Ensure concurrent agent sessions stay isolated, time-bounded, and recoverable.

## Safety Gates

- [ ] **Isolated terminals** — assign each agent its own PTY via `hop_create_terminal`; never share a session between agents.
- [ ] **Destructive-command approval** — gate every `rm -rf`, force-push, or `DROP TABLE` behind explicit user confirmation, regardless of autonomy level.
- [ ] **Per-command timeouts** — enforce `idle_ms` and `max_wait_ms` on every `hop_wait_terminal` call; escalate or kill on deadline breach.

## Execution Loop

1. **Create session** — one `hop_create_terminal` per agent.
2. **Validate prompt** — call `hop_wait_terminal(until_prompt=true)` to confirm the shell is ready before sending any command.
3. **Send command** — write via `hop_write_terminal`; never blind-write into mid-execution output.
4. **Await result** — use `until_regex` or `until_prompt` with `max_wait_ms` to capture output and detect completion.
5. **Assert state** — verify exit code / expected output before proceeding.
6. **Repeat** steps 2–5 for each command in the plan.

## Recovery

| Step | Action |
|------|--------|
| 1 | Send `ctrl_c` via `hop_send_key` |
| 2 | If unresponsive after 5 s → `hop_close_terminal(killSession=true)` |
| 3 | On orchestrator crash → kill **all** child terminals (kill switch) |
| 4 | Verify zero orphaned processes before declaring shutdown complete |

**Rule:** Never skip escalation. Always tear down — never leave orphaned sessions.
