// OpenDub for macOS: the free voice, installed by double-clicking.
//
// The app is a launcher with an installer in front of it. On first run it
// fetches uv, then a Python, then OpenDub and the voice, into Application
// Support — nothing needs the Terminal, admin rights or a package manager.
// On every run after that it starts the local server and shows the dubbing
// interface in its own window. The interface is the one the server itself
// serves, so none of the browser's rules apply to it: no permission to ask
// for before reaching 127.0.0.1, nothing cached for a week, no model to
// download into a tab, no graphics-card limits. The work happens in Python,
// on this machine.
//
// Quitting stops the server: the process is a child of this app, so there is
// no daemon left behind and nothing to clean up later.

import SwiftUI
import AppKit
import WebKit

// ---------------------------------------------------------------- where things live

enum Paths {
    static let home = FileManager.default.homeDirectoryForCurrentUser
    static let root = home.appending(path: "Library/Application Support/OpenDub")
    static let app = root.appending(path: "app")            // the program
    static let uv = root.appending(path: "bin/uv")          // fetches Python and the packages
    static let venv = app.appending(path: ".venv")
    static let python = venv.appending(path: "bin/python")
    static let site = "https://opendub.app"
    static let port = 8910

    /// What the full build carries inside itself.
    ///
    /// The ordinary build fetches uv, then a Python, then a gigabyte of
    /// packages the first time it runs — three things that can fail on a
    /// machine none of us can see. The full one has no first run: its Python,
    /// its packages, ffmpeg and the pipeline that runs in the page are all in
    /// Resources, and nothing is downloaded.
    static let payload = Bundle.main.resourceURL?.appending(path: "payload")
    static var bundledPython: URL? { payload?.appending(path: "python/bin/python3") }
    static var bundledSite: URL? { payload?.appending(path: "site-packages") }
    static var bundledFfmpeg: URL? { payload?.appending(path: "ffmpeg") }
    static var bundledApp: URL? { payload?.appending(path: "app") }

    static var isBundled: Bool {
        guard let py = bundledPython, let site = bundledSite else { return false }
        let fm = FileManager.default
        return fm.isExecutableFile(atPath: py.path) && fm.fileExists(atPath: site.path)
    }
}

// ---------------------------------------------------------------- running other programs

/// Runs a command, streaming every line it prints to `onLine`.
@discardableResult
func run(_ launch: URL, _ args: [String], cwd: URL? = nil,
         env: [String: String] = [:], onLine: @escaping (String) -> Void) throws -> Int32 {
    let task = Process()
    task.executableURL = launch
    task.arguments = args
    if let cwd { task.currentDirectoryURL = cwd }
    if !env.isEmpty {
        var e = ProcessInfo.processInfo.environment
        env.forEach { e[$0] = $1 }
        task.environment = e
    }
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = pipe

    var buffer = Data()
    pipe.fileHandleForReading.readabilityHandler = { handle in
        buffer.append(handle.availableData)
        while let i = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[..<i], as: UTF8.self)
            buffer.removeSubrange(...i)
            if !line.trimmingCharacters(in: .whitespaces).isEmpty { onLine(line) }
        }
    }
    try task.run()
    task.waitUntilExit()
    pipe.fileHandleForReading.readabilityHandler = nil
    return task.terminationStatus
}

/// Downloads a file, reporting 0…1 as it goes.
func download(_ from: URL, to: URL, progress: @escaping (Double) -> Void) async throws {
    let (temp, response) = try await URLSession.shared.download(from: from, delegate: nil)
    if let http = response as? HTTPURLResponse, http.statusCode != 200 {
        throw Failure("\(from.lastPathComponent) could not be downloaded (\(http.statusCode)).")
    }
    try? FileManager.default.removeItem(at: to)
    try FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.moveItem(at: temp, to: to)
    progress(1)
}

struct Failure: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

// ---------------------------------------------------------------- the work

