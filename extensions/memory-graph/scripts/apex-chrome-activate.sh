#!/usr/bin/env bash
# One-shot install: copy plist into LaunchAgents and bootstrap it.
set -euo pipefail

REPO="${HOME}/Projects/openclaw"
SRC="${REPO}/extensions/memory-graph/scripts/apex-chrome-plist.xml"
DEST="${HOME}/Library/LaunchAgents/com.josephmatsiko.apex-chrome.plist"

if [[ ! -f "${SRC}" ]]; then
  echo "plist template not found: ${SRC}" >&2
  exit 1
fi

chmod +x "${REPO}/extensions/memory-graph/scripts/apex-chrome-launchd.sh"
cp "${SRC}" "${DEST}"
echo "installed: ${DEST}"

# Unload if already active, then load
launchctl bootout gui/$(id -u)/com.josephmatsiko.apex-chrome 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "${DEST}"
launchctl kickstart -k "gui/$(id -u)/com.josephmatsiko.apex-chrome" || true
echo "bootstrapped · check status: launchctl print gui/$(id -u)/com.josephmatsiko.apex-chrome"
