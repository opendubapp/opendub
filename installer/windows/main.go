//go:build windows

// OpenDub for Windows: the free voice, installed by double-clicking.
//
// The counterpart of installer/macos/main.swift, and deliberately the same
// program in a different dialect. On first run it fetches uv, then a Python,
// then OpenDub and the voice, into %LOCALAPPDATA% — nothing needs a command
// prompt, admin rights, the registry or a package manager. On every run after
// that it starts the local server and opens opendub.app, which finds it on
// 127.0.0.1 and dubs with it.
//
// Closing the window stops the server: it is a child process in a job object
// that dies with us, so there is no service left behind and nothing to
// uninstall but one folder.
//
// The window is plain Win32 through syscall — no GUI toolkit, no modules to
// fetch — so the whole thing is one statically linked .exe you can put on a
// download page.
package main

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// ---------------------------------------------------------------- where things live

const (
	site = "https://opendub.app"
	port = 8910
)

const version = "1.0.1"

var (
	rootDir   string // %LOCALAPPDATA%\OpenDub
	binDir    string // …\bin      — uv lives here
	appDir    string // …\app      — the program
	uvExe     string // …\bin\uv.exe
	venvDir   string // …\app\.venv
	pythonExe string // …\app\.venv\Scripts\python.exe
	uvicorn   string // …\app\.venv\Scripts\uvicorn.exe
	logPath   string // …\opendub.log — every line, so a failure can be sent to us
)

func setPaths() error {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		// Only reachable on a profile so broken that nothing else would work
		// either, but a blank path would silently install into the exe's folder.
		return friendly("Windows did not say where your app data folder is, so OpenDub cannot be installed.")
	}
	rootDir = filepath.Join(local, "OpenDub")
	binDir = filepath.Join(rootDir, "bin")
	appDir = filepath.Join(rootDir, "app")
	uvExe = filepath.Join(binDir, "uv.exe")
	venvDir = filepath.Join(appDir, ".venv")
	pythonExe = filepath.Join(venvDir, "Scripts", "python.exe")
	uvicorn = filepath.Join(venvDir, "Scripts", "uvicorn.exe")
	logPath = filepath.Join(rootDir, "opendub.log")
	return nil
}

func installed() bool {
	info, err := os.Stat(pythonExe)
	return err == nil && !info.IsDir()
}

// ---------------------------------------------------------------- failures the user can read

// A failure with a sentence in it. Anything that is not one of these never
// reaches the window: a Go error struct is not an explanation.
type plainError string

func (e plainError) Error() string { return string(e) }

func friendly(format string, args ...any) error {
	return plainError(fmt.Sprintf(format, args...))
}

func sentence(err error) string {
	var p plainError
	if errors.As(err, &p) {
		return string(p)
	}
	return "Something went wrong part way through. Try again."
}

// ---------------------------------------------------------------- state the window draws

type phase int

const (
	phaseChecking phase = iota
	phaseNeedsInstall
	phaseWorking
	phaseRunning
	phaseFailed
)

var state struct {
	sync.Mutex
	phase    phase
	status   string
	detail   string
	fraction float64 // < 0 means indeterminate
	lastLine string  // the last thing a child process printed, for failure messages
}

func setState(p phase, status, detail string, fraction float64) {
	state.Lock()
	state.phase = p
	state.status = status
	if detail != "" {
		state.detail = detail
	}
	state.fraction = fraction
	state.Unlock()
	refreshLater()
}

func setDetail(detail string) {
	state.Lock()
	state.detail = detail
	state.Unlock()
	refreshLater()
}

func setFraction(f float64) {
	state.Lock()
	state.fraction = f
	state.Unlock()
	refreshLater()
}

// note records a line of child output. It is what makes a failure explainable
// without a log pane: the last thing uv said is usually the whole story.
func note(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	state.Lock()
	state.lastLine = line
	state.Unlock()
	logLine(line)
}

// logLine appends to %LOCALAPPDATA%\OpenDub\opendub.log. Keeping only the last
// line in memory left the first Windows tester with nothing to send back when
// it failed, which is how a five-minute diagnosis becomes a day of guessing.
// logDiagnostics writes what a reader of the log would otherwise have to ask
// for: which build, which machine, and whether the pieces are actually there.
func logDiagnostics() {
	logLine("---- OpenDub " + version + " starting ----")
	logLine(fmt.Sprintf("windows/%s, %d CPUs", runtime.GOARCH, runtime.NumCPU()))
	for _, p := range []struct{ what, path string }{
		{"root", rootDir}, {"uv", uvExe}, {"python", pythonExe}, {"uvicorn", uvicorn},
	} {
		if info, err := os.Stat(p.path); err == nil {
			logLine(fmt.Sprintf("%-8s %s (%d bytes)", p.what, p.path, info.Size()))
		} else {
			logLine(fmt.Sprintf("%-8s %s — MISSING", p.what, p.path))
		}
	}
}

var logMu sync.Mutex

func logLine(line string) {
	if logPath == "" {
		return
	}
	logMu.Lock()
	defer logMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s  %s\r\n", time.Now().Format("15:04:05"), line)
}

