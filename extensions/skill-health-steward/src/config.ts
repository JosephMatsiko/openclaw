// Runtime config resolver — mirrors openclaw.plugin.json schema.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface HealthStewardConfig {
  enabled: boolean;
  stewardDir: string;
  receiptsDir: string;
  approvalsDir: string;
  executorControlPath: string;
  docketDir: string;
  macSelfHealScript: string;
  macSelfHealDir: string;
  macSelfHealReceiptsDir: string;
  macSelfHealArchivesDir: string;
  eventsPath: string;
  diskMinFreeBytes: number;
  diskMinFreePercent: number;
  swapMaxUsedBytes: number;
  loadOneWatchThreshold: number;
  freeMemoryWatchPercent: number;
  stabilizeMaxSafeActions: number;
  applyMaxActions: number;
  selfHealPlanTimeoutMs: number;
  selfHealApplyTimeoutMs: number;
}

const HOME = homedir();
const STATE_ROOT = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V3 = join(STATE_ROOT, "chuck-v3");
const STEWARD_DIR = join(CHUCK_V3, "health-steward");
const APPROVALS_DIR = join(CHUCK_V3, "approvals");
const EXECUTOR_CONTROL = join(CHUCK_V3, "executor-control.json");
const DOCKET_DIR = join(CHUCK_V3, "docket");
const MAC_SELF_HEAL_DIR = join(CHUCK_V3, "mac-self-heal");
const EVENTS_PATH = join(STATE_ROOT, "apex-events.jsonl");
const REPO_ROOT = resolve(HOME, "Projects", "openclaw");
const MAC_SELF_HEAL_SCRIPT = join(
  REPO_ROOT,
  "extensions",
  "memory-graph",
  "scripts",
  "chuck-mac-self-heal.mjs",
);

const GIB = 1024 ** 3;

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

function pickFloat(input: unknown, fallback: number, min: number, max: number): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

export function resolveConfig(input: Record<string, unknown> | undefined): HealthStewardConfig {
  const raw = input ?? {};
  const stewardDir = pickPath(raw.stewardDir, STEWARD_DIR);
  const macSelfHealDir = pickPath(raw.macSelfHealDir, MAC_SELF_HEAL_DIR);
  return {
    enabled: pickBoolean(raw.enabled, true),
    stewardDir,
    receiptsDir: join(stewardDir, "receipts"),
    approvalsDir: pickPath(raw.approvalsDir, APPROVALS_DIR),
    executorControlPath: pickPath(raw.executorControlPath, EXECUTOR_CONTROL),
    docketDir: pickPath(raw.docketDir, DOCKET_DIR),
    macSelfHealScript: pickPath(raw.macSelfHealScript, MAC_SELF_HEAL_SCRIPT),
    macSelfHealDir,
    macSelfHealReceiptsDir: join(macSelfHealDir, "receipts"),
    macSelfHealArchivesDir: join(macSelfHealDir, "archives"),
    eventsPath: pickPath(raw.eventsPath, EVENTS_PATH),
    diskMinFreeBytes: pickInt(raw.diskMinFreeBytes, 25 * GIB, GIB, 1024 * GIB),
    diskMinFreePercent: pickFloat(raw.diskMinFreePercent, 0.1, 0.01, 0.5),
    swapMaxUsedBytes: pickInt(raw.swapMaxUsedBytes, 10 * GIB, GIB, 1024 * GIB),
    loadOneWatchThreshold: pickFloat(raw.loadOneWatchThreshold, 10, 1, 64),
    freeMemoryWatchPercent: pickFloat(raw.freeMemoryWatchPercent, 0.02, 0.001, 0.5),
    stabilizeMaxSafeActions: pickInt(raw.stabilizeMaxSafeActions, 24, 1, 200),
    applyMaxActions: pickInt(raw.applyMaxActions, 60, 1, 500),
    selfHealPlanTimeoutMs: pickInt(raw.selfHealPlanTimeoutMs, 120_000, 5000, 600_000),
    selfHealApplyTimeoutMs: pickInt(raw.selfHealApplyTimeoutMs, 1_200_000, 60_000, 3_600_000),
  };
}
