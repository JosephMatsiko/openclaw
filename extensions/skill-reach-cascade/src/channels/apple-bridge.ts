// apex-apple-bridge channel — osascript display notification.
//
// Severity-aware sound: critical → Sosumi, otherwise system default.

import { spawnSync } from "node:child_process";
import { osascriptEscape } from "../sign.js";
import type { AttemptResult, NotifyPayload } from "../types.js";

const TIMEOUT_MS = 5_000;

export function attemptAppleBridge(payload: NotifyPayload): AttemptResult {
  const start = Date.now();
  const subject = payload.subject || "Chuck notification";
  const body = payload.body ?? "";
  const sound = payload.severity === "critical" ? "Sosumi" : "default";
  const subj = osascriptEscape(subject);
  const text = osascriptEscape(body || subject);
  const script =
    sound === "default"
      ? `display notification "${text}" with title "${subj}"`
      : `display notification "${text}" with title "${subj}" sound name "${sound}"`;
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
