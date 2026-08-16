---
name: hop-session
description: Conventions for agents working inside a hop terminal session (the HOP_SESSION environment variable is set). Humans watch these terminals live, often from a phone. Covers finding your session identity with hop whoami, rendering math with hop math, handing over results a terminal cannot render — plots, PDFs, images, rendered markdown write-ups — with hop view (always with --title), exposing a running local web server with hop port, ringing the bell for attention, and phone-friendly output.
---

# Working in a hop terminal

You are inside a hop-managed terminal session (`$HOP_SESSION` is set). A human
may be watching this terminal live right now — frequently on a phone — and
everything you print is the interface they see.

## Rendering math

Never show a human raw LaTeX. Render it in the terminal instead:

```bash
hop math 'e^{i\pi} + 1 = 0'
hop math '\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}'
```

`hop math` prints a 2D Unicode layout — real fraction bars, √ overlines,
stacked ∑ limits. Run the command and let its printed output stand as the
formula in your response; do not repeat the raw LaTeX next to it. When you
need the rendered text inside a file or message, capture it:
`hop math '<latex>'` and copy the command's output verbatim.

## Which session are you in?

Everything below targets a SESSION, and yours is knowable, not guessable:

```bash
hop whoami            # display name + internal name of this terminal's session
hop whoami --json     # {"insideHopSession":true,"internalName":"…","displayName":"…"}
```

Inside a hop terminal, `HOP_SESSION` holds the session's internal name and
`hop view` targets it automatically. But subprocesses you spawn may have that
variable deliberately scrubbed (session-identity hygiene), and a renamed
session's internal name never matches what the human calls it — so when in
doubt, ask `hop whoami` and pass the answer explicitly:

```bash
hop view --session "$(hop whoami --json | jq -r .internalName)" --title "…" out.pdf
```

Over MCP, the same answer is the `hop_current_session` tool; via the agent
CLI it is `hopa whoami`. If `hop whoami` says you are NOT in a session,
never guess a target — list candidates (`hop view --list --all`,
`hop_list_sessions`) or ask.

## Showing results a terminal cannot render (plots, PDFs, write-ups)

When the deliverable is a plot, a figure, a report, a PDF, an image, or a
write-up worth reading as a document, do not describe it — publish it and
hand over the link:

```bash
hop view --title "ROC curve: new model vs baseline" results/roc_curve.png
hop view --title "Q3 regression analysis" report.html analysis.pdf
```

**Always pass `--title`.** It is what the human sees in the session's Views
list and in the "new result" chip — a filename like `roc_curve.png` makes
them open it to find out what it is; a title means they already know. One
title describes the whole handoff, so publishing three plots under
"before/after/diff for the cache change" reads correctly.

Markdown is a first-class result, and you can pipe it straight from stdout
with no temp file — it is **rendered** (headings, tables, fenced code,
quotes), not dumped as raw text:

```bash
generate_summary | hop view --name findings.md --title "What the profiler found" -
```

Reach for this whenever the answer is long enough that reading it in a
terminal is worse than reading it as a page: comparisons, tables of numbers,
anything with structure. A table in the scrollback of a phone terminal is
close to unreadable; the same table as a view is not.

`hop view` copies the file behind hop's auth and prints a `View:` URL. It
rings the bell once for you, since a published result is usually the thing
the human is waiting on, and the session's Views surface shows it as new.
Re-running after updating the file re-publishes under the same link.
`hop view --list` shows what this session has published; `hop view --rm
<name>` unpublishes.

## Showing a running web server (dev server, local app)

When you start something that serves HTTP — a dev server, a quick API, a
build's preview server — don't tell the human to open `localhost:<port>`;
they may be on their phone with no way to reach your localhost. Expose it
instead:

```bash
hop port 5173
hop port 8000 my-api
```

`hop port` prints a `View:` URL behind hop's auth, same as `hop view` — one
bell, tap to open. It proxies live (HTTP and WebSocket, so dev-server
hot-reload still works) rather than copying anything, so the link stays
current for as long as the server keeps running; re-running it with the same
name updates the target port in place. Unlike `hop view`, this is for
something ongoing, not a one-off deliverable — closing the server makes the
link stop working.

By default it's ATTACHED to this session, the same way `hop view`'s files
are: it shows up alongside anything you've published here, not as a separate
room in the session list — a webserver a human has to go hunting for a
second entry to find isn't a hand-off, it's a scavenger hunt. If you
genuinely need a standalone room not tied to any session (exposing a service
nobody will think of as "part of" this conversation), pass `--standalone`.

## Asking for attention — two tiers

**Finished something, or pausing normally?** Ring the bell:

```bash
printf '\a'
```

The bell is QUIET on the phone: an attention dot in the switcher and a badge,
no interruption. Ring once when you stop; don't ring repeatedly.

**Blocked, and waiting wastes the human's time?** Use `hop notify`:

```bash
hop notify "VPN is down — reconnect and I can finish the transfer"
hop notify "need your decision: overwrite the frozen artifact tree, or write elsewhere?"
```

This interrupts: it reaches their lock screen with your reason. Use it only
when progress genuinely stops until they act — a decision, credentials, a
dead connection. A routine completion never warrants it; a loop that keeps
running never warrants it. One notify per blockage.

## Phone-friendly output

Key summaries should survive a ~46-column phone wrap: prefer short lines and
compact lists over wide tables when reporting results a human will read.
