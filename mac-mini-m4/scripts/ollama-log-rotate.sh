#!/bin/bash
# Rotates /Users/alex/ollama.log once it crosses a size threshold.
#
# com.local.ollama's StandardOutPath/StandardErrorPath both point at this one
# file with no rotation — it grew to 16GB unbounded (pure GIN request-log
# noise: /api/tags, /api/ps health-check polling) before this existed.
# ollama itself has no signal to reopen its log file, so truncation-in-place
# isn't reliable — instead this deletes the file and force-restarts the
# com.local.ollama LaunchDaemon so launchd reopens a fresh empty file. Same
# bootout+bootstrap technique already used for com.local.slzb-proxy /
# com.local.dns-udp-proxy elsewhere in this repo.
#
# No history retained by design — this log has no long-term diagnostic value.
set -euo pipefail

LOG=/Users/alex/ollama.log
THRESHOLD_BYTES=$((50 * 1024 * 1024))  # 50MB
PLIST=/Library/LaunchDaemons/com.local.ollama.plist

[ -f "$LOG" ] || exit 0

size=$(stat -f%z "$LOG" 2>/dev/null || echo 0)
if [ "$size" -lt "$THRESHOLD_BYTES" ]; then
  exit 0
fi

echo "$(date): ollama.log is ${size} bytes (>= ${THRESHOLD_BYTES}), rotating"

launchctl bootout system "$PLIST" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$LOG"
launchctl bootstrap system "$PLIST" 2>/dev/null || launchctl load "$PLIST"

echo "$(date): rotated ollama.log and restarted com.local.ollama"
