#!/bin/zsh
# Build hop for Mac: the SPM executable wrapped into hop.app, signed.
#   ./build.sh            build .dist/hop.app
#   ./build.sh install    …and put it in ~/Applications (replacing the old copy)
# Signs with your "Developer ID Application" identity when the Keychain has
# one (hardened runtime, so it can be notarized), else ad hoc for this Mac.
# HOP_MAC_SIGN="<identity>" picks one; HOP_MAC_NOTARY_PROFILE=<notarytool
# keychain profile> also notarizes and staples.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="hop"
BUNDLE_ID="${BUNDLE_ID:-io.zhoulab.hop.mac}"
VERSION="$(python3 -c 'import json;print(json.load(open("../package.json"))["version"])')"
GIT_SHA="$(git -C .. rev-parse --short HEAD 2>/dev/null || echo unknown)"
[[ -n "$(git -C .. status --porcelain -- macos 2>/dev/null)" ]] && GIT_SHA="${GIT_SHA}-dirty"

echo "==> swift build -c release"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/Hop"

APP=".dist/${APP_NAME}.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$APP_NAME"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>hop</string>
  <key>CFBundleDisplayName</key><string>hop</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>HopGitSHA</key><string>${GIT_SHA}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>hop — terminals for humans and agents</string>
  <!-- The local daemon is plain http on loopback. -->
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

echo "==> icon"
ICONSET="$(mktemp -d)/AppIcon.iconset"; mkdir -p "$ICONSET"
swift tools/make-icon.swift Resources/icon-source.png "$ICONSET/base.png"
for sz in 16 32 128 256 512; do
  sips -z $sz $sz "$ICONSET/base.png" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
  sips -z $((sz * 2)) $((sz * 2)) "$ICONSET/base.png" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
done
rm "$ICONSET/base.png"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

IDENTITY="${HOP_MAC_SIGN:-$(security find-identity -v -p codesigning 2>/dev/null | sed -nE 's/.*"(Developer ID Application:[^"]+)".*/\1/p' | head -1)}"
if [[ -n "$IDENTITY" ]]; then
  echo "==> signing: $IDENTITY"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
else
  echo "==> signing ad hoc (no Developer ID in the Keychain)"
  codesign --force --sign - "$APP"
fi
codesign --verify --strict "$APP"

if [[ -n "${HOP_MAC_NOTARY_PROFILE:-}" ]]; then
  echo "==> notarizing"
  ZIP="$(mktemp -d)/hop.zip"
  ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$HOP_MAC_NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
fi

echo "==> built $APP ($VERSION, $GIT_SHA)"
if [[ "${1:-}" == install ]]; then
  DEST="$HOME/Applications/hop.app"
  mkdir -p "$HOME/Applications"
  osascript -e 'tell application id "'"$BUNDLE_ID"'" to quit' >/dev/null 2>&1 || true
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  echo "==> installed $DEST"
fi
