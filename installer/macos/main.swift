// OpenDub for macOS: the free voice, installed by double-clicking.
//
// The app is a launcher with an installer in front of it. On first run it
// fetches uv, then a Python, then OpenDub and the voice, into Application
// Support — nothing needs the Terminal, admin rights or a package manager.
// On every run after that it starts the local server and opens opendub.app,
// which finds it on 127.0.0.1 and dubs with it.
//
// Quitting stops the server: the process is a child of this app, so there is
// no daemon left behind and nothing to clean up later.

import SwiftUI
import AppKit

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

    var installed: Bool { FileManager.default.isExecutableFile(atPath: Paths.python.path) }

    func start() {
        phase = .checking
        if installed {
            // Freshen the program before starting it. Without this, a fix we
            // publish never reaches anyone who already installed.
            Task { await update(); await startServer() }
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
    }

    // ---------------------------------------------------------------- the server

    func startServer() async {
        await set("Starting…", "", fraction: nil)
        let task = Process()
        task.executableURL = Paths.venv.appending(path: "bin/uvicorn")
        task.arguments = ["opendub.server:app", "--host", "127.0.0.1", "--port", String(Paths.port)]
        task.currentDirectoryURL = Paths.app
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
                    detail = "Go to opendub.app, choose the free voice, and press “Look for the app on this computer”."
                    fraction = nil
                }
                NSWorkspace.shared.open(URL(string: Paths.site)!)
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

    var body: some View {
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
                case .running:
                    Button("Open opendub.app") { NSWorkspace.shared.open(URL(string: Paths.site)!) }
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

            if installer.phase == .running {
                Text("Keep this app open while you dub. Quitting stops it.")
                    .font(.system(size: 11)).foregroundStyle(.tertiary)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { installer.start() }
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
        .windowResizability(.contentSize)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var installer: Installer?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        installer?.stopServer()          // no daemon left behind
    }
}
