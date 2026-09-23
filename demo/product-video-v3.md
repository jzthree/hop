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
| 6 | `14-switch-hud` | live | ⌘J / ⌘L walk your recent sessions; release to land. |
| 7 | `15-folders` | live | File a session from its menu — no drag needed. |
| 8 | `16-drop` | live | Drop a file on a session: it lands on the host and the path is typed for you. |
| 9 | `06-math` | live | hop math renders LaTeX where a terminal can't. |
| 10 | `13-handoff` | live | Continue a Claude conversation in Codex — or the other way round. |
| 10b | `hero-handoff.svg` | still | (the legend is in the frame) |
| 11 | `hero-operations.svg` | still | restore & recover · per-device logins · the signup front door (legend in the frame) |
| 12 | `hero-mobile.svg` | still | (the legend is in the frame) |
| 13 | end card | rendered | hop — terminals for humans + agents · github.com/jzthree/hop |

Segments 6–9 are a montage of the smaller stories. Segment 11 is the second
new illustration: restore after a reboot, per-device logins with passkeys
and revoke, and the self-service front door are not things a screen
recording can show honestly (a reboot, a Touch ID prompt, someone else's
signup), so they get the README treatment instead.

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
for c in 00-wall 10-new-session 11-panes 12-views 14-switch-hud 15-folders 16-drop 06-math; do node demo/capture/capture.mjs $c; done
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
- **Record with Playwright's own Chromium** (now the default). The installed
  Google Chrome changed under the rig mid-shoot: its 154 headless pads every
  recording with a gray band along the bottom. `HOP_CAPTURE_BROWSER=chrome`
  opts back in.
- The folders clip creates a real folder (`Benchmarks`; a name that already
  exists is refused) and files Nebula into it on camera; cleanup deletes it.
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

## The final cut is built ON the August video

`demo/storyboards/v3-on-v2.json` is the one that ships. It uses
`demo-output/hop-v2-rough.mp4` as the spine — its wall opening (0–12.88s),
its phone illustration (12.88–20.0s) and its end card (20.0–23.33s) exactly
as they were — and splices everything new in between. `v3.json` is the
from-scratch variant with a title card; keep it for reference.

## The phone, filmed for real

The native app is recorded in the iOS simulator against an **isolated,
tunnel-less daemon** so only the demo cast is ever on camera:

```bash
HOP_NO_TUNNEL=1 HOP_HOME=/tmp/hop-demo/hop-home hop start      # its own port + secret
HOP_HOME=/tmp/hop-demo/hop-home HOP_CAPTURE_CAST_SUFFIX= node demo/capture/setup-sessions.mjs
HOP_HOME=/tmp/hop-demo/hop-home HOP_CAPTURE_CAST_SUFFIX= node demo/capture/spawn-aurora.mjs
# mint a device token on THAT daemon, stage hay-web/assets/digest*.json (backup first), then:
cd ~/Code/hop-ios && make gen && xcodebuild build-for-testing -scheme HopSpikeUI …
xcrun simctl status_bar $SIM override --time 9:41 --batteryState charged --batteryLevel 100
xcrun simctl io $SIM recordVideo --codec h264 --force /tmp/hop-demo/phone.mp4 &
TEST_RUNNER_HOP_DEV_COOKIE=$TOKEN TEST_RUNNER_HOP_DEV_SERVER=http://127.0.0.1:$PORT \
TEST_RUNNER_HOP_CAPTURE_OPEN=Lyra xcodebuild test-without-building -scheme HopSpikeUI \
  -only-testing:HopSpikeUITests/WallCapture …
kill -INT %1; restore the digest files; HOP_HOME=/tmp/hop-demo/hop-home hop stop
```

- `UITests/WallCapture.swift` (hop-ios) is the tour: wall, a slow scroll,
  tap a session, type with the keyboard up, back. Real gestures, so the
  recording shows the app as it behaves.
- `HOP_DEV_SERVER` (new, debug builds only) points the app at the rig
  daemon; the dev cookie is no longer marked Secure for http, or the
  simulator would never send it to 127.0.0.1.
- `HOP_CAPTURE_CAST_SUFFIX=` drops the "2" from the cast's names: the
  phone shows internal names verbatim, and an isolated daemon has nothing
  to collide with.
- Type into a SHELL session (Lyra) on the phone, not the claude one: a
  prompt typed into claude gets an answer, and the first take's answer
  quoted the user's global instructions back on camera.
- The briefing files are served from the repo's `hay-web/assets` by every
  daemon, the live one included, so the staged copies must go back within
  minutes — and never across the hourly digest run at :40.
- HopBoard still cannot run in the simulator (keyboard extension + mic +
  on-device Whisper), so the v2 illustration follows the real footage for
  that one beat.
