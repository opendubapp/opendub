#!/usr/bin/env bash
# Build, sign and package OpenDub.app for macOS.
#
#   ./build.sh            build and sign
#   ./build.sh --notarize also notarize and staple (needs the Apple credentials)
#
# Signing uses the Developer ID certificate in the login keychain. Notarizing
# authenticates with the App Store Connect API key in
# ~/.appstoreconnect/private_keys — an app-specific password works too, but the
# key is already there, cannot be confused with an account password, and is
# revoked in one click. Neither ever enters the repo.
#
# Without notarization macOS refuses the download with "Apple could not verify
# this app is free of malware", so a build that is not notarized is not a
# build anyone can use. The last step proves it rather than assuming it.
set -euo pipefail
cd "$(dirname "$0")"

APP="OpenDub.app"
OUT="${1:-build}"
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: DE JIAN KOH (JY2NWT5QFV)}"
BUNDLE_ID="app.opendub.installer"
VERSION="1.0.0"
NOTARIZE=0
[ "${1:-}" = "--notarize" ] && { NOTARIZE=1; OUT=build; }

# Never over a bundle that is running. Deleting it under a live app leaves a
# process whose files are gone, and quitting it stops the server it started —
# so a dub running anywhere else dies with it. A seven-minute run was lost
# that way, because this script was run while the app was open.
if pgrep -f "installer/macos/build/.*OpenDub.app/Contents/MacOS/OpenDub" >/dev/null 2>&1; then
  echo "OpenDub is running from build/. Quit it first: rebuilding would pull its files out from under it." >&2
  exit 1
fi

rm -rf build && mkdir -p "build/$APP/Contents/MacOS" "build/$APP/Contents/Resources"

# --- the binary -------------------------------------------------------------
# Universal, so one download runs on both Apple silicon and Intel.
for arch in arm64 x86_64; do
  swiftc -O -parse-as-library -target "$arch-apple-macos13.0" \
    -o "build/OpenDub-$arch" main.swift
done
lipo -create -output "build/$APP/Contents/MacOS/OpenDub" build/OpenDub-arm64 build/OpenDub-x86_64
rm -f build/OpenDub-arm64 build/OpenDub-x86_64

# --- the bundle -------------------------------------------------------------
cat > "build/$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>OpenDub</string>
  <key>CFBundleDisplayName</key><string>OpenDub</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>OpenDub</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- So a page can ask for the app by name. A browser extension cannot start
       a program, but it can ask the system to open opendub://, and the system
       knows which application that is. Without this, "Start OpenDub" from the
       dubbing page has no way to do anything. -->
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>app.opendub</string>
      <key>CFBundleURLSchemes</key><array><string>opendub</string></array>
    </dict>
  </array>
  <!-- The interface is served by the copy of OpenDub running on this Mac, over
       plain HTTP on the loopback address. Without this the web view refuses to
       load it and the window comes up empty. Nothing else may use http. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
  <key>NSHumanReadableCopyright</key><string>AGPL-3.0. Source: github.com/opendubapp/opendub</string>
</dict>
</plist>
PLIST
[ -f AppIcon.icns ] && cp AppIcon.icns "build/$APP/Contents/Resources/"

# --- signing ----------------------------------------------------------------
# The hardened runtime is what notarization requires; the app spawns Python and
# talks to the network, neither of which needs an entitlement.
cat > build/entitlements.plist <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
</dict>
</plist>
ENT
codesign --force --options runtime --timestamp \
  --entitlements build/entitlements.plist --sign "$IDENTITY" "build/$APP"
codesign --verify --deep --strict --verbose=2 "build/$APP"

# --- the disk image ---------------------------------------------------------
DMG="build/OpenDub.dmg"
rm -f "$DMG"
mkdir -p build/dmg && cp -R "build/$APP" build/dmg/
ln -sf /Applications build/dmg/Applications
hdiutil create -volname "OpenDub" -srcfolder build/dmg -ov -format UDZO "$DMG" >/dev/null
codesign --force --timestamp --sign "$IDENTITY" "$DMG"

if [ "$NOTARIZE" = 1 ]; then
  [ -f ~/.config/opensubs-apple/env ] && { set -a; . ~/.config/opensubs-apple/env; set +a; }
  : "${ASC_KEY_ID:?ASC_KEY_ID is not set}"; : "${ASC_ISSUER_ID:?ASC_ISSUER_ID is not set}"
  AUTH=(--key "$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID")
  echo "Notarizing (a few minutes)…"
  # The app inside the image, and the image itself: Gatekeeper asks Apple when
  # the Mac is online, but an offline first run needs the ticket stapled on.
  ditto -c -k --keepParent "build/$APP" build/OpenDub.zip
  xcrun notarytool submit build/OpenDub.zip "${AUTH[@]}" --wait
  xcrun stapler staple "build/$APP"
  rm -f "$DMG" && rm -rf build/dmg && mkdir -p build/dmg && cp -R "build/$APP" build/dmg/
  ln -sf /Applications build/dmg/Applications
  hdiutil create -volname "OpenDub" -srcfolder build/dmg -ov -format UDZO "$DMG" >/dev/null
  codesign --force --timestamp --sign "$IDENTITY" "$DMG"
  xcrun notarytool submit "$DMG" "${AUTH[@]}" --wait
  xcrun stapler staple "$DMG"

  echo
  echo "Proof, not inference:"
  spctl --assess --type exec --verbose=4 "build/$APP" 2>&1 | sed 's/^/  /'
  xcrun stapler validate "build/$APP" | sed 's/^/  /'
  xcrun stapler validate "$DMG" | sed 's/^/  /'
fi

echo
ls -lh "$DMG" | awk '{print "  " $9, $5}'
codesign -dv --verbose=2 "build/$APP" 2>&1 | grep -E "Authority|TeamIdentifier|Runtime" | sed 's/^/  /'
