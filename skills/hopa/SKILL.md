---
name: hopa
description: Orchestrate sibling hop terminals from the shell with the hopa CLI — create/read/write terminals, run commands, spawn and message other agents. Use when you need to interact with other terminal sessions on this machine and hopa is on PATH (hop MCP tools are the equivalent alternative).
---

# hopa — terminal orchestration for agents

`hopa` drives hop-managed terminals from the shell. It is the CLI twin of the
hop MCP tools (`hop_*` / `hopx_*`) — same capabilities, same daemon, pick
whichever is available. It contains **no admin verbs**: daemon lifecycle,
tunnels, users, and passwords belong to the human-facing `hop` CLI and are
not yours to operate.

Start with `hopa` (bare) — it prints a live overview of agent terminals.
`hopa help` lists every verb; `hopa tools` lists raw tool names and args.

## Core verbs

```bash
hopa term new build --cwd ~/proj        # create a terminal (returns t_... id)
hopa term ls                            # list terminals you can touch
hopa exec build -- npm test             # run a command, wait, get output + exit code
hopa send build 'some text'             # type + submit + wait for the reply
hopa term read build --mode ui          # read the screen (raw | ui | readable_raw)
hopa term key build ctrl+c              # send a key (enter, up, ctrl+c, ...)
hopa term close build --killSession
```

Terminals are addressed by name or `t_...` id — names resolve automatically.

## Working with other agents

```bash
hopa spawn helper --agent claude --task "run the test suite and summarize"
hopa turn helper "now fix the failures"   # verified submit + wait for its turn to end
hopa wait-any helper build                # block until whichever finishes first
hopa trajectory helper                    # read a claude session's conversation
hopa ledger                               # cross-agent task ledger
```

`hopa turn` / `hopa send` know when a Claude Code turn is really finished
(Stop-hook signal when installed, quiet-screen heuristic otherwise) — prefer
them over polling `term read` in a loop.

`hopa spawn --task` waits for its automatic completion contract. Do not use
async waits or `wait_id` continuations through `hopa`: each CLI invocation is a
new process. Use a long-lived Hop MCP connection for async fleets. A worker task
succeeds only when its completion contract is satisfied and its result has been
collected.

The built-in Claude worker is autonomous by default so delegated work cannot
park on an approval prompt. Use `--permission-mode manual` (or another Claude
permission mode) when a restricted worker is intentional.

Use the built-in agent presets for standard workers. Treat a custom launch
command as an explicit exception that must handle its own authentication and
startup gates.

## Permissions

User-owned sessions are blocked by default (`agentPermitted: false`). Do not
try to work around a permission error — ask the human to run
`hop session permit <name>` (or `hopa permit <name>` if you are authorized).
Terminals you create with `hopa term new` / `hopa spawn` are yours.

## Contract

- Exit codes: 0 ok, 1 error (inspect the JSON payload), 2 usage, 124 timeout.
- Output is JSON on stdout; debug goes to stderr only with `HOP_DEBUG=1`.
- Flags map to tool args in any spelling: `--until-regex`, `--uiMaxLines`.
- Long waits: pass `--max-wait-ms`, and `--cli-timeout <ms>` as a hard stop.
- Each `hopa` call is its own process, so async wait jobs and `wait_id`
  continuations are rejected. Use blocking waits or a long-lived Hop MCP
  connection. Read cursors are best-effort across calls; prefer
  `--start-from latest|beginning`.