@MainActor
final class Installer: ObservableObject {
    enum Phase { case checking, needsInstall, working, running, failed }

    @Published var phase: Phase = .checking
    @Published var status = ""
    @Published var detail = ""
    @Published var fraction: Double? = nil      // nil = indeterminate
    @Published var log: [String] = []
    private var server: Process?

    var installed: Bool {
        Paths.isBundled || FileManager.default.isExecutableFile(atPath: Paths.python.path)
    }

    func start() {
        phase = .checking
        if installed {
            // Freshen the program before starting it. Without this, a fix we
            // publish never reaches anyone who already installed.
            // A build that carries everything has nothing to update and
            // nothing to fetch: start, and be running in a second.
            Task {
                if !Paths.isBundled { await update() }
                await startServer()
            }
        } else {
            phase = .needsInstall
            status = "OpenDub is not on this Mac yet."
            detail = "About 2 GB, a few minutes. It all goes in your own user folder."
        }
    }

    func note(_ line: String) {
        log.append(line)
        if log.count > 400 { log.removeFirst(log.count - 400) }
    }

    func install() {
        phase = .working
        fraction = nil
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                try await self?.doInstall()
                await self?.startServer()
            } catch {
                await MainActor.run {
                    self?.phase = .failed
                    self?.status = "That did not finish."
                    self?.detail = error.localizedDescription
                }
            }
        }
    }

    private func set(_ s: String, _ d: String = "", fraction f: Double? = nil) async {
        await MainActor.run { self.status = s; if !d.isEmpty { self.detail = d }; self.fraction = f }
    }

    private func doInstall() async throws {
        let fm = FileManager.default
        try fm.createDirectory(at: Paths.root.appending(path: "bin"), withIntermediateDirectories: true)

        // 1. uv — one small binary that can fetch a Python of its own, so this
        //    works on a Mac with no developer tools installed at all.
        if !fm.isExecutableFile(atPath: Paths.uv.path) {
            await set("Getting the installer…", "uv, about 15 MB", fraction: 0.05)
            #if arch(arm64)
            let name = "uv-aarch64-apple-darwin"
            #else
            let name = "uv-x86_64-apple-darwin"
            #endif
            let tgz = Paths.root.appending(path: "uv.tar.gz")
            try await download(URL(string: "https://github.com/astral-sh/uv/releases/latest/download/\(name).tar.gz")!,
                               to: tgz) { _ in }
            _ = try run(URL(fileURLWithPath: "/usr/bin/tar"),
                        ["-xzf", tgz.path, "-C", Paths.root.appending(path: "bin").path, "--strip-components", "1"],
                        onLine: { [weak self] l in Task { @MainActor in self?.note(l) } })
            try? fm.removeItem(at: tgz)
            guard fm.isExecutableFile(atPath: Paths.uv.path) else { throw Failure("The installer could not be unpacked.") }
        }

        // 2. OpenDub itself: small, because the browser does everything but the voice.
        await set("Getting OpenDub…", "", fraction: 0.15)
        let tgz = Paths.root.appending(path: "opendub.tar.gz")
        try await download(URL(string: "\(Paths.site)/opendub.tar.gz")!, to: tgz) { _ in }
        try fm.createDirectory(at: Paths.app, withIntermediateDirectories: true)
        _ = try run(URL(fileURLWithPath: "/usr/bin/tar"),
                    ["-xzf", tgz.path, "-C", Paths.app.path, "--strip-components", "1"],
                    onLine: { [weak self] l in Task { @MainActor in self?.note(l) } })
        try? fm.removeItem(at: tgz)

        // 3. A Python of its own, so nothing on this Mac is touched or needed.
        await set("Setting up Python…", "", fraction: 0.25)
        var code = try run(Paths.uv, ["venv", "--python", "3.12", Paths.venv.path], cwd: Paths.app,
                           onLine: { [weak self] l in Task { @MainActor in self?.note(l) } })
        guard code == 0 else { throw Failure("Python could not be set up. Open Details to see why.") }

        // 4. The voice. This is the long part — pip names each package as it lands.
        await set("Installing the free voice…", "About 2 GB. This is the long part.", fraction: nil)
        code = try run(Paths.uv,
                       ["pip", "install", "--python", Paths.python.path, "-r", "requirements-voice.txt"],
                       cwd: Paths.app,
                       env: ["UV_HTTP_TIMEOUT": "600"],
                       onLine: { [weak self] l in
                           Task { @MainActor in
                               self?.note(l)
                               if l.contains("Downloading") || l.contains("Installed") || l.contains("Prepared") {
                                   self?.detail = l.trimmingCharacters(in: .whitespaces)
                               }
                           }
                       })
        guard code == 0 else { throw Failure("The voice could not be installed. Open Details to see why.") }
    }

    /// Re-fetch the program: 250 KB, seconds, and a published fix arrives on
    /// its own. The voice and Python — the parts that take minutes — are left
    /// alone. A failure is not worth stopping for; what is on disk still runs.
    func update() async {
        await set("Checking for updates…", "", fraction: nil)
        let fm = FileManager.default
        let tgz = Paths.root.appending(path: "opendub-update.tar.gz")
        do {
            try await download(URL(string: "\(Paths.site)/opendub.tar.gz")!, to: tgz) { _ in }
            let before = try? Data(contentsOf: Paths.app.appending(path: "requirements-voice.txt"))
            _ = try run(URL(fileURLWithPath: "/usr/bin/tar"),
                        ["-xzf", tgz.path, "-C", Paths.app.path, "--strip-components", "1"],
                        onLine: { [weak self] l in Task { @MainActor in self?.note(l) } })
            try? fm.removeItem(at: tgz)
            let after = try? Data(contentsOf: Paths.app.appending(path: "requirements-voice.txt"))
            if let after, after != before {
                // Only when the list itself changed: uv is quick, but a network
                // round trip on every launch is not what anyone wants.
                await set("Updating the voice…", "", fraction: nil)
                _ = try run(Paths.uv, ["pip", "install", "--python", Paths.python.path, "-r", "requirements-voice.txt"],
                            cwd: Paths.app, env: ["UV_HTTP_TIMEOUT": "600"],
                            onLine: { [weak self] l in Task { @MainActor in self?.note(l) } })
            }
        } catch {
            await MainActor.run { note("Update skipped: \(error.localizedDescription)") }
        }
        await ensurePipeline()
    }

    /// The pipeline the page runs in itself, which is what makes this free.
    ///
    /// It lives in its own archive because the program above is fetched on
    /// every launch and this is twenty-one megabytes. The checksum beside it
    /// is a few bytes, so asking "is mine the one you are serving?" costs
    /// nothing and the answer is almost always yes.
    ///
    /// Without it the page asks its own origin for the pipeline, gets a 404,
    /// and the only route left is the one that needs a key.
    private func ensurePipeline() async {
        let marker = Paths.app.appending(path: "web/browser/.sha256")
        let have = (try? String(contentsOf: marker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let want = try? await text("\(Paths.site)/opendub-browser.sha256"),
              !want.isEmpty else { return }           // offline: keep what we have
        if have == want, FileManager.default.fileExists(atPath: Paths.app.appending(path: "web/browser/opendub-browser.js").path) {
            return
        }
        await set("Fetching the dubbing pipeline…", "21 MB, once.", fraction: 0)
        let tgz = Paths.root.appending(path: "browser.tar.gz")
        do {
            try await download(URL(string: "\(Paths.site)/opendub-browser.tar.gz")!, to: tgz) { [weak self] f in
                Task { @MainActor in self?.fraction = f }
            }
            let web = Paths.app.appending(path: "web")
            try? FileManager.default.createDirectory(at: web, withIntermediateDirectories: true)
            _ = try run(URL(fileURLWithPath: "/usr/bin/tar"), ["-xzf", tgz.path, "-C", web.path], onLine: { _ in })
            try? FileManager.default.removeItem(at: tgz)
            try? want.write(to: marker, atomically: true, encoding: .utf8)
        } catch {
            await MainActor.run { note("The pipeline could not be fetched: \(error.localizedDescription)") }
        }
    }

    private func text(_ url: String) async throws -> String {
        var request = URLRequest(url: URL(string: url)!)
        request.timeoutInterval = 10
        let (data, _) = try await URLSession.shared.data(for: request)
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // ---------------------------------------------------------------- the server

    func startServer() async {
        await set("Starting…", "", fraction: nil)
        // A server already on the port is not necessarily the one just
        // installed. For three days a process from an older install held it:
        // every start failed to bind, the health check saw the old one
        // answering and reported success, and every fix shipped in that time
        // sat on disk unread. Ask whoever is there to stand down first — only
        // this program answers that — and wait for the port to go quiet.
        if await healthy() {
            note("A copy of OpenDub was already running; replacing it.")
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(Paths.port)/api/local/quit")!)
            request.httpMethod = "POST"
            request.timeoutInterval = 3
            _ = try? await URLSession.shared.data(for: request)
            for _ in 0..<40 {
                try? await Task.sleep(for: .milliseconds(250))
                if await !healthy() { break }
            }
        }
        let task = Process()
        if Paths.isBundled, let py = Paths.bundledPython, let site = Paths.bundledSite,
           let ff = Paths.bundledFfmpeg, let app = Paths.bundledApp {
            // Its own Python, its own packages, its own ffmpeg. Nothing is
            // looked for on the machine and nothing is fetched.
            task.executableURL = py
            task.arguments = ["-m", "uvicorn", "opendub.server:app", "--host", "127.0.0.1", "--port", String(Paths.port)]
            task.currentDirectoryURL = app
            var env = ProcessInfo.processInfo.environment
            env["PYTHONPATH"] = site.path
            env["PATH"] = ff.path + ":" + (env["PATH"] ?? "/usr/bin:/bin")
            env["PYTHONHOME"] = ""
            env.removeValue(forKey: "PYTHONHOME")
            task.environment = env
        } else {
        task.executableURL = Paths.venv.appending(path: "bin/uvicorn")
        task.arguments = ["opendub.server:app", "--host", "127.0.0.1", "--port", String(Paths.port)]
        task.currentDirectoryURL = Paths.app
        }
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let text = String(decoding: h.availableData, as: UTF8.self)
            for line in text.split(separator: "\n") {
                Task { @MainActor in self?.note(String(line)) }
            }
        }
        do { try task.run() } catch {
            await MainActor.run {
                phase = .failed
                status = "OpenDub could not start."
                detail = error.localizedDescription
            }
            return
        }
        server = task

        // Wait for it to answer rather than assuming it did.
        for _ in 0..<60 {
            try? await Task.sleep(for: .milliseconds(500))
            if await healthy() {
                await MainActor.run {
                    phase = .running
                    status = "OpenDub is running on this Mac."
                    detail = ""
                    fraction = nil
                }
                return
            }
        }
        await MainActor.run {
            phase = .failed
            status = "OpenDub started but did not answer."
            detail = "Open Details to see what it printed."
        }
    }

    private func healthy() async -> Bool {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(Paths.port)/api/local/health")!)
        request.timeoutInterval = 2
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return false }
        return http.statusCode == 200
    }

    func stopServer() {
        server?.terminate()
        server = nil
    }
}

