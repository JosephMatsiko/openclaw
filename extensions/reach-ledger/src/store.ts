// Atomic-write JSON ledger for per-channel reach state.
//
// Salvaged from chuck-reach-ledger.mjs. Preserves the file format so
// existing ~/.openclaw/workspace/state/chuck-v3/reach-ledger.json data
// survives the migration unchanged.
//
// Concurrent writers: temp-file + rename pattern keeps readers from
// observing torn state. Single-host (cooperating processes through the
// filesystem); not multi-host coordinated.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChannelRecord, Ledger, RecordSuccessDetail } from "./types.js";

const SCHEMA_VERSION = 1;
const HOME = homedir();
const DEFAULT_LEDGER_PATH = join(
  HOME,
  ".openclaw",
  "workspace",
  "state",
  "chuck-v3",
  "reach-ledger.json",
);

const DEFAULT_CHANNEL_RECORD: Readonly<ChannelRecord> = Object.freeze({
  last_proven_at: null,
  last_proven_message_id: null,
  last_proven_transport: null,
  last_failed_at: null,
  last_failed_reason: null,
  consecutive_failures: 0,
  consecutive_successes: 0,
});

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

function emptyLedger(): Ledger {
  return {
    version: SCHEMA_VERSION,
    channels: {},
    global: { last_reached_via: null, last_reached_at: null },
  };
}

function readLedger(path: string): Ledger {
  if (!existsSync(path)) return emptyLedger();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Ledger;
    if (!parsed || typeof parsed !== "object") return emptyLedger();
    if (!parsed.channels) parsed.channels = {};
    if (!parsed.global) parsed.global = { last_reached_via: null, last_reached_at: null };
    parsed.version = SCHEMA_VERSION; // forward-compat tolerant
    return parsed;
  } catch {
    return emptyLedger();
  }
}

function writeLedgerAtomic(path: string, ledger: Ledger): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function ensureChannel(ledger: Ledger, channel: string): ChannelRecord {
  if (!ledger.channels[channel]) {
    ledger.channels[channel] = { ...DEFAULT_CHANNEL_RECORD };
  }
  return ledger.channels[channel];
}

export interface StoreOptions {
  ledgerPath?: string;
}

function resolvePath(opts?: StoreOptions): string {
  return opts?.ledgerPath ? expandHome(opts.ledgerPath) : DEFAULT_LEDGER_PATH;
}

/**
 * Record a successful reach via `channel`. Updates per-channel and global
 * fields and returns the resulting ledger entry.
 */
export function recordSuccess(
  channel: string,
  detail: RecordSuccessDetail = {},
  opts?: StoreOptions,
): { ok: true; channel: string; ts: string; ledgerPath: string } {
  const path = resolvePath(opts);
  const ledger = readLedger(path);
  const rec = ensureChannel(ledger, channel);
  const ts = new Date().toISOString();
  rec.last_proven_at = ts;
  rec.last_proven_message_id = detail.messageId ?? rec.last_proven_message_id;
  rec.last_proven_transport = detail.transport ?? rec.last_proven_transport;
  rec.consecutive_successes = (rec.consecutive_successes ?? 0) + 1;
  rec.consecutive_failures = 0;
  ledger.global.last_reached_via = channel;
  ledger.global.last_reached_at = ts;
  writeLedgerAtomic(path, ledger);
  return { ok: true, channel, ts, ledgerPath: path };
}

/**
 * Record a failed reach attempt via `channel`. Bumps consecutive_failures
 * but does NOT touch global last_reached_*.
 */
export function recordFailure(
  channel: string,
  reason: string | undefined,
  opts?: StoreOptions,
): { ok: true; channel: string; ledgerPath: string } {
  const path = resolvePath(opts);
  const ledger = readLedger(path);
  const rec = ensureChannel(ledger, channel);
  rec.last_failed_at = new Date().toISOString();
  rec.last_failed_reason = String(reason ?? "unknown").slice(0, 500);
  rec.consecutive_failures = (rec.consecutive_failures ?? 0) + 1;
  rec.consecutive_successes = 0;
  writeLedgerAtomic(path, ledger);
  return { ok: true, channel, ledgerPath: path };
}

/**
 * Inspect the current ledger.
 */
export function getStatus(opts?: StoreOptions): Ledger {
  return readLedger(resolvePath(opts));
}

/**
 * Reset the ledger (mostly used in tests).
 */
export function resetLedger(opts?: StoreOptions): void {
  writeLedgerAtomic(resolvePath(opts), emptyLedger());
}
