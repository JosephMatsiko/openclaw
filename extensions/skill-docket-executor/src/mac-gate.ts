// Mac health gate. Eligibility check consults this for non-exempt
// commandKinds — disk free / swap usage thresholds gate task admission so a
// runaway build doesn't catch the Mac mid-OOM.

import { spawnSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import type { DocketExecutorConfig } from "./config.js";
import type { CommandKind, DiskStatus, MacHealthGateStatus, SwapStatus } from "./types.js";

const HOME = homedir();
const MIB = 1024 ** 2;

export const MAC_GATE_EXEMPT_COMMAND_KINDS: ReadonlySet<CommandKind> = new Set<CommandKind>([
  "bootstrap",
  "doctor",
  "capability-ledger",
  "docket-list",
  "prior-capsule",
  "mac-self-heal",
]);

const MAC_GATE_CACHE_MS = 5_000;
let cache: { cachedAtMs: number; value: MacHealthGateStatus } | null = null;

function readDiskStatus(): DiskStatus {
  try {
    const statValue = statfsSync(HOME);
    const totalBytes = Number(statValue.blocks) * Number(statValue.bsize);
    const freeBytes = Number(statValue.bavail) * Number(statValue.bsize);
    return {
      available: true,
      path: HOME,
      totalBytes,
      freeBytes,
      freePercent: totalBytes > 0 ? freeBytes / totalBytes : null,
    };
  } catch (err) {
    return { available: false, path: HOME, reason: (err as Error).message };
  }
}

function readSwapStatus(): SwapStatus {
  const result = spawnSync("/usr/sbin/sysctl", ["-n", "vm.swapusage"], {
    encoding: "utf8",
    timeout: 2000,
  });
  const text = result.stdout ?? "";
  const match = text.match(/total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M/i);
  if (!match) {
    return {
      available: false,
      reason: result.stderr || result.error?.message || "swap usage unavailable",
    };
  }
  const totalBytes = Number(match[1]) * MIB;
  const usedBytes = Number(match[2]) * MIB;
  const freeBytes = Number(match[3]) * MIB;
  return {
    available: true,
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: totalBytes > 0 ? usedBytes / totalBytes : null,
    raw: text.trim(),
  };
}

function formatBytes(n: number | undefined): string {
  if (n == null) return "?";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  return `${n} B`;
}

export function macHealthGateStatus(
  config: DocketExecutorConfig,
  options: { now?: number } = {},
): MacHealthGateStatus {
  const now = options.now ?? Date.now();
  if (cache && now - cache.cachedAtMs < MAC_GATE_CACHE_MS) return cache.value;
  const cpuCount = cpus().length || 1;
  const loads = loadavg();
  const totalMemoryBytes = totalmem();
  const freeMemoryBytes = freemem();
  const disk = readDiskStatus();
  const swap = readSwapStatus();
  const blockers: string[] = [];
  const signals: MacHealthGateStatus["signals"] = [];
  const loadRatio = loads[0] / cpuCount;
  const memoryFreePercent = totalMemoryBytes > 0 ? freeMemoryBytes / totalMemoryBytes : null;

  if (!disk.available) {
    blockers.push("mac health gate cannot read disk status");
    signals.push({
      category: "mac.disk",
      severity: "error",
      summary: disk.reason ?? "disk unavailable",
    });
  } else {
    const lowDisk =
      (disk.freePercent ?? 1) < config.diskWarnFreePercent ||
      (disk.freeBytes ?? Number.POSITIVE_INFINITY) < config.diskMinFreeBytes;
    if (lowDisk) {
      blockers.push(
        `mac disk gate: ${formatBytes(disk.freeBytes)} free below ${formatBytes(config.diskMinFreeBytes)} or ${Math.round(config.diskWarnFreePercent * 100)}%`,
      );
    }
    signals.push({
      category: "mac.disk",
      severity: lowDisk ? "warn" : "info",
      summary: `${formatBytes(disk.freeBytes)} free`,
      value: disk.freePercent ?? null,
    });
  }
  if (swap.available) {
    const highSwap = (swap.usedBytes ?? 0) > config.swapWarnUsedBytes;
    if (highSwap) {
      blockers.push(
        `mac swap gate: ${formatBytes(swap.usedBytes)} used above ${formatBytes(config.swapWarnUsedBytes)}`,
      );
    }
    signals.push({
      category: "mac.swap",
      severity: highSwap ? "warn" : "info",
      summary: `${formatBytes(swap.usedBytes)} used`,
      value: swap.usedPercent ?? null,
    });
  }
  signals.push({
    category: "mac.load",
    severity: loadRatio > 2 ? "warn" : "info",
    summary: `load ${loads[0].toFixed(2)} / ${cpuCount} cores`,
    value: loadRatio,
  });
  signals.push({
    category: "mac.memory",
    severity: memoryFreePercent !== null && memoryFreePercent < 0.05 ? "warn" : "info",
    summary: `free memory ${Math.round((memoryFreePercent ?? 0) * 100)}%`,
    value: memoryFreePercent,
  });

  const value: MacHealthGateStatus = {
    generatedAt: new Date(now).toISOString(),
    state: blockers.length > 0 ? "blocked" : "clear",
    blockers,
    thresholds: {
      diskMinFreeBytes: config.diskMinFreeBytes,
      diskWarnFreePercent: config.diskWarnFreePercent,
      swapWarnUsedBytes: config.swapWarnUsedBytes,
    },
    load: { one: loads[0], five: loads[1], fifteen: loads[2], cpuCount, loadRatio },
    memory: {
      totalBytes: totalMemoryBytes,
      freeBytes: freeMemoryBytes,
      freePercent: memoryFreePercent,
    },
    disk,
    swap,
    signals,
  };
  cache = { cachedAtMs: now, value };
  return value;
}

/** Bypass cache (mainly for tests). */
export function clearMacGateCache(): void {
  cache = null;
}

export function macHealthGateBlockers(
  task: { commandKind?: string },
  config: DocketExecutorConfig,
): string[] {
  const commandKind = String(task?.commandKind ?? "");
  if (MAC_GATE_EXEMPT_COMMAND_KINDS.has(commandKind as CommandKind)) return [];
  return macHealthGateStatus(config).blockers;
}
