// osascript Messages.app send — the Continuity SMS fallback path.
//
// Why this exists: openclaw's bundled imessage channel times out on
// large chat.db (issue #75792 — observed on Joseph's 94 MB db). This
// plugin bypasses imsg entirely with a thin osascript send; Apple's
// Continuity routes through the iPhone's LTE link when iMessage is
// offline, giving the deepest reach-resilience in the cascade.
//
// Salvaged from chuck-sms-bridge.mjs.

import { spawnSync } from "node:child_process";
import { recordFailure, recordSuccess } from "../../reach-ledger/api.js";
import type { SendInput, SendResult } from "./types.js";

const CHANNEL_NAME = "sms-bridge";
const DEFAULT_TIMEOUT_MS = 12_000;

function osascriptEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Send a message through Messages.app. Apple decides iMessage vs SMS-over-
 * LTE routing based on recipient capability + signal.
 */
export function sendImessage(input: SendInput): SendResult {
  const start = Date.now();
  if (!input.buddy?.trim()) {
    return {
      ok: false,
      durationMs: 0,
      transport: "messages-osascript",
      error: "buddy required",
    };
  }
  if (!input.text?.trim()) {
    return {
      ok: false,
      durationMs: 0,
      transport: "messages-osascript",
      error: "text required",
    };
  }

  const escaped = osascriptEscape(input.text);
  const script = `tell application "Messages"
\tset targetService to 1st service whose service type = iMessage
\tset targetBuddy to buddy "${input.buddy}" of targetService
\tsend "${escaped}" to targetBuddy
end tell`;

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = spawnSync("/usr/bin/osascript", ["-e", script], {
    timeout: timeoutMs,
    encoding: "utf8",
  });

  const durationMs = Date.now() - start;

  if (res.error) {
    const error = `osascript spawn error: ${res.error.message}`;
    if (input.recordToLedger !== false) recordFailure(CHANNEL_NAME, error);
    return { ok: false, durationMs, transport: "messages-osascript", error };
  }
  if (res.status !== 0) {
    const error = (res.stderr ?? "").trim() || `osascript exit ${res.status}`;
    if (input.recordToLedger !== false) recordFailure(CHANNEL_NAME, error);
    return { ok: false, durationMs, transport: "messages-osascript", error };
  }

  if (input.recordToLedger !== false) {
    recordSuccess(CHANNEL_NAME, { transport: "messages-osascript" });
  }
  return { ok: true, durationMs, transport: "messages-osascript" };
}
