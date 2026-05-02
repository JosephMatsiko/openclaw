// Notification-ledger I/O — wire-compatible with chuck-notify.mjs.
//
// Writes chuck-v3.notification-ledger/1 entries under
// ~/.openclaw/workspace/state/chuck-v3/notification-ledger/<YYYYMMDD>/<notif_id>.json.
// Same schema and atomic-write protocol so existing readers (cascade-watcher,
// dashboard panels) keep working.

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { NotifyConfig } from "./config.js";
import { NOTIFY_LEDGER_SCHEMA, type NotifyEntry } from "./types.js";

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function ymd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function makeNotifId(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  const rand = randomBytes(3).toString("hex");
  return `notif_${y}${m}${d}T${hh}${mm}${ss}Z_${rand}`;
}

export function ledgerPathFor(config: NotifyConfig, notifId: string, date: Date): string {
  return join(config.ledgerRoot, ymd(date), `${notifId}.json`);
}

function listDayDirsDescending(config: NotifyConfig): string[] {
  if (!existsSync(config.ledgerRoot)) return [];
  return readdirSync(config.ledgerRoot)
    .filter((name) => /^\d{8}$/.test(name))
    .sort()
    .reverse();
}

function listEntryFilesDescending(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
}

export function findLedgerPath(
  config: NotifyConfig,
  notifId: string,
  dateHint?: string,
): string | null {
  if (dateHint) {
    const dir = String(dateHint).replaceAll(/[^0-9]/g, "");
    const p = join(config.ledgerRoot, dir, `${notifId}.json`);
    return existsSync(p) ? p : null;
  }
  for (const day of listDayDirsDescending(config)) {
    const p = join(config.ledgerRoot, day, `${notifId}.json`);
    if (existsSync(p)) return p;
  }
  return null;
}

function readEntry(path: string): NotifyEntry {
  return JSON.parse(readFileSync(path, "utf8")) as NotifyEntry;
}

export interface WriteEntryInput {
  event: string;
  channel: string;
  payload: unknown;
  ts?: Date;
  meta?: Record<string, string>;
}

export interface WriteEntryResult {
  notif_id: string;
  path: string;
  entry: NotifyEntry;
}

export function writeEntry(config: NotifyConfig, input: WriteEntryInput): WriteEntryResult {
  if (!input.event) throw new Error("event is required");
  if (!input.channel) throw new Error("channel is required");
  const ts = input.ts ?? new Date();
  const notifId = makeNotifId(ts);
  const entry: NotifyEntry = {
    schema: NOTIFY_LEDGER_SCHEMA,
    notif_id: notifId,
    ts: ts.toISOString(),
    event_type: input.event,
    channel: input.channel,
    payload: input.payload,
    ack_received: false,
    ack_ts: null,
    ack_method: null,
  };
  if (input.meta && Object.keys(input.meta).length > 0) entry.meta = input.meta;
  const path = ledgerPathFor(config, notifId, ts);
  writeJsonAtomic(path, entry);
  return { notif_id: notifId, path, entry };
}

export interface AckEntryInput {
  notifId: string;
  method: string;
  ts?: Date;
  note?: string;
  date?: string;
}

export function ackEntry(
  config: NotifyConfig,
  input: AckEntryInput,
): {
  notif_id: string;
  path: string;
  entry: NotifyEntry;
} {
  if (!input.notifId) throw new Error("notifId is required");
  if (!input.method) throw new Error("method is required");
  const path = findLedgerPath(config, input.notifId, input.date);
  if (!path) throw new Error(`notif not found: ${input.notifId}`);
  const entry = readEntry(path);
  const ts = input.ts ?? new Date();
  entry.ack_received = true;
  entry.ack_ts = ts.toISOString();
  entry.ack_method = input.method;
  if (typeof input.note === "string") entry.ack_note = input.note;
  writeJsonAtomic(path, entry);
  return { notif_id: input.notifId, path, entry };
}

export interface ListEntriesInput {
  pending?: boolean;
  date?: string;
  limit?: number;
  all?: boolean;
}

export interface ListEntriesResult {
  entries: Array<
    Pick<
      NotifyEntry,
      "notif_id" | "ts" | "event_type" | "channel" | "ack_received" | "ack_ts" | "ack_method"
    >
  >;
}

export function listEntries(config: NotifyConfig, input: ListEntriesInput = {}): ListEntriesResult {
  if (!existsSync(config.ledgerRoot)) return { entries: [] };
  const limit = input.limit ?? 50;
  const wantPending = Boolean(input.pending);
  let days: string[];
  if (input.date) {
    days = [String(input.date).replaceAll(/[^0-9]/g, "")];
  } else if (input.all) {
    days = listDayDirsDescending(config);
  } else {
    days = [ymd(new Date())];
  }
  const entries: ListEntriesResult["entries"] = [];
  for (const day of days) {
    const dir = join(config.ledgerRoot, day);
    if (!existsSync(dir)) continue;
    for (const file of listEntryFilesDescending(dir)) {
      let entry: NotifyEntry;
      try {
        entry = readEntry(join(dir, file));
      } catch {
        continue;
      }
      if (wantPending && entry.ack_received) continue;
      entries.push({
        notif_id: entry.notif_id,
        ts: entry.ts,
        event_type: entry.event_type,
        channel: entry.channel,
        ack_received: entry.ack_received,
        ack_ts: entry.ack_ts,
        ack_method: entry.ack_method,
      });
      if (entries.length >= limit) return { entries };
    }
  }
  return { entries };
}

export function getEntry(
  config: NotifyConfig,
  notifId: string,
  date?: string,
): {
  entry: NotifyEntry;
  path: string;
} {
  if (!notifId) throw new Error("notifId is required");
  const path = findLedgerPath(config, notifId, date);
  if (!path) throw new Error(`notif not found: ${notifId}`);
  return { entry: readEntry(path), path };
}
