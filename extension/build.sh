#!/usr/bin/env bash
# Assemble the Chrome and Firefox extensions into build/.
#
#   ./build.sh          build both, and zip them
#
# The dubbing pipeline is copied in from ../web/browser, which `npm run build`
# in ../browser produces. It is carried inside the extension rather than
# loaded from opendub.app for two reasons: the site sets frame-ancestors
# 'none' so it cannot be embedded, and an extension page may not load remote
# code at all. The cost is that a fix here needs a new version, where a fix on
# the site reaches everyone at once.
set -euo pipefail
cd "$(dirname "$0")"

BUNDLE=../web/browser
[ -d "$BUNDLE" ] || { echo "Build the pipeline first: (cd ../browser && npm run build)"; exit 1; }

rm -rf build && mkdir -p build

for target in chrome firefox; do
  out="build/$target"
  mkdir -p "$out"
  cp src/*.js src/*.html src/*.css "$out/"
  cp -R icons "$out/"
  cp -R "$BUNDLE" "$out/browser"
  # Every runtime file the site ships, with none left out. Dropping the
  # asyncify build to save 26 MB broke WebGPU at the third step of a dub —
  # the runtime asks for it by name and the whole thing stops (APP-191).
  site_files=$(ls "$BUNDLE/ort" | sort)
  ext_files=$(ls "$out/browser/ort" | sort)
  [ "$site_files" = "$ext_files" ] || { echo "$target: the runtime is not the one the site ships"; exit 1; }
  cp "src/manifest.$target.json" "$out/manifest.json"
  rm -f "$out/manifest.chrome.json" "$out/manifest.firefox.json"
  python3 -c "import json,sys; json.load(open('$out/manifest.json'))" || { echo "$target: manifest is not valid JSON"; exit 1; }
  (cd "$out" && zip -qr "../opendub-$target.zip" .)
  echo "  $target  $(du -sh "$out" | cut -f1)  →  build/opendub-$target.zip"
done

echo
echo "Load it while developing:"
echo "  Chrome   chrome://extensions → Developer mode → Load unpacked → extension/build/chrome"
echo "  Firefox  about:debugging → This Firefox → Load Temporary Add-on → extension/build/firefox/manifest.json"
