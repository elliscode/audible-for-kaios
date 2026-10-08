#!/usr/bin/env bash
# Builds capture/audio-capture, the BlackHole recorder the server runs (see capture/capture.swift).
# Needs the Xcode command line tools (xcode-select --install). Run once per Mac, and after
# changing capture.swift.
set -euo pipefail
cd "$(dirname "$0")/.."
swiftc -O -swift-version 5 capture/capture.swift -o capture/audio-capture
echo "Built capture/audio-capture"
