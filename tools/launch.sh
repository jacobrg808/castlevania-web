#!/bin/bash
# macOS-only launcher, used by Castlevania.app and Castlevania.command. Every
# platform's portable equivalent is `npm run play` (tools/play.mjs).
#
# It serves the production build on localhost and opens it in a bare Chrome window (no tabs or address bar) so it behaves like a
# standalone game. Closing the window shuts the server down.
#
# Runs in two modes:
#
#   Bundled (GAME_ROOT set) — Castlevania.app runs its own copy of this script
#     from inside the bundle and serves the build bundled beside it. It never
#     reads the project directory, because macOS denies Finder-launched apps
#     access to ~/Documents until the user grants it explicitly.
#
#   Dev (GAME_ROOT unset) — Castlevania.command in the project root builds
#     dist/ if it is stale, then serves that. Terminal already has file access,
#     so this mode always plays the current source.

set -uo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SUPPORT_DIR="$HOME/Library/Application Support/castlevania-web"
PROFILE_DIR="$SUPPORT_DIR/chrome-profile"
LOG="$HOME/Library/Logs/castlevania-web-launch.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$(dirname "$LOG")" "$SUPPORT_DIR"
exec 2> >(tee -a "$LOG" >&2)

# Show a real dialog on failure — a .app bundle has no console to print to.
die() {
  echo "$1" >&2
  /usr/bin/osascript -e "display dialog \"$1\" with title \"Castlevania\" buttons {\"OK\"} default button 1 with icon stop" >/dev/null 2>&1
  exit 1
}

# --- locate node -------------------------------------------------------------
# A Finder-launched app inherits a bare PATH, so nvm's shims are not on it.
find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.volta/bin/node \
    /usr/bin/node
  do
    [ -x "$candidate" ] && echo "$candidate"
  done
}

# Highest version wins if several nvm installs matched.
NODE="$(find_node | sort -V | tail -n 1)"
[ -n "$NODE" ] || die "Could not find Node.js. Install it from https://nodejs.org and try again."

# --- resolve what to serve ---------------------------------------------------
if [ -n "${GAME_ROOT:-}" ]; then
  # Bundled mode: the build and the server script ship next to this script.
  SERVER="$SCRIPT_DIR/serve-dist.mjs"
  [ -f "$GAME_ROOT/index.html" ] || die "This copy of Castlevania is missing its game files. Re-run 'npm run package-app' in the project."
else
  # Dev mode: build from source when dist/ is missing or stale.
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  cd "$PROJECT_DIR" || die "Could not enter $PROJECT_DIR"
  export PATH="$(dirname "$NODE"):$PATH"
  SERVER="tools/serve-dist.mjs"

  needs_build() {
    [ -f dist/index.html ] || return 0
    [ -n "$(find src index.html package.json tsconfig.json -newer dist/index.html 2>/dev/null | head -n 1)" ]
  }

  [ -d public/assets ] || die "Game assets are missing (public/assets). Run 'npm run setup' in $PROJECT_DIR first."
  if needs_build; then
    [ -d node_modules ] || npm install --silent || die "npm install failed. See $LOG"
    npm run build >>"$LOG" 2>&1 || die "Build failed. See $LOG"
  fi
  GAME_ROOT="$PROJECT_DIR/dist"
fi

# --- serve -------------------------------------------------------------------
SERVER_OUT="$(mktemp -t castlevania-serve)"
GAME_ROOT="$GAME_ROOT" "$NODE" "$SERVER" >"$SERVER_OUT" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null
  rm -f "$SERVER_OUT"
}
trap cleanup EXIT INT TERM

# Wait (up to ~5s) for the server to report its URL.
URL=""
for _ in $(seq 1 50); do
  URL="$(sed -n 's/^READY //p' "$SERVER_OUT" | head -n 1)"
  [ -n "$URL" ] && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.1
done
[ -n "$URL" ] || die "The game server did not start: $(cat "$SERVER_OUT" 2>/dev/null | head -n 3)"

# --- open --------------------------------------------------------------------
# Chrome records exit_type=Crashed whenever it is killed rather than quit (which
# is what happens if the app is force-quit, or the machine sleeps mid-session).
# On the next start that triggers crash recovery, which can pop a stray blank
# window. Reset the flag and point any window Chrome opens on its own at the
# game, so it can never surface an empty New Tab.
prep_chrome_profile() {
  local prefs="$PROFILE_DIR/Default/Preferences"
  mkdir -p "$PROFILE_DIR/Default"
  [ -f "$prefs" ] || echo '{}' > "$prefs"
  GAME_URL="$1" "$NODE" -e '
    const fs = require("fs");
    const path = process.argv[1];
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
    prefs.profile = { ...prefs.profile, exit_type: "Normal", exited_cleanly: true };
    prefs.session = {
      ...prefs.session,
      restore_on_startup: 4,               // 4 = open a specific list of URLs
      startup_urls: [process.env.GAME_URL],
    };
    prefs.homepage = process.env.GAME_URL;
    prefs.homepage_is_newtabpage = false;
    fs.writeFileSync(path, JSON.stringify(prefs));
  ' "$prefs" 2>/dev/null
}

if [ -x "$CHROME" ]; then
  prep_chrome_profile "$URL"
  # Chrome runs in the foreground on its own profile, so closing the game window
  # exits this script and the trap above stops the server. The game renders at
  # 512x448 (8:7), so 1024x896 is an exact 2x.
  "$CHROME" \
    --app="$URL" \
    --user-data-dir="$PROFILE_DIR" \
    --window-size=1024,896 \
    --no-first-run \
    --no-default-browser-check \
    --autoplay-policy=no-user-gesture-required \
    --disable-session-crashed-bubble \
    --hide-crash-restore-bubble \
    --disable-background-mode \
    --no-service-autorun \
    >>"$LOG" 2>&1
else
  # No Chrome: fall back to the default browser and hold the server open until
  # the user dismisses this dialog.
  open "$URL"
  /usr/bin/osascript -e 'display dialog "Castlevania is running in your browser.

Click Quit when you are done playing." with title "Castlevania" buttons {"Quit"} default button 1' >/dev/null 2>&1
fi
