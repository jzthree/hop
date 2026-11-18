import AppKit
import WebKit

// A hop page opening another hop page in a new window, as the app does it,
// with nothing on screen: the windows are made but never shown.
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let origin = URL(string: "http://127.0.0.1:\(CommandLine.arguments[1])/")!

final class Opener: NSObject, WKUIDelegate {
    var popup: WebWindowController?
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        print("popup shares the opener's content controller: \(configuration.userContentController === webView.configuration.userContentController)")
        // What AppDelegate.openWindow does, short of showing the window.
        let w = WebWindowController(url: action.request.url!, origin: origin, configuration: configuration, frameName: "HarnessPopup") { _ in }
        popup = w
        return w.webView
    }
}

let opener = WebWindowController(url: origin.appendingPathComponent("opener.html"), origin: origin, frameName: "HarnessMain") { _ in }
let ui = Opener()
opener.webView.uiDelegate = ui

func waitFor(_ label: String, _ want: String, _ then: @escaping () -> Void, tries: Int = 200) {
    if NSApp.dockTile.badgeLabel == want { print("ok: \(label)"); then(); return }
    if tries == 0 { print("FAIL: \(label) (badge \(NSApp.dockTile.badgeLabel ?? "nil"))"); exit(1) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { waitFor(label, want, then, tries: tries - 1) }
}

waitFor("the new window's page reaches the app", "7") {
    ui.popup?.window?.close()
    ui.popup = nil
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        opener.webView.evaluateJavaScript("window.hopNative.post({ type: 'badge', count: 3 }); 1") { _, _ in }
        waitFor("the first window still reaches the app after the new one closed", "3") { exit(0) }
    }
}
app.run()
