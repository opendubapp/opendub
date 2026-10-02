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
"$UV" pip install --python-platform x86_64-pc-windows-msvc --python-version "$PYVER" \
  --target "$OUT/payload/site-packages" --only-binary=:all: \
  -r "$ROOT/requirements-voice.txt" >/dev/null

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
# The launcher checks this before fetching the pipeline; written here so a
# bundled install never downloads what it already has.
( cd "$ROOT/web" && tar -czf /tmp/opendub-browser-check.tar.gz browser )
shasum -a 256 /tmp/opendub-browser-check.tar.gz | cut -d' ' -f1 > "$OUT/payload/app/web/browser/.sha256"
rm -f /tmp/opendub-browser-check.tar.gz
find "$OUT/payload" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT/payload" -name '.DS_Store' -delete 2>/dev/null || true

cp "$LAUNCHER" "$OUT/payload/OpenDub.exe"

du -sh "$OUT/payload" | awk '{print "\npayload: " $1}'
