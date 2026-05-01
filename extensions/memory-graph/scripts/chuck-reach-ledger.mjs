#!/usr/bin/env node
// =============================================================================
// TRANSITIONAL DUPLICATE — Unit 2 of the openclaw-first migration (2026-05-01).
// =============================================================================
// The CANONICAL implementation lives at:
//   extensions/reach-ledger/  (@openclaw/plugin-reach-ledger)
//
// This .mjs preserves identical wire-format reads/writes (same
// ~/.openclaw/workspace/state/chuck-v3/reach-ledger.json) so the remaining
// caller (chuck-comms-cascade.mjs) keeps working unchanged during the
// transition. The .mjs cannot import the TS plugin's api.ts at vanilla-Node
// runtime (no .ts loader), so duplicating the logic is the working seam.
//
// This file retires when chuck-comms-cascade migrates into openclaw skills
// in Unit 4 (queued). Joseph's policy 2026-05-01: every commit moves
// chuck-* mass INTO openclaw or RETIRES it. Both copies write to the same
// ledger file — wire-compatible.
//
// EDITS: bug fixes go in BOTH places (here AND extensions/reach-ledger/src/store.ts)
// until this shim retires.
// =============================================================================
//
// chuck-reach-ledger — per-channel `last_proven_at` ledger.
//
// This is the panel's #1 failure-mode mitigation: every cascade attempt
// records WHICH channel last successfully reached Joseph and when. The
// ledger is consulted when ranking cascade order so a channel that's been
// silently failing isn't tried first; a channel that just succeeded is
// trusted as the canonical reach path for the next ~freshnessMs window.
//
// File: ~/.openclaw/workspace/state/chuck-v3/reach-ledger.json
//
// Schema v1:
//   {
//     "version": 1,
//     "channels": {
//       "<channel>": {
//         "last_proven_at": "ISO-8601 | null",
//         "last_proven_message_id": "string | null",
//         "last_proven_transport": "openclaw-native | raw-bot-api | osascript | ...",
//         "last_failed_at": "ISO-8601 | null",
//         "last_failed_reason": "string | null",
//         "consecutive_failures": number,
//         "consecutive_successes": number
//       }
//     },
//     "global": {
//       "last_reached_via": "<channel> | null",
//       "last_reached_at": "ISO-8601 | null"
//     }
//   }
//
// CLI:
//   node chuck-reach-ledger.mjs status       — print current ledger
//   node chuck-reach-ledger.mjs ranking      — print cascade order based on freshness
//   node chuck-reach-ledger.mjs reset        — wipe ledger (require --force)

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();
const LEDGER_PATH = join(HOME, ".openclaw", "workspace", "state", "chuck-v3", "reach-ledger.json");

const SCHEMA_VERSION = 1;

const DEFAULT_CHANNEL_RECORD = Object.freeze({
  last_proven_at: null,
  last_proven_message_id: null,
  last_proven_transport: null,
  last_failed_at: null,
  last_failed_reason: null,
  consecutive_failures: 0,
  consecutive_successes: 0,
});

function nowIso() {
  return new Date().toISOString();
}

