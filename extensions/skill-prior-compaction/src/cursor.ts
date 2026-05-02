// applied-decision cursor + decision file enumeration.

import type { PriorCompactionConfig } from "./config.js";
import type { AppliedCursor, CompactionDecision, DecisionFile } from "./types.js";
import { compareIso, latestJsonFiles, type JsonFileEntry } from "./util.js";

const SCHEMA = "chuck.prior-compaction-decision.v1";

export function compactionDecisionFiles(
  config: PriorCompactionConfig,
  statuses: string[] | null = null,
): DecisionFile[] {
  const statusSet = Array.isArray(statuses) ? new Set(statuses) : null;
  const files = latestJsonFiles<CompactionDecision>(config.compactionsDir, config.defaultLimit);
  return files
    .filter(
      (file): file is JsonFileEntry<CompactionDecision> => file.data?.schemaVersion === SCHEMA,
    )
    .filter((file) => !statusSet || statusSet.has(file.data?.status))
    .map((file) => ({
      name: file.name,
      path: file.path,
      mtimeMs: file.mtimeMs,
      data: file.data,
    }));
}

export function latestCompactionDecision(
  config: PriorCompactionConfig,
  statuses: string[] | null = null,
): DecisionFile | null {
  return compactionDecisionFiles(config, statuses)[0] ?? null;
}

export function appliedCompactionCursor(config: PriorCompactionConfig): AppliedCursor {
  const applied = compactionDecisionFiles(config, ["applied"]).sort(
    (a, b) => compareIso(a.data.appliedAt, b.data.appliedAt) || a.path.localeCompare(b.path),
  );
  const deltaIds = new Set<string>();
  let latest: DecisionFile | null = null;
  for (const file of applied) {
    latest = file;
    for (const id of Array.isArray(file.data?.includedDeltaIds) ? file.data.includedDeltaIds : []) {
      deltaIds.add(id);
    }
  }
  return {
    latestDecisionId: latest?.data?.decisionId ?? null,
    latestResultingPriorId: latest?.data?.resultingPriorId ?? null,
    appliedDeltaIds: [...deltaIds].sort(),
  };
}
