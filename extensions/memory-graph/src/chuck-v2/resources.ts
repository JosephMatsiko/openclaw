import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MachineResourceSnapshot, MemoryPressure } from "./types.js";

export type MemoryWatcherLevel = "L0" | "L1" | "L2" | "L3";

export type MemoryPressureWatcherSample = {
  ts?: number;
  level: MemoryWatcherLevel;
  freeMb?: number;
  freeMemoryMb?: number;
  swapUsedMb?: number;
  compressedMb?: number;
};

export type DarwinVmStatParse = {
  pageSizeBytes: number;
  freeMemoryMb?: number;
  inactiveMemoryMb?: number;
  speculativeMemoryMb?: number;
  purgeableMemoryMb?: number;
  compressedMb?: number;
};

export type DarwinMemoryInputs = {
  vmStatOutput: string;
  memsizeOutput: string;
  swapUsageOutput?: string;
  capturedAt?: string;
};

const execFileAsync = promisify(execFile);

export function memoryPressureFromWatcherLevel(level: MemoryWatcherLevel): MemoryPressure {
  switch (level) {
    case "L0":
      return "normal";
    case "L1":
    case "L2":
      return "warning";
    case "L3":
      return "critical";
  }
  return "warning";
}

export function machineResourceSnapshotFromMemorySample(
  sample: MemoryPressureWatcherSample,
): MachineResourceSnapshot {
  return {
    capturedAt: sample.ts === undefined ? undefined : new Date(sample.ts).toISOString(),
    memoryPressure: memoryPressureFromWatcherLevel(sample.level),
    freeMemoryMb: sample.freeMemoryMb ?? sample.freeMb,
    swapUsedMb: sample.swapUsedMb,
    notes:
      sample.compressedMb === undefined
        ? undefined
        : [`compressed memory ${Math.round(sample.compressedMb)}MB`],
  };
}

export function parseSysctlMemsize(output: string): number | undefined {
  const match = output.match(/(?:hw\.memsize:\s*)?(\d+)/);
  if (!match) {
    return undefined;
  }
  const bytes = Number(match[1]);
  return Number.isFinite(bytes) ? bytes : undefined;
}

export function parseSwapUsageMb(output: string): number | undefined {
  const match = output.match(/used\s*=\s*([0-9.]+)\s*M/i);
  if (!match) {
    return undefined;
  }
  const mb = Number(match[1]);
  return Number.isFinite(mb) ? mb : undefined;
}

export function parseDarwinVmStat(output: string, pageSizeBytes = 16_384): DarwinVmStatParse {
  const pages = (label: string): number | undefined => {
    const match = output.match(new RegExp(`${label}:\\s+([0-9.]+)\\.`, "i"));
    if (!match) {
      return undefined;
    }
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
  };
  const mb = (pageCount: number | undefined): number | undefined =>
    pageCount === undefined ? undefined : Math.round((pageCount * pageSizeBytes) / 1_048_576);
  return {
    pageSizeBytes,
    freeMemoryMb: mb(pages("Pages free")),
    inactiveMemoryMb: mb(pages("Pages inactive")),
    speculativeMemoryMb: mb(pages("Pages speculative")),
    purgeableMemoryMb: mb(pages("Pages purgeable")),
    compressedMb: mb(pages("Pages occupied by compressor")),
  };
}

export function machineResourceSnapshotFromDarwinMemory({
  vmStatOutput,
  memsizeOutput,
  swapUsageOutput = "",
  capturedAt = new Date().toISOString(),
}: DarwinMemoryInputs): MachineResourceSnapshot {
  const vm = parseDarwinVmStat(vmStatOutput);
  const memBytes = parseSysctlMemsize(memsizeOutput);
  const totalMemoryMb = memBytes === undefined ? undefined : Math.round(memBytes / 1_048_576);
  const freeMemoryMb = [vm.freeMemoryMb, vm.speculativeMemoryMb, vm.purgeableMemoryMb]
    .filter((value): value is number => value !== undefined)
    .reduce((sum, value) => sum + value, 0);
  const swapUsedMb = parseSwapUsageMb(swapUsageOutput);
  const memoryPressure = pressureFromDarwinNumbers({
    freeMemoryMb,
    swapUsedMb,
    compressedMb: vm.compressedMb,
    totalMemoryMb,
  });
  return {
    capturedAt,
    memoryPressure,
    freeMemoryMb,
    swapUsedMb,
    notes: [
      totalMemoryMb === undefined ? undefined : `total memory ${totalMemoryMb}MB`,
      vm.compressedMb === undefined ? undefined : `compressed memory ${vm.compressedMb}MB`,
      vm.inactiveMemoryMb === undefined
        ? undefined
        : `inactive memory ${vm.inactiveMemoryMb}MB not counted as admission headroom`,
    ].filter((note): note is string => note !== undefined),
  };
}

export async function captureDarwinMemorySnapshot(): Promise<MachineResourceSnapshot> {
  const [vmStat, memsize, swap] = await Promise.all([
    execFileAsync("/usr/bin/vm_stat", []),
    execFileAsync("/usr/sbin/sysctl", ["hw.memsize"]),
    execFileAsync("/usr/sbin/sysctl", ["vm.swapusage"]),
  ]);
  return machineResourceSnapshotFromDarwinMemory({
    vmStatOutput: vmStat.stdout,
    memsizeOutput: memsize.stdout,
    swapUsageOutput: swap.stdout,
  });
}

function pressureFromDarwinNumbers({
  freeMemoryMb,
  swapUsedMb,
  compressedMb,
  totalMemoryMb,
}: {
  freeMemoryMb: number;
  swapUsedMb?: number;
  compressedMb?: number;
  totalMemoryMb?: number;
}): MemoryPressure {
  const criticalFree = totalMemoryMb === undefined ? 384 : Math.max(256, totalMemoryMb * 0.02);
  const warningFree = totalMemoryMb === undefined ? 1_024 : Math.max(1_024, totalMemoryMb * 0.08);
  const warningSwap = totalMemoryMb === undefined ? 256 : Math.max(256, totalMemoryMb * 0.015625);
  const criticalSwap = totalMemoryMb === undefined ? 4_096 : Math.max(4_096, totalMemoryMb * 0.25);
  const warningCompressed =
    totalMemoryMb === undefined ? 2_048 : Math.max(2_048, totalMemoryMb * 0.12);
  const criticalCompressed =
    totalMemoryMb === undefined ? 6_144 : Math.max(6_144, totalMemoryMb * 0.35);
  if (
    freeMemoryMb <= criticalFree ||
    (swapUsedMb ?? 0) >= criticalSwap ||
    (compressedMb ?? 0) >= criticalCompressed
  ) {
    return "critical";
  }
  if (
    freeMemoryMb <= warningFree ||
    (swapUsedMb ?? 0) >= warningSwap ||
    (compressedMb ?? 0) >= warningCompressed
  ) {
    return "warning";
  }
  return "normal";
}
