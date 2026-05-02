// applyAction() — gated by confirm tokens; produces receipts + events.
//
// Supported actions: cloud-offload | purge-local-archive | write-approval-
// capsules. Anything else throws.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { writeApprovalCapsules } from "./actions.js";
import { latestVerifiedLocalArchiveCandidate } from "./archive.js";
import type { HealthStewardConfig } from "./config.js";
import { defaultSelfHealRunner } from "./selfheal.js";
import { buildStatus } from "./status.js";
import type { ApplyOptions, ApplyResult, RunDeps } from "./types.js";
import { appendEvent, defaultReceiptId, ensureDir, makeEvent, writeJsonAtomic } from "./util.js";

const CONFIRM_CLOUD_OFFLOAD = "RUN_APPROVED_CLOUD_OFFLOAD";
const CONFIRM_PURGE_LOCAL = "PURGE_VERIFIED_LOCAL_ARCHIVE";

export async function applyAction(
  config: HealthStewardConfig,
  options: ApplyOptions,
  deps: RunDeps = {},
): Promise<ApplyResult> {
  const action = options.action;
  if (!action) throw new Error("--action is required for apply");
  ensureDir(config.receiptsDir);
  const selfHeal = deps.selfHeal ?? defaultSelfHealRunner(config);
  const idGen = deps.receiptIdGen ?? defaultReceiptId;
  if (action === "cloud-offload") {
    if (options.confirm !== CONFIRM_CLOUD_OFFLOAD) {
      throw new Error(`confirm must equal ${CONFIRM_CLOUD_OFFLOAD}`);
    }
    const run = await selfHeal.apply({
      allowCloudOffload: true,
      maxActions: options.maxActions ?? config.applyMaxActions,
    });
    const receiptId = run.ok ? (run.parsed.receiptId ?? null) : null;
    const result: unknown = run.ok ? run.parsed : run;
    appendEvent(
      config.eventsPath,
      makeEvent("chuck.health.approval-applied", {
        action,
        ok: run.ok,
        receiptId,
      }),
    );
    return { ok: run.ok, action, result };
  }
  if (action === "purge-local-archive") {
    if (options.confirm !== CONFIRM_PURGE_LOCAL) {
      throw new Error(`confirm must equal ${CONFIRM_PURGE_LOCAL}`);
    }
    const candidate = latestVerifiedLocalArchiveCandidate(config);
    if (!candidate.available) {
      return {
        ok: !candidate.blocked,
        action,
        available: candidate.available,
        blocked: candidate.blocked,
        reason: candidate.reason,
      };
    }
    rmSync(candidate.archiveRoot ?? "", { recursive: true, force: false });
    const id = idGen("local-purge");
    const path = join(config.receiptsDir, `${id}.json`);
    const receipt = {
      schema: "chuck-v3.mac-self-heal.local-archive-purge/1",
      receiptId: id,
      createdAt: new Date().toISOString(),
      operator: "health-steward",
      sourceReceiptId: candidate.receiptId,
      sourceReceiptPath: candidate.receiptPath,
      deletedArchiveRoot: candidate.archiveRoot,
      deletedAppliedFileCount: candidate.fileCount,
      deletedBytesApprox: candidate.bytes,
      cloudCopiesVerifiedBeforeDelete: candidate.cloudCopiesVerified,
    };
    writeJsonAtomic(path, receipt);
    appendEvent(
      config.eventsPath,
      makeEvent("chuck.health.local-archive-purged", {
        receiptId: id,
        path,
        deletedBytesApprox: candidate.bytes,
      }),
    );
    return { ok: true, action, receipt, path };
  }
  if (action === "write-approval-capsules") {
    const status = await buildStatus(config, { ...deps, selfHeal, writeApprovals: false });
    const paths = writeApprovalCapsules(config, status.approvalActions);
    return {
      ok: true,
      action,
      approvalCapsulePaths: paths,
      approvalActions: status.approvalActions,
    };
  }
  throw new Error(`unknown health steward action: ${action}`);
}
