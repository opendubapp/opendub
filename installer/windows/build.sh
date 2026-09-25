#!/usr/bin/env bash
# Build OpenDub-setup.exe for Windows, from anywhere Go runs — this is
# cross-compiled from the same Mac that builds the .app, so one machine
# produces both downloads.
#
#   ./build.sh
#
# Two binaries, because Windows on ARM runs x64 under emulation but the Python
# that uv fetches would then be the wrong one. -H=windowsgui is what makes it a
# GUI program: without it Windows opens a console window behind the app.
#
# There is no code signing here. An unsigned .exe gets SmartScreen's "Windows
# protected your PC" on first download, and the way past that is an
# Authenticode certificate, not a build flag.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf build && mkdir -p build

# -s -w drops the symbol table and DWARF: nothing here is ever debugged on the
# user's machine, and it takes a couple of megabytes off the download.
LDFLAGS="-H=windowsgui -s -w"

echo "Checking…"
gofmt -l .
GOOS=windows go vet ./...

echo "Building…"
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$LDFLAGS" -o build/OpenDub-setup-x64.exe
GOOS=windows GOARCH=arm64 go build -trimpath -ldflags "$LDFLAGS" -o build/OpenDub-setup-arm64.exe

echo
ls -lh build/
file build/*.exe
