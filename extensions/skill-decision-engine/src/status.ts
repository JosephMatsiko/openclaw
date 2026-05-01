// Status / apply / reject — interactive surfaces called by Joseph (or the
// Telegram /decision approve|reject command flow) to action open proposals.

import { dropFollowupDocketTask } from "./auto-apply.js";
import type { DecisionEngineConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { decisionPath, lastScanPath, loadDecisions, writeDecision } from "./store.js";
import type { Proposal } from "./types.js";
import { createEventEmitter, readJson } from "./util.js";

export interface StatusSummary {
  lastScanAt: string | null;
  counts: {
    total: number;
    open: number;
    applied: number;
    rejected: number;
  };
  open: Array<{
    id: string;
    ts: string;
    category: string;
    riskClass: string;
    situation: string;
    recommendation: string;
  }>;
}

export function summarizeStatus(configIn?: DecisionEngineConfig): StatusSummary {
  const config = configIn ?? resolveConfig({});
  const decisions = loadDecisions(config);
  const open = decisions.filter((d) => d.status === "open");
  const applied = decisions.filter((d) => d.status === "applied");
  const rejected = decisions.filter((d) => d.status === "rejected");
  const last = readJson<{ lastScanAt?: string } | null>(lastScanPath(config), null);
  return {
    lastScanAt: last?.lastScanAt ?? null,
    counts: {
      total: decisions.length,
      open: open.length,
      applied: applied.length,
      rejected: rejected.length,
    },
    open: open.map((d) => ({
      id: d.id,
      ts: d.ts,
      category: d.category,
      riskClass: d.riskClass,
      situation: d.situation,
      recommendation: d.recommendation,
    })),
  };
}

export interface ApplyResult {
  ok: boolean;
  decisionId: string;
  action?: string;
  taskId?: string;
  reason?: string;
}

export function applyDecision(decisionIdIn: string, configIn?: DecisionEngineConfig): ApplyResult {
  const config = configIn ?? resolveConfig({});
  const events = createEventEmitter(config.eventsPath);
  const dec = readJson<Proposal | null>(decisionPath(config, decisionIdIn), null);
  if (!dec) return { ok: false, decisionId: decisionIdIn, reason: "decision not found" };
  if (dec.status === "applied") return { ok: false, decisionId: dec.id, reason: "already applied" };
  if (dec.status === "rejected")
    return { ok: false, decisionId: dec.id, reason: "already rejected; cannot apply" };

  const result = dropFollowupDocketTask(dec, config);
  dec.applied = true;
  dec.appliedAt = new Date().toISOString();
  dec.appliedAction = result.action;
  dec.status = "applied";
  writeDecision(dec, config);
  events.emit("chuck.decision.applied", {
    decisionId: dec.id,
    action: dec.appliedAction,
    manual: true,
  });
  return { ok: true, decisionId: dec.id, action: result.action, taskId: result.taskId };
}

export interface RejectResult {
  ok: boolean;
  decisionId: string;
  status?: "rejected";
  reason?: string;
}

export function rejectDecision(
  decisionIdIn: string,
  reason: string | null = null,
  configIn?: DecisionEngineConfig,
): RejectResult {
  const config = configIn ?? resolveConfig({});
  const events = createEventEmitter(config.eventsPath);
  const dec = readJson<Proposal | null>(decisionPath(config, decisionIdIn), null);
  if (!dec) return { ok: false, decisionId: decisionIdIn, reason: "decision not found" };

  dec.status = "rejected";
  dec.rejectedAt = new Date().toISOString();
  dec.rejectedReason = reason;
  writeDecision(dec, config);
  events.emit("chuck.decision.rejected", { decisionId: dec.id, reason: reason ?? null });
  return { ok: true, decisionId: dec.id, status: "rejected" };
}
