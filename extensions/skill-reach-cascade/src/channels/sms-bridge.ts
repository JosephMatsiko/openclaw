// sms-bridge channel — routes through @openclaw/plugin-imessage-osascript.
//
// Apple Continuity decides whether the recipient gets iMessage (Apple-to-
// Apple) or SMS over LTE. When the Mac's Wi-Fi degrades but the iPhone's
// cellular link is up, SMS-over-LTE is the working path — separate carrier
// from openclaw's gateway, by design.
//
// The cascade records its own ledger writes for sms-bridge under that
// channel name, so we pass `recordToLedger: false` here to avoid double-
// counting per-channel last_proven_at.

import { sendImessage } from "../../../imessage-osascript/api.js";
import { buildSignedText } from "../sign.js";
import type { AttemptResult, NotifyPayload } from "../types.js";

export function attemptSmsBridge(payload: NotifyPayload, opts: { buddy: string }): AttemptResult {
  const text = buildSignedText(payload);
  const result = sendImessage({
    buddy: opts.buddy,
    text,
    recordToLedger: false,
  });
  if (result.ok) {
    return {
      ok: true,
      durationMs: result.durationMs,
      transport: result.transport,
    };
  }
  return {
    ok: false,
    durationMs: result.durationMs,
    error: result.error ?? "sms-bridge failed",
  };
}
