# Dev Notes

## Mobile touch scrolling + selection mode (iOS Safari)

We intentionally disable native touch handling on the xterm DOM so we can
implement our own smooth touch scrolling, but we also need a "selection mode"
that restores iOS text selection handles. The fix is split across CSS and JS.

### Default mode (scrolling)
* **CSS** (`hay/apps/web/src/styles.css`):
  * `.terminal-scroll` and `.xterm*` get `touch-action: none` to prevent
    Safari's native scrolling/selection on the terminal surface.
  * `.xterm-rows` and span children use `pointer-events: none` so touches hit
    our container instead of individual text nodes.
* **JS** (`hay/apps/web/src/App.tsx`, mobile touch effect):
  * We attach custom `touchstart/move/end` handlers to implement momentum
    scrolling on the terminal content.

### Selection mode (text selection)
* **CSS** (`hay/apps/web/src/styles.css`):
  * `.session.selection-mode` re-enables `pointer-events` and `user-select`
    on `.xterm-rows` so iOS can show selection handles.
  * `touch-action: auto` is restored on xterm elements.
* **JS** (`hay/apps/web/src/App.tsx`):
  * We skip the custom touch scrolling effect when `selectionMode` is true.
  * We disable xterm's internal `viewport.handleTouchStart/Move` to stop it
    from swallowing selection gestures.
  * The click handler clears selection and toggles `user-select` to re-arm
    iOS selection after a tap.

### If selection or scrolling regresses
1. Confirm `.session` has the `selection-mode` class when the toggle is on.
2. Verify the CSS block for `.session.selection-mode` is present (pointer-events
   and user-select must be re-enabled).
3. In `App.tsx`, ensure the selection-mode guards still:
   * prevent installing custom touch scrolling, and
   * override `viewport.handleTouchStart/Move`.
4. If text selection works but scrolling is broken, verify `touch-action: none`
   and `pointer-events: none` are still applied in default mode.
