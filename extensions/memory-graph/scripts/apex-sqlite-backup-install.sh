#!/bin/zsh
# apex-sqlite-backup-install — one-time setup for the nightly encrypted
# backup of ~/.openclaw/memory/graph.sqlite.
#
# Designed via panel review 2026-04-23 (Opus 4.7 CLI, Opus 4.7 Adaptive,
# ChatGPT 5.5 Thinking, Perplexity Pro). This script:
#   1. Generates a random 48-byte base64 passphrase
#   2. Stores it in the macOS login Keychain with -T whitelist so the
#      LaunchAgent (running as the logged-in user at 03:30) can read it
#      without a GUI prompt (Claude.ai's key correction).
#   3. Prints the passphrase ONCE — Joseph MUST write it down and store
#      offline (paper, sealed envelope, or password manager). Losing this
#      passphrase means every backup becomes undecryptable.
#   4. Installs the LaunchAgent to run at 03:30 local + on load + every 6h.
#
# After install:
#   - Run `$HOME/.openclaw/bin/apex-sqlite-backup.sh` once manually (this
#     script wraps apex-sqlite-backup.mjs); if Keychain prompts, approve.
#   - Check `~/.openclaw/logs/apex-sqlite-backup.log` for the first run.
#   - `node apex-sqlite-backup.mjs verify` confirms the latest backup
#     decrypts + passes PRAGMA quick_check.

set -euo pipefail
umask 077

KEYCHAIN_ITEM="apex-backup-key"
APEX_BIN_DIR="$HOME/.openclaw/bin"
SCRIPTS_DIR="$HOME/Projects/openclaw/extensions/memory-graph/scripts"
PLIST_PATH="$HOME/Library/LaunchAgents/com.josephmatsiko.apex-sqlite-backup.plist"
LOG_DIR="$HOME/.openclaw/logs"
ICLOUD_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/apex-backups"
NODE_BIN="$(which node)"

mkdir -p "$APEX_BIN_DIR" "$LOG_DIR" "$ICLOUD_DIR"
chmod 700 "$APEX_BIN_DIR" "$LOG_DIR"

# ----- 1. Generate + store the key --------------------------------------

if /usr/bin/security find-generic-password -s "$KEYCHAIN_ITEM" -a "$USER" >/dev/null 2>&1; then
  echo "Keychain item '$KEYCHAIN_ITEM' already exists. Skipping key generation."
  echo "If you want to rotate: security delete-generic-password -s $KEYCHAIN_ITEM -a $USER"
else
  PASS="$(/opt/homebrew/bin/openssl rand -base64 48)"
  # -T whitelist is the critical piece for LaunchAgent access (Claude.ai
  # 2026-04-23): the listed binaries can read this item without a GUI
  # prompt. Without this, security find-generic-password at 03:30 from
  # a LaunchAgent either prompts a modal dialog that never gets answered
  # or fails with errSecAuth.
  /usr/bin/security add-generic-password \
    -a "$USER" \
    -s "$KEYCHAIN_ITEM" \
    -w "$PASS" \
    -T /usr/bin/security \
    -T /bin/sh \
    -T /bin/zsh \
    -T "$NODE_BIN" \
    -U
  cat <<EOF

==============================================================================
  BACKUP PASSPHRASE — PRINT THIS PAGE AND STORE OFFLINE
  (write it on paper, seal in envelope, keep somewhere fire + flood-safe)

  $PASS

  Lose this string, lose every encrypted backup. There is no recovery.
==============================================================================

EOF
  unset PASS
  echo "After you've recorded the passphrase above, press Enter to continue..."
  read -r _
fi

# ----- 2. Install the wrapper shell ------------------------------------

cat > "$APEX_BIN_DIR/apex-sqlite-backup.sh" <<SHELL
#!/bin/zsh
# Thin wrapper so the LaunchAgent invokes a single stable path.
# The Node script does all the work; this wrapper only sets PATH so
# Homebrew openssl resolves.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec "$NODE_BIN" "$SCRIPTS_DIR/apex-sqlite-backup.mjs" run
SHELL
chmod 700 "$APEX_BIN_DIR/apex-sqlite-backup.sh"

# ----- 3. Install LaunchAgent ------------------------------------------

# StartCalendarInterval 03:30 + RunAtLoad (catches missed schedules on
# sleep-wake) + StartInterval 21600 (6h belt-and-suspenders, per Claude.ai).
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.josephmatsiko.apex-sqlite-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APEX_BIN_DIR/apex-sqlite-backup.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/apex-sqlite-backup.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/apex-sqlite-backup.err.log</string>
</dict>
</plist>
PLIST

# Reload if already loaded.
launchctl bootout "gui/$(id -u)/com.josephmatsiko.apex-sqlite-backup" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

echo
echo "Installed: $PLIST_PATH"
echo "Wrapper: $APEX_BIN_DIR/apex-sqlite-backup.sh"
echo
echo "Next steps:"
echo "  1. Run once manually to prime the Keychain prompt (if any):"
echo "       $APEX_BIN_DIR/apex-sqlite-backup.sh"
echo "  2. Verify the backup decrypts + passes quick_check:"
echo "       node $SCRIPTS_DIR/apex-sqlite-backup.mjs verify"
echo "  3. Tail the log:"
echo "       tail -f $LOG_DIR/apex-sqlite-backup.log"
echo
