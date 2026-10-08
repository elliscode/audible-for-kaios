#!/usr/bin/env bash
# Starts the Chrome that plays Audible, with its own profile (log into Audible by hand once; the
# profile keeps the session) and the DevTools port the server uses for play/pause/seek.
#
# - Real Google Chrome, not Playwright's Chromium: Audible's player needs Widevine.
# - The DevTools port only listens on 127.0.0.1.
# - Switches the Mac's sound output to BlackHole first, so the server can capture it.
# - If that Chrome is already running, waits until it exits instead (so the launchd agent from
#   install-autostart.sh restarts it after a crash or quit, without opening a second copy).
set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="${AUDIBLE_PROFILE:-$HOME/audible-browser-profile}"
PORT="${CDP_PORT:-9222}"
OUTPUT="${AUDIO_DEVICE:-BlackHole 2ch}"
URL="https://www.audible.com/library/titles"

cdp_up() { curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/json/version"; }

if command -v SwitchAudioSource >/dev/null; then
  SwitchAudioSource -t output -s "$OUTPUT" || echo "Couldn't switch output to $OUTPUT" >&2
else
  echo "SwitchAudioSource not found (brew install switchaudio-osx); set the output to $OUTPUT by hand" >&2
fi

if cdp_up; then
  echo "Chrome is already running on port $PORT; waiting for it to exit."
  while cdp_up; do sleep 30; done
  exit 0
fi

mkdir -p "$PROFILE"
exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --window-size=960,1104 \
  --window-position=0,0 \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  "$URL"