func lastLine() string {
	state.Lock()
	defer state.Unlock()
	return state.lastLine
}

// because adds the child's last words to a failure, trimmed so the window
// never has to grow a scrollbar.
func because(what string) error {
	line := lastLine()
	if line == "" {
		return friendly("%s", what)
	}
	if len(line) > 110 {
		line = line[:110] + "…"
	}
	return friendly("%s The last thing it said was: %s", what, line)
}

// ---------------------------------------------------------------- fetching things

// No overall client timeout: this downloads gigabytes over someone's home
// connection. The per-stage timeouts still catch a dead server.
var web = &http.Client{
	Transport: &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
		Proxy:                 http.ProxyFromEnvironment,
	},
}

// download fetches url to dst, calling progress with 0…1 when the server said
// how big the file is.
func download(url, dst, what string, progress func(float64)) error {
	resp, err := web.Get(url)
	if err != nil {
		return friendly("%s could not be downloaded. Check your connection and try again.", what)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return friendly("%s could not be downloaded (%d).", what, resp.StatusCode)
	}

	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return friendly("%s could not be saved to your app data folder.", what)
	}
	f, err := os.Create(dst)
	if err != nil {
		return friendly("%s could not be saved to your app data folder.", what)
	}
	defer f.Close()

	var body io.Reader = resp.Body
	if resp.ContentLength > 0 && progress != nil {
		body = io.TeeReader(resp.Body, &counter{total: resp.ContentLength, report: progress})
	}
	if _, err := io.Copy(f, body); err != nil {
		return friendly("%s stopped downloading part way through. Check your connection and try again.", what)
	}
	return f.Close()
}

// counter turns bytes written into a fraction, at most a few times a second so
// the window is not repainted for every packet.
type counter struct {
	seen   int64
	total  int64
	last   time.Time
	report func(float64)
}

func (c *counter) Write(p []byte) (int, error) {
	c.seen += int64(len(p))
	if time.Since(c.last) > 200*time.Millisecond {
		c.last = time.Now()
		c.report(float64(c.seen) / float64(c.total))
	}
	return len(p), nil
}

// ---------------------------------------------------------------- unpacking

// unzipFlat writes every file in the archive straight into dst, ignoring the
// directories inside it. uv's Windows zip is just uv.exe and uvx.exe at the
// top level, and flattening means a name with a path in it cannot escape dst.
func unzipFlat(src, dst string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return friendly("The installer could not be unpacked.")
	}
	defer r.Close()
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return friendly("The installer could not be unpacked.")
	}
	for _, entry := range r.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		name := filepath.Base(filepath.FromSlash(entry.Name))
		if name == "." || name == ".." || name == string(filepath.Separator) {
			continue
		}
		in, err := entry.Open()
		if err != nil {
			return friendly("The installer could not be unpacked.")
		}
		err = writeFile(filepath.Join(dst, name), in)
		in.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// untarStrip1 unpacks a .tar.gz into dst, dropping the single leading path
// component — what `tar --strip-components 1` does, which is what the Mac app
// and install.sh both rely on.
func untarStrip1(src, dst string) error {
	f, err := os.Open(src)
	if err != nil {
		return friendly("OpenDub could not be unpacked.")
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return friendly("OpenDub could not be unpacked — the download looks incomplete.")
	}
	defer gz.Close()

	if err := os.MkdirAll(dst, 0o755); err != nil {
		return friendly("OpenDub could not be unpacked.")
	}
	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return friendly("OpenDub could not be unpacked — the download looks incomplete.")
		}

		rel, ok := strip1(header.Name)
		if !ok {
			continue
		}
		target := filepath.Join(dst, rel)
		// Belt and braces against an archive that tries to write outside dst.
		if !strings.HasPrefix(target, dst+string(filepath.Separator)) {
			continue
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return friendly("OpenDub could not be unpacked.")
			}
		case tar.TypeReg:
			if err := writeFile(target, tr); err != nil {
				return err
			}
		default:
			// Links and devices: the archive has none, and Windows would need
			// a privilege we deliberately do not ask for.
		}
	}
}

// strip1 drops the first path component, the way tar --strip-components 1 does,
// and reports false for the archive's own root entry.
func strip1(name string) (string, bool) {
	name = strings.TrimPrefix(filepath.ToSlash(name), "./")
	parts := strings.Split(name, "/")
	var kept []string
	for _, p := range parts[1:] {
		if p == "" || p == "." || p == ".." {
			continue
		}
		kept = append(kept, p)
	}
	if len(kept) == 0 {
		return "", false
	}
	return filepath.Join(kept...), true
}

func writeFile(path string, r io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return friendly("%s could not be written.", filepath.Base(path))
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return friendly("%s could not be written.", filepath.Base(path))
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return friendly("%s could not be written.", filepath.Base(path))
	}
	return f.Close()
}

// ---------------------------------------------------------------- running other programs

