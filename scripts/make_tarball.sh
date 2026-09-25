#!/usr/bin/env bash
# Build the archive install.sh downloads: opendub.tar.gz, into the site folder.
#
# It holds the program and nothing else — no virtualenv, no work folder, no
# .env, and not the in-browser bundle (72 MB, and the copy on opendub.app is
# the one a tab loads). About a megabyte, so the install is quick even where
# the connection is not.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-../openapps/opendub-website-deploy/opendub.tar.gz}"

STAGE="$(mktemp -d)/opendub"
trap 'rm -rf "$(dirname "$STAGE")"' EXIT
mkdir -p "$STAGE"

cp -R opendub "$STAGE/"
cp requirements.txt requirements-voice.txt run.sh README.md LICENSE "$STAGE/"
mkdir -p "$STAGE/web" "$STAGE/scripts"
cp web/*.html web/*.js web/*.css "$STAGE/web/"
cp -R web/vendor "$STAGE/web/"
cp scripts/install.sh "$STAGE/scripts/"
find "$STAGE" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

tar -czf "$OUT" -C "$(dirname "$STAGE")" opendub
echo "$OUT  $(du -h "$OUT" | cut -f1)"
tar -tzf "$OUT" | head -5
