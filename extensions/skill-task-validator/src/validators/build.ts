// validateBuildTask — the highest-leverage validator. Catches the
// 2026-04-29 morning-digest failure mode where exit=0 but no script was
// written.
//
// Order of preference for deliverable detection:
//   1. task.deliverable.{path, paths} — explicit, scanner-set
//   2. inferDeliverablePaths(intent, repoRoot) — heuristic text inference
//
// Each candidate goes through: existence → size > 0 → mtime > startedAt
// → syntactic check (node --check / plutil -lint / JSON.parse). Any
// failure short-circuits with category-tagged evidence.

import { existsSync, statSync } from "node:fs";
import {
  inferDeliverablePaths,
  parseStartedAtMs,
  resolveCandidatePath,
  syntaxCheck,
} from "../path-infer.js";
import type { DocketTask, ValidationResult, Validator } from "../types.js";

export const validateBuildTask: Validator = (task: DocketTask, config): ValidationResult => {
  const intent = task?.intent ?? "";
  const startedAtMs = parseStartedAtMs(task);

  let candidates: string[] | undefined;
  let candidateSource: string;
  const explicit = task?.deliverable;
  if (explicit && typeof explicit === "object") {
    const explicitPaths: string[] = Array.isArray(explicit.paths)
      ? explicit.paths
      : typeof explicit.path === "string"
        ? [explicit.path]
        : [];
    if (explicitPaths.length > 0) {
      const dedup = new Set<string>();
      for (const raw of explicitPaths) {
        if (typeof raw !== "string" || !raw.trim()) continue;
        dedup.add(resolveCandidatePath(raw, config.repoRoot));
      }
      candidates = [...dedup];
      candidateSource = "explicit";
    }
  }
  if (!candidates) {
    candidates = inferDeliverablePaths(intent, config.repoRoot);
    candidateSource = "intent-inference";
  }

  if (candidates.length === 0) {
    return {
      valid: true,
      reason: "no inferrable deliverable paths in intent; trusting exit code",
      category: "no-deliverable-inferred",
      evidence: { candidates: [], candidateSource },
    };
  }

  const checked: Array<{
    path: string;
    size: number;
    mtimeMs: number;
    syntax: string;
  }> = [];
  for (const p of candidates) {
    if (!existsSync(p)) {
      return {
        valid: false,
        reason: `intent referenced path '${p}' but it does not exist on disk after task completion`,
        category: "missing-deliverable",
        evidence: { candidates, missing: p, checked },
      };
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch (e) {
      return {
        valid: false,
        reason: `deliverable '${p}' stat failed: ${(e as Error).message ?? e}`,
        category: "stat-error",
        evidence: { candidates, path: p, checked },
      };
    }
    if (st.size === 0) {
      return {
        valid: false,
        reason: `deliverable '${p}' exists but is empty`,
        category: "empty-deliverable",
        evidence: { candidates, path: p, size: 0, checked },
      };
    }
    if (startedAtMs && st.mtimeMs < startedAtMs) {
      return {
        valid: false,
        reason: `deliverable '${p}' existed before task started (mtime ${new Date(st.mtimeMs).toISOString()} < startedAt ${new Date(startedAtMs).toISOString()}) — task did not write or update it`,
        category: "stale-deliverable",
        evidence: { candidates, path: p, mtimeMs: st.mtimeMs, startedAtMs, checked },
      };
    }
    const syntax = syntaxCheck(p);
    if (!syntax.ok) {
      return {
        valid: false,
        reason: `${p} exists but failed syntactic check (${syntax.kind}): ${syntax.stderr ?? "no detail"}`,
        category: "syntax-fail",
        evidence: { candidates, path: p, syntax, checked },
      };
    }
    checked.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, syntax: syntax.kind });
  }
  return {
    valid: true,
    reason: `all ${checked.length} inferrable deliverable(s) exist + parse clean`,
    category: "deliverables-verified",
    evidence: { candidates, checked },
  };
};
