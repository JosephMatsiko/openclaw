// imessage channel — direct osascript send to a known buddy.
//
// Distinct from sms-bridge: this path is what chuck-comms-cascade.mjs called
// `attemptIMessage` (Apple Messages.app, iMessage-or-fail; no Continuity
// SMS fallback at this layer). The downstream sms-bridge channel — which
// uses @openclaw/plugin-imessage-osascript — is what gives us the SMS-over-
// LTE escape hatch.

import { spawnSync } from "node:child_process";
import { buildSignedText, osascriptEscape } from "../sign.js";
import type { AttemptResult, NotifyPayload } from "../types.js";

const TIMEOUT_MS = 10_000;

export function attemptImessage(payload: NotifyPayload, opts: { buddy: string }): AttemptResult {
  const start = Date.now();
  const text = buildSignedText(payload);
  const escaped = osascriptEscape(text);
  const script = `tell application "Messages"
\tset targetService to 1st service whose service type = iMessage
\tset targetBuddy to buddy "${opts.buddy}" of targetService
\tsend "${escaped}" to targetBuddy
end tell`;
  try {
    const res = spawnSync("/usr/bin/osascript", ["-e", script], {
      timeout: TIMEOUT_MS,
      encoding: "utf8",
    });
    const durationMs = Date.now() - start;
    if (res.error) return { ok: false, error: res.error.message, durationMs };
    if (res.status !== 0) {
      return {
        ok: false,
        error: (res.stderr ?? "").trim() || `exit ${res.status}`,
        durationMs,
      };
    }
    return { ok: true, durationMs };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message ?? String(err),
      durationMs: Date.now() - start,
    };
  }
}
