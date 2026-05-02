// Runtime config resolver — paths + script location + caps.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface PriorCapsuleConfig {
  enabled: boolean;
  scriptPath: string;
  priorsDir: string;
  latestPriorPath: string;
  buildTimeoutMs: number;
  defaultLimit: number;
}

const HOME = homedir();
const REPO_ROOT = resolve(HOME, "Projects", "openclaw");
const DEFAULT_SCRIPT = join(
  REPO_ROOT,
  "extensions",
  "memory-graph",
  "scripts",
  "chuck-prior-capsule.mjs",
);
const DEFAULT_PRIORS_DIR = join(HOME, ".openclaw", "workspace", "state", "chuck-v3", "priors");

function pickBoolean(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input;
  return fallback;
}

function pickPath(input: unknown, fallback: string): string {
  if (typeof input !== "string" || input.length === 0) return fallback;
  if (input.startsWith("~/")) return join(HOME, input.slice(2));
  return input;
}

function pickInt(input: unknown, fallback: number, min: number, max: number): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return fallback;
  const intVal = Math.trunc(n);
  if (intVal < min || intVal > max) return fallback;
  return intVal;
}

export function resolveConfig(input: Record<string, unknown> | undefined): PriorCapsuleConfig {
  const raw = input ?? {};
  const priorsDir = pickPath(raw.priorsDir, DEFAULT_PRIORS_DIR);
  return {
    enabled: pickBoolean(raw.enabled, true),
    scriptPath: pickPath(raw.scriptPath, DEFAULT_SCRIPT),
    priorsDir,
    latestPriorPath: join(priorsDir, "latest.json"),
    buildTimeoutMs: pickInt(raw.buildTimeoutMs, 60_000, 5000, 600_000),
    defaultLimit: pickInt(raw.defaultLimit, 10, 1, 200),
  };
}
