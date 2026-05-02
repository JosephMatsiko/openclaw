// Runtime config resolver — script path + per-command timeouts + caps.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface MacSelfHealConfig {
  enabled: boolean;
  scriptPath: string;
  stateDir: string;
  receiptsDir: string;
  archivesDir: string;
  latestPath: string;
  statusTimeoutMs: number;
  planTimeoutMs: number;
  applyTimeoutMs: number;
  defaultMaxActions: number;
}

const HOME = homedir();
const REPO_ROOT = resolve(HOME, "Projects", "openclaw");
const DEFAULT_SCRIPT = join(
  REPO_ROOT,
  "extensions",
  "memory-graph",
  "scripts",
  "chuck-mac-self-heal.mjs",
);
const DEFAULT_STATE = join(HOME, ".openclaw", "workspace", "state", "chuck-v3", "mac-self-heal");

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

export function resolveConfig(input: Record<string, unknown> | undefined): MacSelfHealConfig {
  const raw = input ?? {};
  const stateDir = pickPath(raw.stateDir, DEFAULT_STATE);
  return {
    enabled: pickBoolean(raw.enabled, true),
    scriptPath: pickPath(raw.scriptPath, DEFAULT_SCRIPT),
    stateDir,
    receiptsDir: join(stateDir, "receipts"),
    archivesDir: join(stateDir, "archives"),
    latestPath: join(stateDir, "latest.json"),
    statusTimeoutMs: pickInt(raw.statusTimeoutMs, 30_000, 5000, 120_000),
    planTimeoutMs: pickInt(raw.planTimeoutMs, 120_000, 10_000, 300_000),
    applyTimeoutMs: pickInt(raw.applyTimeoutMs, 1_200_000, 60_000, 3_600_000),
    defaultMaxActions: pickInt(raw.defaultMaxActions, 24, 1, 500),
  };
}
