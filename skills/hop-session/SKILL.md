---
name: hop-session
description: Conventions for agents working inside a hop terminal session (the HOP_SESSION environment variable is set). Humans watch these terminals live, often from a phone. Covers rendering math with hop math, publishing viewable files (HTML/PDF/images) with hop view, ringing the bell for attention, and phone-friendly output.
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

## Asking for attention

When you are blocked on the human — a question, a decision, a finished
deliverable — ring the terminal bell:

```bash
printf '\a'
```

hop counts bells and surfaces them as attention dots in the session switcher
and as phone notifications. Ring once when you stop; don't ring repeatedly.

## Phone-friendly output

Key summaries should survive a ~46-column phone wrap: prefer short lines and
compact lists over wide tables when reporting results a human will read.
