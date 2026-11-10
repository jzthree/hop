import AppKit
import WebKit

// One hop window: a WKWebView on the chosen server, with what a browser
// would otherwise have provided — dialogs (hop asks before a kill, prompts
// for folder names), file pickers, downloads, links out to the default
// browser, and new windows for hop pages opened in a "new tab".

final class WebWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    let webView: WKWebView
    private var origin: URL
    private var onClose: ((WebWindowController) -> Void)?

    /// The app's web data (cookies, storage) is one shared store, so every
    /// window is signed in and sees the same per-browser settings.
    static let dataStore = WKWebsiteDataStore.default()

    init(url: URL, origin: URL, configuration: WKWebViewConfiguration? = nil, frameName: String = "HopMain",
         seed: [String: String]? = nil, onClose: @escaping (WebWindowController) -> Void) {
        self.origin = origin
        let config = configuration ?? WebWindowController.makeConfiguration()
        webView = HopWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = true
        // Safari's Web Inspector can attach (Develop menu), as in a browser.
        webView.isInspectable = true
        webView.setValue(false, forKey: "drawsBackground")
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        // A plain title bar for now: a full-height page would put the window
        // buttons over hop's sidebar strip.
        window.title = "hop"
        window.titlebarSeparatorStyle = .none
        window.minSize = NSSize(width: 520, height: 400)
        window.tabbingMode = .disallowed
        window.backgroundColor = NSColor(name: nil) { a in
            a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(red: 0.075, green: 0.071, blue: 0.094, alpha: 1) : NSColor(red: 0.97, green: 0.97, blue: 0.98, alpha: 1)
        }
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName(frameName)
        self.onClose = onClose
        super.init(window: window)
        window.delegate = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        config.userContentController.add(self, name: "hop")
        if let seed { seedSessionStorage(seed) }
        webView.load(URLRequest(url: url))
    }

    /// Give the page back the per-window state it kept when the app quit
    /// (the open panel, the side column, the overview's filter and scroll —
    /// hop keeps these in sessionStorage, which a quit empties). Set before
    /// the page's own scripts run, once per window.
    func seedSessionStorage(_ storage: [String: String]) {
        guard !storage.isEmpty, let data = try? JSONSerialization.data(withJSONObject: storage),
              let json = String(data: data, encoding: .utf8) else { return }
        let source = "(function(){try{if(sessionStorage.getItem('__hopSeeded'))return;var d=\(json);for(var k in d)sessionStorage.setItem(k,d[k]);sessionStorage.setItem('__hopSeeded','1');}catch(e){}})();"
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    /// What this window would need to come back to: its page and its
    /// per-window state. Nil for a page that is not hop's.
    func snapshot(_ done: @escaping (SavedWindow?) -> Void) {
        guard webView.url?.scheme?.hasPrefix("http") == true else { done(nil); return }
        let js = "JSON.stringify({ path: location.pathname + location.search + location.hash, storage: Object.fromEntries(Object.keys(sessionStorage).filter(function (k) { return k !== '__hopSeeded'; }).map(function (k) { return [k, sessionStorage.getItem(k)]; })) })"
        webView.evaluateJavaScript(js) { result, _ in
            guard let s = result as? String, let d = s.data(using: .utf8),
                  let w = try? JSONDecoder().decode(SavedWindow.self, from: d) else { done(nil); return }
            done(w)
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    static func makeConfiguration() -> WKWebViewConfiguration {
        let c = WKWebViewConfiguration()
        c.websiteDataStore = dataStore
        c.applicationNameForUserAgent = "Version/26.0 Safari/605.1.15 HopMac/\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1")"
        c.preferences.isElementFullscreenEnabled = true
        c.preferences.javaScriptCanOpenWindowsAutomatically = true
        // The web app's hook into the shell: window.hopNative says it is
        // running here (and which build); messages come back on "hop".
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1"
        let marker = WKUserScript(source: "window.hopNative = { platform: 'mac', version: '\(version)', post: function (m) { try { window.webkit.messageHandlers.hop.postMessage(m); } catch (e) {} } };",
                                  injectionTime: .atDocumentStart, forMainFrameOnly: true)
        c.userContentController.addUserScript(marker)
        return c
    }

    func load(_ url: URL) { webView.load(URLRequest(url: url)) }
    /// The daemon moved (another port): its pages are still hop's.
    func retarget(origin: URL) { self.origin = origin }

    func windowWillClose(_ notification: Notification) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "hop")
        onClose?(self)
        onClose = nil
    }

    // MARK: - Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let kind = m["type"] as? String else { return }
        switch kind {
        case "badge":
            let n = (m["count"] as? Int) ?? 0
            NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
        case "start-daemon":
            (NSApp.delegate as? AppDelegate)?.startLocalDaemon()
        case "retry":
            (NSApp.delegate as? AppDelegate)?.connect()
        default: break
        }
    }

    // MARK: - Navigation

    private func isHop(_ url: URL) -> Bool {
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return true }
        if url.host == origin.host && url.port == origin.port && url.scheme == origin.scheme { return true }
        // This Mac's hop, wherever it is listening now, is always the app's.
        if ServerChoice.current == .local, let d = LocalDaemon.read(), url.host == "127.0.0.1", url.port == d.port { return true }
        return false
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload { decisionHandler(.download); return }
        // Only the main frame's own pages stay here; a link elsewhere (a
        // paper, GitHub, a Nebula on another host) opens in the browser.
        if action.targetFrame?.isMainFrame != false, !isHop(url), url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        if url.scheme == "mailto" || url.scheme == "tel" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = response.response as? HTTPURLResponse,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition"), disposition.lowercased().hasPrefix("attachment") {
            decisionHandler(.download)
            return
        }
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Log.note("loaded \(webView.url?.absoluteString ?? "-")")
        // hop's own login page, on this Mac's hop: the app lost its login.
        if webView.title == "Verify Identity", webView.url?.host == "127.0.0.1" {
            (NSApp.delegate as? AppDelegate)?.landedOnLoginPage()
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Log.note("load failed: \(error.localizedDescription)")
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Log.note("could not open \(webView.url?.absoluteString ?? "-"): \(error.localizedDescription)")
    }

    // MARK: - Downloads: to ~/Downloads, never over an existing file

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        let name = (suggestedFilename as NSString)
        var dest = dir.appendingPathComponent(suggestedFilename)
        var n = 1
        while FileManager.default.fileExists(atPath: dest.path) {
            n += 1
            let base = name.deletingPathExtension, ext = name.pathExtension
            dest = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
        }
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Glass")?.play()
    }

    // MARK: - What a browser provides

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        // hop's own page "in a new tab" (a session, a view): a new hop window.
        if isHop(url) {
            let controller = (NSApp.delegate as? AppDelegate)?.openWindow(url: url, configuration: configuration)
            return controller?.webView
        }
        NSWorkspace.shared.open(url)
        return nil
    }

    func webViewDidClose(_ webView: WKWebView) { window?.close() }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        present(alert) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        present(alert) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        present(alert) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        guard let window else { completionHandler(nil); return }
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    private func present(_ alert: NSAlert, then done: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window { alert.beginSheetModal(for: window, completionHandler: done) } else { done(alert.runModal()) }
    }
}

/// A line in the app's log (Console.app, or stderr when run from a terminal).
enum Log {
    static func note(_ line: String) { FileHandle.standardError.write(Data("[hop] \(line)\n".utf8)) }
}

/// The web view, plus the one thing a page cannot do: know where a dragged
/// file is. Browsers never tell a page a dropped file's path, so hop copied
/// every dropped file up to the host — slow enough to feel frozen. As files
/// are dragged over the window their real paths are handed to the page
/// (window.__hopDragPaths), before its own drop event; the page passes them
/// to the daemon, which checks each is there (same name and size) and pastes
/// that path instead of copying the file.
final class HopWebView: WKWebView {
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                                                         options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        let paths = urls.filter { $0.isFileURL }.map { $0.path }
        if !paths.isEmpty, let data = try? JSONSerialization.data(withJSONObject: paths),
           let json = String(data: data, encoding: .utf8) {
            evaluateJavaScript("window.__hopDragPaths = \(json);", completionHandler: nil)
        }
        return super.draggingEntered(sender)
    }
}

/// One window as it was when the app quit (see AppDelegate's restore).
struct SavedWindow: Codable {
    let path: String
    let storage: [String: String]
}
