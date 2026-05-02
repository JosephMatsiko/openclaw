// Runtime config resolver — paths + caps for the compaction gate.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface PriorCompactionConfig {
  enabled: boolean;
  compactionsDir: string;
  deltasDir: string;
  priorsDir: string;
  latestPriorPath: string;
  docketDir: string;
  designDir: string;
  compactionSchemaPath: string;
  priorCapsuleScript: string;
  eventsPath: string;
  defaultLimit: number;
  priorCapsuleTimeoutMs: number;
  approvalToken: "APPROVE_PRIOR_COMPACTION";
}

const HOME = homedir();
const STATE = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V3 = join(STATE, "chuck-v3");
const REPO_ROOT = resolve(HOME, "Projects", "openclaw");
const DEFAULT_DESIGN = join(REPO_ROOT, "extensions", "memory-graph", "data", "chuck-v2-design");
const DEFAULT_PRIOR_CAPSULE = join(
  REPO_ROOT,
  "extensions",
  "memory-graph",
  "scripts",
  "chuck-prior-capsule.mjs",
);

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

export function resolveConfig(input: Record<string, unknown> | undefined): PriorCompactionConfig {
  const raw = input ?? {};
  const priorsDir = pickPath(raw.priorsDir, join(CHUCK_V3, "priors"));
  const designDir = pickPath(raw.designDir, DEFAULT_DESIGN);
  return {
    enabled: pickBoolean(raw.enabled, true),
    compactionsDir: pickPath(raw.compactionsDir, join(CHUCK_V3, "compactions")),
    deltasDir: pickPath(raw.deltasDir, join(CHUCK_V3, "posterior-deltas")),
    priorsDir,
    latestPriorPath: join(priorsDir, "latest.json"),
    docketDir: pickPath(raw.docketDir, join(CHUCK_V3, "docket")),
    designDir,
    compactionSchemaPath: join(designDir, "prior-compaction-decision.schema.json"),
    priorCapsuleScript: pickPath(raw.priorCapsuleScript, DEFAULT_PRIOR_CAPSULE),
    eventsPath: pickPath(raw.eventsPath, join(STATE, "apex-events.jsonl")),
    defaultLimit: pickInt(raw.defaultLimit, 1000, 10, 10_000),
    priorCapsuleTimeoutMs: pickInt(raw.priorCapsuleTimeoutMs, 60_000, 5000, 600_000),
    approvalToken: "APPROVE_PRIOR_COMPACTION",
  };
}
