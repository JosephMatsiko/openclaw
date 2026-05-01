#!/usr/bin/env node
// =============================================================================
// TRANSITIONAL DUPLICATE — Unit 2 of the openclaw-first migration (2026-05-01).
// =============================================================================
// The CANONICAL implementation lives at:
//   extensions/imessage-osascript/  (@openclaw/plugin-imessage-osascript)
//
// This .mjs preserves identical osascript send + reach-ledger writes so the
// remaining caller (chuck-comms-cascade.mjs) keeps working unchanged during
// the transition. The .mjs cannot import the TS plugin's api.ts at
// vanilla-Node runtime (no .ts loader), so duplicating the logic is the
// working seam.
//
// This file retires when chuck-comms-cascade migrates into openclaw skills
// in Unit 4 (queued).
//
// EDITS: bug fixes go in BOTH places (here AND extensions/imessage-osascript/src/send.ts)
// until this shim retires.
// =============================================================================
//
// chuck-sms-bridge — SMS-via-Mac-Messages.app fallback for reach-Joseph cascade.
//
// Why this exists:
//   The panel synthesis flagged dual-outage of Anthropic + OpenAI as the #1
//   reach-Joseph failure mode. Telegram + Discord ride on Joseph's home Wi-Fi
//   through openclaw's gateway. If the Mac's Wi-Fi is down OR the gateway
//   itself is degraded, those channels can't reach.
//
//   Apple's Continuity SMS pairs the Mac with the iPhone's cellular link.
//   When iMessage delivery fails (recipient offline, Apple ID issue, network
//   degraded), Messages.app automatically falls back to SMS over LTE through
//   the iPhone — a separate carrier than the Mac's primary network.
//
//   This script is a thin osascript wrapper around Messages.app that bypasses
//   the openclaw iMessage channel entirely. It's the deepest fallback in the
//   reach-Joseph cascade — when even openclaw can't reach.
//
// Why bypass openclaw iMessage:
//   - openclaw iMessage channel is currently broken on Joseph's setup
//     (94 MB chat.db blocks chats.list RPC; see filed issue #75792)
//   - openclaw iMessage requires the gateway to be healthy
//   - We want SMS-fallback to work when openclaw is degraded
//
// Contract:
//   send({ buddy, text }) → { ok, durationMs, transport, error? }
//   - buddy: phone number (E.164) or Apple ID
//   - text: message body (Apple is generous on length; SMS truncates to ~150
//           chars per segment, multiple segments stitched)
//   - transport: always "messages-osascript" — it's the same Mac path
//                whether iMessage or SMS-over-iPhone routing wins. Apple
//                decides routing based on recipient capability + signal.
//
// CLI:
//   node chuck-sms-bridge.mjs send <buddy> <text>
//   node chuck-sms-bridge.mjs probe <buddy>     — send a tiny probe message
//
// Side effects:
//   - Updates the reach-ledger via chuck-reach-ledger.mjs on success/failure.

import { spawnSync } from "node:child_process";
import { recordFailure, recordSuccess } from "./chuck-reach-ledger.mjs";

const TIMEOUT_MS = 12_000;
const CHANNEL_NAME = "sms-bridge";

function osascriptEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Send a message via Messages.app to the given buddy.
 *
 * @param {{ buddy: string, text: string, recordToLedger?: boolean }} input
 * @returns {{ ok: boolean, durationMs: number, transport: string, error?: string }}
 */
export function send(input) {
  const start = Date.now();
  const { buddy, text } = input;
  if (!buddy) {
    return { ok: false, durationMs: 0, transport: "messages-osascript", error: "buddy required" };
  }
  if (!text || !text.trim()) {
    return { ok: false, durationMs: 0, transport: "messages-osascript", error: "text required" };
  }

  const escapedText = osascriptEscape(text);
  // Prefer the SERVICE_TYPE iMessage path with explicit buddy lookup. Apple
  // routes to SMS automatically when iMessage isn't available for the
  // recipient + the Mac is paired with an iPhone via Continuity. See:
  // https://support.apple.com/en-us/HT208386
  const script = `tell application "Messages"
\tset targetService to 1st service whose service type = iMessage
\tset targetBuddy to buddy "${buddy}" of targetService
\tsend "${escapedText}" to targetBuddy
end tell`;

  const res = spawnSync("/usr/bin/osascript", ["-e", script], {
    timeout: TIMEOUT_MS,
    encoding: "utf8",
  });

  const durationMs = Date.now() - start;
  if (res.error) {
    const error = `osascript spawn error: ${res.error.message}`;
    if (input.recordToLedger !== false) recordFailure(CHANNEL_NAME, error);
    return { ok: false, durationMs, transport: "messages-osascript", error };
  }
  if (res.status !== 0) {
    const error = (res.stderr || "").trim() || `osascript exit ${res.status}`;
    if (input.recordToLedger !== false) recordFailure(CHANNEL_NAME, error);
    return { ok: false, durationMs, transport: "messages-osascript", error };
  }

  if (input.recordToLedger !== false) {
    recordSuccess(CHANNEL_NAME, { transport: "messages-osascript" });
  }
  return { ok: true, durationMs, transport: "messages-osascript" };
}

// ─── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const cmd = process.argv[2];
  if (cmd === "send") {
    const buddy = process.argv[3];
    const text = process.argv.slice(4).join(" ");
    if (!buddy || !text) {
      console.error("usage: chuck-sms-bridge send <buddy> <text>");
      process.exit(2);
    }
    const r = send({ buddy, text });
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
    return;
  }
  if (cmd === "probe") {
    const buddy = process.argv[3];
    if (!buddy) {
      console.error("usage: chuck-sms-bridge probe <buddy>");
      process.exit(2);
    }
    const ts = new Date().toISOString();
    const r = send({ buddy, text: `Chuck reach-probe @ ${ts} (sms-bridge)` });
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
    return;
  }
  console.error("usage: chuck-sms-bridge {send <buddy> <text> | probe <buddy>}");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