// hidden is what every child process gets. HideWindow covers the case where
// Windows would show a console anyway; CREATE_NO_WINDOW stops one being
// allocated at all, which matters because this is a GUI process with no
// console of its own to inherit.
func hidden() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// run executes a command in appDir, streaming every line it prints to onLine
// so the window never looks hung during the long install.
func run(name string, args []string, env []string, onLine func(string)) (int, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = appDir
	cmd.Env = append(os.Environ(), env...)
	cmd.SysProcAttr = hidden()

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return -1, friendly("%s could not be started.", filepath.Base(name))
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return -1, friendly("%s could not be started.", filepath.Base(name))
	}
	if err := cmd.Start(); err != nil {
		return -1, friendly("%s could not be started.", filepath.Base(name))
	}

	var wg sync.WaitGroup
	wg.Add(2)
	for _, pipe := range []io.Reader{stdout, stderr} {
		go func(r io.Reader) {
			defer wg.Done()
			scanLines(r, onLine)
		}(pipe)
	}
	wg.Wait()

	if err := cmd.Wait(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode(), nil
		}
		return -1, friendly("%s stopped unexpectedly.", filepath.Base(name))
	}
	return 0, nil
}

// scanLines splits on carriage returns as well as newlines: pip and uv redraw
// a line in place, and waiting for a \n would leave the status frozen.
func scanLines(r io.Reader, onLine func(string)) {
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	s.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		for i, b := range data {
			if b == '\n' || b == '\r' {
				return i + 1, data[:i], nil
			}
		}
		if atEOF && len(data) > 0 {
			return len(data), data, nil
		}
		return 0, nil, nil
	})
	for s.Scan() {
		if line := strings.TrimSpace(s.Text()); line != "" {
			onLine(line)
		}
	}
}

// ---------------------------------------------------------------- the work

func startInstall() {
	setState(phaseWorking, "Getting ready…", "", -1)
	go func() {
		if err := doInstall(); err != nil {
			setState(phaseFailed, "That did not finish.", sentence(err), -1)
			return
		}
		startServer()
	}()
}

func doInstall() error {
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return friendly("Your app data folder could not be created. OpenDub needs %s.", rootDir)
	}

	// 1. uv — one small binary that can fetch a Python of its own, so this
	//    works on a PC with no Python and no developer tools on it at all.
	if _, err := os.Stat(uvExe); err != nil {
		setState(phaseWorking, "Getting the installer…", "uv, about 15 MB", 0.05)
		name := "uv-x86_64-pc-windows-msvc"
		if runtime.GOARCH == "arm64" {
			name = "uv-aarch64-pc-windows-msvc"
		}
		archive := filepath.Join(rootDir, "uv.zip")
		url := "https://github.com/astral-sh/uv/releases/latest/download/" + name + ".zip"
		if err := download(url, archive, "The installer", func(f float64) {
			setFraction(0.05 + 0.10*f)
		}); err != nil {
			return err
		}
		if err := unzipFlat(archive, binDir); err != nil {
			return err
		}
		os.Remove(archive)
		if _, err := os.Stat(uvExe); err != nil {
			return friendly("The installer could not be unpacked.")
		}
	}

	// 2. OpenDub itself: small, because the browser does everything but the voice.
	setState(phaseWorking, "Getting OpenDub…", "", 0.15)
	archive := filepath.Join(rootDir, "opendub.tar.gz")
	if err := download(site+"/opendub.tar.gz", archive, "OpenDub", func(f float64) {
		setFraction(0.15 + 0.08*f)
	}); err != nil {
		return err
	}
	if err := untarStrip1(archive, appDir); err != nil {
		return err
	}
	os.Remove(archive)

	// 3. A Python of its own, so nothing already on this PC is touched or needed.
	setState(phaseWorking, "Setting up Python…", "", 0.25)
	code, err := run(uvExe, []string{"venv", "--python", "3.12", ".venv"}, uvEnv, func(l string) {
		note(l)
		setDetail(l)
	})
	if err != nil {
		return err
	}
	if code != 0 {
		return because("Python could not be set up.")
	}

	// 4. The voice. This is the long part — uv names each package as it lands,
	//    which is the only reason anyone believes it is still working.
	setState(phaseWorking, "Installing the free voice…", "About 2 GB. This is the long part.", -1)
	code, err = run(uvExe,
		[]string{"pip", "install", "--python", pythonExe, "-r", "requirements-voice.txt"},
		uvEnv, func(l string) {
			note(l)
			if strings.Contains(l, "Downloading") || strings.Contains(l, "Installed") ||
				strings.Contains(l, "Prepared") || strings.Contains(l, "Resolved") {
				setDetail(l)
			}
		})
	if err != nil {
		return err
	}
	if code != 0 {
		return because("The voice could not be installed.")
	}
	return nil
}

// A long HTTP timeout because some of these wheels are hundreds of megabytes,
// and no progress bars because the output is a pipe, not a terminal.
var uvEnv = []string{"UV_HTTP_TIMEOUT=600", "UV_NO_PROGRESS=1"}

