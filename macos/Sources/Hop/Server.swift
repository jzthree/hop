import Foundation
import Security

// Where the window points, and how it gets in.
//
// "This Mac" (the default) is the hop daemon on this machine, reached on
// its own loopback port — never through the public tunnel, so typing does
// not make a round trip through the internet. The app signs itself in the
// way the hop CLI does: the daemon secret in ~/.hop2/.tunnel-state lets it
// mint a device session ("hop for Mac"), kept in the Keychain and set as
// the login cookie. A remote hop (e.g. https://hop.example.org) is used like
// a browser would: its own login page, its cookie kept by the web view.

enum ServerChoice: Equatable {
    case local
    case remote(URL)

    static let defaultsKey = "server"

    static var current: ServerChoice {
        get {
            if let s = UserDefaults.standard.string(forKey: defaultsKey), let u = URL(string: s), u.scheme?.hasPrefix("http") == true {
                return .remote(u)
            }
            return .local
        }
        set {
            switch newValue {
            case .local: UserDefaults.standard.removeObject(forKey: defaultsKey)
            case .remote(let u): UserDefaults.standard.set(u.absoluteString, forKey: defaultsKey)
            }
        }
    }
}

struct LocalDaemon {
    let port: Int
    let secret: String

    var base: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    static var hopHome: URL {
        if let h = ProcessInfo.processInfo.environment["HOP_HOME"], !h.isEmpty { return URL(fileURLWithPath: h) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".hop2")
    }

    /// The running daemon's port and secret, from the file it writes at start.
    static func read() -> LocalDaemon? {
        let url = hopHome.appendingPathComponent(".tunnel-state")
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let secret = obj["sessionSecret"] as? String, !secret.isEmpty else { return nil }
        let port = (obj["port"] as? Int) ?? Int(obj["port"] as? String ?? "") ?? 0
        return port > 0 ? LocalDaemon(port: port, secret: secret) : nil
    }

    /// Is it answering?
    func isUp() async -> Bool {
        var req = URLRequest(url: base.appendingPathComponent("health"))
        req.timeoutInterval = 2
        guard let (_, resp) = try? await URLSession.shared.data(for: req) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }

    enum TokenCheck { case ok, rejected, unreachable }

    /// Does this device token still open hop — and if not, did hop say no,
    /// or not answer (still starting after a restart)? Only a "no" is a
    /// reason to mint a new one.
    func check(_ token: String) async -> TokenCheck {
        var req = URLRequest(url: base.appendingPathComponent("api/auth"))
        req.timeoutInterval = 4
        // This cookie, not whatever the shared cookie jar holds.
        req.httpShouldHandleCookies = false
        req.setValue("tunnel_session=\(token)", forHTTPHeaderField: "Cookie")
        guard let (_, resp) = try? await URLSession.shared.data(for: req), let http = resp as? HTTPURLResponse else { return .unreachable }
        switch http.statusCode {
        case 200: return .ok
        case 401, 403: return .rejected
        default: return .unreachable
        }
    }

    /// A new device session for this app, minted with the daemon secret (as `hop auth token` does).
    func mintToken() async -> String? {
        var req = URLRequest(url: base.appendingPathComponent("api/auth/sessions/token"))
        req.httpMethod = "POST"
        req.timeoutInterval = 6
        req.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("cli", forHTTPHeaderField: "x-hop-via")
        req.httpShouldHandleCookies = false
        let host = Host.current().localizedName ?? "Mac"
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["label": "hop for Mac · \(host)"])
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = obj["token"] as? String else { return nil }
        return token
    }

    /// A working token: the Keychain's if hop still takes it, else a new
    /// one. Patient with a hop that is still coming up (right after a
    /// restart it answers /health before it answers sign-ins): it retries
    /// for a while instead of falling through to the login page.
    func signIn(attempts: Int = 20) async -> String? {
        var daemon = self
        for attempt in 0..<attempts {
            if attempt > 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                // A restart writes a new secret (and maybe a port): read it again.
                if let fresh = LocalDaemon.read() { daemon = fresh }
            }
            if let saved = Keychain.read() {
                let verdict = await daemon.check(saved)
                Log.note("sign-in attempt \(attempt + 1): saved login \(verdict)")
                switch verdict {
                case .ok: return saved
                case .unreachable: continue
                case .rejected: break
                }
            }
            let minted = await daemon.mintToken()
            Log.note("sign-in attempt \(attempt + 1): new login \(minted == nil ? "refused" : "minted")")
            if let fresh = minted {
                Keychain.write(fresh)
                return fresh
            }
        }
        return nil
    }
}

/// The app's device token, in the login Keychain (never on disk in the clear).
enum Keychain {
    private static let service = "hop for Mac"
    private static let account = "local-device-token"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func read() -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ token: String) {
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    static func clear() { SecItemDelete(query as CFDictionary) }
}

/// The `hop` command, as the user's login shell finds it.
enum HopCLI {
    /// Start the daemon, detached: it outlives the app (quitting hop for Mac
    /// never stops a session). Readiness is the caller's to poll.
    static func start() -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "command -v hop >/dev/null || exit 127; nohup hop start >/dev/null 2>&1 &"]
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus == 0 } catch { return false }
    }
}