// ---------------------------------------------------------------- the window

struct ContentView: View {
    @ObservedObject var installer: Installer
    @State private var showLog = false

    /// Installing is a panel; running is the product. Once the server
    /// answers there is nothing left to say, so the window gives itself over
    /// to the interface instead of explaining where to go and find it.
    var body: some View {
        if installer.phase == .running {
            DubUI(url: URL(string: "http://127.0.0.1:\(Paths.port)/")!)
                .frame(minWidth: 940, minHeight: 680)
                .onAppear { NSApp.windows.first?.setContentSize(NSSize(width: 1080, height: 760)) }
        } else {
            panel
        }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "waveform")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 1) {
                    Text("OpenDub").font(.system(size: 17, weight: .semibold))
                    Text("The free voice, on this Mac").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }

            Divider()

            Text(installer.status).font(.system(size: 13, weight: .medium))
            if !installer.detail.isEmpty {
                Text(installer.detail).font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if installer.phase == .working {
                if let f = installer.fraction {
                    ProgressView(value: f).progressViewStyle(.linear)
                } else {
                    ProgressView().progressViewStyle(.linear)
                }
            }

            HStack {
                switch installer.phase {
                case .needsInstall:
                    Button("Install OpenDub") { installer.install() }
                        .keyboardShortcut(.defaultAction)
                case .failed:
                    Button("Try again") { installer.install() }
                default:
                    EmptyView()
                }
                Spacer()
                Button(showLog ? "Hide details" : "Details") { showLog.toggle() }
                    .buttonStyle(.link)
            }

            if showLog {
                ScrollView {
                    Text(installer.log.joined(separator: "\n"))
                        .font(.system(size: 10.5, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 150)
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }

        }
        .padding(20)
        .frame(width: 460)
        .onAppear { installer.start() }
    }
}


