// summarizeStatus / applyIntrospection / dismissIntrospection — read-only
// status + interactive action surfaces.

import { existsSync } from "node:fs";
import type { IntrospectConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { findIntrospectionPath, loadAllIntrospections, loadLastScan } from "./store.js";
import type { IntrospectionRecord } from "./types.js";
import { createEventEmitter, readJson, writeJson } from "./util.js";

export interface StatusSummary {
  lastScanAt: string | null;
  lastFocusAt: string | null;
  counts: { total: number; open: number; applied: number; dismissed: number };
  open: Array<
    Pick<
      IntrospectionRecord,
      "id" | "ts" | "mode" | "category" | "riskClass" | "observation" | "recommendation"
    >
  >;
  recent: Array<{
    id: string;
    ts: string;
    category: string;
    state: "applied" | "dismissed" | "open";
  }>;
}

export function summarizeStatus(configIn?: IntrospectConfig): StatusSummary {
  const config = configIn ?? resolveConfig({});
  const records = loadAllIntrospections(config).sort((a, b) => {
    const ta = a.ts ? Date.parse(a.ts) : 0;
    const tb = b.ts ? Date.parse(b.ts) : 0;
    return tb - ta;
  });
  const open = records.filter((r) => !r.applied && !r.dismissed);
  const applied = records.filter((r) => r.applied);
  const dismissed = records.filter((r) => r.dismissed);
  const lastScan = loadLastScan(config);
  return {
    lastScanAt: lastScan.lastScanAt ?? null,
    lastFocusAt: lastScan.lastFocusAt ?? null,
    counts: {
      total: records.length,
      open: open.length,
      applied: applied.length,
      dismissed: dismissed.length,
    },
    open: open.slice(0, 10).map((r) => ({
      id: r.id,
      ts: r.ts,
      mode: r.mode,
      category: r.category,
      riskClass: r.riskClass,
      observation: r.observation,
      recommendation: r.recommendation,
    })),
    recent: records.slice(0, 10).map((r) => ({
      id: r.id,
      ts: r.ts,
      category: r.category,
      state: r.applied ? "applied" : r.dismissed ? "dismissed" : "open",
    })),
  };
}

export interface ApplyResult {
  ok: boolean;
  status?: "applied" | "already-applied";
  appliedAt?: string;
  error?: string;
}

export function applyIntrospection(id: string, configIn?: IntrospectConfig): ApplyResult {
  const config = configIn ?? resolveConfig({});
  const events = createEventEmitter(config.eventsPath);
  const path = findIntrospectionPath(id, config);
  if (!existsSync(path)) return { ok: false, error: `introspection not found: ${id}` };
  const r = readJson<IntrospectionRecord | null>(path, null);
  if (!r) return { ok: false, error: `unreadable: ${path}` };
  if (r.applied) return { ok: true, status: "already-applied" };
  if (r.dismissed) return { ok: false, error: `cannot apply a dismissed introspection (${id})` };
  r.applied = true;
  r.appliedAt = new Date().toISOString();
  writeJson(path, r);
  events.emit("chuck.introspect.applied", { introspectId: id, manual: true });
  return { ok: true, status: "applied", appliedAt: r.appliedAt };
}

export interface DismissResult {
  ok: boolean;
  status?: "dismissed" | "already-dismissed";
  reason?: string | null;
  error?: string;
}

export function dismissIntrospection(
  id: string,
  reason: string | null = null,
  configIn?: IntrospectConfig,
): DismissResult {
  const config = configIn ?? resolveConfig({});
  const events = createEventEmitter(config.eventsPath);
  const path = findIntrospectionPath(id, config);
  if (!existsSync(path)) return { ok: false, error: `introspection not found: ${id}` };
  const r = readJson<IntrospectionRecord | null>(path, null);
  if (!r) return { ok: false, error: `unreadable: ${path}` };
  if (r.dismissed) return { ok: true, status: "already-dismissed", reason: r.dismissedReason };
  r.dismissed = true;
  r.dismissedAt = new Date().toISOString();
  r.dismissedReason = reason;
  writeJson(path, r);
  events.emit("chuck.introspect.dismissed", { introspectId: id, reason });
  return { ok: true, status: "dismissed", reason };
}
