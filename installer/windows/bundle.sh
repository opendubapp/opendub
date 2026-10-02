#!/usr/bin/env bash
# Build the Windows installer that carries everything: OpenDub-Setup.exe.
#
#   ./bundle.sh
#
# The ordinary installer is a megabyte and fetches uv, a Python and a
# gigabyte of packages on first run. That is three things that can fail on
# someone else's machine, and on Windows it also leaves out ffmpeg, which the
# system does not provide. This one has no first run: Python, every package,
# ffmpeg and the in-page pipeline are all inside it.
#
# It is assembled on a Mac. uv resolves and downloads Windows wheels for a
# Windows interpreter without needing one to be present
# (--python-platform x86_64-pc-windows-msvc), and the Python itself is the
# same python-build-standalone that uv would have fetched on the machine.
#
# About 1.3 GB unpacked. Nothing here has been run on Windows.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
OUT=build/full
UV=${UV:-$HOME/Library/Application Support/OpenDub/bin/uv}
PYVER=3.12

say() { printf '\n== %s\n' "$1"; }

# Before anything else: build.sh starts by deleting build/, which is where
# the payload is assembled. Building the launcher afterwards would throw the
# payload away — it did, once.
say "the launcher"
./build.sh >/dev/null
LAUNCHER=$(mktemp -d)/OpenDub.exe
cp build/OpenDub-setup-x64.exe "$LAUNCHER"

rm -rf "$OUT" && mkdir -p "$OUT"

say "the Python that will run it"
PY_URL=$(curl -s https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest \
  | grep -oE '"browser_download_url": "[^"]*cpython-3\.12[^"]*x86_64-pc-windows-msvc-install_only\.tar\.gz"' \
  | head -1 | cut -d'"' -f4)
[ -n "$PY_URL" ] || { echo "could not find a Windows CPython to bundle"; exit 1; }
curl -sL "$PY_URL" -o "$OUT/python.tar.gz"
mkdir -p "$OUT/payload"
tar -xzf "$OUT/python.tar.gz" -C "$OUT/payload"      # unpacks to python/
rm "$OUT/python.tar.gz"
[ -f "$OUT/payload/python/python.exe" ] || { echo "the Python archive is not the shape expected"; exit 1; }

say "every package, as Windows wheels"
# Both lists. The voice one is enough for a dub whose heavy work happens in the
# tab; requirements.txt is what the server needs to do the whole thing itself,
# and leaving it out ships an installer that fails on an import rather than on
# anything the user did. Nearly all of the weight — torch — is in either way.
# jieba is the one requirement PyPI has no wheel for, and --only-binary
# refuses it, which takes the whole resolve down with it. It is pure Python,
# so a source build produces the same files for any platform — hence a second
# call rather than loosening the rule for everything.
"$UV" pip install --python-platform x86_64-pc-windows-msvc --python-version "$PYVER" \
  --target "$OUT/payload/site-packages" --only-binary=:all: \
  -r "$ROOT/requirements-voice.txt" -r "$ROOT/requirements.txt" \
  --no-binary jieba >/dev/null

say "ffmpeg, which Windows does not come with"
curl -sL "https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip" -o "$OUT/ffmpeg.zip"
mkdir -p "$OUT/payload/ffmpeg"
7z e -y -o"$OUT/payload/ffmpeg" "$OUT/ffmpeg.zip" "*/bin/ffmpeg.exe" "*/bin/ffprobe.exe" >/dev/null
rm "$OUT/ffmpeg.zip"
[ -f "$OUT/payload/ffmpeg/ffmpeg.exe" ] || { echo "ffmpeg did not come out of the archive"; exit 1; }

say "the program, and the pipeline that runs in the page"
mkdir -p "$OUT/payload/app"
cp -R "$ROOT/opendub" "$OUT/payload/app/"
cp "$ROOT/requirements.txt" "$ROOT/requirements-voice.txt" "$ROOT/README.md" "$ROOT/LICENSE" "$OUT/payload/app/"
mkdir -p "$OUT/payload/app/web"
cp "$ROOT"/web/*.html "$ROOT"/web/*.js "$ROOT"/web/*.css "$OUT/payload/app/web/"
cp -R "$ROOT/web/vendor" "$OUT/payload/app/web/"
cp -R "$ROOT/web/browser" "$OUT/payload/app/web/"
# The weights the page runs, so the first dub downloads nothing. They are the
# same files on either platform — ONNX and JSON, nothing compiled.
"$ROOT/scripts/fetch_models.sh" "$ROOT/web/models" >/dev/null
cp -R "$ROOT/web/models" "$OUT/payload/app/web/"
# The launcher checks this before fetching the pipeline; written here so a
# bundled install never downloads what it already has.
# Reproducibly, so it equals the checksum the site publishes for the same
# files; see scripts/make_browser_tarball.sh.
( cd "$ROOT/web" && tar -cf - browser | gzip -n > /tmp/opendub-browser-check.tar.gz )
shasum -a 256 /tmp/opendub-browser-check.tar.gz | cut -d' ' -f1 > "$OUT/payload/app/web/browser/.sha256"
rm -f /tmp/opendub-browser-check.tar.gz
find "$OUT/payload" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT/payload" -name '.DS_Store' -delete 2>/dev/null || true

cp "$LAUNCHER" "$OUT/payload/OpenDub.exe"

say "does it carry everything?"
# A Windows payload cannot be run from here, so this is presence only: every
# binary and every package the program imports. What the binaries can actually
# do is checked by the macOS build, which ships the same program.
python3 "$ROOT/installer/check_payload.py" "$OUT/payload" windows

du -sh "$OUT/payload" | awk '{print "\npayload: " $1}'

say "the installer"
# One command, one artefact. Leaving makensis as a step someone remembers is
# how a release ends up carrying last week's payload inside this week's
# installer.
command -v makensis >/dev/null || { echo "makensis is not installed: brew install makensis"; exit 1; }
makensis -V2 full.nsi
[ -f build/OpenDub-Setup-full.exe ] || { echo "the installer was not produced"; exit 1; }
ls -l build/OpenDub-Setup-full.exe | awk '{printf "  OpenDub-Setup-full.exe  %.0f MB\n", $5/1048576}'
