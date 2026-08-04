# Product video v2 — the switcher-first cut

The March cut opened on a session *list* and treated full screen as the
product. That is backwards now: **the wall is the product**, full screen is a
deliberate mode, and three new stories exist — the briefing, hop-ios, and
HopBoard dictation. Target: ~60s, captioned, no voiceover.

## Shot list

Captured with the sanitized rig (`demo/capture/`) unless marked PHONE.
Dark theme throughout; captions succinct, not salesy.

1. **00-wall** (10–13s) — CAPTURED, `demo-output/footage/live/00-wall.webm`
   The wall breathing: live tiles ticking, briefing card up top, filter
   narrows live, click engages a session in place, ⌘⏎ enters full screen.
   Caption: `Every terminal, one wall. Sessions are the home screen.`
2. **01-briefing** (5s) — crop/zoom of the briefing card reading itself.
   Caption: `A briefing, not a backlog — what happened while you were away.`
   (Staged via route interception in the 00-wall clip; can reuse frames.)
3. **02-agent-live** (8s) — existing rig clip, still valid: an agent working
   in a session while you watch and type into the same terminal.
   Caption: `Agents work in real terminals. Watch, steer, take over.`
4. **03-phone-live** (6s) — existing rig clip (mobile web).
   Caption: `The same fleet from your phone.`
5. **04-hop-ios** (8s) — PHONE. Native app: wall → tile → keyboard feel,
   then the briefing on the phone. Film on device (simulator hides the
   keyboard feel, which is the whole point of the native app).
6. **05-hopboard** (6s) — PHONE. Any app: hold the HopBoard mic key,
   speak, text lands at the cursor. One take, no cuts — the honesty IS
   the demo. Caption: `On-device Whisper dictation. Audio never leaves
   the phone.`
7. **06-close** (3s) — wall again, one tile ringing its attention bell,
   cursor moves to it. Caption: `hop — github.com/jzthree/hop`.

## Rig notes (what changed since March)

- New clip `00-wall` in `capture.mjs`; briefing is staged by intercepting
  `/assets/digest.json` — nothing written to disk, nothing to leak.
- The rig's sessions are created through the terminal API, so the origin
  classifier marks them agent-created and the wall's default USER scope
  would hide the entire cast — the network filter now presents them as
  user sessions (`createdBy: "user"` rewrite).
- The legacy `01-sessions` clip targets the old `/sessions` hub page.
  Superseded by `00-wall`; keep the code until the v2 edit is locked.

## Phone footage checklist (only you can film these)

- iPhone, dark mode, notifications off, screen-record at 60fps.
- hop-ios: open on the wall, scroll it once, tap a tile, type one short
  line (keyboard feel is the shot), open the briefing.
- HopBoard: in Notes or a claude session, tap mic key, speak one sentence
  ("route the exporter errors into the retry queue"), stop, let the text
  land. Keep the orange mic indicator in frame — it is the privacy story.

## Assembly

`stitch-demo-video.mjs` concatenates WebM → MP4 as before. Captions get
burned in at edit time (same as March cut) — keep each on screen ≥2.5s.
