// Action plan builders — automatic vs approval-gated vs operator-handoff.
//
// Automatic actions: pause-executor-intake (when blocked) + run-safe-self-heal
// (when safe-plan has work). Approval actions need explicit confirm tokens to
// run via apply: cloud-offload, purge-local-archive, quit-heavy-gui-apps.
// Handoff actions cannot be automated at all (operator-restart-mac).

import { join } from "node:path";
import type { HealthStewardConfig } from "./config.js";
import type {
  ApprovalAction,
  ApprovalCapsule,
  AutomaticAction,
  ExecutorControl,
  HandoffAction,
  HealthSnapshot,
  LocalArchiveCandidate,
  ProcessGroup,
  SelfHealPlan,
} from "./types.js";
import { ensureDir, writeJsonAtomic } from "./util.js";

const HEAVY_GUI_APP_RSS_THRESHOLD = 500 * 1024 * 1024;
const HEAVY_GUI_APP_GROUPS = new Set(["Claude", "Comet", "Google Chrome"]);

export function buildAutomaticActions(opts: {
  health: HealthSnapshot;
  executor: ExecutorControl;
  planSafe: SelfHealPlan;
}): AutomaticAction[] {
  const actions: AutomaticAction[] = [];
  if (opts.health.state === "blocked" && !opts.executor.paused) {
    actions.push({
      action: "pause-executor-intake",
      title: "Pause executor intake",
      risk: "safe-local-control",
      why: "Mac gate is blocked; no new heavy tasks should start.",
    });
  }
  if ((opts.planSafe.actionCount ?? 0) > 0) {
    actions.push({
      action: "run-safe-self-heal",
      title: "Run safe self-heal cleanup",
      risk: "safe-allowlisted-cleanup",
      count: opts.planSafe.actionCount,
      bytes: opts.planSafe.reclaimableBytes,
      why: "Only allowlisted non-cloud actions are included.",
    });
  }
  return actions;
}

export function buildApprovalActions(opts: {
  planSafe: SelfHealPlan;
  planCloud: SelfHealPlan;
  localArchive: LocalArchiveCandidate;
  groups: ProcessGroup[];
}): ApprovalAction[] {
  const actions: ApprovalAction[] = [];
  const cloudOnlyBytes = Math.max(
    0,
    Number(opts.planCloud.reclaimableBytes ?? 0) - Number(opts.planSafe.reclaimableBytes ?? 0),
  );
  const cloudOnlyCount = Math.max(
    0,
    Number(opts.planCloud.actionCount ?? 0) - Number(opts.planSafe.actionCount ?? 0),
  );
  if (opts.planCloud?.cloud?.available && cloudOnlyCount > 0) {
    actions.push({
      approvalId: "approval-mac-cloud-offload",
      action: "cloud-offload",
      title: "Cloud offload old OpenClaw evidence",
      risk: "sensitive-data-transmission",
      confirm: "RUN_APPROVED_CLOUD_OFFLOAD",
      bytes: cloudOnlyBytes,
      count: cloudOnlyCount,
      destination: opts.planCloud.cloud.archivePath ?? null,
      why: "Old evidence can leave the hot path after Joseph approves Google Drive transmission.",
    });
  }
  if (opts.localArchive.available) {
    actions.push({
      approvalId: "approval-purge-verified-local-archive",
      action: "purge-local-archive",
      title: "Purge verified duplicate local archive",
      risk: "local-delete",
      confirm: "PURGE_VERIFIED_LOCAL_ARCHIVE",
      bytes: opts.localArchive.bytes,
      count: opts.localArchive.fileCount,
      sourceReceiptId: opts.localArchive.receiptId,
      path: opts.localArchive.archiveRoot,
      why: "Cloud copies are present; local duplicate can be deleted with approval.",
    });
  }
  const heavyUserApps = opts.groups
    .filter(
      (group) =>
        HEAVY_GUI_APP_GROUPS.has(group.group) && group.rssBytes > HEAVY_GUI_APP_RSS_THRESHOLD,
    )
    .map((group) => ({
      app: group.group,
      rssBytes: group.rssBytes,
      processCount: group.processCount,
    }));
  if (heavyUserApps.length) {
    actions.push({
      approvalId: "approval-quit-heavy-gui-apps",
      action: "quit-heavy-gui-apps",
      title: "Gracefully quit heavy GUI apps",
      risk: "may-close-unsaved-work",
      confirm: "QUIT_HEAVY_GUI_APPS",
      apps: heavyUserApps,
      why: "These apps hold substantial resident memory. Joseph must approve because they may contain active work.",
    });
  }
  return actions;
}

export function buildHandoffActions(
  health: HealthSnapshot,
  config: HealthStewardConfig,
): HandoffAction[] {
  const handoffs: HandoffAction[] = [];
  if (health.swap?.available && (health.swap.usedBytes ?? 0) > config.swapMaxUsedBytes) {
    handoffs.push({
      action: "restart-mac-after-saving-work",
      title: "Restart Mac after saving work",
      risk: "operator-handoff",
      why: "Swap is high; macOS often needs restart or major app quits to release it.",
    });
  }
  return handoffs;
}

export function writeApprovalCapsules(
  config: HealthStewardConfig,
  actions: ApprovalAction[],
): string[] {
  ensureDir(config.approvalsDir);
  const paths: string[] = [];
  for (const action of actions) {
    const capsule: ApprovalCapsule = {
      schema: "chuck-v3.approval-capsule/1",
      approvalId: action.approvalId,
      domain: "health-steward",
      status: "pending",
      createdAt: new Date().toISOString(),
      action: action.action,
      title: action.title,
      risk: action.risk,
      confirm: action.confirm,
      why: action.why,
      bytes: action.bytes,
      count: action.count,
      destination: action.destination,
      sourceReceiptId: action.sourceReceiptId,
      path: action.path,
      apps: action.apps,
    };
    const path = join(config.approvalsDir, `${action.approvalId}.json`);
    writeJsonAtomic(path, capsule);
    paths.push(path);
  }
  return paths;
}
