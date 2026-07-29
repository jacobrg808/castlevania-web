#!/bin/bash
# Builds Castlevania.app — a self-contained, double-clickable macOS app. This is
# a macOS-only convenience; the portable way to run the game on any platform is
# `npm run play` (tools/play.mjs).
#
#   npm run package-app
#
# The bundle carries its own copy of the production build, the static server and
# the launcher, so it never reads the project directory. That matters because
# macOS (TCC) denies Finder-launched apps access to ~/Documents until the user
# grants it, and an unsigned app gets no prompt — it just fails.
#
# Re-run this after code changes to refresh the app. To play the live source
# instead, double-click Castlevania.command in the project root.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

DEST="${1:-/Applications}"
APP="$DEST/Castlevania.app"

[ -d public/assets ] || {
  echo "error: public/assets is missing. Run 'npm run convert-assets' first." >&2
  exit 1
}

echo "==> Building production bundle"
npm run build

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# The game itself, plus the two scripts that run it.
cp -R dist "$APP/Contents/Resources/game"
cp tools/serve-dist.mjs tools/launch.sh "$APP/Contents/Resources/"
chmod +x "$APP/Contents/Resources/launch.sh"

# Bundle entry point: point the launcher at the bundled build.
cat > "$APP/Contents/MacOS/Castlevania" <<'LAUNCHER'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
export GAME_ROOT="$RES/game"
exec "$RES/launch.sh"
LAUNCHER
chmod +x "$APP/Contents/MacOS/Castlevania"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.1.0)"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Castlevania</string>
  <key>CFBundleDisplayName</key><string>Castlevania</string>
  <key>CFBundleExecutable</key><string>Castlevania</string>
  <key>CFBundleIdentifier</key><string>com.jacobrg.castlevania-web</string>
  <key>CFBundleIconFile</key><string>Castlevania</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Icon: tools/icon.png if present, otherwise cut a square from the title screen.
ICON_SRC=""
if [ -f tools/icon.png ]; then
  ICON_SRC="tools/icon.png"
elif [ -f public/assets/sprites/main_menu.png ]; then
  ICON_SRC="public/assets/sprites/main_menu.png"
fi

if [ -n "$ICON_SRC" ]; then
  WORK="$(mktemp -d)"
  ICONSET="$WORK/Castlevania.iconset"
  mkdir -p "$ICONSET"
  # Square the source (a centered crop is a no-op on an already-square icon).
  SIDE="$(sips -g pixelHeight -g pixelWidth "$ICON_SRC" | awk '/pixel/ {print $2}' | sort -n | head -1)"
  sips -c "$SIDE" "$SIDE" "$ICON_SRC" --out "$WORK/square.png" >/dev/null
  for s in 16 32 128 256 512; do
    sips -z $s $s "$WORK/square.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$WORK/square.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Castlevania.icns"
  rm -rf "$WORK"
fi

# Ad-hoc signature keeps macOS from treating the bundle as damaged.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

echo "==> Done: $APP"
echo "    Double-click it, or drag it to the Dock."
