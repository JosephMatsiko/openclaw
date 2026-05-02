// healthSnapshot — combines disk/swap/memory/load probes and applies thresholds.

import type { HealthStewardConfig } from "./config.js";
import type { HealthSnapshot, SystemProbes } from "./types.js";
import { formatBytes } from "./util.js";

export function buildHealthSnapshot(
  probes: SystemProbes,
  config: HealthStewardConfig,
): HealthSnapshot {
  const disk = probes.disk();
  const swap = probes.swap();
  const memoryPressure = probes.memoryPressure();
  const loads = probes.load();
  const totalMemoryBytes = probes.totalMemoryBytes();
  const freeMemoryBytes = probes.freeMemoryBytes();
  const freeMemoryPercent = totalMemoryBytes > 0 ? freeMemoryBytes / totalMemoryBytes : null;
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (
    disk.available &&
    typeof disk.freeBytes === "number" &&
    typeof disk.freePercent === "number" &&
    (disk.freeBytes < config.diskMinFreeBytes || disk.freePercent < config.diskMinFreePercent)
  ) {
    blockers.push(
      `disk gate: ${formatBytes(disk.freeBytes)} free below ${formatBytes(config.diskMinFreeBytes)} or ${Math.round(config.diskMinFreePercent * 100)}%`,
    );
  }
  if (
    swap.available &&
    typeof swap.usedBytes === "number" &&
    swap.usedBytes > config.swapMaxUsedBytes
  ) {
    blockers.push(
      `swap gate: ${formatBytes(swap.usedBytes)} used above ${formatBytes(config.swapMaxUsedBytes)}`,
    );
  }
  if (loads.one > config.loadOneWatchThreshold) {
    warnings.push(`load watch: ${loads.one.toFixed(2)} one-minute load`);
  }
  if (freeMemoryPercent != null && freeMemoryPercent < config.freeMemoryWatchPercent) {
    warnings.push(`memory watch: ${Math.round(freeMemoryPercent * 100)}% free raw pages`);
  }
  return {
    state: blockers.length ? "blocked" : warnings.length ? "watch" : "clear",
    blockers,
    warnings,
    generatedAt: new Date().toISOString(),
    load: loads,
    memory: {
      totalBytes: totalMemoryBytes,
      freeBytes: freeMemoryBytes,
      freePercent: freeMemoryPercent,
      pressure: memoryPressure,
    },
    disk,
    swap,
    thresholds: {
      diskMinFreeBytes: config.diskMinFreeBytes,
      diskMinFreePercent: config.diskMinFreePercent,
      swapMaxUsedBytes: config.swapMaxUsedBytes,
    },
  };
}
