// Build the signed text body that every channel-text-payload uses.
//
// Format: subject \n\n body \n\n "— Chuck — for Joseph — YYYY-MM-DD"
// (matches chuck-comms-cascade.mjs:buildSignedText so wire format is
// preserved for downstream watchers + ledger consumers).

import type { NotifyPayload } from "./types.js";

export function buildSignedText(payload: NotifyPayload, now: Date = new Date()): string {
  const ymd = now.toISOString().slice(0, 10);
  const head = payload.body ? `${payload.subject}\n\n${payload.body}` : payload.subject;
  return `${head}\n\n— Chuck — for Joseph — ${ymd}`;
}

export function osascriptEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
