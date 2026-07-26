# Session restore: failure taxonomy and the design that closes it

Status: living document · Last updated 2026-07-26

Every failure below was observed on the real fleet, not imagined. Each entry
names the mechanism, the symptom the user saw, and where it is closed.

## The two things restore must get right

Restore answers exactly two questions per session, and every bug so far has
been one of them getting a wrong answer confidently:

1. **Identity** — *which conversation belongs to this session?*
2. **Execution** — *did the relaunch actually happen?*

Everything else (buffers, cwd, flags, config roots) is detail hanging off
those two.

---

## A. Identity failures

### A1. A helper claude steals the session's record
**Mechanism.** The SessionStart hook keys its record on `HOP_SESSION`. Any
claude started *inside* a session inherits that variable — including hop's
own `hop ai tagline` helper, which runs `claude -p --model haiku` in a temp
dir. It recorded itself as the session's conversation.
**Symptom.** "Solstice didn't recover — I had to start claude manually."
Restore refused a record whose cwd was a temp dir and opened a plain shell.
**Closed by.** `aiChildEnv()` deletes `HOP_SESSION`/`HOP_SESSION_INTERNAL`, so
hop's own helpers are invisible to the hook.

### A2. A nested/side claude clobbers the record
**Mechanism.** Same hook, different intruder: an MCP/agent workspace claude
launched by a tool inside the session. The hook's original guard keyed on
`CLAUDE_CODE_SESSION_ID`, which hop deliberately scrubs — so the guard never
fired.
**Symptom.** A `~/Code/nebula-slides` session came back in the slides tool's
`agent-home/claude-workspace`; the room "became" a different session.
**Closed by.** The hook refuses to overwrite an existing record when the new
claude's cwd differs, parking the intruder at `<session>.other.json`.

### A3. The record disagrees with where the session actually is
**Mechanism.** Even with the guards, a record can predate a `cd`, or belong
to a foreign tree.
**Symptom.** Resuming resurrects the wrong conversation in the wrong place.
**Closed by.** The room's **live cwd** — persisted to the durable meta from
the host, which no nested process can forge — is the arbiter.
`restorePlanForSession` refuses a record whose cwd disagrees, and promotes a
parked `.other.json` whose cwd *matches*. Otherwise it opens a shell in the
right directory with a visible warning.

### A4. The recorded conversation doesn't exist on this host
**Symptom.** `⚠ recorded claude conversation 673a1060… has no transcript on
this host` (Hubble).
**Closed by.** Detected before relaunch; falls back to a plain shell in the
right cwd rather than running a command that would fail.

### A5. Two sessions wearing one name
**Mechanism.** A session renamed to a name that a *later* session owns as its
internal name. Display names are not unique, so every name-addressed
operation picked an arbitrary one of the two.
**Symptom.** One tile flickering between a shell and a claude session;
rename hitting the wrong session.
**Closed by.** Rename addresses sessions by internal name; hydration detects
a display name owned by another live session and gives it back.

---

## B. Execution failures

### B1. Typing on a timer
**Mechanism.** Restore typed the relaunch 800ms after attaching, then walked
away. A shell still booting swallowed the keystrokes.
**Symptom.** Orion: a bare shell holding **62 copies** of an un-run resume
command, while restore reported success.
**Closed by.** A per-session state machine (`wait-ready → type → verify →
one retry → fail`) driven by the host's own view of the room.

### B2. No idempotence
**Mechanism.** Nothing checked whether the session was already running before
typing, so every restore added another copy.
**Closed by.** A room whose foreground process is not a shell is left alone.

### B3. Silent failure
**Mechanism.** Restore's report was its *plan*, not its result.
**Closed by.** Per-session outcomes (`resumed` / `already-running` /
`never-started` / `timeout`), printed for failures and returned to callers.

### B4. Flags accumulating
**Mechanism.** The hook records the argv claude actually ran with — which
already contains the flags the previous restore added.
**Symptom.** `--dangerously-skip-permissions` five times in one command.
**Closed by.** Valueless flags deduped when rebuilding the launch.

### B5. Restart races
**Mechanism.** A daemon restart during the salvage script's restore phase
cycled the host; PTYs died mid-restore.
**Symptom.** 17 sessions lost at once (recovered via `hop restore`).
**Open.** See below.

---

## C. What was open — now closed

1. **Restart races (B5).** A pid-stamped lifecycle lock
   (`~/.hop2/.lifecycle.lock`) serializes `hop start`, `hop stop`,
   `hop restore` and the salvage script. Stale holders (dead pid, or held
   >10min) are taken over, so a crash cannot wedge restarts.
2. **The resume-choice prompt.** Sessions parked on claude's
   "resume from summary / full session" question are marked **NEEDS YOU** on
   the wall, detected from preview text already fetched. hop still never
   answers it — that choice can consume a large share of a usage limit.
3. **Restore is no longer keystrokes.** The relaunch is the room's own argv:
   `shell -lc "<cmd>; exec shell -l"`, threaded from the daemon through
   `POST /rooms` to `createPty`. No prompt to race, nothing half-typed, no
   command echo in the scrollback; the session still drops to an interactive
   shell when the app exits. Typing survives only as the fallback for a host
   that predates this.

## Remaining risk

The failure classes above are structurally closed, but two things still
depend on the environment rather than on hop:

- A conversation whose transcript is missing on this host (A4) can only ever
  become a plain shell in the right directory.
- Restore cannot tell whether the app itself will succeed once launched (a
  bad API key, an exhausted usage limit). Verification confirms the process
  started, not that it is happy.

## The invariant to hold on to

> Never infer what can be observed, and never assume what can be verified.

Identity comes from the room's live state (which the host owns), not from a
file anything can overwrite. Execution is confirmed by watching the room's
process, not by a timer. Every failure above is one of those two rules being
broken.
