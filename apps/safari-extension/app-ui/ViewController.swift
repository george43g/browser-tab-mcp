//
//  ViewController.swift
//  Browser Tab Helper
//
//  ⚠️ OVERLAY SOURCE — this file is TRACKED at
//  `apps/safari-extension/app-ui/ViewController.swift` and copied into the
//  GENERATED Xcode project by `scripts/overlay-app-ui.sh` on every
//  `convert` and every `sideload`. The copy inside `xcode/` is gitignored
//  and is overwritten on the next build, so edit the tracked file, never
//  the generated one.
//
//  What this replaces: the stock converter template, which showed one
//  unconditional "Quit and Open Safari Settings…" button and nothing else.
//  This version resolves a real status — is the extension enabled, is the
//  daemon reachable, and is the bundle Safari is RUNNING the same one this
//  app SHIPS — and shows the control that matches.
//

import Cocoa
import Darwin
import SafariServices
import WebKit

let extensionBundleIdentifier = "com.george43g.browser-tab-helper.Extension"

// MARK: - Daemon IPC

/// One NDJSON request/response against the daemon's unix socket.
///
/// Protocol (`apps/browser-tab-mcp/src/daemon/ipc-server.ts`): one JSON
/// object per line — request `{id, method}`, response `{id, ok, result}`.
/// A dozen lines of POSIX beats shelling out to the CLI: no dependency on
/// where `browser-tab` happens to be installed on this machine, and no
/// subprocess to leave behind if the daemon is wedged.
enum DaemonIPC {

    struct Failure: Error {
        let reason: String
    }

    /// The daemon's socket lives under the user's REAL home.
    ///
    /// Under App Sandbox `NSHomeDirectory()` answers with the app's container
    /// (`~/Library/Containers/…/Data`), which is not where the daemon writes.
    /// `getpwuid` is not rewritten by the sandbox, so it is the one reading
    /// that is correct in a sandboxed AND an unsandboxed build — which
    /// matters because this app has shipped as both.
    static func socketPath() -> String {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir {
            return String(cString: dir) + "/.browser-tab/daemon.sock"
        }
        return NSHomeDirectory() + "/.browser-tab/daemon.sock"
    }

    private static func errnoText() -> String {
        String(cString: strerror(errno))
    }

    /// Ask the daemon for its status. Blocking — call it off the main thread.
    static func status(timeoutSeconds: Int32 = 2) -> Result<[String: Any], Failure> {
        let path = socketPath()

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            return .failure(Failure(reason: "socket(): \(errnoText())"))
        }
        defer { close(fd) }

        var tv = timeval(tv_sec: Int(timeoutSeconds), tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count < capacity else {
            return .failure(Failure(reason: "socket path is longer than sun_path (\(capacity))"))
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: pathBytes)
            raw[pathBytes.count] = 0
        }

        let connected = withUnsafePointer(to: &addr) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            return .failure(Failure(reason: "connect(\(path)): \(errnoText())"))
        }

        let request = Array("{\"id\":1,\"method\":\"status\"}\n".utf8)
        var sent = 0
        while sent < request.count {
            let wrote = request.withUnsafeBytes { buffer -> Int in
                guard let base = buffer.baseAddress else { return -1 }
                return send(fd, base.advanced(by: sent), request.count - sent, 0)
            }
            guard wrote > 0 else {
                return .failure(Failure(reason: "send(): \(errnoText())"))
            }
            sent += wrote
        }

        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        var accumulated = [UInt8]()
        while !accumulated.contains(0x0A) {
            let read = recv(fd, &chunk, chunk.count, 0)
            if read < 0 {
                return .failure(Failure(reason: "recv(): \(errnoText())"))
            }
            if read == 0 { break }
            accumulated.append(contentsOf: chunk[0..<read])
            // The status payload is small; this only guards a wedged peer.
            if accumulated.count > 8 * 1024 * 1024 { break }
        }

        guard let newline = accumulated.firstIndex(of: 0x0A) else {
            return .failure(Failure(reason: "daemon closed the socket without a reply"))
        }
        let line = Data(accumulated[..<newline])
        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            return .failure(Failure(reason: "daemon reply was not JSON"))
        }
        guard object["ok"] as? Bool == true else {
            return .failure(Failure(reason: (object["error"] as? String) ?? "daemon reported an error"))
        }
        guard let result = object["result"] as? [String: Any] else {
            return .failure(Failure(reason: "daemon reply carried no result"))
        }
        return .success(result)
    }
}

