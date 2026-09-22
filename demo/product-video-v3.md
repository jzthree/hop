# Product video v3 — what shipped since August

The v2 cut (August) opened on the wall and closed on the phone illustration.
Since then the product grew four stories worth filming — a three-choice
session form, iTerm-style panes, published Views, and the Claude ⇄ Codex
hand-off — and the rig, the daemon and the wall all changed under the
recording. Target: ~85s, captioned, no voiceover. Dark theme throughout;
captions succinct, not salesy; illustrations in the README house style
where footage cannot be honest.

## Shot list

Live clips come from the sanitized rig (`demo/capture/`); stills are the
`docs/hero-*.svg` illustrations with a slow push-in. The storyboard the
assembler reads is `demo/storyboards/v3.json`.

| # | segment | source | caption |
|---|---------|--------|---------|
| 0 | title card | rendered | hop — every session your agents run, on one wall |
| 1 | `00-wall` | live | Every terminal, one wall. Filter to find it; click to work in place. |
| 2 | `10-new-session` | live | Terminal, Claude or Codex — in any directory, with completion. |
| 3 | `02-agent-live` | live, real claude | Agents work in real terminals. Watch, steer, take over. |
| 4 | `11-panes` | live | Split any side. Drag a pane to re-dock it. Zoom, and back. |
| 5 | `12-views` | live | hop view publishes a result; read it right on the wall. |
| 6 | `13-handoff` | live | Continue a Claude conversation in Codex — or the other way round. |
| 6b | `hero-handoff.svg` | still | (the legend is in the frame) |
| 7 | `hero-mobile.svg` | still | The same fleet in your pocket — and a keyboard that listens on-device. |
| 8 | end card | rendered | hop — terminals for humans + agents · github.com/jzthree/hop |

Segment 6 is real: the rig's Aurora runs a real `claude`, the card menu's
"Continue in Codex…" runs the real hand-off, and the new `Aurora-codex`
card appears on the wall while codex starts reading the transcript. The
illustration that follows explains what just happened (fork vs hand-off,
filed beside its source), the way `hero-overview.svg` explains the runtime.

## Producing it

```bash
export PATH=/opt/homebrew/bin:$PATH
node demo/capture/setup-sessions.mjs        # Lyra / Nebula / Polaris tickers
node demo/capture/spawn-aurora.mjs          # a real claude in the demo workspace
for c in 00-wall 10-new-session 11-panes 12-views; do node demo/capture/capture.mjs $c; done
HOP_CAPTURE_TASK=02B node demo/capture/capture.mjs 02-agent-live   # after the tour, the director's cut
node demo/capture/capture.mjs 13-handoff    # AFTER 02: the hand-off needs a conversation to hand over
node demo/assemble-video.mjs --storyboard demo/storyboards/v3.json --out demo-output/hop-v3-rough.mp4
```

`assemble-video.mjs` replaces the March stitcher for this cut: the homebrew
ffmpeg has no `drawtext`, so captions and cards are rendered by Chromium
(real CSS typography — the illustrations' monospace kicker over a
sentence in a dark pill) and composited as transparent overlays; stills
get a `zoompan` push-in from a 2x render; segments are encoded uniformly,
concatenated, and faded in/out once. `--no-captions` keeps a clean plate;
`--only 11-panes,12-views` re-renders a subset while iterating.

## Rig notes (what changed since v2)

- **Auth.** The daemon takes its secret only as a Bearer header now; a
  browser needs a real login session. The rig mints a one-day device token
  (`POST /api/auth/sessions/token`) once per run and uses it as the cookie.
  With the old cookie every clip recorded the login page — light, and with
  no room attached.
- **Minted ids.** Sessions are `s_…` ids; the cast is addressed by display
  name. Filters, the safety check and the preview gate accept both. The
  preview gate reading the display name is why the first agent clip
  recorded a finished screen: it never saw output grow.
- **Briefing staging is global**, for both files the card reads. The card
  now also loads `digest-archive.json` (every edition, by session); staging
  only `digest.json` put the real fleet's week on camera under the staged
  summary. Nothing is written to disk.
- **Views are fleet-wide** (`/api/views`): filtered to the cast, keyed by
  session id.
- **Directory completion** reads the real filesystem: `/api/fs/complete`
  answers with a staged tree rooted at the demo workspace, in the field's
  shape (`{home, entries:[{path}]}`). The wrong shape produced `undefined/`
  and the session opened in the real home directory.
- **Session pages never go network-idle** (they stream): readiness is the
  terminal mounting, not `networkidle`.
- **The card's ⋯ is revealed on hover** and a hidden twin matches the same
  label; hover the card, then click the visible one.
- `hay_passkey_nudge_done=1` keeps the "Touch ID next time?" bar off camera.
- Claude's effort prompt ("Keep xhigh / Switch") must be answered after the
  spawn (send `↓⏎` through the terminal API), else the tile sits on a
  question for the whole shoot.
- Codex asks to trust a new directory. Before the hand-off clip, add
  `[projects."/private/tmp/hop-demo/workspace"] trust_level = "trusted"` to
  `~/.codex/config.toml` (and remove it afterwards), or the new tile shows
  the trust question instead of codex reading the transcript.
- The DOM rewriter also maps the real home directory to `~` and the
  username to `demo`: the hand-off prompt names the extract's path under
  `~/.hop2/uploads/`, and tiles render through the DOM, so it applies.

## Product bug found by the shoot

`hop view --session <display name>` filed the view under the display name
while the wall joins views on the session id, so the card never lit up.
Fixed in the CLI: `--session` resolves to the id before publishing.

## Phone footage checklist (unchanged)

hero-mobile.svg still stands in for the two segments only a phone can film
(hop-ios keyboard feel, HopBoard dictation). Real device footage replaces
the still whenever it gets filmed; the slot and timing stay.
