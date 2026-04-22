import { homedir } from "node:os";
import { join } from "node:path";
import type { GraphScope } from "./types.js";

const DEFAULT_SCOPE: GraphScope = "workspace";
const DEFAULT_AUTO_INGEST = true;
const DEFAULT_TOKEN_BUDGET_RATIO = 0.2;

// Layer-5 orchestrator routing mode. Controls whether the before_model_resolve
// hook runs the classifier and optionally overrides the per-turn model.
//
//   "off"    — no classifier call, zero latency, current behavior.
//   "shadow" — classifier runs, verdict logged, NO override applied. Use this
//              to sanity-check classifier decisions against live traffic
//              before flipping to "on".
//   "on"     — classifier runs, verdict logged, override applied per the
//              routing table. CAUTION: OpenClaw's google provider plumbing
//              currently hangs on Gemini inference (see THREAT_MODEL + the
//              alignment doc). Flip to "on" only after that path works.
export type RoutingMode = "off" | "shadow" | "on";
const DEFAULT_ROUTING_MODE: RoutingMode = "off";

export type MemoryGraphConfig = {
  dbPath: string;
  scope: GraphScope;
  autoIngest: boolean;
  tokenBudgetRatio: number;
  routing: RoutingMode;
};

type RawConfig = {
  dbPath?: unknown;
  scope?: unknown;
  autoIngest?: unknown;
  tokenBudgetRatio?: unknown;
  routing?: unknown;
};

function resolveDefaultDbPath(): string {
  return join(homedir(), ".openclaw", "memory", "graph.sqlite");
}

function coerceScope(value: unknown): GraphScope {
  return value === "agent" ? "agent" : DEFAULT_SCOPE;
}

function coerceTokenBudgetRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TOKEN_BUDGET_RATIO;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function coerceRouting(value: unknown): RoutingMode {
  if (value === "shadow" || value === "on") {
    return value;
  }
  return DEFAULT_ROUTING_MODE;
}

export function resolveMemoryGraphConfig(raw: unknown): MemoryGraphConfig {
  const source: RawConfig = raw !== null && typeof raw === "object" ? (raw as RawConfig) : {};
  const dbPath =
    typeof source.dbPath === "string" && source.dbPath.trim()
      ? source.dbPath.trim()
      : resolveDefaultDbPath();
  const scope = coerceScope(source.scope);
  const autoIngest =
    typeof source.autoIngest === "boolean" ? source.autoIngest : DEFAULT_AUTO_INGEST;
  const tokenBudgetRatio = coerceTokenBudgetRatio(source.tokenBudgetRatio);
  const routing = coerceRouting(source.routing);
  return { dbPath, scope, autoIngest, tokenBudgetRatio, routing };
}
