#!/usr/bin/env bash
# Makes Chrome (with Audible), the server and Caddy start automatically at login (macOS launchd agents), the
# macOS equivalent of a Windows startup script. Run it once on the Mac that hosts everything:
#
#   ./scripts/install-autostart.sh              install (or reinstall) and start them now
#   ./scripts/install-autostart.sh --uninstall  stop them and remove them
#
# - chrome: scripts/start-chrome.sh (sound output -> BlackHole, then Chrome with the Audible
#           profile and DevTools port), restarted if Chrome exits.
# - server: node server/index.js, restarted automatically if it exits.
# - caddy:  caddy run --config Caddyfile, restarted automatically if it exits. Leave it out with
#           NO_CADDY=1 when another Caddy on this Mac already serves audible.elliscode.com.
# Logs go to logs/*.log in this folder. Login codes are in logs/server.log.
#
# Agents only run while you're logged in, so turn on automatic login (System Settings → Users &
# Groups). The server's ffmpeg needs Microphone permission to capture BlackHole; see README.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PREFIX="com.elliscode.audible-for-kaios"
NAMES="chrome server"
[ -n "${NO_CADDY:-}" ] || NAMES="$NAMES caddy"
DOMAIN="gui/$(id -u)"

unload() {
  for name in $NAMES; do
    launchctl bootout "$DOMAIN/$PREFIX.$name" 2>/dev/null || true
  done
}

if [ "${1:-}" = "--uninstall" ]; then
  unload
  for name in $NAMES; do rm -f "$AGENTS_DIR/$PREFIX.$name.plist"; done
  echo "Autostart removed."
  exit 0
fi

# launchd starts programs with a minimal PATH, so record where the tools live on this Mac.
need() { command -v "$1" || { echo "Not found: $1 ($2)" >&2; exit 1; }; }
NODE=$(need node "brew install node")
FFMPEG=$(need ffmpeg "brew install ffmpeg")
[ -x "$REPO/capture/audio-capture" ] || { echo "Not built: capture/audio-capture (./scripts/build-capture.sh)" >&2; exit 1; }
if [ -z "${NO_CADDY:-}" ]; then CADDY=$(need caddy "brew install caddy"); else CADDY=""; fi
TOOL_PATH="$(dirname "$NODE"):$(dirname "$FFMPEG"):${CADDY:+$(dirname "$CADDY"):}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$AGENTS_DIR" "$REPO/logs"

# write_agent <name> <working dir> <keep alive: true|false> <program> [args...]
write_agent() {
  local name=$1 dir=$2 keepalive=$3
  shift 3
  local args=""
  for a in "$@"; do args+="    <string>$a</string>"$'\n'; done
  cat > "$AGENTS_DIR/$PREFIX.$name.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PREFIX.$name</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>WorkingDirectory</key>
  <string>$dir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$TOOL_PATH</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <$keepalive/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$REPO/logs/$name.log</string>
  <key>StandardErrorPath</key>
  <string>$REPO/logs/$name.log</string>
</dict>
</plist>
EOF
  plutil -lint -s "$AGENTS_DIR/$PREFIX.$name.plist"
}

write_agent chrome "$REPO" true /bin/bash "$REPO/scripts/start-chrome.sh"
write_agent server "$REPO/server" true "$NODE" index.js
if [ -z "${NO_CADDY:-}" ]; then write_agent caddy "$REPO" true "$CADDY" run --config Caddyfile; fi

if [ -n "${NO_LOAD:-}" ]; then
  echo "Wrote agents to $AGENTS_DIR (not loaded)."
  exit 0
fi

unload
for name in $NAMES; do
  launchctl bootstrap "$DOMAIN" "$AGENTS_DIR/$PREFIX.$name.plist"
done
echo "Autostart installed and started. Logs: $REPO/logs/ (login codes: tail -f logs/server.log)"
echo "Stop any copies you started by hand (npm start / caddy run) first, or they'll clash on ports."
