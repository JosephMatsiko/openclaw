// Runtime config resolver — paths + caps for posterior-delta writer.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface PosteriorDeltaConfig {
  enabled: boolean;
  deltasDir: string;
  readMarkersDir: string;
  priorsDir: string;
  latestPriorPath: string;
  runsDir: string;
  designDir: string;
  posteriorSchemaPath: string;
  dissentSchemaPath: string;
  readMarkerSchemaPath: string;
  maxClaimsPerDelta: number;
  maxOpenQuestions: number;
  maxRecommendations: number;
}

const HOME = homedir();
const STATE = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V2 = join(STATE, "chuck-v2");
const CHUCK_V3 = join(STATE, "chuck-v3");
const DEFAULT_DELTAS = join(CHUCK_V3, "posterior-deltas");
const DEFAULT_READ_MARKERS = join(CHUCK_V3, "read-markers");
const DEFAULT_PRIORS = join(CHUCK_V3, "priors");
const DEFAULT_RUNS = join(CHUCK_V2, "runs");
const REPO_ROOT = resolve(HOME, "Projects", "openclaw");
const DEFAULT_DESIGN = join(REPO_ROOT, "extensions", "memory-graph", "data", "chuck-v2-design");

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

export function resolveConfig(input: Record<string, unknown> | undefined): PosteriorDeltaConfig {
  const raw = input ?? {};
  const priorsDir = pickPath(raw.priorsDir, DEFAULT_PRIORS);
  const designDir = pickPath(raw.designDir, DEFAULT_DESIGN);
  return {
    enabled: pickBoolean(raw.enabled, true),
    deltasDir: pickPath(raw.deltasDir, DEFAULT_DELTAS),
    readMarkersDir: pickPath(raw.readMarkersDir, DEFAULT_READ_MARKERS),
    priorsDir,
    latestPriorPath: join(priorsDir, "latest.json"),
    runsDir: pickPath(raw.runsDir, DEFAULT_RUNS),
    designDir,
    posteriorSchemaPath: join(designDir, "posterior-delta.schema.json"),
    dissentSchemaPath: join(designDir, "dissent-record.schema.json"),
    readMarkerSchemaPath: join(designDir, "read-marker.schema.json"),
    maxClaimsPerDelta: pickInt(raw.maxClaimsPerDelta, 12, 1, 100),
    maxOpenQuestions: pickInt(raw.maxOpenQuestions, 12, 1, 100),
    maxRecommendations: pickInt(raw.maxRecommendations, 8, 1, 50),
  };
}
