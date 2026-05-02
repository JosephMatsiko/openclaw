// Probe primitives — pgrep / ps / err-log scan. All pure-ish (subprocesses
// + filesystem reads, no global state).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { GatewayWatchdogConfig } from "./config.js";
import type { EventLoopBlocks } from "./types.js";

const PGREP_PATH = "/usr/bin/pgrep";
const PS_PATH = "/bin/ps";
const ERR_LOG_TAIL_BYTES = 2_000_000;

export function findGatewayPid(config: GatewayWatchdogConfig): number | null {
  const res = spawnSync(PGREP_PATH, ["-f", config.gatewayPgrepPattern], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const pids = res.stdout
    .trim()
    .split("\n")
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return pids[0] ?? null;
}

export function readGatewayCpu(pid: number | null): number | null {
  if (!pid) return null;
  const res = spawnSync(PS_PATH, ["-p", String(pid), "-o", "%cpu="], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const v = Number.parseFloat(res.stdout.trim());
  return Number.isFinite(v) ? v : null;
}

/**
 * Read the gateway's recent event-loop liveness warnings from its err log.
 * Returns the count + most-recent block duration in the last `windowMs`.
 *
 * Scans the tail of the log (last 2 MB) only; older entries are unlikely
 * to matter for liveness detection and slurping multi-GB logs would defeat
 * the purpose of a fast probe.
 */
export function recentEventLoopBlocks(
  windowMs: number,
  config: GatewayWatchdogConfig,
  now: number = Date.now(),
): EventLoopBlocks {
  if (!existsSync(config.gatewayErrLogPath)) {
    return { count: 0, maxBlockMs: 0, lastTs: null };
  }
  let buf: string;
  try {
    const all = readFileSync(config.gatewayErrLogPath, "utf8");
    buf = all.length > ERR_LOG_TAIL_BYTES ? all.slice(-ERR_LOG_TAIL_BYTES) : all;
  } catch {
    return { count: 0, maxBlockMs: 0, lastTs: null };
  }
  const lines = buf.split("\n");
  const cutoff = now - windowMs;
  let count = 0;
  let maxBlockMs = 0;
  let lastTs: string | null = null;
  const blockRe = /eventLoopDelayMaxMs=([\d.]+)/;
  const tsRe = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-\d{2}:\d{2})/;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes("liveness warning")) continue;
    const tsm = line.match(tsRe);
    if (!tsm) continue;
    const ts = Date.parse(tsm[1]);
    if (!ts) continue;
    if (ts < cutoff) break;
    const m = line.match(blockRe);
    if (!m) continue;
    const ms = Number.parseFloat(m[1]);
    if (Number.isFinite(ms)) {
      count += 1;
      if (ms > maxBlockMs) {
        maxBlockMs = ms;
        lastTs = tsm[1];
      }
    }
  }
  return { count, maxBlockMs, lastTs };
}
