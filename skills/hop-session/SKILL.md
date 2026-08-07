---
name: hop-session
description: Conventions for agents working inside a hop terminal session (the HOP_SESSION environment variable is set). Humans watch these terminals live, often from a phone. Covers rendering math with hop math, publishing viewable files (HTML/PDF/images) with hop view, exposing a running local web server with hop port, ringing the bell for attention, and phone-friendly output.
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

## Showing files a terminal cannot render (HTML, PDF, images)

When the deliverable is a plot, a figure, an HTML report, a PDF, or any
image, do not describe it — publish it and hand over the link:

```bash
hop view results/roc_curve.png
hop view report.html analysis.pdf
```

`hop view` copies the file behind hop's auth and prints a `View:` URL. The
human taps it and their browser renders it — on the desktop wall or from the
phone app, which opens these in-app. It rings the bell once for you, since a
published artifact is usually the thing the human is waiting on. Re-running
it after updating the file re-publishes under the same link.

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
current for as long as the server keeps running; re-running `hop port` with
the same name updates it if the port changes. Unlike `hop view`, this is for
something ongoing, not a one-off deliverable — closing the server makes the
link stop working.

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
