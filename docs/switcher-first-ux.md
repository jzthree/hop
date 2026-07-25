# Switcher-first hop: design direction

Status: proposal · Author: drafted with Claude · Date: 2026-07-25

## The shift

hop was built terminal-first: you land in a session, and the switcher is a
palette you summon (⌘K) to leave it. The way hop is actually used — supervising
many concurrent agent sessions, often from a phone — inverts that. The wall of
sessions is the workspace; a single full-screen terminal is one mode of looking
at it.

This document proposes making the switcher the primary surface, with full-screen
as a first-class mode, and **the default a user choice**. Both must remain
one gesture apart.

## What already supports this

The switcher has quietly grown most of the machinery:

- **Zoom ladder** (9 levels, +/−, viewport-capped) — the wall scales from a
  dense overview to near-readable panes.
- **Interactive tiles** above zoom level 6 — click a tile and type in it in
  place, with a reconnect lifecycle of its own.
- **Grid previews** — every tile shows the session's true current screen,
  cheaply, because the daemon keeps a real parsed grid per room.
- **Frozen ordering + activity glow** — the wall stops moving while you scan
  it; activity signals in place.
- **Taglines** — each session says what it is *for*, generated automatically.
- **Search over content** — filter matches session names, working directories,
  and terminal/transcript content, with previews retained in results.

The gap is not capability. It is that the switcher still behaves like a
transient palette: it resets on open, it has no durable identity of its own,
and full-screen is where hop assumes you live.

## Principles

1. **The wall is a place, not a popup.** State the user establishes (zoom,
   sort, scope, scroll position) persists across opens.
2. **One gesture between modes, in both directions.** ⌘⏎ from a tile opens it
   full screen; ⌘. returns. Escape never destroys work.
3. **The default surface is a setting, not an opinion.** Some sessions are a
   long single conversation; some are a fleet.
4. **Nothing on the wall requires a round trip to be useful.** Tagline,
   activity state, and last screen are all readable at a glance.
5. **Phone-first ergonomics.** Thumb reach, no hover dependencies, and no
   layout that assumes a mouse.

## Proposed changes

### 1. Default surface setting
`Settings → Start on:` **Session wall** | **Last session** (current behavior).
The daemon's landing redirect honors it, so opening hop goes where the user
wants without a flash of the wrong surface.

### 2. The wall gets an identity
- A stable URL (`/wall`) so it can be bookmarked and returned to.
- Zoom, sort mode, origin scope, and scroll offset persist per device.
- Opening it does not reset scope to `user` (today it does).

### 3. Mode switching becomes symmetric
| From | Gesture | To |
|---|---|---|
| Wall | Enter / tap | Session, full screen |
| Wall | ⌘⏎ on a tile | Interactive tile, stay on the wall |
| Session | ⌘K / swipe down | Wall |
| Interactive tile | ⌘⏎ | Session, full screen |
| Interactive tile | ⌘. | Release, stay on the wall |

Escape from the wall returns to the previous session when there is one;
otherwise it is a no-op (never a dead end).

### 4. Wall-native actions
Rename, kill, and "new session here" already exist per tile. Add: pin a
session to the top, and a compact keyboard path for each (the wall should be
fully drivable without a pointer).

### 5. Attention model
Bell and unread dots stay. With ordering frozen, attention is communicated
by the in-place glow plus an optional "N sessions want you" affordance that
jumps to the next one — supervising twenty sessions should not require
scanning twenty tiles.

## Open questions

- Does the wall replace the hub landing page, or are they the same surface in
  two states? (Leaning: same surface; the hub is simply the wall with no
  current session.)
- On a phone, is the interactive tile worth the complexity versus always going
  full screen for input? Real usage should decide.
- Should panes and the wall converge — is a split pane just two pinned tiles?

## Sequencing

1. Default-surface setting + stable `/wall` URL (small, unblocks the rest).
2. Persist wall state across opens; stop resetting scope.
3. Symmetric mode gestures + Escape semantics.
4. Attention jump affordance.
5. Revisit panes vs. wall convergence.

Each step is independently shippable and leaves hop usable if the next never
lands.