// ---------------------------------------------------------------- the interface

/// The dubbing interface, in this window rather than in a browser.
///
/// It is the page the local server already serves, so everything is same
/// origin and nothing has to be allowed first. Two things a web view does not
/// do on its own and the page depends on: a link that saves a file, and a link
/// that should leave the app.
struct DubUI: NSViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        view.setValue(false, forKey: "drawsBackground")
        // The app updates itself on launch, and a web view keeps its own
        // cache across restarts — so the window can come up showing the
        // interface from before the update, complete with the instructions
        // the update was meant to remove. The files come from this machine
        // over loopback, so there is nothing to save by holding them.
        let store = WKWebsiteDataStore.default()
        let caches: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache]
        store.removeData(ofTypes: caches, modifiedSince: .distantPast) {
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            view.load(request)
        }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        private static let ours: Set<String> = ["127.0.0.1", "localhost"]

        /// The product stays in the window; anything else is the web, and the
        /// web belongs in a browser. Without this, pressing a link to the
        /// account page replaces the app with a website and there is no way
        /// back.
        func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.allow) }
            if let host = url.host, !Self.ours.contains(host) {
                NSWorkspace.shared.open(url)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        /// A page asking to save a file gets a save panel. A web view ignores
        /// `download` links unless told not to, so without this the button
        /// that saves the dubbed video looks fine and does nothing.
        func webView(_ view: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(response.canShowMIMEType ? .allow : .download)
        }

        func webView(_ view: WKWebView, navigationAction: WKNavigationAction,
                     didBecome download: WKDownload) { download.delegate = self }

        func webView(_ view: WKWebView, navigationResponse: WKNavigationResponse,
                     didBecome download: WKDownload) { download.delegate = self }

        /// A page asking for a file gets an open panel. A web view does
        /// nothing at all when a file input is clicked unless this is here —
        /// the same omission as downloads, one step earlier: press "Choose a
        /// video" and the window simply sits there.
        func webView(_ view: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping ([URL]?) -> Void) {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
        }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                      suggestedFilename: String,
                      completionHandler: @escaping (URL?) -> Void) {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = suggestedFilename
            panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            panel.begin { completionHandler($0 == .OK ? panel.url : nil) }
        }
    }
}

@main
struct OpenDubApp: App {
    @StateObject private var installer = Installer()
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

    var body: some Scene {
        Window("OpenDub", id: "main") {
            ContentView(installer: installer)
                .onAppear { delegate.installer = installer }
        }
        .windowResizability(.contentMinSize)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var installer: Installer?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        installer?.stopServer()          // no daemon left behind
    }
}