// MARK: - Bundled extension identity

/// What THIS app bundle ships, read out of its own `.appex`.
///
/// The build stamp (`<semver>+<count>.<sha>`) is frozen into `background.js`
/// at build time by `scripts/build-stamp.mjs`, and it is the same string the
/// extension hands the daemon in its `hello`. Comparing it against what the
/// daemon reports is therefore an EXACT answer to "is Safari running this
/// build" — the manifest's bare semver cannot tell two builds of one release
/// apart, which is precisely how a stale bundle keeps reporting a plausible
/// version.
enum BundledExtension {

    private static let stampPattern =
        #"[0-9]+\.[0-9]+\.[0-9]+\+[0-9]+\.[0-9A-Za-z]+(?:\.dirty\.[0-9A-Za-z]+)?"#

    private static func appexResources() -> URL? {
        guard let plugins = Bundle.main.builtInPlugInsURL,
              let entries = try? FileManager.default.contentsOfDirectory(
                  at: plugins, includingPropertiesForKeys: nil)
        else { return nil }
        for entry in entries where entry.pathExtension == "appex" {
            return entry.appendingPathComponent("Contents/Resources")
        }
        return nil
    }

    /// The build stamp baked into the bundled `background.js`, if present.
    static func stamp() -> String? {
        guard let resources = appexResources() else { return nil }
        let script = resources.appendingPathComponent("background.js")
        guard let text = try? String(contentsOf: script, encoding: .utf8) else { return nil }
        guard let regex = try? NSRegularExpression(pattern: stampPattern) else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: range),
              let matched = Range(match.range, in: text)
        else { return nil }
        return String(text[matched])
    }

    /// The bare semver from the bundled manifest — the fallback, and what
    /// Safari itself shows in Settings → Extensions.
    static func manifestVersion() -> String? {
        guard let resources = appexResources() else { return nil }
        let manifest = resources.appendingPathComponent("manifest.json")
        guard let data = try? Data(contentsOf: manifest),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object["version"] as? String
    }
}

// MARK: - The resolved status

/// The states this window can be in. Exactly one of them shows the
/// "Quit and Open Safari Settings…" button: `extensionOff`. Everything else
/// gets "Check Again", because nothing else is fixed by restarting Safari.
enum AppState: String {
    case checking
    case extensionOff
    case extensionUnknown
    case daemonUnreachable
    case notConnected
    case stale
    case healthy
}

struct StatusReport {
    var state: AppState
    var bundledVersion: String?
    var liveVersion: String?
    var daemonBuild: String?
    var detail: String?

    func payload() -> [String: Any] {
        var out: [String: Any] = ["state": state.rawValue]
        if let bundledVersion { out["bundled"] = bundledVersion }
        if let liveVersion { out["live"] = liveVersion }
        if let daemonBuild { out["daemon"] = daemonBuild }
        if let detail { out["detail"] = detail }
        return out
    }
}

