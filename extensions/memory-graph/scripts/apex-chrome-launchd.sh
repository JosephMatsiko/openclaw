#!/usr/bin/env bash
# Apex Chrome launchd entrypoint — brought up by
# ~/Library/LaunchAgents/com.josephmatsiko.apex-chrome.plist.
#
# Responsibilities:
#   1. Launch every Apex Chrome profile (a / b / c) on its CDP port
#      (9222 / 9223 / 9224) if not already up.
#   2. Sideload session cookies from Joseph's main profile for every
#      known subscription domain.
#   3. Exit cleanly — the plist loops on a schedule; this script is
#      designed to be idempotent and fast.

set -euo pipefail

REPO="${HOME}/Projects/openclaw"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
SCRIPTS="${REPO}/extensions/memory-graph/scripts"
LOG_DIR="${HOME}/.openclaw/logs"
mkdir -p "${LOG_DIR}"
LOG="${LOG_DIR}/apex-chrome-launchd.log"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "${LOG}"
}

# Which profiles to keep up
PROFILES="${APEX_CHROME_PROFILES:-a}"

for p in ${PROFILES}; do
  log "launching profile ${p}"
  APEX_CHROME_PROFILE="${p}" "${NODE_BIN}" "${SCRIPTS}/apex-chrome-cdp.mjs" launch >> "${LOG}" 2>&1 || log "launch ${p} failed"
done

# Sideload cookies for all known subscription domains (fast; no-op if
# already fresh).
sleep 2
for p in ${PROFILES}; do
  log "cookie sideload profile ${p}"
  APEX_CHROME_PROFILE="${p}" "${NODE_BIN}" "${SCRIPTS}/apex-chrome-cookies-sideload.mjs" \
    chatgpt.com openai.com perplexity.ai gemini.google.com google.com accounts.google.com claude.ai anthropic.com grok.com x.ai aistudio.google.com \
    >> "${LOG}" 2>&1 || log "sideload ${p} failed"
done

log "apex-chrome-launchd done"
