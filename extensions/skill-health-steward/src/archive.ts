// Verified-local-archive candidate detection.
//
// chuck-mac-self-heal records a receipt for each "copied-to-cloud-and-moved-
// local-archive" action. To purge a local archive safely, we need:
//  1. The receipt's archive root still exists locally
//  2. ALL associated cloud copies still exist (block purge if any missing)
//  3. AT LEAST ONE local archived file still exists (the purge target)
//
// This module finds the latest such purgeable candidate.

import { join } from "node:path";
import type { HealthStewardConfig } from "./config.js";
import type { LocalArchiveCandidate } from "./types.js";
import { latestJsonFiles, pathExists, pathInside } from "./util.js";

interface SelfHealReceiptResult {
  status?: string;
  action?: string;
  cloudPath?: string;
  localArchivePath?: string;
  bytes?: number;
}

interface SelfHealReceipt {
  receiptId?: string;
  results?: SelfHealReceiptResult[];
  appliedBytes?: number;
}

export function latestVerifiedLocalArchiveCandidate(
  config: HealthStewardConfig,
): LocalArchiveCandidate {
  for (const file of latestJsonFiles<SelfHealReceipt>(config.macSelfHealReceiptsDir, 40)) {
    const receipt = file.data;
    const applied = (Array.isArray(receipt?.results) ? receipt.results : []).filter(
      (r) =>
        r?.status === "applied" &&
        r?.action === "copied-to-cloud-and-moved-local-archive" &&
        typeof r.cloudPath === "string" &&
        typeof r.localArchivePath === "string",
    );
    if (!applied.length || !receipt?.receiptId) continue;
    const archiveRoot = join(config.macSelfHealArchivesDir, receipt.receiptId);
    if (!pathInside(archiveRoot, config.macSelfHealArchivesDir) || !pathExists(archiveRoot))
      continue;
    const missingCloud = applied.filter((r) => !pathExists(String(r.cloudPath)));
    const existingLocal = applied.filter((r) => pathExists(String(r.localArchivePath)));
    if (missingCloud.length) {
      return {
        available: false,
        blocked: true,
        reason: `${missingCloud.length} cloud copy/copies missing; refusing local archive purge`,
        receiptId: receipt.receiptId,
        missingCloudCount: missingCloud.length,
      };
    }
    if (existingLocal.length) {
      const bytes =
        Number(receipt.appliedBytes) ||
        existingLocal.reduce((sum, r) => sum + (Number(r.bytes) || 0), 0);
      return {
        available: true,
        receiptId: receipt.receiptId,
        receiptPath: file.path,
        archiveRoot,
        fileCount: existingLocal.length,
        bytes,
        cloudCopiesVerified: applied.length,
      };
    }
  }
  return {
    available: false,
    blocked: false,
    reason: "no verified local archive copy is currently purgeable",
  };
}