// updateProgram re-fetches the program before starting it. It is 250 KB — the
// voice and Python, the parts that take minutes, are untouched — so it costs a
// second and means a published fix arrives on its own. A failure here is not
// worth stopping for: the copy already on disk still runs.
func updateProgram() {
	setState(phaseWorking, "Checking for updates…", "", -1)
	archive := filepath.Join(rootDir, "opendub-update.tar.gz")
	if err := download(site+"/opendub.tar.gz", archive, "OpenDub", nil); err != nil {
		logLine("update: could not download, carrying on with what is here: " + err.Error())
		return
	}
	defer os.Remove(archive)
	before := requirementsHash()
	if err := untarStrip1(archive, appDir); err != nil {
		logLine("update: could not unpack, carrying on: " + err.Error())
		return
	}
	logLine("update: program refreshed")
	// Only reinstall packages when the list itself changed; uv is quick, but a
	// network round trip on every launch is not what anyone wants.
	if after := requirementsHash(); after != before && after != "" {
		setState(phaseWorking, "Updating the voice…", "", -1)
		if code, err := run(uvExe, []string{"pip", "install", "--python", pythonExe, "-r", "requirements-voice.txt"}, uvEnv, note); err != nil || code != 0 {
			logLine("update: package update did not finish; the previous set is still installed")
		}
	}
}

func requirementsHash() string {
	b, err := os.ReadFile(filepath.Join(appDir, "requirements-voice.txt"))
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%x", sha256.Sum256(b))
}

// ---------------------------------------------------------------- the server

var (
	serverMu sync.Mutex
	server   *exec.Cmd
)

func startServer() {
	setState(phaseWorking, "Starting…", "", -1)
	logDiagnostics()

	// A server already on the port is not necessarily the one just installed.
	// On a Mac a process from an older install held it for three days: every
	// start failed to bind, the health check saw the old one answering and
	// reported success, and every fix shipped in that time sat on disk unread.
	// Ask whoever is there to stand down — only this program answers that —
	// and wait for the port to go quiet.
	if healthy() {
		logLine("a copy of OpenDub was already running; asking it to stop")
		setDetail("A copy of OpenDub was already running; replacing it.")
		req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/api/local/quit", port), nil)
		if resp, err := web.Do(req); err == nil {
			resp.Body.Close()
		}
		for i := 0; i < 40 && healthy(); i++ {
			time.Sleep(250 * time.Millisecond)
		}
	}

	// The console script is the normal way in. If it is missing — a venv moved,
	// a half-finished install — the module is still there, so try that rather
	// than failing with nothing to say.
	exe, args := uvicorn, []string{"opendub.server:app", "--host", "127.0.0.1", "--port", fmt.Sprint(port)}
	if _, err := os.Stat(uvicorn); err != nil {
		exe, args = pythonExe, append([]string{"-m", "uvicorn"}, args...)
		logLine("uvicorn.exe is missing; starting with python -m uvicorn instead")
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = appDir
	cmd.SysProcAttr = hidden()
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		setState(phaseFailed, "OpenDub could not start.",
			"The local server could not be launched from your app data folder. Try again.", -1)
		return
	}
	serverMu.Lock()
	server = cmd
	serverMu.Unlock()
	adoptIntoJob(cmd)
	// Wait must not run while the pipes are still being read, or the last lines
	// — the ones that say why it stopped — are lost to a closed pipe.
	var readers sync.WaitGroup
	readers.Add(2)
	go func() { defer readers.Done(); scanLines(stdout, note) }()
	go func() { defer readers.Done(); scanLines(stderr, note) }()

	// Wait for it to answer rather than assuming it did. Three minutes, not
	// thirty seconds: on a cold Windows machine the antivirus scans every DLL
	// as Python first loads it, and the first import of numpy, soundfile and
	// fastapi out of a freshly written folder is genuinely slow. Thirty seconds
	// was our first tester's whole failure.
	exited := make(chan error, 1)
	go func() {
		readers.Wait()
		exited <- cmd.Wait()
	}()

	started := time.Now()
	for {
		select {
		case <-exited:
			// It stopped by itself, so waiting longer is pointless: say so, and
			// hand over the last thing it printed and where the rest of it is.
			setState(phaseFailed, "OpenDub stopped while starting.",
				detailWithLog(fmt.Sprintf("It ran for %d seconds and then stopped. Last line: %s",
					int(time.Since(started).Seconds()), lastLine())), -1)
			return
		case <-time.After(500 * time.Millisecond):
		}
		if healthy() {
			setState(phaseRunning, "OpenDub is running on this PC.", "", -1)
			logLine("health: answering on 127.0.0.1:" + fmt.Sprint(port))
			openLocalUI()
			return
		}
		waited := int(time.Since(started).Seconds())
		if waited >= 180 {
			break
		}
		if waited > 10 {
			// Say the seconds out loud, so a slow machine does not look stuck.
			setState(phaseWorking, "Starting…",
				fmt.Sprintf("Still starting, %d seconds in. The first start is the slow one — Windows scans each file as it is read.", waited), -1)
		}
	}
	setState(phaseFailed, "OpenDub started but did not answer.",
		detailWithLog("It was still silent on 127.0.0.1:8910 after three minutes. Last line: "+lastLine()), -1)
}

// detailWithLog puts the log's path in the message: without it, someone hitting
// this has nothing to send us but a screenshot of one sentence.
func detailWithLog(detail string) string {
	if logPath == "" {
		return detail
	}
	return detail + "  The whole log is in " + logPath
}

