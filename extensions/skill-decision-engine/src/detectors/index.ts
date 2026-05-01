// Detector registry. Order is the scan-evaluation order; rearranging changes
// the priority of which proposal wins under the per-scan flood cap.

import type { Detector } from "../types.js";
import { detectChannelDrift } from "./channel-drift.js";
import { detectFailedTaskCluster } from "./failed-task-cluster.js";
import { detectOrphanMcp } from "./orphan-mcp.js";
import { detectScannerTune } from "./scanner-tune.js";
import { detectStaleMacHeal } from "./stale-mac-heal.js";
import { detectZombieCluster } from "./zombie-cluster.js";

export const ALL_DETECTORS: Detector[] = [
  detectFailedTaskCluster,
  detectZombieCluster,
  detectChannelDrift,
  detectScannerTune,
  detectOrphanMcp,
  detectStaleMacHeal,
];
