# AGENTS.md (hop2)

Guidance for agents working on hop2.

## Project shape
- `hop` is the main Node.js CLI/server entry point (bin target).
- `sessions.html` is the built-in session picker UI.
- `hay/` contains the terminal sharing stack (server/cli/web).
- `hay-web/` is the built web client output served by `hop`.

## Local state & config
- Default config dir is `~/.hop2` (override via `HOP_HOME`).
- State files here should remain private (permissions matter).
- Be careful with migrations: preserve backward compatibility where possible.

## Change discipline
- Keep changes focused and consistent with existing patterns.
- Avoid unrelated refactors; minimize surface area.
- Add concise comments only for non-obvious logic.
- Update docs when user-visible behavior changes.

## Build & test
- Build web assets via `npm run build` (builds `hay` then syncs to `hay-web`).
- Basic sanity check: `npm test` (runs `node --check hop`).
- If you don’t run tests, say so and suggest likely commands.

## UI work
- Preserve existing visual language unless a redesign is intended.
- Ensure layouts remain usable on desktop and mobile.

## Server/CLI work
- Prefer clear errors and non-zero exit codes on failures.
- Keep security-sensitive behavior conservative and explicit.
