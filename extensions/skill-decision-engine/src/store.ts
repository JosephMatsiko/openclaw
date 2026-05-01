// Decision file IO + last-scan fingerprint state.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DecisionEngineConfig } from "./config.js";
import type { Proposal } from "./types.js";
import { readJson, writeJson } from "./util.js";

export interface LastScanState {
  lastScanAt?: string;
  fingerprints?: Record<string, { ts: string; decisionId: string }>;
}

export function lastScanPath(config: DecisionEngineConfig): string {
  return join(config.decisionsDir, "last-scan.json");
}

export function decisionPath(config: DecisionEngineConfig, decisionId: string): string {
  return join(config.decisionsDir, `${decisionId}.json`);
}

export function writeDecision(decision: Proposal, config: DecisionEngineConfig): void {
  writeJson(decisionPath(config, decision.id), decision);
}

export function loadDecisions(config: DecisionEngineConfig): Proposal[] {
  if (!existsSync(config.decisionsDir)) return [];
  return readdirSync(config.decisionsDir)
    .filter((n) => n.startsWith("decision-") && n.endsWith(".json"))
    .map((n) => readJson<Proposal | null>(join(config.decisionsDir, n), null))
    .filter((d): d is Proposal => d !== null);
}

export function loadLastScan(config: DecisionEngineConfig): LastScanState {
  return readJson<LastScanState>(lastScanPath(config), { fingerprints: {} });
}

export function saveLastScan(state: LastScanState, config: DecisionEngineConfig): void {
  writeJson(lastScanPath(config), state);
}
