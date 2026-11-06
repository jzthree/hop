import AppKit
import ServiceManagement
import WebKit

// hop for Mac. The window is hop's web app; this is everything around it:
// connecting (to this Mac's daemon, signed in on its own, or to a remote
// hop), the menus — kept to what an app must own, so ⌘K, ⌘N, ⌘T, ⌘1… reach
// hop instead of a browser — reopening, and opening at login. Quitting the
// app never stops a session: the daemon is its own process.

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var windows: [WebWindowController] = []
    private var base: URL?
    private var connecting = false
    private var portWatch: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMenu()
        connect()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { connect() }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // MARK: - Connecting

    /// Point the window at the chosen hop, signing in on the way for this Mac's.
    /// `reload`: load the page again even when it is already on that hop
    /// (after a fresh sign-in).
    func connect(reload: Bool = false) {
        guard !connecting else { return }
        connecting = true
        Task { @MainActor in
            defer { connecting = false }
            switch ServerChoice.current {
            case .remote(let url):
                base = url
                show(url)
            case .local:
                // Right after a restart hop is still starting: give it time
                // (saying so) before calling it not running.
                var daemon: LocalDaemon? = nil
                for attempt in 0..<90 {
                    if let d = LocalDaemon.read(), await d.isUp() { daemon = d; break }
                    if attempt == 1 { showPage(Pages.starting()) }
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
                guard let daemon else {
                    Log.note("hop did not come up on this Mac")
                    showPage(Pages.notRunning())
                    watchForDaemon()
                    return
                }
                Log.note("hop is up on port \(daemon.port); signing in")
                guard let token = await daemon.signIn() else {
                    showPage(Pages.cannotSignIn())
                    return
                }
                let cookie = HTTPCookie(properties: [
                    .name: "tunnel_session", .value: token, .domain: "127.0.0.1", .path: "/",
                    .expires: Date().addingTimeInterval(400 * 86400)
                ])!
                await WebWindowController.dataStore.httpCookieStore.setCookie(cookie)
                base = LocalDaemon.read()?.base ?? daemon.base
                show(base!, reload: reload)
                watchLocalPort()
            }
        }
    }

    /// The daemon can come back on another port (a restart that could not
    /// reuse its old one): follow it, every window staying on its page.
    private func watchLocalPort() {
        portWatch?.invalidate()
        portWatch = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self, ServerChoice.current == .local, let base = self.base,
                  let now = LocalDaemon.read(), now.port != base.port else { return }
            Task { @MainActor in
                guard await now.isUp(), let token = await now.signIn() else { return }
                let cookie = HTTPCookie(properties: [.name: "tunnel_session", .value: token, .domain: "127.0.0.1", .path: "/",
                                                     .expires: Date().addingTimeInterval(400 * 86400)])!
                await WebWindowController.dataStore.httpCookieStore.setCookie(cookie)
                self.base = now.base
                for w in self.windows {
                    var parts = URLComponents(url: w.webView.url ?? now.base, resolvingAgainstBaseURL: false) ?? URLComponents()
                    if parts.host == nil || parts.host == "127.0.0.1" {
                        parts.scheme = "http"; parts.host = "127.0.0.1"; parts.port = now.port
                        w.retarget(origin: now.base)
                        w.load(parts.url ?? now.base)
                    }
                }
            }
        }
    }

    /// While the window says hop is not running, keep looking: the moment
    /// it is (started from a terminal, or by itself after a restart), connect.
    private var daemonWatch: Timer?
    private func watchForDaemon() {
        daemonWatch?.invalidate()
        daemonWatch = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] t in
            guard let self, ServerChoice.current == .local, !self.connecting, let d = LocalDaemon.read() else { return }
            Task { @MainActor in
                guard await d.isUp() else { return }
                t.invalidate()
                self.daemonWatch = nil
                self.connect()
            }
        }
    }

    func startLocalDaemon() {
        showPage(Pages.starting())
        Task.detached {
            guard HopCLI.start() else {
                await MainActor.run { self.showPage(Pages.notRunning(error: "hop is not installed for this user (no `hop` on the login shell's PATH).")) }
                return
            }
            for _ in 0..<60 {
                if let d = LocalDaemon.read(), await d.isUp() { break }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            await MainActor.run { self.connect() }
        }
    }

    /// The app never needs hop's login page for this Mac (it signs itself
    /// in). Landing there means its login was lost: sign in again, once a
    /// minute at most, and reload.
    private var lastRecovery = Date.distantPast
    func landedOnLoginPage() {
        guard ServerChoice.current == .local, Date().timeIntervalSince(lastRecovery) > 60 else { return }
        lastRecovery = Date()
        Log.note("on hop's login page — signing this Mac in again")
        connect(reload: true)
    }

    private func show(_ url: URL, reload: Bool = false) {
        if let w = windows.first {
            // The window may have been made for a page of the app's own ("hop
            // is starting") before hop was there: hop's pages are its pages
            // now. Without this, loading hop counted as leaving for another
            // site — it opened hop's login page in the browser instead.
            w.retarget(origin: url)
            if reload || w.webView.url?.host != url.host || w.webView.url?.port != url.port || w.webView.url?.scheme == nil { w.load(url) }
            w.showWindow(nil)
            w.window?.makeKeyAndOrderFront(nil)
        } else {
            _ = openWindow(url: url, configuration: nil)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showPage(_ html: String) {
        let w = windows.first ?? openWindow(url: URL(string: "about:blank")!, configuration: nil)
        w.webView.loadHTMLString(html, baseURL: nil)
        w.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @discardableResult
    func openWindow(url: URL, configuration: WKWebViewConfiguration?) -> WebWindowController {
        let origin = base ?? url
        let name = windows.isEmpty ? "HopMain" : "HopWindow\(windows.count)"
        let w = WebWindowController(url: url, origin: origin, configuration: configuration, frameName: name) { [weak self] closed in
            self?.windows.removeAll { $0 === closed }
        }
        if !windows.isEmpty, let last = windows.last?.window {
            w.window?.setFrameTopLeftPoint(NSPoint(x: last.frame.minX + 28, y: last.frame.maxY - 28))
        }
        windows.append(w)
        w.showWindow(nil)
        return w
    }

    // MARK: - Menu actions

    @objc func newWindow(_ sender: Any?) {
        guard let base else { connect(); return }
        openWindow(url: base, configuration: nil)
    }

    @objc func reload(_ sender: Any?) {
        guard let w = keyWindowController() else { connect(); return }
        if w.webView.url?.scheme?.hasPrefix("http") == true { w.webView.reload() } else { connect() }
    }

    @objc func connectLocal(_ sender: Any?) {
        ServerChoice.current = .local
        connect()
    }

    @objc func connectRemote(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "Connect to a hop on another machine"
        alert.informativeText = "Its address, as you would open it in a browser. You sign in there once."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        if case .remote(let u) = ServerChoice.current { field.stringValue = u.absoluteString }
        field.placeholderString = "https://hop.example.org"
        alert.accessoryView = field
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        var text = field.stringValue.trimmingCharacters(in: .whitespaces)
        if !text.contains("://") { text = "https://" + text }
        guard let url = URL(string: text), url.host != nil else { return }
        ServerChoice.current = .remote(url)
        windows.forEach { $0.close() }
        windows.removeAll()
        connect()
    }

    @objc func signOutLocal(_ sender: Any?) {
        Keychain.clear()
        connect()
    }

    @objc func toggleOpenAtLogin(_ sender: NSMenuItem) {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled { try service.unregister() } else { try service.register() }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Could not change Open at Login"
            alert.informativeText = "\(error.localizedDescription)\n\nMove hop to Applications first, then try again."
            alert.runModal()
        }
    }

    @objc func zoomIn(_ sender: Any?) { keyWindowController()?.webView.pageZoom += 0.1 }
    @objc func zoomOut(_ sender: Any?) { if let v = keyWindowController()?.webView { v.pageZoom = max(0.5, v.pageZoom - 0.1) } }
    @objc func zoomReset(_ sender: Any?) { keyWindowController()?.webView.pageZoom = 1 }

    private func keyWindowController() -> WebWindowController? {
        windows.first { $0.window === NSApp.keyWindow } ?? windows.first
    }

    // MARK: - Menus

    private func buildMenu() -> NSMenu {
        let main = NSMenu()
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target
            return i
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
            let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            i.submenu = m
            return i
        }

        let openAtLogin = item("Open at Login", #selector(toggleOpenAtLogin(_:)), target: self)
        main.addItem(submenu("hop", [
            item("About hop", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            submenu("Connect to", [
                item("This Mac", #selector(connectLocal(_:)), target: self),
                item("Another Machine…", #selector(connectRemote(_:)), target: self)
            ]),
            item("Sign This Mac In Again", #selector(signOutLocal(_:)), target: self),
            openAtLogin,
            .separator(),
            item("Hide hop", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit hop", #selector(NSApplication.terminate(_:)), "q")
        ]))
        // Edit: the responder-chain actions the web view needs for the
        // clipboard and undo. ⌘ keys hop does not claim still work.
        main.addItem(submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a")
        ]))
        main.addItem(submenu("View", [
            item("Reload", #selector(reload(_:)), "r", [.command, .shift]),
            .separator(),
            item("Actual Size", #selector(zoomReset(_:)), "0", [.command, .option], target: self),
            item("Zoom In", #selector(zoomIn(_:)), "=", [.command, .option], target: self),
            item("Zoom Out", #selector(zoomOut(_:)), "-", [.command, .option], target: self),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        ]))
        main.addItem(submenu("Window", [
            item("New Window", #selector(newWindow(_:)), "n", [.command, .option], target: self),
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w", [.command, .shift]),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)))
        ]))
        main.items.last?.submenu.map { NSApp.windowsMenu = $0 }
        for i in main.items { i.submenu?.items.forEach { if $0.target == nil, $0.action == #selector(reload(_:)) { $0.target = self } } }
        main.delegate = MenuState.shared
        MenuState.shared.openAtLogin = openAtLogin
        return main
    }
}

/// Ticks the menu's state as it opens.
final class MenuState: NSObject, NSMenuDelegate {
    static let shared = MenuState()
    weak var openAtLogin: NSMenuItem?
    func menuNeedsUpdate(_ menu: NSMenu) {}
    func menuWillOpen(_ menu: NSMenu) {
        openAtLogin?.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }
}

/// The few pages the app draws itself, when there is no hop to show yet.
enum Pages {
    private static func page(_ title: String, _ body: String, _ actions: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8"><style>
        :root { color-scheme: light dark; }
        body { margin: 0; height: 100vh; display: grid; place-items: center; font: 14px/1.5 -apple-system, sans-serif;
               background: light-dark(#f8f8fa, #17171c); color: light-dark(#1e1b2e, #e7e5ee); }
        main { max-width: 440px; text-align: center; padding: 24px; }
        h1 { font-size: 20px; margin: 0 0 8px; } p { margin: 0 0 18px; color: light-dark(#5b5770, #a8a4b8); }
        button { font: 600 13px -apple-system, sans-serif; border: 0; border-radius: 8px; padding: 8px 16px; margin: 0 4px;
                 background: #7c3aed; color: #fff; cursor: pointer; } button.quiet { background: light-dark(#e7e5ee, #2a2833); color: inherit; }
        code { font: 12px ui-monospace, monospace; }
        </style></head><body><main><h1>\(title)</h1><p>\(body)</p>\(actions)</main>
        <script>function post(t){ try { window.webkit.messageHandlers.hop.postMessage({type:t}); } catch(e){} }</script></body></html>
        """
    }
    static func notRunning(error: String? = nil) -> String {
        page("hop isn't running on this Mac",
             error ?? "Your sessions live in hop's background service. Start it here — quitting this app never stops it.",
             "<button onclick=\"post('start-daemon')\">Start hop</button><button class=quiet onclick=\"post('retry')\">Try again</button>")
    }
    static func starting() -> String {
        page("Starting hop…", "Bringing your sessions back. This takes a few seconds.", "")
    }
    static func cannotSignIn() -> String {
        page("Couldn't sign in to hop", "hop is running, but it didn't accept this app. Run <code>hop status</code> in a terminal, then try again.",
             "<button onclick=\"post('retry')\">Try again</button>")
    }
}

