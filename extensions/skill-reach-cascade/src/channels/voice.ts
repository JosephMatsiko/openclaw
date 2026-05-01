// voice channel — /usr/bin/say -v Samantha, fire-and-forget.
//
// Tight spoken text: subject only, plus first sentence of body iff critical.
// We don't await speech completion; the cascade marks ok=true the moment
// `say` spawns successfully.

import { spawn } from "node:child_process";
import { osascriptEscape } from "../sign.js";
import type { AttemptResult, NotifyPayload } from "../types.js";

export function attemptVoice(payload: NotifyPayload): AttemptResult {
  const start = Date.now();
  let spoken = payload.subject ?? "";
  if (payload.severity === "critical" && payload.body) {
    const first = String(payload.body).split(/(?<=[.!?])\s/)[0] ?? "";
    if (first) spoken = `${spoken}. ${first}`;
  }
  const escaped = osascriptEscape(spoken);
  try {
    const child = spawn("/usr/bin/say", ["-v", "Samantha", "-r", "190", escaped], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const durationMs = Date.now() - start;
    if (child.pid) return { ok: true, durationMs };
    return { ok: false, error: "say spawn returned no pid", durationMs };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message ?? String(err),
      durationMs: Date.now() - start,
    };
  }
}
