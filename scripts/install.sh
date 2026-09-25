#!/usr/bin/env bash
# OpenDub on your own computer, in one command:
#
#   curl -fsSL https://opendub.app/install.sh | bash
#
# It downloads OpenDub, installs the free voice (OmniVoice) into a virtualenv
# of its own, and starts it on 127.0.0.1:8910. Nothing is installed system
# wide, nothing needs an account or a key, and the page at opendub.app then
# finds it on localhost and dubs with it.
#
#   --full     also install the whole pipeline (demucs, faster-whisper), for
#              dubbing on this machine instead of in a browser tab
#   --stop     stop a running OpenDub
#   --dir D    install somewhere other than ~/OpenDub
#
# Re-running it updates OpenDub and restarts it. Your .env and your work
# folder are left alone.
set -euo pipefail

SITE="${OPENDUB_SITE:-https://opendub.app}"
DIR="${OPENDUB_DIR:-$HOME/OpenDub}"
PORT="${PORT:-8910}"
FULL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1 ;;
    --dir)  DIR="${2:?--dir needs a path}"; shift ;;
    --stop) STOP=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
  shift
done

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- stopping is the other half of starting -------------------------------
stop_running() {
  local pid
  pid="$(pgrep -f "opendub.server:app" || true)"
  # Ending on a false test would return non-zero, and `set -e` would take the
  # whole script down here — silently, right before it starts the server.
  if [ -n "$pid" ]; then
    kill $pid 2>/dev/null || true
    sleep 1
  fi
  return 0
}
if [ "${STOP:-0}" = 1 ]; then
  stop_running
  green "OpenDub stopped."
  exit 0
fi

bold "OpenDub"
echo "Installing into $DIR"
echo

# --- 1. what this machine has ---------------------------------------------
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "This installer is for macOS and Linux. On Windows, follow the steps at $SITE (or use WSL)." ;;
esac

PY=""
for c in python3.12 python3.11 python3.10 python3; do
  command -v "$c" >/dev/null 2>&1 || continue
  "$c" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)' 2>/dev/null || continue
  PY="$c"; break
done
if [ -z "$PY" ]; then
  if [ "$(uname -s)" = Darwin ]; then
    die "Python 3.10 or newer is needed. Install it with:  brew install python@3.12"
  fi
  die "Python 3.10 or newer is needed. Install it with:  sudo apt install python3 python3-venv"
fi
echo "  Python      $("$PY" -V 2>&1 | cut -d' ' -f2)"

# ffmpeg is only needed for a whole dub on this machine. The voice does not
# touch it, so a missing ffmpeg is a note here rather than a failure.
if command -v ffmpeg >/dev/null 2>&1; then
  echo "  ffmpeg      $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
elif [ "$FULL" = 1 ]; then
  die "--full needs ffmpeg. Install it with:  $([ "$(uname -s)" = Darwin ] && echo 'brew install ffmpeg' || echo 'sudo apt install ffmpeg')"
fi

# --- 2. the code ----------------------------------------------------------
echo "  Downloading OpenDub…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL --retry 3 -o "$TMP/opendub.tar.gz" "$SITE/opendub.tar.gz" \
  || die "Could not download $SITE/opendub.tar.gz — check your connection and try again."
mkdir -p "$DIR"
# Only the program is replaced: .env, work/ and .venv/ are not in the archive.
tar -xzf "$TMP/opendub.tar.gz" -C "$DIR" --strip-components 1
echo "  Code        $DIR"

# --- 3. the virtualenv ----------------------------------------------------
cd "$DIR"
[ -d .venv ] || "$PY" -m venv .venv
PIP=".venv/bin/pip"
echo "  Installing the free voice (about 2 GB the first time, a few minutes)…"
echo
"$PIP" install --upgrade pip >/dev/null 2>&1 || true   # a nicety, never a reason to stop
# One retry: this is gigabytes over someone's home connection, and a dropped
# download is the ordinary failure here, not a broken machine.
"$PIP" install -r requirements-voice.txt \
  || { warn "  That did not finish. Trying once more…"; "$PIP" install -r requirements-voice.txt; } \
  || die "The install failed. The output above says why; try again, or follow the steps on $SITE."
echo
if [ "$FULL" = 1 ]; then
  echo "  Installing the whole pipeline (demucs, faster-whisper)…"
  "$PIP" install -r requirements.txt || die "The full install failed; the voice alone is still usable."
fi

# --- 4. start it ----------------------------------------------------------
stop_running
mkdir -p "$DIR/work"
nohup .venv/bin/uvicorn opendub.server:app --host 127.0.0.1 --port "$PORT" \
  > "$DIR/opendub.log" 2>&1 &

for _ in $(seq 1 40); do
  sleep 0.5
  if curl -fsS "http://127.0.0.1:$PORT/api/local/health" >/dev/null 2>&1; then
    READY=1; break
  fi
done
[ "${READY:-0}" = 1 ] || die "OpenDub did not start. The reason is in $DIR/opendub.log"

# A way back in that needs no terminal: double-click this file.
cat > "$DIR/Start OpenDub.command" <<EOF
#!/usr/bin/env bash
cd "\$(dirname "\$0")"
exec .venv/bin/uvicorn opendub.server:app --host 127.0.0.1 --port $PORT
EOF
chmod +x "$DIR/Start OpenDub.command"

echo
green "OpenDub is running on http://127.0.0.1:$PORT"
echo
bold "Now go back to $SITE, choose the free voice, and press \"Look for the app on this computer\"."
echo
echo "Later:  double-click \"$DIR/Start OpenDub.command\" to start it again"
echo "Stop:   curl -fsSL $SITE/install.sh | bash -s -- --stop"
