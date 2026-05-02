// reportWatchers — orchestrator that gathers per-watcher health.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WatchersConfig } from "./config.js";
import { DEFAULT_WATCHERS } from "./registry.js";
import { defaultLaunchctlRunner, defaultPsRunner } from "./runners.js";
import type { ReportOptions, RunDeps, WatcherEntry, WatcherReport } from "./types.js";

interface ParsedLaunchctl {
  loaded: boolean;
  pid: number | null;
  lastExitCode: number | null;
}

function parseLaunchctlList(stdout: string, label: string): ParsedLaunchctl {
  const text = stdout.trim();
  if (!text || /Could not find service/i.test(text)) {
    return { loaded: false, pid: null, lastExitCode: null };
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 3) continue;
    if (cols[cols.length - 1] !== label) continue;
    const rawPid = cols[0];
    const rawExit = cols[1];
    const pid = rawPid === "-" || !/^\d+$/.test(rawPid ?? "") ? null : Number(rawPid);
    const lastExitCode = /^-?\d+$/.test(rawExit ?? "") ? Number(rawExit) : null;
    return { loaded: true, pid, lastExitCode };
  }
  return { loaded: false, pid: null, lastExitCode: null };
}

function readLastBusEvent(
  eventsPath: string,
  busSource: string | null | undefined,
  windowMs: number,
): { type: string; ts: string } | null {
  if (!busSource || !existsSync(eventsPath)) return null;
  try {
    const stats = statSync(eventsPath);
    if (Date.now() - stats.mtimeMs > windowMs) return null;
    // Read tail bytes (max 1 MB) to avoid loading huge ledgers.
    const text = readFileSync(eventsPath, "utf8");
    const tail = text.length > 1_000_000 ? text.slice(text.length - 1_000_000) : text;
    const lines = tail.split("\n").filter(Boolean);
    const cutoff = Date.now() - windowMs;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i] ?? "");
        if (ev?.source !== busSource) continue;
        const tsMs = Date.parse(String(ev.ts ?? ""));
        if (!Number.isFinite(tsMs) || tsMs < cutoff) return null;
        return { type: String(ev.type ?? "?"), ts: String(ev.ts ?? "") };
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readLastLogLine(logsDir: string, log: string | null | undefined): string | null {
  if (!log) return null;
  const path = join(logsDir, log);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n").filter(Boolean);
    return lines.length > 0 ? (lines[lines.length - 1] ?? null) : null;
  } catch {
    return null;
  }
}

function readStateFile(stateFile: string | null | undefined): boolean | null {
  if (!stateFile) return null;
  if (!existsSync(stateFile)) return false;
  try {
    JSON.parse(readFileSync(stateFile, "utf8"));
    return true;
  } catch {
    return false;
  }
}

export async function reportWatchers(
  config: WatchersConfig,
  options: ReportOptions = {},
  deps: RunDeps = {},
): Promise<WatcherReport[]> {
  const watchers = deps.watchers ?? DEFAULT_WATCHERS;
  const filtered = options.label ? watchers.filter((w) => w.label === options.label) : watchers;
  const launchctl = deps.launchctl ?? defaultLaunchctlRunner();
  const ps = deps.ps ?? defaultPsRunner();
  const windowHours = options.busWindowHours ?? config.busWindowHours;
  const windowMs = windowHours * 3600 * 1000;

  const reports: WatcherReport[] = [];
  for (const w of filtered) {
    const launchctlResult = await launchctl({
      label: w.label,
      timeoutMs: config.launchctlTimeoutMs,
    });
    const parsed = parseLaunchctlList(launchctlResult.stdout, w.label);
    let cpuPercent: number | null = null;
    let uptimeMs: number | null = null;
    if (parsed.pid != null) {
      const psResult = await ps({ pid: parsed.pid });
      cpuPercent = psResult.cpu;
      uptimeMs = psResult.uptimeSec != null ? psResult.uptimeSec * 1000 : null;
    }
    reports.push({
      label: w.label,
      loaded: parsed.loaded,
      pid: parsed.pid,
      lastExitCode: parsed.lastExitCode,
      uptimeMs,
      cpuPercent,
      lastBusEvent: readLastBusEvent(config.eventsPath, w.busSource, windowMs),
      lastLogLine: readLastLogLine(config.logsDir, w.log),
      stateOk: readStateFile(w.stateFile),
      reason: launchctlResult.ok ? undefined : launchctlResult.stderr || undefined,
    });
  }
  return reports;
}
