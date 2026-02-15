# Agent Team Runbook (Safe Mode)

This runbook is for multi-agent experiments where you want explicit rollback and interrupt controls.

## Goals

- Isolate team runs from your main branch.
- Be able to stop all workers quickly.
- Recover from bad runs without destructive resets.

## Commands

Use the control script:

```bash
npm run agent-team -- <command>
```

Supported commands:

- `start [name] [--allow-dirty]`
- `status`
- `interrupt <terminal-id> [terminal-id ...]`
- `rollback [run-id] [--allow-dirty] [--drop-branch]`

## 1) Start a safe run

```bash
npm run agent-team -- start lease-failover
```

What it does:

- creates an annotated checkpoint tag: `agent-checkpoint/<run-id>`
- creates and switches to a work branch: `agent-run/<run-id>`
- stores run metadata in `$(git rev-parse --git-dir)/agent-runs/current.json`

## 2) Run your team

Use Hop MCP to spawn terminals and assign work.

Recommended pattern:

- one orchestrator terminal
- N worker terminals
- structured messages with `TASK_ID` and `DONE|ERROR` markers

## 3) Interrupt bad runs

Send `Ctrl-C` to worker terminals:

```bash
npm run agent-team -- interrupt t_abc123 t_def456
```

This uses the local Hop API (`~/.hop2/.tunnel-state`) and posts `\u0003` to each terminal write endpoint.

## 4) Roll back context

Return to base branch while preserving evidence:

```bash
npm run agent-team -- rollback
```

Optional:

- pass run id explicitly: `rollback <run-id>`
- delete work branch after rollback: `rollback --drop-branch`

Notes:

- rollback is non-destructive (no hard reset)
- checkpoint tag is kept for audit/recovery

## 5) Typical recovery flow

1. interrupt all active workers
2. inspect branch diff and logs
3. rollback to base branch
4. restart a fresh run with improved prompts/task split
