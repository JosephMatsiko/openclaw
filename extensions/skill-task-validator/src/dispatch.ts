// validateTaskDeliverable — primary entry point. Looks up the validator
// for the task's commandKind and runs it. Catches all exceptions and
// returns a "trusting exit code" result so the validator never false-fails.
//
// LLM-introspection layer (build-class deep check via claude-cli) is
// queued for v0.2 — it sits between the heuristic pass and the final
// verdict, flipping heuristic-pass to fail when it has high confidence
// the deliverable doesn't satisfy intent. The .mjs implementation lives
// at extensions/memory-graph/scripts/chuck-task-validator.mjs while v0.2
// is being designed.

import type { TaskValidatorConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import type { DocketTask, ValidationResult } from "./types.js";
import { VALIDATORS } from "./validators/index.js";

export async function validateTaskDeliverable(
  task: DocketTask,
  configIn?: TaskValidatorConfig,
): Promise<ValidationResult> {
  const config = configIn ?? resolveConfig({});
  const kind = task?.commandKind ?? task?.command?.commandKind ?? "(unknown)";
  const fn = VALIDATORS[kind];
  if (!fn) {
    return {
      valid: true,
      reason: `no validator wired for commandKind '${kind}'; trusting exit code`,
      category: "no-validator",
      evidence: { commandKind: kind },
    };
  }
  let heuristic: ValidationResult;
  try {
    heuristic = await fn(task, config);
  } catch (e) {
    return {
      valid: true,
      reason: `validator error: ${(e as Error).message ?? e}; trusting exit code`,
      category: "validator-error",
      evidence: { commandKind: kind, error: (e as Error).message ?? String(e) },
    };
  }

  // LLM layer queued for v0.2 — see chuck-task-validator.mjs for the .mjs
  // implementation that ships with the LaunchAgent today. When ported, it
  // wraps build-class results: heuristic-pass + LLM-high-confidence-fail
  // flips to invalid; uncertainty trusts heuristic.
  if (
    !config.skipLlmLayer &&
    (kind === "claude-cli-build" || kind === "codex-build") &&
    heuristic.valid === true
  ) {
    return {
      ...heuristic,
      llm: {
        skipped: true,
        reason: "LLM layer port queued for v0.2; heuristic verdict stands",
      },
    };
  }
  return heuristic;
}
