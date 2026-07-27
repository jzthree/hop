# Session identity: names, layers, and the rules that keep them honest

Renaming a session has broken, in a different way, four times. Each fix
addressed the symptom in front of it (persistence, then a false 409, then
duplicate display names) and the next failure arrived from the same
direction. This document names the underlying structure so the class stays
closed.

## The layers

A session's metadata lives in three places, and every one of them can answer
"what is this session called?":

| Layer | Where | Lifetime | Written by |
|---|---|---|---|
| Store config | `sessionStore.sessions[internal]` (in memory; a workspace file only when a workspace exists) | until daemon exit | `setSessionConfig`, restore (`saveDefinition: true`), session creation |
| Runtime metadata | `runtimeSessionMetadata` map | until daemon exit | `rememberRuntimeSessionMetadata`, every reconcile tick |
| Durable meta | `~/.hop2/claude-sessions/<internal>.meta` | forever | rename, park/archive, tagline, hook records |

A session is addressed by its **internal name** — the room id, immutable for
the session's life. The **display name** is a label, and the alias map
(`sessionAliases`) redirects old labels to current ones.

## The rules

1. **Write through every layer a reader consults.** Not "the right one" —
   all of them. The recurring rename bug was a write/read asymmetry:
   `renameSessionDisplayName` chose its target via the workspace-GATED
   `getSavedSessionConfig`, while `getEffectiveSessionConfig`,
   `reconcileExternalRuntimeSessions`, and `getSessionDisplayName` all read
   the UNGATED store first. Any session with a store entry and no workspace —
   which is every restored session — took the runtime branch, and the next
   reconcile copied the stale store name back over it. The rename reverted
   seconds later, which is why it kept looking like "rename doesn't persist."

2. **Durable meta is the authority for a name.** It is the only layer written
   by every rename and the only one that survives a restart. Reconcile
   resolves `displayName` from meta first, then store, then runtime.

3. **Never invent a session.** `resolveSessionDisplayName` returns `null`
   when nothing owns a name, and callers refuse. It used to return the
   requested name either way (both ternary branches were identical), so
   `/ws?room=<name>` CREATED an empty session wearing that name. Combined
   with rule 1's revert, one rename produced a phantom shell holding the new
   name while the real session ran on, unreachable, behind the old one — and
   because the alias pointed the old name at the new one, *both* names
   resolved to the phantom. Any typo'd room name in a URL did the same thing.

4. **Address by internal name whenever the caller knows it.** Display names
   collide; the UI passes `internalName` so a rename always lands on the
   session the user clicked.

5. **A name conflict resolves in favour of the room that owns it.** If a
   session's claimed display name is another live room's internal name, the
   claimant falls back to its own name and the collision is logged. Two
   identically-named sessions are indistinguishable in the UI and ambiguous
   to address.

## Diagnosing the next one

- `[ws] refused attach to unknown session "X"` — a client is asking for a
  name nothing owns. Before rule 3, this line was a new session instead.
- `[rename] "X" is another live session's name` — rule 5 fired.
- Disagreement between `<name>.meta` on disk and `/api/sessions` output means
  a layer is stale: rule 1 or 2 has been violated by a new code path.

## Covered by

`npm run test:identity` — CI runs unit suites only (the integration tests
need a real daemon and PTYs), so these guards do NOT run on push. Run them
locally before shipping anything that touches naming, aliases, or attach.

`tests/terminal-api.integration.test.cjs`:
- *websocket attach to an unknown session refuses instead of creating one*
  (fails without rule 3)
- *rename sticks across reconcile ticks and never manufactures a session*
