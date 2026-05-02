// approve command — draft → approved → applying → applied (with prior capsule
// refresh subprocess).

import { defaultRefreshPriorCapsule } from "./capsule.js";
import type { PriorCompactionConfig } from "./config.js";
import type { ApproveOptions, ApproveReceipt, CompactionDecision, RunDeps } from "./types.js";
import {
  appendEvent,
  makeEvent,
  pathExists,
  readJson,
  resolveDecisionPath,
  writeJsonAtomic,
} from "./util.js";
import { createDecisionValidator, validateOrThrow } from "./validators.js";

const APPROVED_STATUSES = new Set(["draft", "approved"]);

export async function approveDecision(
  config: PriorCompactionConfig,
  options: ApproveOptions,
  deps: RunDeps = {},
): Promise<ApproveReceipt> {
  if (!options.decision) throw new Error("--decision is required");
  if (options.confirm !== config.approvalToken) {
    throw new Error(`--confirm must equal ${config.approvalToken}`);
  }
  const validateDecision = deps.validateDecision ?? createDecisionValidator(config);
  const refresh = deps.refreshPriorCapsule ?? defaultRefreshPriorCapsule(config);
  const path = resolveDecisionPath(options.decision, config.compactionsDir);
  if (!pathExists(path)) throw new Error(`compaction decision not found: ${path}`);
  const current = readJson<CompactionDecision>(path);
  validateOrThrow(validateDecision, current, "prior compaction decision");
  if (current.status === "applied") {
    return {
      ok: true,
      command: "approve",
      alreadyApplied: true,
      path,
      decisionId: current.decisionId,
      resultingPriorId: current.resultingPriorId,
      decision: current,
    };
  }
  if (!APPROVED_STATUSES.has(current.status)) {
    throw new Error(`decision status must be draft or approved, got ${current.status}`);
  }

  const approvedAt = new Date().toISOString();
  const approved: CompactionDecision = {
    ...current,
    status: "approved",
    approval: {
      at: approvedAt,
      by: String(options.approvedBy ?? "operator/cockpit").slice(0, 120),
      confirm: "APPROVE_PRIOR_COMPACTION",
      note: "Joseph-approved compaction gate. This approval mutates only the compact prior capsule, not executor intake.",
    },
    approvedAt,
  };
  validateOrThrow(validateDecision, approved, "approved prior compaction decision");
  writeJsonAtomic(path, approved);
  appendEvent(
    config.eventsPath,
    makeEvent("chuck.prior-compaction.approved", {
      decisionId: approved.decisionId,
      path,
      includedDeltaCount: approved.includedDeltaIds.length,
      promotedClaimCount: approved.promotedClaims.length,
      deferredClaimCount: approved.deferredClaims.length,
    }),
  );

  const appliedAt = new Date().toISOString();
  const applying: CompactionDecision = {
    ...approved,
    status: "applied",
    appliedAt,
    resultingPriorId: null,
    result: null,
  };
  validateOrThrow(validateDecision, applying, "applying prior compaction decision");
  writeJsonAtomic(path, applying);
  const priorReceipt = await refresh();
  const applied: CompactionDecision = {
    ...applying,
    status: "applied",
    resultingPriorId: priorReceipt.priorId ?? null,
    result: {
      priorReceipt,
      appliedBy: "extensions/memory-graph/scripts/chuck-prior-compaction.mjs",
      appliedAt,
    },
  };
  validateOrThrow(validateDecision, applied, "applied prior compaction decision");
  writeJsonAtomic(path, applied);
  appendEvent(
    config.eventsPath,
    makeEvent("chuck.prior-compaction.applied", {
      decisionId: applied.decisionId,
      path,
      resultingPriorId: applied.resultingPriorId,
      priorPath: priorReceipt.path ?? null,
      latestPath: priorReceipt.latestPath ?? null,
    }),
  );
  return {
    ok: true,
    command: "approve",
    path,
    decisionId: applied.decisionId,
    resultingPriorId: applied.resultingPriorId,
    priorReceipt,
    decision: applied,
  };
}