function ensureDir() {
  const dir = dirname(LEDGER_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readLedger() {
  if (!existsSync(LEDGER_PATH)) {
    return {
      version: SCHEMA_VERSION,
      channels: {},
      global: { last_reached_via: null, last_reached_at: null },
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    if (!parsed.channels) parsed.channels = {};
    if (!parsed.global) parsed.global = { last_reached_via: null, last_reached_at: null };
    if (parsed.version !== SCHEMA_VERSION) {
      // Forward-compatible: read older versions tolerantly. We only ship v1
      // today, so this is a guard for future schema bumps.
      parsed.version = SCHEMA_VERSION;
    }
    return parsed;
  } catch (err) {
    process.stderr.write(`[reach-ledger] read failed (${String(err)}); resetting\n`);
    return {
      version: SCHEMA_VERSION,
      channels: {},
      global: { last_reached_via: null, last_reached_at: null },
    };
  }
}

function writeLedgerAtomic(ledger) {
  ensureDir();
  // Atomic write: tmp file + rename so concurrent readers can't see torn state.
  const tmp = `${LEDGER_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  renameSync(tmp, LEDGER_PATH);
}

function ensureChannelRecord(ledger, channel) {
  if (!ledger.channels[channel]) {
    ledger.channels[channel] = { ...DEFAULT_CHANNEL_RECORD };
  }
  return ledger.channels[channel];
}

/**
 * Record a successful reach via `channel`. Updates per-channel and global
 * fields. `detail` is freeform: { messageId, transport, ledgerEntryId, ... }.
 */
export function recordSuccess(channel, detail = {}) {
  const ledger = readLedger();
  const rec = ensureChannelRecord(ledger, channel);
  const ts = nowIso();
  rec.last_proven_at = ts;
  rec.last_proven_message_id = detail.messageId ?? rec.last_proven_message_id;
  rec.last_proven_transport = detail.transport ?? rec.last_proven_transport;
  rec.consecutive_successes = (rec.consecutive_successes ?? 0) + 1;
  rec.consecutive_failures = 0;
  ledger.global.last_reached_via = channel;
  ledger.global.last_reached_at = ts;
  writeLedgerAtomic(ledger);
  return { ok: true, ledgerPath: LEDGER_PATH, channel, ts };
}

/**
 * Record a failed reach attempt via `channel`. Updates per-channel state
 * but does NOT touch global last_reached_* (failure of this channel doesn't
 * change "who last reached him").
 */
export function recordFailure(channel, reason) {
  const ledger = readLedger();
  const rec = ensureChannelRecord(ledger, channel);
  rec.last_failed_at = nowIso();
  rec.last_failed_reason = String(reason ?? "unknown").slice(0, 500);
  rec.consecutive_failures = (rec.consecutive_failures ?? 0) + 1;
  rec.consecutive_successes = 0;
  writeLedgerAtomic(ledger);
  return { ok: true, ledgerPath: LEDGER_PATH, channel };
}

/**
 * Inspect the ledger.
 */
export function getStatus() {
  return readLedger();
}

/**
 * Rank channels by freshness for cascade ordering.
 *
 * Strategy:
 *   1. Channels with `last_proven_at` within `freshnessMs` come first,
 *      sorted by recency.
 *   2. Channels never proven (or stale) come next, sorted by their default
 *      cascade priority.
 *   3. Channels with `consecutive_failures >= circuitBreakerThreshold` are
 *      pushed last (still tried, but only after all other options).
 *
 * Returns an array of channel names in cascade order.
 */
export function rankChannels(defaultOrder, opts = {}) {
  const freshnessMs = opts.freshnessMs ?? 15 * 60 * 1000; // 15 min
  const circuitBreakerThreshold = opts.circuitBreakerThreshold ?? 5;
  const now = Date.now();
  const ledger = readLedger();

  const fresh = [];
  const normal = [];
  const tripped = [];

  for (const ch of defaultOrder) {
    const rec = ledger.channels[ch];
    const failures = rec?.consecutive_failures ?? 0;
    if (failures >= circuitBreakerThreshold) {
      tripped.push({ ch, failures });
      continue;
    }
    const provenAt = rec?.last_proven_at ? Date.parse(rec.last_proven_at) : null;
    if (provenAt && now - provenAt <= freshnessMs) {
      fresh.push({ ch, provenAt });
    } else {
      normal.push(ch);
    }
  }

  fresh.sort((a, b) => b.provenAt - a.provenAt);
  tripped.sort((a, b) => a.failures - b.failures); // less-broken first

  return [...fresh.map((x) => x.ch), ...normal, ...tripped.map((x) => x.ch)];
}

// ─── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const cmd = process.argv[2] ?? "status";
  if (cmd === "status") {
    const ledger = readLedger();
    console.log(JSON.stringify(ledger, null, 2));
    return;
  }
  if (cmd === "ranking") {
    const defaultOrder = (
      process.argv[3] ?? "telegram,discord,apex-apple-bridge,imessage,sms-bridge,web-push"
    ).split(",");
    const ranked = rankChannels(defaultOrder);
    console.log(JSON.stringify({ defaultOrder, ranked }, null, 2));
    return;
  }
  if (cmd === "reset") {
    if (process.argv[3] !== "--force") {
      console.error("usage: chuck-reach-ledger reset --force");
      process.exit(2);
    }
    writeLedgerAtomic({
      version: SCHEMA_VERSION,
      channels: {},
      global: { last_reached_via: null, last_reached_at: null },
    });
    console.log(`reset ${LEDGER_PATH}`);
    return;
  }
  console.error(`unknown command: ${cmd}`);
  console.error("usage: chuck-reach-ledger {status | ranking [defaultOrder] | reset --force}");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
