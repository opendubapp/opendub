#!/usr/bin/env bash
# Build the macOS app that carries everything: OpenDub-full.dmg.
#
#   ./bundle.sh
#
# The ordinary app is half a megabyte and fetches uv, a Python and a gigabyte
# of packages the first time it runs. This one has no first run: its Python,
# every package, ffmpeg and the pipeline that runs in the page are inside the
# bundle, in Contents/Resources/payload.
#
# Apple Silicon only. The app itself is universal, but a Python and a
# gigabyte of wheels are not, and shipping both architectures would double
# an already large download. An Intel build is the same script with the
# platform changed.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
UV=${UV:-$HOME/Library/Application Support/OpenDub/bin/uv}
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: DE JIAN KOH (JY2NWT5QFV)}"
PY_PLATFORM=aarch64-apple-darwin
STAGE=build/payload

say() { printf '\n== %s\n' "$1"; }

# build.sh deletes build/ first, so the payload is assembled after it, not
# before: the Windows one lost its payload that way once.
say "the app"
./build.sh >/dev/null
APPDIR="build/OpenDub.app"
[ -d "$APPDIR" ] || { echo "the app was not built"; exit 1; }

rm -rf "$STAGE" && mkdir -p "$STAGE"

say "the Python that will run it"
PY_URL=$(curl -s https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest \
  | grep -oE '"browser_download_url": "[^"]*cpython-3\.12[^"]*'"$PY_PLATFORM"'-install_only\.tar\.gz"' \
  | head -1 | cut -d'"' -f4)
[ -n "$PY_URL" ] || { echo "could not find a macOS CPython to bundle"; exit 1; }
curl -sL "$PY_URL" -o /tmp/opendub-python.tar.gz
tar -xzf /tmp/opendub-python.tar.gz -C "$STAGE"       # unpacks to python/
rm /tmp/opendub-python.tar.gz
[ -x "$STAGE/python/bin/python3" ] || { echo "the Python archive is not the shape expected"; exit 1; }

say "every package"
"$UV" pip install --python-platform "$PY_PLATFORM" --python-version 3.12 \
  --target "$STAGE/site-packages" --only-binary=:all: \
  -r "$ROOT/requirements-voice.txt" >/dev/null

say "ffmpeg, which macOS does not come with"
mkdir -p "$STAGE/ffmpeg"
curl -sL "https://www.osxexperts.net/ffmpeg711arm.zip" -o /tmp/opendub-ffmpeg.zip
7z e -y -o"$STAGE/ffmpeg" /tmp/opendub-ffmpeg.zip ffmpeg >/dev/null
rm /tmp/opendub-ffmpeg.zip
chmod +x "$STAGE/ffmpeg/ffmpeg"
[ -x "$STAGE/ffmpeg/ffmpeg" ] || { echo "ffmpeg did not come out of the archive"; exit 1; }

say "the program, and the pipeline that runs in the page"
mkdir -p "$STAGE/app/web"
cp -R "$ROOT/opendub" "$STAGE/app/"
cp "$ROOT/requirements.txt" "$ROOT/requirements-voice.txt" "$ROOT/LICENSE" "$STAGE/app/"
cp "$ROOT"/web/*.html "$ROOT"/web/*.js "$ROOT"/web/*.css "$STAGE/app/web/"
cp -R "$ROOT/web/vendor" "$ROOT/web/browser" "$STAGE/app/web/"
( cd "$ROOT/web" && tar -czf /tmp/opendub-browser-check.tar.gz browser )
shasum -a 256 /tmp/opendub-browser-check.tar.gz | cut -d' ' -f1 > "$STAGE/app/web/browser/.sha256"
rm -f /tmp/opendub-browser-check.tar.gz
find "$STAGE" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE" -name '.DS_Store' -delete 2>/dev/null || true

say "into the bundle"
cp -R "$STAGE" "$APPDIR/Contents/Resources/payload"
du -sh "$APPDIR" | awk '{print "  app: " $1}'

say "signing"
cat > build/entitlements-full.plist <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <!-- The wheels bring hundreds of .so files compiled by other people. A
       hardened app will not load them unless library validation is off. -->
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <!-- Python compiles and runs code at runtime, which a hardened app
       otherwise refuses. -->
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict>
</plist>
ENT
# Every Mach-O inside has to carry a signature for the hardened runtime, and
# the wheels bring hundreds of .so files that nobody here compiled. Signing
# them all with this identity is what --deep does; library validation is
# switched off because a few arrive already signed by somebody else.
codesign --remove-signature "$APPDIR" 2>/dev/null || true
codesign --force --deep --options runtime --timestamp \
  --entitlements build/entitlements-full.plist \
  --sign "$IDENTITY" "$APPDIR" >/dev/null
codesign --verify --deep --strict "$APPDIR" && echo "  signature verifies"

say "the disk image"
rm -rf build/dmg-full && mkdir -p build/dmg-full
cp -R "$APPDIR" build/dmg-full/
ln -s /Applications build/dmg-full/Applications
hdiutil create -quiet -volname OpenDub -srcfolder build/dmg-full \
  -ov -format UDZO build/OpenDub-full.dmg
ls -la build/OpenDub-full.dmg | awk '{printf "  OpenDub-full.dmg  %.0f MB\n", $5/1048576}'