var health = &http.Client{Timeout: 2 * time.Second}

func healthy() bool {
	resp, err := health.Get(fmt.Sprintf("http://127.0.0.1:%d/api/local/health", port))
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func stopServer() {
	serverMu.Lock()
	if server != nil && server.Process != nil {
		server.Process.Kill()
	}
	server = nil
	serverMu.Unlock()
	closeJob() // and anything the server started, if it started anything
}

// ---------------------------------------------------------------- Win32

// Load DLLs from System32 only, so a stray user32.dll sitting next to the
// downloaded .exe cannot be picked up instead of the real one.
func init() {
	procSetDefaultDllDirectories.Call(loadLibrarySearchSystem32)
}

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	comctl32 = syscall.NewLazyDLL("comctl32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")

	procSetDefaultDllDirectories = kernel32.NewProc("SetDefaultDllDirectories")
	procGetModuleHandleW         = kernel32.NewProc("GetModuleHandleW")
	procCreateJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	procOpenProcess              = kernel32.NewProc("OpenProcess")
	procCloseHandle              = kernel32.NewProc("CloseHandle")

	procRegisterClassExW   = user32.NewProc("RegisterClassExW")
	procCreateWindowExW    = user32.NewProc("CreateWindowExW")
	procDefWindowProcW     = user32.NewProc("DefWindowProcW")
	procShowWindow         = user32.NewProc("ShowWindow")
	procUpdateWindow       = user32.NewProc("UpdateWindow")
	procGetMessageW        = user32.NewProc("GetMessageW")
	procTranslateMessage   = user32.NewProc("TranslateMessage")
	procDispatchMessageW   = user32.NewProc("DispatchMessageW")
	procPostQuitMessage    = user32.NewProc("PostQuitMessage")
	procDestroyWindow      = user32.NewProc("DestroyWindow")
	procSendMessageW       = user32.NewProc("SendMessageW")
	procPostMessageW       = user32.NewProc("PostMessageW")
	procSetWindowTextW     = user32.NewProc("SetWindowTextW")
	procLoadCursorW        = user32.NewProc("LoadCursorW")
	procGetSysColorBrush   = user32.NewProc("GetSysColorBrush")
	procGetSysColor        = user32.NewProc("GetSysColor")
	procSetProcessDPIAware = user32.NewProc("SetProcessDPIAware")
	procGetDC              = user32.NewProc("GetDC")
	procReleaseDC          = user32.NewProc("ReleaseDC")
	procGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	procAdjustWindowRect   = user32.NewProc("AdjustWindowRect")
	procGetWindowLongPtrW  = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW  = user32.NewProc("SetWindowLongPtrW")
	procMessageBoxW        = user32.NewProc("MessageBoxW")

	procCreateFontW   = gdi32.NewProc("CreateFontW")
	procDeleteObject  = gdi32.NewProc("DeleteObject")
	procGetDeviceCaps = gdi32.NewProc("GetDeviceCaps")
	procSetBkMode     = gdi32.NewProc("SetBkMode")
	procSetTextColor  = gdi32.NewProc("SetTextColor")

	procInitCommonControlsEx = comctl32.NewProc("InitCommonControlsEx")
	procShellExecuteW        = shell32.NewProc("ShellExecuteW")
)

const (
	loadLibrarySearchSystem32 = 0x00000800
	createNoWindow            = 0x08000000

	wsOverlapped  = 0x00000000
	wsCaption     = 0x00C00000
	wsSysMenu     = 0x00080000
	wsMinimizeBox = 0x00020000
	wsChild       = 0x40000000
	wsVisible     = 0x10000000
	wsTabStop     = 0x00010000
	wsGroup       = 0x00020000

	ssLeft       = 0x00000000
	ssEtchedHorz = 0x00000010
	bsDefPush    = 0x00000001
	pbsMarquee   = 0x00000008

	wmDestroy        = 0x0002
	wmClose          = 0x0010
	wmSetFont        = 0x0030
	wmCommand        = 0x0111
	wmCtlColorStatic = 0x0138
	wmApp            = 0x8000
	wmRefresh        = wmApp + 1
	pbmSetPos        = 0x0402 // WM_USER + 2
	pbmSetRange32    = 0x0406 // WM_USER + 6
	pbmSetMarquee    = 0x040A // WM_USER + 10

	swHide       = 0
	swShow       = 5
	swShowNormal = 1

	colorBtnFace  = 15
	colorGrayText = 17
	transparent   = 1
	logPixelsY    = 90
	smCxScreen    = 0
	smCyScreen    = 1
	iccProgress   = 0x00000020
	idcArrow      = 32512
	mbIconError   = 0x00000010

	fwNormal   = 400
	fwSemibold = 600
	fwBold     = 700

	idButton = 100
)

// GWL_STYLE is negative, and a negative constant will not convert to uintptr,
// so it has to travel as a variable.
var gwlStyle = int32(-16)

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   syscall.Handle
	Icon       syscall.Handle
	Cursor     syscall.Handle
	Background syscall.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     syscall.Handle
}

