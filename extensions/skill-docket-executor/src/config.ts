// Config resolver for @openclaw/skill-docket-executor.

import { homedir } from "node:os";
import { join } from "node:path";

const GIB = 1024 ** 3;

export interface DocketExecutorConfig {
  enabled: boolean;
  repoRoot: string;
  docketDir: string;
  executorControlPath: string;
  globalRunningCap: number;
  diskMinFreeBytes: number;
  diskWarnFreePercent: number;
  swapWarnUsedBytes: number;
}

const HOME = homedir();

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

const DEFAULTS: DocketExecutorConfig = {
  enabled: true,
  repoRoot: expandHome("~/Projects/openclaw"),
  docketDir: expandHome("~/.openclaw/workspace/state/chuck-v3/docket"),
  executorControlPath: expandHome("~/.openclaw/workspace/state/chuck-v3/executor-control.json"),
  globalRunningCap: 6,
  diskMinFreeBytes: 25 * GIB,
  diskWarnFreePercent: 0.1,
  swapWarnUsedBytes: 10 * GIB,
};

function pickBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  return typeof v === "boolean" ? v : fallback;
}

function pickInt(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  bounds?: { min?: number; max?: number },
): number {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return fallback;
  if (bounds?.min != null && v < bounds.min) return fallback;
  if (bounds?.max != null && v > bounds.max) return fallback;
  return v;
}

function pickNumber(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  bounds?: { min?: number; max?: number },
): number {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (bounds?.min != null && v < bounds.min) return fallback;
  if (bounds?.max != null && v > bounds.max) return fallback;
  return v;
}

function pickPath(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) return fallback;
  return expandHome(v);
}

export function resolveConfig(
  raw: Record<string, unknown> | null | undefined,
): DocketExecutorConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    repoRoot: pickPath(r, "repoRoot", DEFAULTS.repoRoot),
    docketDir: pickPath(r, "docketDir", DEFAULTS.docketDir),
    executorControlPath: pickPath(r, "executorControlPath", DEFAULTS.executorControlPath),
    globalRunningCap: pickInt(r, "globalRunningCap", DEFAULTS.globalRunningCap, {
      min: 1,
      max: 32,
    }),
    diskMinFreeBytes: pickInt(r, "diskMinFreeBytes", DEFAULTS.diskMinFreeBytes, { min: GIB }),
    diskWarnFreePercent: pickNumber(r, "diskWarnFreePercent", DEFAULTS.diskWarnFreePercent, {
      min: 0.01,
      max: 0.5,
    }),
    swapWarnUsedBytes: pickInt(r, "swapWarnUsedBytes", DEFAULTS.swapWarnUsedBytes, { min: GIB }),
  };
}
