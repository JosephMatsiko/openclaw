// probe — composes findGatewayPid + readGatewayCpu + recentEventLoopBlocks
// into a single health verdict.

import type { GatewayWatchdogConfig } from "./config.js";
import { findGatewayPid, readGatewayCpu, recentEventLoopBlocks } from "./probes.js";
import type { ProbeResult } from "./types.js";

export function probe(config: GatewayWatchdogConfig, now: number = Date.now()): ProbeResult {
  const pid = findGatewayPid(config);
  if (!pid) {
    return {
      pid: null,
      cpu: null,
      eventLoopBlocks: { count: 0, maxBlockMs: 0, lastTs: null },
      healthy: false,
      reason: "gateway process not found",
    };
  }
  const cpu = readGatewayCpu(pid);
  const blocks = recentEventLoopBlocks(config.pinDetectionWindowMs, config, now);
  const recentLongBlock = blocks.maxBlockMs > config.longBlockThresholdMs;
  const sustainedHighCpu = (cpu ?? 0) > config.highCpuThresholdPercent;
  const healthy = !recentLongBlock && !sustainedHighCpu;
  const reasonParts: string[] = [];
  if (recentLongBlock) {
    reasonParts.push(
      `event-loop blocked ${Math.round(blocks.maxBlockMs / 1000)}s (last ${blocks.lastTs})`,
    );
  }
  if (sustainedHighCpu) reasonParts.push(`cpu ${cpu}%`);
  return {
    pid,
    cpu,
    eventLoopBlocks: blocks,
    healthy,
    reason: reasonParts.join(", ") || "ok",
  };
}
