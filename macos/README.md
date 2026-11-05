# hop for Mac

A native window around hop's web app: the same sidebar, places and
terminals, as an app of its own instead of a browser tab.

- **Your shortcuts.** ⌘K, ⌘N, ⌘T, ⌘W, ⌘1… reach hop; a browser kept them.
  The app's own are ⌘⌥N (new window), ⌘⇧W (close window), ⌘⇧R (reload),
  ⌘⌥= / ⌘⌥- / ⌘⌥0 (zoom), ⌃⌘F (full screen), ⌘Q.
- **This Mac, directly.** It talks to this Mac's hop daemon on its loopback
  port, never through the public tunnel, and signs itself in: the daemon
  secret in `~/.hop2/.tunnel-state` mints a device session ("hop for Mac",
  listed by `hop auth list`, kept in the Keychain). hop ▸ Connect to ▸
  Another Machine… opens a remote hop with its own login instead.
- **Sessions outlive it.** The daemon is its own process: quitting the app
  stops nothing. If hop is not running, the window offers to start it.
- **What a browser gave.** Confirm and prompt dialogs, file pickers and
  drag-and-drop, downloads to ~/Downloads, links out to your browser, hop
  pages "in a new tab" as new windows, Open at Login, the Safari Web
  Inspector (Develop menu).

The page knows it is in the app: `window.hopNative` (`{ platform: 'mac',
version, post(message) }`). `post({ type: 'badge', count })` sets the Dock
badge — the start of the native signals (notifications, the menu bar).

## Build

    ./build.sh            # .dist/hop.app
    ./build.sh install    # …into ~/Applications

Swift Package Manager; Xcode's command-line tools are enough. Signed with
your "Developer ID Application" identity when the Keychain has one
(hardened runtime), else ad hoc. To notarize for other Macs, store a
notarytool profile once (`xcrun notarytool store-credentials hop`) and run
`HOP_MAC_NOTARY_PROFILE=hop ./build.sh`.
