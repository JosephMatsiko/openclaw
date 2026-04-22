#!/usr/bin/env bash
# Activate the OpenClaw gateway LaunchAgent so it starts on login and
# auto-restarts on crash. Safe to run multiple times (idempotent-ish).
#
# Usage:
#   scripts/activate-gateway-launchagent.sh
#
# Undo:
#   launchctl bootout gui/$(id -u)/com.josephmatsiko.openclaw-gateway

set -euo pipefail

PLIST_PATH="${HOME}/Library/LaunchAgents/com.josephmatsiko.openclaw-gateway.plist"
LABEL="com.josephmatsiko.openclaw-gateway"
DOMAIN="gui/$(id -u)"

if [[ ! -f "${PLIST_PATH}" ]]; then
  echo "error: ${PLIST_PATH} not found" >&2
  exit 1
fi

echo "[1/4] stopping any manually-started gateway..."
pkill -f "openclaw.*gateway" 2>/dev/null || true
sleep 2

echo "[2/4] booting out any prior LaunchAgent registration..."
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true

echo "[3/4] bootstrapping LaunchAgent from ${PLIST_PATH}..."
launchctl bootstrap "${DOMAIN}" "${PLIST_PATH}"
launchctl enable "${DOMAIN}/${LABEL}"

echo "[4/4] waiting for gateway to come up..."
for i in $(seq 1 20); do
  if curl -sS --max-time 2 http://127.0.0.1:18789/health 2>/dev/null | grep -q '"status":"live"'; then
    echo "✓ gateway live: $(curl -sS http://127.0.0.1:18789/health)"
    echo ""
    echo "launchctl state:"
    launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null | grep -E "state =|last exit code|program =" | head -5 || true
    echo ""
    echo "done. the gateway will now auto-start on every login and auto-restart on crash."
    echo "tail logs with: tail -f /tmp/openclaw/gateway.stdout.log"
    exit 0
  fi
  sleep 1
done

echo "warn: gateway didn't reach /health in 20s; check /tmp/openclaw/gateway.stderr.log" >&2
exit 1
