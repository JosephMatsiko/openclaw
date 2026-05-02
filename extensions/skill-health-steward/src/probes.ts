// Default system probes — disk / swap / memory pressure / load / process groups.
//
// These call into macOS-specific binaries (sysctl, memory_pressure, ps). Tests
// inject `Partial<SystemProbes>` to bypass the syscalls; production wires the
// defaults below.

import { spawnSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { freemem, homedir, loadavg, totalmem } from "node:os";
import { basename } from "node:path";
import type {
  DiskStatus,
  LoadStatus,
  MemoryPressure,
  ProcessGroup,
  SwapStatus,
  SystemProbes,
} from "./types.js";

export function readDiskStatus(home: string = homedir()): DiskStatus {
  try {
    const stat = statfsSync(home);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    return {
      available: true,
      totalBytes,
      freeBytes,
      freePercent: totalBytes > 0 ? freeBytes / totalBytes : null,
    };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function readSwapStatus(): SwapStatus {
  const result = spawnSync("/usr/sbin/sysctl", ["vm.swapusage"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  const raw = String(result.stdout ?? "").trim();
  const match = raw.match(/total = ([0-9.]+)M\s+used = ([0-9.]+)M\s+free = ([0-9.]+)M/i);
  if (!match) {
    return { available: false, raw };
  }
  const totalBytes = Number(match[1]) * 1024 * 1024;
  const usedBytes = Number(match[2]) * 1024 * 1024;
  return {
    available: true,
    totalBytes,
    usedBytes,
    freeBytes: Number(match[3]) * 1024 * 1024,
    usedPercent: totalBytes > 0 ? usedBytes / totalBytes : null,
    raw,
  };
}

export function readMemoryPressure(): MemoryPressure {
  const result = spawnSync("/usr/bin/memory_pressure", [], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  const stdout = String(result.stdout ?? "");
  const freeMatch = stdout.match(/System-wide memory free percentage:\s+([0-9]+)%/);
  return {
    available: result.status === 0,
    freePercentReported: freeMatch ? Number(freeMatch[1]) / 100 : null,
    sample: stdout.split("\n").slice(0, 18).join("\n"),
  };
}

export function readLoadAverage(): LoadStatus {
  const loads = loadavg();
  return { one: loads[0] ?? 0, five: loads[1] ?? 0, fifteen: loads[2] ?? 0 };
}

interface PsRow {
  pid: number;
  rssBytes: number;
  comm: string;
  args: string;
}

function psRows(): PsRow[] {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,rss=,comm=,args="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): PsRow | null => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        rssBytes: Number(match[2]) * 1024,
        comm: match[3] ?? "",
        args: match[4] ?? "",
      };
    })
    .filter((row): row is PsRow => row != null);
}

export function readProcessGroups(): ProcessGroup[] {
  const groups = new Map<string, ProcessGroup>();
  const classify = (row: PsRow): string => {
    const text = `${row.comm} ${row.args}`;
    if (text.includes("Google Chrome")) return "Google Chrome";
    if (text.includes("Claude")) return "Claude";
    if (text.includes("Codex")) return "Codex";
    if (text.includes("Comet")) return "Comet";
    if (text.includes("Google Drive")) return "Google Drive";
    if (/openclaw/i.test(text)) return "OpenClaw";
    if (/node|tsx/.test(text) && /chuck|apex|openclaw/i.test(text)) return "OpenClaw Node";
    return "Other";
  };
  for (const row of psRows()) {
    const group = classify(row);
    if (group === "Other") continue;
    const existing = groups.get(group) ?? { group, rssBytes: 0, processCount: 0, top: [] };
    existing.rssBytes += row.rssBytes;
    existing.processCount += 1;
    existing.top.push({
      pid: row.pid,
      rssBytes: row.rssBytes,
      comm: basename(row.comm),
      args: row.args.slice(0, 220),
    });
    groups.set(group, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      top: group.top.sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 5),
    }))
    .sort((a, b) => b.rssBytes - a.rssBytes);
}

export function defaultProbes(): SystemProbes {
  return {
    disk: () => readDiskStatus(),
    swap: () => readSwapStatus(),
    memoryPressure: () => readMemoryPressure(),
    load: () => readLoadAverage(),
    totalMemoryBytes: () => totalmem(),
    freeMemoryBytes: () => freemem(),
    processGroups: () => readProcessGroups(),
  };
}

export function mergeProbes(overrides: Partial<SystemProbes> | undefined): SystemProbes {
  const base = defaultProbes();
  if (!overrides) return base;
  return { ...base, ...overrides };
}
