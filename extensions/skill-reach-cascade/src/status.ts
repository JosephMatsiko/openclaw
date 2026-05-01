// Status + replay helpers — mirror the chuck-comms-cascade.mjs CLI commands
// but expose them as plain functions the tool layer + sibling plugins can
// call without subprocess overhead.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ReachCascadeConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { notify } from "./notify.js";
import type { LedgerEntry, NotifyResult } from "./types.js";

export interface StatusSummary {
  count: number;
  recent: Array<{
    id: string;
    ts: string;
    subject: string;
    severity: string;
    tier: string;
    delivered: boolean;
    deliveredVia: string | null;
    attempts: string[];
    quietHoursActive: boolean;
    dryRun: boolean;
  }>;
}

function readLedgerEntry(path: string): LedgerEntry | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LedgerEntry;
  } catch {
    return null;
  }
}

export function listRecentLedger(limit = 10, configIn?: ReachCascadeConfig): LedgerEntry[] {
  const config = configIn ?? resolveConfig({});
  if (!existsSync(config.ledgerDir)) return [];
  const files = readdirSync(config.ledgerDir)
    .filter((n) => n.startsWith("notif-") && n.endsWith(".json"))
    .sort()
    .slice(-limit)
    .reverse();
  return files
    .map((f) => readLedgerEntry(join(config.ledgerDir, f)))
    .filter((e): e is LedgerEntry => e !== null);
}

export function findLedgerEntry(
  entryId: string,
  configIn?: ReachCascadeConfig,
): LedgerEntry | null {
  const config = configIn ?? resolveConfig({});
  return readLedgerEntry(join(config.ledgerDir, `${entryId}.json`));
}

export function summarizeStatus(configIn?: ReachCascadeConfig): StatusSummary {
  const recent = listRecentLedger(10, configIn);
  const summary = recent.map((e) => ({
    id: e.id,
    ts: e.ts,
    subject: e.payload?.subject ?? "",
    severity: e.payload?.severity ?? "info",
    tier: e.tier,
    delivered: e.delivered,
    deliveredVia: e.deliveredVia,
    attempts: (e.attempts ?? []).map(
      (a) => `${a.channel}:${a.ok ? "ok" : a.skipped ? "skip" : "fail"}`,
    ),
    quietHoursActive: e.quietHoursActive,
    dryRun: e.dryRun || false,
  }));
  return { count: summary.length, recent: summary };
}

export async function replay(
  entryId: string,
  configIn?: ReachCascadeConfig,
): Promise<{ ok: boolean; replayed?: string; error?: string; result?: NotifyResult }> {
  const config = configIn ?? resolveConfig({});
  const entry = findLedgerEntry(entryId, config);
  if (!entry) return { ok: false, error: `ledger entry not found: ${entryId}` };
  const replayPayload = { ...entry.payload, replayOf: entryId };
  const result = await notify(replayPayload, { bypassAntispam: true }, config);
  return { ok: true, replayed: entryId, result };
}
