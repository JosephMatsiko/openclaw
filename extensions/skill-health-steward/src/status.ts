// buildStatus orchestrator — composes health snapshot + executor + docket +
// process groups + mac-self-heal plans into the canonical chuck-v3.health-
// steward/1 status payload.

import {
  buildApprovalActions,
  buildAutomaticActions,
  buildHandoffActions,
  writeApprovalCapsules,
} from "./actions.js";
import { latestVerifiedLocalArchiveCandidate } from "./archive.js";
import type { HealthStewardConfig } from "./config.js";
import { summarizeDocket } from "./docket.js";
import { readExecutorControl } from "./executor.js";
import { buildHealthSnapshot } from "./health.js";
import { mergeProbes } from "./probes.js";
import { defaultSelfHealRunner, planResultOrFallback, statusResultOrFallback } from "./selfheal.js";
import type { StatusOptions, StatusResult, StatusSummary } from "./types.js";

export async function buildStatus(
  config: HealthStewardConfig,
  options: StatusOptions = {},
): Promise<StatusResult> {
  const probes = mergeProbes(options.probes);
  const selfHeal = options.selfHeal ?? defaultSelfHealRunner(config);
  const now = options.now ?? Date.now();
  const health = buildHealthSnapshot(probes, config);
  const executor = readExecutorControl(config);
  const docket = summarizeDocket(config, now);
  const groups = probes.processGroups();
  const macSelfHealStatus = statusResultOrFallback(await selfHeal.status());
  const planSafe = planResultOrFallback(await selfHeal.plan({ allowCloudOffload: false }));
  const planCloud = planResultOrFallback(await selfHeal.plan({ allowCloudOffload: true }));
  const localArchive = latestVerifiedLocalArchiveCandidate(config);
  const automaticActions = buildAutomaticActions({ health, executor, planSafe });
  const approvalActions = buildApprovalActions({ planSafe, planCloud, localArchive, groups });
  const approvalCapsulePaths = options.writeApprovals
    ? writeApprovalCapsules(config, approvalActions)
    : [];
  const handoffActions = buildHandoffActions(health, config);
  return {
    schema: "chuck-v3.health-steward/1",
    generatedAt: new Date().toISOString(),
    state: health.state,
    health,
    executor,
    docket,
    storage: {
      cloudAvailable: macSelfHealStatus.cloud?.available === true,
      cloudRecommendation: macSelfHealStatus.cloud?.recommendation ?? null,
      archivePath: macSelfHealStatus.cloud?.archivePath ?? null,
      localArchive,
      safePlan: {
        actionCount: planSafe.actionCount ?? 0,
        reclaimableBytes: planSafe.reclaimableBytes ?? 0,
        blockedCount: planSafe.blockedCount ?? 0,
        blockedBytes: planSafe.blockedBytes ?? 0,
      },
      approvedCloudPreview: {
        actionCount: planCloud.actionCount ?? 0,
        reclaimableBytes: planCloud.reclaimableBytes ?? 0,
      },
    },
    processGroups: groups,
    automaticActions,
    approvalActions,
    approvalCapsulePaths,
    handoffActions,
    phoneReady: {
      approvalCapsules: true,
      dashboardApi: true,
      telegramDelivery: false,
      reason:
        "Telegram/phone delivery still requires a configured channel; capsules and API are ready.",
    },
  };
}

export function summarizeStatus(status: StatusResult): StatusSummary {
  return {
    state: status.state,
    blockers: status.health.blockers,
    executorPaused: status.executor.paused,
    diskFreeBytes: status.health.disk?.freeBytes ?? null,
    swapUsedBytes: status.health.swap?.usedBytes ?? null,
    automaticActionCount: status.automaticActions.length,
    approvalActionCount: status.approvalActions.length,
  };
}