type msgStruct struct {
	Hwnd    syscall.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

type rect struct{ Left, Top, Right, Bottom int32 }

type initCommonControlsEx struct {
	Size uint32
	ICC  uint32
}

// utf16 allocates the wide string Win32 wants. The pointer must be held in a
// variable across the call that uses it — converting it to uintptr inside an
// argument list hides it from the collector, which is free to free it while
// the call is still running. Hence the KeepAlive on every caller below.
func utf16(s string) *uint16 {
	p, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		// Only possible if the string holds a NUL, which none of ours do.
		p, _ = syscall.UTF16PtrFromString("")
	}
	return p
}

// ---------------------------------------------------------------- the window

var (
	hwnd      syscall.Handle
	hTitle    syscall.Handle
	hSubtitle syscall.Handle
	hRule     syscall.Handle
	hStatus   syscall.Handle
	hDetail   syscall.Handle
	hProgress syscall.Handle
	hButton   syscall.Handle
	hNote     syscall.Handle

	fontBody   syscall.Handle
	fontStrong syscall.Handle
	fontTitle  syscall.Handle
	faceBrush  syscall.Handle
	dpi        int32 = 96
)

// scale converts a layout figure written at 96 dpi into real pixels.
func scale(n int32) int32 { return n * dpi / 96 }

func main() {
	// The message loop and every window must stay on one OS thread.
	runtime.LockOSThread()

	procSetProcessDPIAware.Call()
	var icc = initCommonControlsEx{Size: uint32(unsafe.Sizeof(initCommonControlsEx{})), ICC: iccProgress}
	procInitCommonControlsEx.Call(uintptr(unsafe.Pointer(&icc)))

	if err := setPaths(); err != nil {
		text, caption := utf16(sentence(err)), utf16("OpenDub")
		procMessageBoxW.Call(0, uintptr(unsafe.Pointer(text)),
			uintptr(unsafe.Pointer(caption)), mbIconError)
		runtime.KeepAlive(text)
		runtime.KeepAlive(caption)
		return
	}

	createWindow()

	// Same first move as the Mac app: if it is already here, freshen it and
	// start it. Without the freshening, a fix we publish never reaches anyone
	// who already installed — which is how a fixed bug stays reported.
	if installed() {
		setState(phaseChecking, "Starting…", "", -1)
		go func() {
			updateProgram()
			startServer()
		}()
	} else {
		setState(phaseNeedsInstall, "OpenDub is not on this PC yet.",
			"About 2 GB, a few minutes. It all goes in your own user folder.", 0)
	}

	var m msgStruct
	for {
		ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(ret) <= 0 { // 0 is WM_QUIT, -1 is an error we cannot recover from
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	stopServer()
}

func createWindow() {
	instance, _, _ := procGetModuleHandleW.Call(0)
	cursor, _, _ := procLoadCursorW.Call(0, idcArrow)
	brush, _, _ := procGetSysColorBrush.Call(colorBtnFace)
	faceBrush = syscall.Handle(brush)

	className := utf16("OpenDubInstaller")
	class := wndClassEx{
		Size:       uint32(unsafe.Sizeof(wndClassEx{})),
		WndProc:    syscall.NewCallback(wndProc),
		Instance:   syscall.Handle(instance),
		Cursor:     syscall.Handle(cursor),
		Background: faceBrush,
		ClassName:  className,
	}
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class)))
	runtime.KeepAlive(className)

	// Work out the pixel size of the fonts and the layout for this screen.
	dc, _, _ := procGetDC.Call(0)
	if dc != 0 {
		y, _, _ := procGetDeviceCaps.Call(dc, logPixelsY)
		if y > 0 {
			dpi = int32(y)
		}
		procReleaseDC.Call(0, dc)
	}
	fontBody = makeFont(9, fwNormal)
	fontStrong = makeFont(9, fwBold)
	fontTitle = makeFont(13, fwSemibold)

	// Fixed size: there is nothing here worth resizing, and a fixed window
	// means the layout below is the whole layout.
	const style = wsOverlapped | wsCaption | wsSysMenu | wsMinimizeBox
	want := rect{0, 0, scale(470), scale(232)}
	procAdjustWindowRect.Call(uintptr(unsafe.Pointer(&want)), style, 0)
	w, h := want.Right-want.Left, want.Bottom-want.Top
	sw, _, _ := procGetSystemMetrics.Call(smCxScreen)
	sh, _, _ := procGetSystemMetrics.Call(smCyScreen)

	windowTitle := utf16("OpenDub")
	h0, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowTitle)),
		style,
		uintptr((int32(sw)-w)/2), uintptr((int32(sh)-h)/2), uintptr(w), uintptr(h),
		0, 0, instance, 0)
	hwnd = syscall.Handle(h0)
	runtime.KeepAlive(windowTitle)

	staticClass := utf16("STATIC")
	static := func(text string, x, y, w, h int32, extra uintptr, font syscall.Handle) syscall.Handle {
		caption := utf16(text)
		c, _, _ := procCreateWindowExW.Call(
			0,
			uintptr(unsafe.Pointer(staticClass)),
			uintptr(unsafe.Pointer(caption)),
			wsChild|wsVisible|ssLeft|extra,
			uintptr(scale(x)), uintptr(scale(y)), uintptr(scale(w)), uintptr(scale(h)),
			uintptr(hwnd), 0, instance, 0)
		runtime.KeepAlive(caption)
		handle := syscall.Handle(c)
		procSendMessageW.Call(uintptr(handle), wmSetFont, uintptr(font), 1)
		return handle
	}

	hTitle = static("OpenDub", 20, 16, 420, 22, 0, fontTitle)
	hSubtitle = static("The free voice, on this PC", 20, 40, 420, 18, 0, fontBody)
	hRule = static("", 20, 64, 430, 2, ssEtchedHorz, fontBody)
	hStatus = static("", 20, 78, 430, 20, 0, fontStrong)
	hDetail = static("", 20, 100, 430, 48, 0, fontBody)

	progressClass, empty := utf16("msctls_progress32"), utf16("")
	p, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(progressClass)),
		uintptr(unsafe.Pointer(empty)),
		wsChild,
		uintptr(scale(20)), uintptr(scale(152)), uintptr(scale(430)), uintptr(scale(14)),
		uintptr(hwnd), 0, instance, 0)
	hProgress = syscall.Handle(p)
	runtime.KeepAlive(progressClass)
	runtime.KeepAlive(empty)
	procSendMessageW.Call(uintptr(hProgress), pbmSetRange32, 0, 1000)

	buttonClass, buttonText := utf16("BUTTON"), utf16("Install OpenDub")
	b, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(buttonClass)),
		uintptr(unsafe.Pointer(buttonText)),
		wsChild|wsTabStop|wsGroup|bsDefPush,
		uintptr(scale(20)), uintptr(scale(182)), uintptr(scale(160)), uintptr(scale(30)),
		uintptr(hwnd), idButton, instance, 0)
	hButton = syscall.Handle(b)
	runtime.KeepAlive(buttonClass)
	runtime.KeepAlive(buttonText)
	procSendMessageW.Call(uintptr(hButton), wmSetFont, uintptr(fontBody), 1)

	hNote = static("", 192, 189, 258, 32, 0, fontBody)

	runtime.KeepAlive(staticClass)
	procShowWindow.Call(uintptr(hwnd), swShowNormal)
	procUpdateWindow.Call(uintptr(hwnd))
}

