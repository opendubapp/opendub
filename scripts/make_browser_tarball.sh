#!/usr/bin/env bash
# The in-browser pipeline, as its own archive: opendub-browser.tar.gz.
#
# It is kept out of opendub.tar.gz because that one is fetched on every launch
# to pick up fixes, and 25 MB on every launch is not a fix, it is a tax. This
# one is fetched only when its checksum changes, which is why the checksum is
# published beside it.
#
# Without it the app on a computer has no free route at all: the page it
# serves asks its own origin for the pipeline and gets a 404, and the server's
# own pipeline sends every step to Higgs.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-../openapps/opendub-website-deploy/opendub-browser.tar.gz}"

[ -d web/browser ] || { echo "Build it first: (cd browser && npm run build)"; exit 1; }

tar -czf "$OUT" -C web browser
# Published beside it so a copy already installed can tell, in a few bytes,
# whether what it has is what is being served.
shasum -a 256 "$OUT" | cut -d' ' -f1 > "${OUT%.tar.gz}.sha256"

echo "$OUT  $(du -h "$OUT" | cut -f1)"
echo "$(cat "${OUT%.tar.gz}.sha256")  $(basename "${OUT%.tar.gz}.sha256")"