// MARK: - View controller

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    /// Bounded re-checks after a non-terminal result. Safari picks a rebuilt
    /// `.appex` up on its own within ~15s of the container app relaunching
    /// (measured — see `scripts/rebuild.sh`), so a window opened by
    /// `sideload` is usually looking at a stale reading that fixes itself.
    /// A short backoff catches that without becoming a poller.
    private static let retryBackoff: [TimeInterval] = [3, 8, 20]
    private var scheduledRetries: [DispatchWorkItem] = []
    private var pageIsReady = false

    override func viewDidLoad() {
        super.viewDidLoad()

        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "controller")
        webView.loadFileURL(
            Bundle.main.url(forResource: "Main", withExtension: "html")!,
            allowingReadAccessTo: Bundle.main.resourceURL!)

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationBecameActive),
            name: NSApplication.didBecomeActiveNotification,
            object: nil)
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        // The stock storyboard window is 425×325 — enough for one sentence and
        // one button, not for a version block. Grow it here rather than in the
        // storyboard, which the converter regenerates.
        if let window = view.window {
            window.styleMask.insert(.resizable)
            window.setContentSize(NSSize(width: 460, height: 430))
            window.contentMinSize = NSSize(width: 380, height: 340)
            window.center()
        }
    }

    @objc private func applicationBecameActive() {
        guard pageIsReady else { return }
        refresh()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageIsReady = true
        refresh()
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? String else { return }
        switch body {
        case "open-settings":
            SFSafariApplication.showPreferencesForExtension(
                withIdentifier: extensionBundleIdentifier
            ) { _ in
                DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
            }
        case "retry":
            refresh()
        default:
            break
        }
    }

    // MARK: Status resolution

    private func cancelScheduledRetries() {
        for item in scheduledRetries { item.cancel() }
        scheduledRetries.removeAll()
    }

    private func refresh() {
        cancelScheduledRetries()
        render(StatusReport(state: .checking))
        resolve { [weak self] report in
            guard let self else { return }
            self.render(report)
            switch report.state {
            case .stale, .notConnected, .daemonUnreachable:
                self.scheduleRetries()
            default:
                break
            }
        }
    }

    private func scheduleRetries() {
        for delay in Self.retryBackoff {
            let item = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.resolve { report in
                    self.render(report)
                    // A settled result ends the backoff early.
                    if report.state == .healthy || report.state == .extensionOff {
                        self.cancelScheduledRetries()
                    }
                }
            }
            scheduledRetries.append(item)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        }
    }

    /// Ask Safari whether the extension is on, then ask the daemon what it
    /// sees, then decide. Always calls back on the main queue.
    private func resolve(_ completion: @escaping (StatusReport) -> Void) {
        let bundled = BundledExtension.stamp() ?? BundledExtension.manifestVersion()

        SFSafariExtensionManager.getStateOfSafariExtension(
            withIdentifier: extensionBundleIdentifier
        ) { state, error in
            guard let state, error == nil else {
                DispatchQueue.main.async {
                    completion(StatusReport(
                        state: .extensionUnknown,
                        bundledVersion: bundled,
                        detail: error?.localizedDescription
                            ?? "Safari did not report the extension's state."))
                }
                return
            }

            if !state.isEnabled {
                DispatchQueue.main.async {
                    completion(StatusReport(state: .extensionOff, bundledVersion: bundled))
                }
                return
            }

            DispatchQueue.global(qos: .userInitiated).async {
                let report = Self.reportFromDaemon(bundled: bundled)
                DispatchQueue.main.async { completion(report) }
            }
        }
    }

    private static func reportFromDaemon(bundled: String?) -> StatusReport {
        switch DaemonIPC.status() {
        case .failure(let failure):
            return StatusReport(
                state: .daemonUnreachable,
                bundledVersion: bundled,
                detail: failure.reason)

        case .success(let result):
            let daemonBuild = result["build"] as? String
            let info = (result["extensionInfo"] as? [[String: Any]]) ?? []
            let safari = info.first { ($0["browser"] as? String) == "safari" }

            guard let safari, let live = safari["extVersion"] as? String else {
                return StatusReport(
                    state: .notConnected,
                    bundledVersion: bundled,
                    daemonBuild: daemonBuild,
                    detail: "The daemon is running but no Safari extension has connected to it.")
            }

            if let bundled, bundled != live {
                return StatusReport(
                    state: .stale,
                    bundledVersion: bundled,
                    liveVersion: live,
                    daemonBuild: daemonBuild)
            }

            return StatusReport(
                state: .healthy,
                bundledVersion: bundled,
                liveVersion: live,
                daemonBuild: daemonBuild)
        }
    }

    private func render(_ report: StatusReport) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: report.payload()),
            let json = String(data: data, encoding: .utf8)
        else { return }
        webView.evaluateJavaScript("render(\(json))")
    }
}