func makeFont(points int32, weight uintptr) syscall.Handle {
	face := utf16("Segoe UI")
	height := -(points*dpi + 36) / 72 // MulDiv, rounded the way Windows does it
	f, _, _ := procCreateFontW.Call(
		uintptr(height), 0, 0, 0, weight,
		0, 0, 0,
		1, // DEFAULT_CHARSET
		0, // OUT_DEFAULT_PRECIS
		0, // CLIP_DEFAULT_PRECIS
		5, // CLEARTYPE_QUALITY
		0, // DEFAULT_PITCH
		uintptr(unsafe.Pointer(face)))
	runtime.KeepAlive(face)
	return syscall.Handle(f)
}

func setText(control syscall.Handle, text string) {
	p := utf16(text)
	procSetWindowTextW.Call(uintptr(control), uintptr(unsafe.Pointer(p)))
	runtime.KeepAlive(p)
}

func show(control syscall.Handle, visible bool) {
	mode := uintptr(swHide)
	if visible {
		mode = swShow
	}
	procShowWindow.Call(uintptr(control), mode)
}

// refreshLater asks the UI thread to redraw from the shared state. Every
// update comes from a worker goroutine, and only this thread may touch a HWND.
func refreshLater() {
	if hwnd != 0 {
		procPostMessageW.Call(uintptr(hwnd), wmRefresh, 0, 0)
	}
}

func refresh() {
	state.Lock()
	p, status, detail, fraction := state.phase, state.status, state.detail, state.fraction
	state.Unlock()

	setText(hStatus, status)
	setText(hDetail, detail)

	working := p == phaseWorking || p == phaseChecking
	show(hProgress, working)
	if working {
		setProgress(fraction)
	}

	switch p {
	case phaseNeedsInstall:
		setText(hButton, "Install OpenDub")
		show(hButton, true)
	case phaseRunning:
		setText(hButton, "Open OpenDub")
		show(hButton, true)
	case phaseFailed:
		setText(hButton, "Try again")
		show(hButton, true)
	default:
		show(hButton, false)
	}

	if p == phaseRunning {
		setText(hNote, "Keep this window open while you dub.\r\nClosing it stops OpenDub.")
	} else {
		setText(hNote, "")
	}
}

