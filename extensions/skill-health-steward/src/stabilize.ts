// stabilize() orchestrator — applies safe automatic actions and writes a
// receipt. NEVER applies approval-gated actions; those go through apply().

import { join } from "node:path";
import type { HealthStewardConfig } from "./config.js";
import { writeExecutorControl } from "./executor.js";
import { defaultSelfHealRunner } from "./selfheal.js";
import { buildStatus, summarizeStatus } from "./status.js";
import type { StabilizeOptions, StabilizeReceipt, StabilizeResult } from "./types.js";
import { appendEvent, defaultReceiptId, ensureDir, makeEvent, writeJsonAtomic } from "./util.js";

export async function stabilize(
  config: HealthStewardConfig,
  options: StabilizeOptions = {},
): Promise<StabilizeResult> {
  ensureDir(config.receiptsDir);
  const idGen = options.receiptIdGen ?? defaultReceiptId;
  const selfHeal = options.selfHeal ?? defaultSelfHealRunner(config);
  const before = await buildStatus(config, { ...options, writeApprovals: true, selfHeal });
  const results: Array<Record<string, unknown>> = [];
  if (before.health.state === "blocked" && !before.executor.paused) {
    const control = writeExecutorControl(config, {
      mode: "paused",
      reason: "health steward paused executor intake because Mac resource gate is blocked",
    });
    results.push({ action: "pause-executor-intake", status: "applied", control });
  }
  const planSafe = before.storage.safePlan;
  if ((planSafe.actionCount ?? 0) > 0) {
    const maxActions = options.maxActions ?? config.stabilizeMaxSafeActions;
    const run = await selfHeal.apply({ onlyUnderPressure: true, maxActions });
    results.push({
      action: "run-safe-self-heal",
      status: run.ok ? "applied" : "failed",
      run: run.ok ? run.parsed : run,
    });
  }
  const after = await buildStatus(config, { ...options, writeApprovals: true, selfHeal });
  const id = idGen("health-stabilize");
  const path = join(config.receiptsDir, `${id}.json`);
  const receipt: StabilizeReceipt = {
    schema: "chuck-v3.health-steward/1",
    receiptId: id,
    createdAt: new Date().toISOString(),
    mode: "stabilize",
    before: summarizeStatus(before),
    after: summarizeStatus(after),
    results,
    approvalCapsulePaths: after.approvalCapsulePaths,
  };
  writeJsonAtomic(path, receipt);
  appendEvent(
    config.eventsPath,
    makeEvent("chuck.health.stabilized", {
      receiptId: id,
      path,
      resultCount: results.length,
    }),
  );
  return { ok: true, receiptId: id, path, results, before, after };
}
