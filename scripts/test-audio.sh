#!/usr/bin/env bash
# Milestone 2: proves the Mac's sound can be captured from BlackHole.
# Play something in Audible (with the output set to BlackHole), then run this. It lists the
# capture devices, records 10 seconds to capture.wav and prints the loudness: about -91 dB means
# silence (nothing reached BlackHole). The first run asks for Microphone permission.
set -euo pipefail
cd "$(dirname "$0")/.."
DEVICE="${AUDIO_DEVICE:-BlackHole 2ch}"
SECONDS_TO_RECORD="${1:-10}"

echo "== Audio capture devices =="
# ffmpeg always ends a device listing with "Error opening input": that part is noise.
DEVICES=$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 |
  sed -n '/audio devices/,$p' | grep -o '\[[0-9]*\] .*' || true)
echo "$DEVICES"

if ! printf '%s\n' "$DEVICES" | grep -qF "] $DEVICE"; then
  echo
  echo "\"$DEVICE\" isn't in the list." >&2
  if [ -d "/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver" ]; then
    echo "It's installed but macOS hasn't loaded it yet: run  sudo killall coreaudiod  (or reboot)." >&2
  else
    echo "Install it with  brew install blackhole-2ch , then  sudo killall coreaudiod ." >&2
  fi
  exit 1
fi

[ -x capture/audio-capture ] || ./scripts/build-capture.sh

# Same recorder the server uses (ffmpeg's own avfoundation input drops audio; see capture.swift).
echo "== Recording $SECONDS_TO_RECORD s from \"$DEVICE\" to capture.wav =="
capture/audio-capture "$DEVICE" |
  ffmpeg -hide_banner -loglevel error -y -f s16le -ar 48000 -ac 2 -i pipe:0 -t "$SECONDS_TO_RECORD" capture.wav ||
  true # the recorder ends with SIGPIPE once ffmpeg has its seconds
SAMPLES=$(ffprobe -v error -select_streams a -count_packets -show_entries stream=duration -of csv=p=0 capture.wav)
echo "Recorded $SAMPLES s of audio"

echo "== Loudness =="
ffmpeg -hide_banner -i capture.wav -af volumedetect -f null - 2>&1 | grep -E 'mean_volume|max_volume'
echo "To listen: switch the output back to speakers (SwitchAudioSource -t output -s \"Mac mini Speakers\"), then afplay capture.wav"