// setProgress switches the bar between a real fraction and the marquee used
// for the steps that cannot say how far along they are.
func setProgress(fraction float64) {
	style, _, _ := procGetWindowLongPtrW.Call(uintptr(hProgress), uintptr(gwlStyle))
	marquee := fraction < 0
	if marquee == (style&pbsMarquee != 0) {
		// The style is already right. Re-sending PBM_SETMARQUEE restarts the
		// sweep, so a marquee that is already running is left alone.
		if !marquee {
			procSendMessageW.Call(uintptr(hProgress), pbmSetPos, uintptr(int32(fraction*1000)), 0)
		}
		return
	}
	if marquee {
		style |= pbsMarquee
	} else {
		style &^= pbsMarquee
	}
	procSetWindowLongPtrW.Call(uintptr(hProgress), uintptr(gwlStyle), style)
	if marquee {
		procSendMessageW.Call(uintptr(hProgress), pbmSetMarquee, 1, 30)
		return
	}
	procSendMessageW.Call(uintptr(hProgress), pbmSetMarquee, 0, 0)
	procSendMessageW.Call(uintptr(hProgress), pbmSetPos, uintptr(int32(fraction*1000)), 0)
}

// openLocalUI shows the dubbing interface this PC is serving, in a window of
// its own rather than a browser tab.
//
// Edge is on every Windows 10 and 11, and --app opens a chromeless window: no
// address bar, no tabs, its own taskbar button. The page is then same origin
// with the server, so none of the browser's rules about reaching your own
// machine apply — no permission to grant, nothing cached from the website.
//
// A WebView2 control inside this window would be tidier still, and is the
// next step; this is written on a Mac and cannot be run here, so it uses the
// browser that is certainly present rather than COM that certainly is not
// tested. If Edge is not where it should be, the default browser opens the
// same local address, which works just as well with a tab around it.
func openLocalUI() {
	local := fmt.Sprintf("http://127.0.0.1:%d/", port)
	for _, exe := range []string{
		os.Getenv("ProgramFiles(x86)") + `\Microsoft\Edge\Application\msedge.exe`,
		os.Getenv("ProgramFiles") + `\Microsoft\Edge\Application\msedge.exe`,
	} {
		if _, err := os.Stat(exe); err != nil {
			continue
		}
		cmd := exec.Command(exe, "--app="+local, "--window-size=1100,780")
		cmd.SysProcAttr = hidden()
		if err := cmd.Start(); err == nil {
			logLine("opened the interface in its own window")
			return
		}
	}
	logLine("Edge was not where it should be; opening the default browser instead")
	openURL(local)
}

func openURL(target string) {
	verb, url := utf16("open"), utf16(target)
	procShellExecuteW.Call(0,
		uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(url)),
		0, 0, swShowNormal)
	runtime.KeepAlive(verb)
	runtime.KeepAlive(url)
}

func wndProc(hWnd syscall.Handle, message uintptr, wParam, lParam uintptr) uintptr {
	switch message {
	case wmRefresh:
		refresh()
		return 0

	case wmCommand:
		if uint16(wParam) == idButton {
			onButton()
		}
		return 0

	case wmCtlColorStatic:
		// Without this the labels paint a white box on the dialog-grey window.
		procSetBkMode.Call(wParam, transparent)
		if syscall.Handle(lParam) == hSubtitle || syscall.Handle(lParam) == hDetail ||
			syscall.Handle(lParam) == hNote {
			grey, _, _ := procGetSysColor.Call(colorGrayText)
			procSetTextColor.Call(wParam, grey)
		}
		return uintptr(faceBrush)

	case wmClose:
		stopServer() // no service left behind
		procDestroyWindow.Call(uintptr(hWnd))
		return 0

	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	ret, _, _ := procDefWindowProcW.Call(uintptr(hWnd), message, wParam, lParam)
	return ret
}

func onButton() {
	state.Lock()
	p := state.phase
	state.Unlock()

	switch p {
	case phaseNeedsInstall:
		startInstall()
	case phaseRunning:
		openLocalUI()
	case phaseFailed:
		// Try again picks up wherever it stopped: uv and the code are already
		// on disk if they got that far, so a retry is usually the last step only.
		if installed() {
			setState(phaseWorking, "Starting…", "", -1)
			go startServer()
		} else {
			startInstall()
		}
	}
}

// ---------------------------------------------------------------- the job object

// Everything we spawn joins a job that Windows kills when the last handle to
// it closes — which happens when this process exits, however it exits. Without
// it a crash here would leave a Python server listening on 8910 with no window
// anywhere to stop it.
var job syscall.Handle

func init() {
	h, _, _ := procCreateJobObjectW.Call(0, 0)
	if h == 0 {
		return
	}
	job = syscall.Handle(h)
	limits := jobObjectExtendedLimitInformation{}
	limits.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	procSetInformationJobObject.Call(uintptr(job), jobObjectExtendedLimitInfo,
		uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
}

func adoptIntoJob(cmd *exec.Cmd) {
	if job == 0 || cmd.Process == nil {
		return
	}
	h, _, _ := procOpenProcess.Call(processSetQuota|processTerminate, 0, uintptr(cmd.Process.Pid))
	if h == 0 {
		return
	}
	procAssignProcessToJobObject.Call(uintptr(job), h)
	procCloseHandle.Call(h)
}

func closeJob() {
	if job != 0 {
		procCloseHandle.Call(uintptr(job))
		job = 0
	}
}

const (
	jobObjectExtendedLimitInfo   = 9
	jobObjectLimitKillOnJobClose = 0x00002000
	processTerminate             = 0x0001
	processSetQuota              = 0x0100
)

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}
