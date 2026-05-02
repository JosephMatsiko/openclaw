// preview command — buildPreviewDecision + optional write + event.

import { join } from "node:path";
import type { PriorCompactionConfig } from "./config.js";
import { buildPreviewDecision } from "./decision.js";
import type { CompactionDecision, PreviewOptions, PreviewReceipt, RunDeps } from "./types.js";
import {
  appendEvent,
  ensureDir,
  makeEvent,
  pathExists,
  readJson,
  writeJsonAtomic,
} from "./util.js";
import { createDecisionValidator, validateOrThrow } from "./validators.js";

export function writeDecision(
  config: PriorCompactionConfig,
  decision: CompactionDecision,
  validateDecision: import("ajv").ValidateFunction,
): { decisionId: string; path: string } {
  validateOrThrow(validateDecision, decision, "prior compaction decision");
  ensureDir(config.compactionsDir);
  const path = join(config.compactionsDir, `${decision.decisionId}.json`);
  if (pathExists(path)) {
    const existing = readJson<CompactionDecision>(path);
    if (existing.status !== "draft" && existing.status !== decision.status) {
      throw new Error(`refusing to overwrite non-draft compaction decision: ${path}`);
    }
  }
  writeJsonAtomic(path, decision);
  return { decisionId: decision.decisionId, path };
}

export async function previewDecision(
  config: PriorCompactionConfig,
  options: PreviewOptions = {},
  deps: RunDeps = {},
): Promise<PreviewReceipt> {
  const validateDecision = deps.validateDecision ?? createDecisionValidator(config);
  const limit = options.limit ?? config.defaultLimit;
  const decision = buildPreviewDecision(config, { validateDecision, limit });
  let writes = false;
  let path: string | null = null;
  if (options.write) {
    const written = writeDecision(config, decision, validateDecision);
    appendEvent(
      config.eventsPath,
      makeEvent("chuck.prior-compaction.draft-written", {
        decisionId: decision.decisionId,
        path: written.path,
        includedDeltaCount: decision.includedDeltaIds.length,
        promotedClaimCount: decision.promotedClaims.length,
        deferredClaimCount: decision.deferredClaims.length,
      }),
    );
    writes = true;
    path = written.path;
  }
  return { ok: true, command: "preview", writes, path, decision };
}
