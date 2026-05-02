#!/usr/bin/env node
// =============================================================================
// TRANSITIONAL DUPLICATE — Unit 6a of the openclaw-first migration (2026-05-01).
// =============================================================================
// The CANONICAL implementation lives at:
//   extensions/skill-task-validator/src/dispatch.ts (re-exported via
//   @openclaw/skill-task-validator api.ts)
//
// This .mjs preserves identical heuristic + LLM-introspection semantics so
// chuck-docket-executor.mjs (which imports validateTaskDeliverable from
// here) keeps working unchanged. Vanilla Node can't import the TS plugin's
// api.ts at runtime, so duplicating the logic is the working seam.
//
// LLM-INTROSPECTION LAYER: still lives only here in v0.1. The TS plugin
// exposes the toggle (config.skipLlmLayer) but the layer port is queued
// for v0.2 — the .mjs is canonical for the LLM path until then.
//
// EDITS: heuristic bug fixes go in BOTH places (here AND
// extensions/skill-task-validator/src/*.ts). LLM-layer edits stay here only
// until the v0.2 port lands.
//
// The .mjs retires when chuck-docket-executor migrates and the LLM layer
// has been ported (queued).
// =============================================================================
//
// chuck-task-validator — closed-loop deliverable validator for the docket
// executor.
//
// Why: chuck-docket-executor records `status: "completed"` whenever the spawned
// child returns exit=0 with no signal/timeout. That's a leaky proxy: the
// 2026-04-29 morning-digest task exited 0 but never wrote the script or the
// launchd plist (PID 40729 zombie-died after exit). The executor still recorded
// "completed". This module is the post-spawn check that flips the status to
// `failed-validation` when the deliverable referenced in `intent` is missing,
// empty, syntactically broken, or stale (mtime predates startedAt).
//
// Per-commandKind validators are intentionally small and conservative. When a
// validator can't infer what to check, it returns `valid: true` with a
// "trusting exit code" reason — we never false-fail tasks because the regex
// couldn't find a path.
//
// Programmatic:
//   import { validateTaskDeliverable } from "./chuck-task-validator.mjs";
//   const r = await validateTaskDeliverable(task);
//   // { valid: bool, reason: string, category: string, evidence: object }
//
// CLI:
//   node chuck-task-validator.mjs validate <task-json-path>
//   node chuck-task-validator.mjs sweep            # last 24h completed tasks

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const REPO_ROOT = join(HOME, "Projects", "openclaw");
const DOCKET_DIR = join(HOME, ".openclaw", "workspace", "state", "chuck-v3", "docket");
const MAC_HEAL_LATEST = join(
  HOME,
  ".openclaw",
  "workspace",
  "state",
  "chuck-v3",
  "mac-self-heal",
  "latest.json",
);
const MAC_HEAL_RECEIPTS = join(
  HOME,
  ".openclaw",
  "workspace",
  "state",
  "chuck-v3",
  "mac-self-heal",
  "receipts",
);
const PRIORS_LATEST = join(
  HOME,
  ".openclaw",
  "workspace",
  "state",
  "chuck-v3",
  "priors",
  "latest.json",
);
const SCOUTS_DIR = join(HOME, ".openclaw", "workspace", "state", "chuck-v3", "scouts");
const CODEX_CONFIG = join(HOME, ".codex", "config.toml");
const OPENCLAW_CONFIG = join(HOME, ".openclaw", "openclaw.json");
const CLAUDE_CONFIG = join(HOME, ".claude.json");

// LLM-introspection layer state (build-class deliverable deep-check).
const VALIDATOR_STATE_DIR = join(HOME, ".openclaw", "workspace", "state", "chuck-v3", "validator");
const LLM_BUDGET_PATH = join(VALIDATOR_STATE_DIR, "llm-call-budget.json");
const LLM_DAILY_CAP = 30; // max LLM-validation calls per rolling 24h
const LLM_PROMPT_FILE_CAP = 8 * 1024; // truncate each deliverable read to 8 KB
const LLM_TIMEOUT_MS = 4 * 60 * 1000; // 4 minute claude-cli timeout
const LLM_CONFIDENCE_FLOOR = 0.7; // below this, trust the heuristic
const VALIDATOR_SCRIPT_PATH = fileURLToPath(import.meta.url);

// ─── Helpers ─────────────────────────────────────────────────────────────

function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

function resolveCandidatePath(p) {
  const expanded = expandHome(p);
  if (isAbsolute(expanded)) return expanded;
  // Relative paths in build-task intents are virtually always relative to the
  // openclaw repo root (extensions/memory-graph/scripts/foo.mjs etc).
  return resolve(REPO_ROOT, expanded);
}

function parseStartedAtMs(task) {
  const iso = task?.startedAt ?? task?.createdAt;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// Sweep the intent text for likely deliverable paths. Look for absolute paths,
// tilde-expanded paths, repo-relative paths under extensions/, and any explicit
// LaunchAgents plist references. Conservative: prefer known-good prefixes over
// loose `*.mjs` mentions that might be incidental references.
function inferDeliverablePaths(intent) {
  const text = String(intent ?? "");
  const hits = new Set();

  // 1) Absolute paths beginning with / and ending in known build extensions.
  // Require leading boundary (start of string, whitespace, or punctuation) so
  // we don't grab the trailing `/foo.mjs` slice of a relative path like
  // `extensions/memory-graph/scripts/foo.mjs`.
  // Order alternatives longest-first so `.json` matches `json` (not just `js`).
  for (const m of text.matchAll(
    /(?:^|[\s(`'"])(\/[A-Za-z0-9_./-]+\.(?:mjs|tsx|json|plist|toml|ts|js))/g,
  )) {
    hits.add(m[1]);
  }
  // 2) Tilde-expanded paths.
  for (const m of text.matchAll(
    /(?:^|[\s(`'"])(~\/[A-Za-z0-9_./-]+\.(?:mjs|tsx|json|plist|toml|ts|js))/g,
  )) {
    hits.add(m[1]);
  }
  // 3) LaunchAgents plists referenced by bare basename pattern.
  for (const m of text.matchAll(/(?:Library\/LaunchAgents\/)([A-Za-z0-9._-]+\.plist)/g)) {
    hits.add(`~/Library/LaunchAgents/${m[1]}`);
  }
  // 4) Common label-style plist mentions (com.openclaw.foo) → resolve to LaunchAgents.
  for (const m of text.matchAll(
    /\b(com\.[a-z0-9.-]+(?:\.chuck-[a-z0-9-]+|\.openclaw[a-z0-9.-]*))\b/g,
  )) {
    if (
      text.toLowerCase().includes("launchd") ||
      text.toLowerCase().includes("plist") ||
      text.toLowerCase().includes("launchagent")
    ) {
      hits.add(`~/Library/LaunchAgents/${m[1]}.plist`);
    }
  }
  // 5) Repo-relative scripts under extensions/.
  for (const m of text.matchAll(/(extensions\/[A-Za-z0-9_./-]+\.(?:mjs|tsx|json|ts|js))/g)) {
    hits.add(m[1]);
  }
  // 6) "Build at <path>" / "Build <path>" / "Output to <path>" patterns —
  // catch any *.{mjs,js,ts,plist,json,toml} adjacent to those verbs.
  for (const m of text.matchAll(
    /(?:Build(?:\s+at)?|Output(?:s)?(?:\s+to)?|Write(?:\s+to)?|Create)\s+([^\s,;]+\.(?:mjs|tsx|json|plist|toml|ts|js))/gi,
  )) {
    hits.add(m[1]);
  }

  // Resolve and dedupe.
  const resolved = new Set();
  for (const raw of hits) resolved.add(resolveCandidatePath(raw));
  return [...resolved];
}

function syntaxCheck(path) {
  if (/\.(mjs|js|ts|tsx)$/i.test(path)) {
    // ts/tsx → run node --check; will fail on TS-only syntax. We treat that as
    // a syntactic check the caller can interpret. For .ts/.tsx, fall back to
    // existence-only because node --check rejects type annotations.
    if (/\.(ts|tsx)$/i.test(path)) {
      // No reliable stdlib TypeScript check. Existence + non-empty already
      // verified upstream; accept silently here.
      return { ok: true, kind: "ts-existence-only" };
    }
    const r = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", timeout: 15_000 });
    if (r.status === 0) return { ok: true, kind: "node-check" };
    return { ok: false, kind: "node-check", stderr: (r.stderr || r.stdout || "").trim() };
  }
  if (/\.plist$/i.test(path)) {
    const r = spawnSync("plutil", ["-lint", path], { encoding: "utf8", timeout: 10_000 });
    if (r.status === 0) return { ok: true, kind: "plutil-lint" };
    return { ok: false, kind: "plutil-lint", stderr: (r.stderr || r.stdout || "").trim() };
  }
  if (/\.json$/i.test(path)) {
    try {
      JSON.parse(readFileSync(path, "utf8"));
      return { ok: true, kind: "json-parse" };
    } catch (e) {
      return { ok: false, kind: "json-parse", stderr: e?.message ?? String(e) };
    }
  }
  return { ok: true, kind: "unchecked-extension" };
}

// ─── Per-commandKind validators ─────────────────────────────────────────

function validateBuildTask(task) {
  const intent = task?.intent ?? "";
  const startedAtMs = parseStartedAtMs(task);

  // Prefer explicit task.deliverable.{path|paths} when present — scanners
  // (e.g. chuck-self-improvement-scanner mcpgap tasks) set this so the
  // validator doesn't have to guess from intent text. Mixed legacy + explicit
  // is supported: explicit wins, but if both are absent we fall back to
  // intent-text inference for backwards compat.
  let candidates;
  let candidateSource;
  const explicit = task?.deliverable;
  if (explicit && typeof explicit === "object") {
    const explicitPaths = Array.isArray(explicit.paths)
      ? explicit.paths
      : typeof explicit.path === "string"
        ? [explicit.path]
        : [];
    if (explicitPaths.length > 0) {
      const dedup = new Set();
      for (const raw of explicitPaths) {
        if (typeof raw !== "string" || !raw.trim()) continue;
        dedup.add(resolveCandidatePath(raw));
      }
      candidates = [...dedup];
      candidateSource = "explicit";
    }
  }
  if (!candidates) {
    candidates = inferDeliverablePaths(intent);
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
  const checked = [];
  for (const p of candidates) {
    if (!existsSync(p)) {
      return {
        valid: false,
        reason: `intent referenced path '${p}' but it does not exist on disk after task completion`,
        category: "missing-deliverable",
        evidence: { candidates, missing: p, checked },
      };
    }
    let st;
    try {
      st = statSync(p);
    } catch (e) {
      return {
        valid: false,
        reason: `deliverable '${p}' stat failed: ${e?.message ?? e}`,
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
}

// ─── LLM-introspection layer (build-class deep check) ───────────────────
//
// Heuristics (size > 0, parses, fresh mtime) catch the morning-digest case
// (script never written), but they miss cases where the deliverable EXISTS
// and PARSES but doesn't actually do what the intent specified — e.g. the
// intent was "build a script that exports add(a,b)" and the file just contains
// `console.log("hello")`. This layer reads the intent + reads the deliverable
// content and asks claude-cli "did this satisfy the intent?".
//
// Defaults to trust-heuristic on any LLM uncertainty (low confidence, parse
// errors, timeouts, missing claude binary, budget exhausted) — never false-
// fail real work because the LLM was confused.
//
// Toggles:
//   CHUCK_VALIDATOR_SKIP_LLM=1  → skip LLM layer entirely (unit-test fast path)
// Anti-recursion:
//   intent or deliverable mentioning chuck-task-validator → skip LLM layer
// Anti-flood:
//   ~/.openclaw/workspace/state/chuck-v3/validator/llm-call-budget.json caps
//   LLM-validation calls at LLM_DAILY_CAP/24h. Beyond cap → skip LLM layer.

// PATH augment so claude resolves under launchd's minimal env. Mirrors the
// pattern from chuck-docket-executor.buildExecutorEnv.
function buildValidatorEnv() {
  const home = process.env.HOME ?? HOME;
  const existingPath = (process.env.PATH ?? "").split(":").filter(Boolean);
  const augments = [
    `${home}/.openclaw/bin`,
    `${home}/.nvm/versions/node/v24.14.1/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const seen = new Set(existingPath);
  for (const p of augments) {
    if (!seen.has(p)) {
      existingPath.push(p);
      seen.add(p);
    }
  }
  return { ...process.env, HOME: home, PATH: existingPath.join(":") };
}

function ensureValidatorStateDir() {
  try {
    mkdirSync(VALIDATOR_STATE_DIR, { recursive: true });
  } catch {
    /* best-effort */
  }
}

function readLlmBudget() {
  try {
    const raw = JSON.parse(readFileSync(LLM_BUDGET_PATH, "utf8"));
    if (Array.isArray(raw?.calls)) return raw;
    return { calls: [] };
  } catch {
    return { calls: [] };
  }
}

function pruneAndCountBudget(budget) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = (budget.calls || []).filter((ts) => Number.isFinite(ts) && ts >= cutoff);
  return { calls: recent, count: recent.length };
}

function recordLlmCall() {
  ensureValidatorStateDir();
  const budget = readLlmBudget();
  const pruned = pruneAndCountBudget(budget);
  pruned.calls.push(Date.now());
  try {
    writeFileSync(
      LLM_BUDGET_PATH,
      JSON.stringify({ calls: pruned.calls, lastUpdated: new Date().toISOString() }, null, 2),
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

function isAntiRecursion(task, deliverablePaths) {
  const intent = String(task?.intent ?? "").toLowerCase();
  if (intent.includes("chuck-task-validator")) return true;
  for (const p of deliverablePaths) {
    if (p === VALIDATOR_SCRIPT_PATH) return true;
    if (p.toLowerCase().endsWith("chuck-task-validator.mjs")) return true;
  }
  return false;
}

function readDeliverableForPrompt(path) {
  try {
    const st = statSync(path);
    const sizeBytes = st.size;
    let body;
    if (sizeBytes <= LLM_PROMPT_FILE_CAP) {
      body = readFileSync(path, "utf8");
    } else {
      // Read just the first cap bytes; mark truncation.
      let fd = null;
      try {
        fd = openSync(path, "r");
        const buf = Buffer.alloc(LLM_PROMPT_FILE_CAP);
        readSync(fd, buf, 0, LLM_PROMPT_FILE_CAP, 0);
        body =
          buf.toString("utf8") +
          `\n\n[...TRUNCATED, original ${sizeBytes} bytes, showing first ${LLM_PROMPT_FILE_CAP}]`;
      } catch {
        // Fall back to readFileSync + slice.
        body =
          readFileSync(path, "utf8").slice(0, LLM_PROMPT_FILE_CAP) +
          `\n\n[...TRUNCATED, original ${sizeBytes} bytes, showing first ${LLM_PROMPT_FILE_CAP}]`;
      } finally {
        if (fd != null) {
          try {
            closeSync(fd);
          } catch {
            /* best-effort */
          }
        }
      }
    }
    return { ok: true, sizeBytes, body };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function buildLlmPrompt(intent, files) {
  const fileBlocks = files
    .map((f) => {
      if (!f.read.ok) return `--- ${f.path} (read failed: ${f.read.error}) ---\n[unreadable]`;
      return `--- ${f.path} (${f.read.sizeBytes} bytes) ---\n${f.read.body}`;
    })
    .join("\n\n");
  return `You're verifying that a build task's deliverable actually satisfies the intent. Be terse and skeptical — score the match honestly, flag genuine misalignments. Don't false-positive on minor stylistic issues; only flag if the deliverable materially fails the intent.

TASK INTENT:
${intent}

DELIVERABLE FILES:
${fileBlocks}

Respond with ONLY this JSON (no prose, no code fence):
{ "satisfies_intent": true | false, "confidence": 0.0..1.0, "reason": "<1-2 sentences>", "gaps": ["<gap1>", ...] }`;
}

function parseLlmJson(stdout) {
  if (typeof stdout !== "string") return null;
  let s = stdout.trim();
  // Strip code fences if present.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  // Find first { and last } and try to parse the slice.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = s.slice(first, last + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}

function dispatchClaudeCli(prompt) {
  // Same dispatch shape used by chuck-docket-executor for claude-cli-build.
  const env = buildValidatorEnv();
  const r = spawnSync(
    "claude",
    ["-p", "--model", "opus", "--permission-mode", "bypassPermissions", prompt],
    { encoding: "utf8", timeout: LLM_TIMEOUT_MS, env, maxBuffer: 8 * 1024 * 1024 },
  );
  return r;
}

export async function validateBuildDeliverableViaLLM(task, heuristicResult) {
  // Toggle: skip LLM entirely.
  if (process.env.CHUCK_VALIDATOR_SKIP_LLM === "1") {
    return {
      valid: heuristicResult.valid,
      llm: { skipped: true, reason: "CHUCK_VALIDATOR_SKIP_LLM=1" },
    };
  }
  // Pre-conditions: only run when heuristic passed AND we have build kind AND we inferred deliverables.
  const kind = task?.commandKind ?? task?.command?.commandKind ?? "";
  if (!(kind === "claude-cli-build" || kind === "codex-build")) {
    return {
      valid: heuristicResult.valid,
      llm: { skipped: true, reason: `commandKind '${kind}' is not a build lane` },
    };
  }
  if (!heuristicResult?.valid) {
    return { valid: false, llm: { skipped: true, reason: "heuristic already failed" } };
  }
  const checked = Array.isArray(heuristicResult?.evidence?.checked)
    ? heuristicResult.evidence.checked
    : [];
  const deliverablePaths = checked
    .map((c) => c.path)
    .filter((p) => typeof p === "string" && p.length > 0);
  if (deliverablePaths.length === 0) {
    return {
      valid: heuristicResult.valid,
      llm: { skipped: true, reason: "no inferred deliverable paths to inspect" },
    };
  }
  // Anti-recursion: never ask claude to validate the validator.
  if (isAntiRecursion(task, deliverablePaths)) {
    return {
      valid: heuristicResult.valid,
      llm: {
        skipped: true,
        reason: "anti-recursion guard (intent/path references chuck-task-validator)",
      },
    };
  }
  // Anti-flood: budget cap on rolling 24h LLM-validation calls.
  ensureValidatorStateDir();
  const budget = readLlmBudget();
  const pruned = pruneAndCountBudget(budget);
  if (pruned.count >= LLM_DAILY_CAP) {
    return {
      valid: heuristicResult.valid,
      llm: {
        skipped: true,
        reason: `daily LLM-validation cap hit (${pruned.count}/${LLM_DAILY_CAP} in last 24h)`,
      },
    };
  }
  // Read each deliverable (capped at LLM_PROMPT_FILE_CAP bytes).
  const files = deliverablePaths.map((p) => ({ path: p, read: readDeliverableForPrompt(p) }));
  const intent = String(task?.intent ?? "").trim();
  if (intent.length === 0) {
    return {
      valid: heuristicResult.valid,
      llm: { skipped: true, reason: "intent is empty; nothing to verify against" },
    };
  }
  const prompt = buildLlmPrompt(intent, files);

  // Record call BEFORE dispatch so the budget reflects intent even on timeout/crash.
  recordLlmCall();
  const r = dispatchClaudeCli(prompt);

  // Treat any spawn failure as uncertainty → trust heuristic.
  if (r.error) {
    return {
      valid: heuristicResult.valid,
      llm: {
        skipped: false,
        dispatched: true,
        parseOk: false,
        reason: `claude-cli spawn error: ${r.error?.message ?? r.error}`,
      },
    };
  }
  if (r.signal === "SIGTERM") {
    return {
      valid: heuristicResult.valid,
      llm: {
        skipped: false,
        dispatched: true,
        parseOk: false,
        reason: `claude-cli timed out after ${LLM_TIMEOUT_MS}ms`,
      },
    };
  }
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  if (r.status !== 0) {
    return {
      valid: heuristicResult.valid,
      llm: {
        skipped: false,
        dispatched: true,
        parseOk: false,
        reason: `claude-cli exit ${r.status}: ${(stderr || stdout).slice(0, 200)}`,
      },
    };
  }
  const parsed = parseLlmJson(stdout);
  if (
    !parsed ||
    typeof parsed.satisfies_intent !== "boolean" ||
    typeof parsed.confidence !== "number"
  ) {
    return {
      valid: heuristicResult.valid,
      llm: {
        skipped: false,
        dispatched: true,
        parseOk: false,
        reason: "claude reply did not contain valid {satisfies_intent, confidence, reason} JSON",
        rawTail: stdout.slice(-400),
      },
    };
  }
  const confidence = Math.max(0, Math.min(1, parsed.confidence));
  const llmEvidence = {
    skipped: false,
    dispatched: true,
    parseOk: true,
    satisfiesIntent: parsed.satisfies_intent,
    confidence,
    reason: typeof parsed.reason === "string" ? parsed.reason : "(no reason)",
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
    inspectedFiles: deliverablePaths,
  };
  // Confidence floor: below floor → trust heuristic.
  if (confidence < LLM_CONFIDENCE_FLOOR) {
    return {
      valid: heuristicResult.valid,
      llm: {
        ...llmEvidence,
        decisionNote: `confidence ${confidence} < floor ${LLM_CONFIDENCE_FLOOR}; trusting heuristic`,
      },
    };
  }
  // High-confidence pass.
  if (parsed.satisfies_intent === true) {
    return {
      valid: true,
      llm: { ...llmEvidence, decisionNote: "LLM confirms deliverable satisfies intent" },
    };
  }
  // High-confidence fail → flip to invalid.
  return {
    valid: false,
    reason: `LLM intent-mismatch (confidence ${confidence}): ${llmEvidence.reason}`,
    category: "llm-intent-mismatch",
    evidence: {
      gaps: llmEvidence.gaps,
      confidence,
      inspectedFiles: deliverablePaths,
      llmReason: llmEvidence.reason,
    },
    llm: { ...llmEvidence, decisionNote: "LLM flagged deliverable as not satisfying intent" },
  };
}

function validateMacSelfHeal(task) {
  const startedAtMs = parseStartedAtMs(task);
  if (!existsSync(MAC_HEAL_LATEST)) {
    return {
      valid: false,
      reason: `mac-self-heal latest.json missing at ${MAC_HEAL_LATEST}`,
      category: "missing-state",
      evidence: { latestPath: MAC_HEAL_LATEST },
    };
  }
  const latestStat = statSync(MAC_HEAL_LATEST);
  if (startedAtMs && latestStat.mtimeMs < startedAtMs) {
    // Check receipts dir for a fresh receipt instead of fail-fast on latest.json.
    if (existsSync(MAC_HEAL_RECEIPTS)) {
      const receipts = readdirSync(MAC_HEAL_RECEIPTS).filter((f) => f.endsWith(".json"));
      const fresh = receipts.find((f) => {
        try {
          return statSync(join(MAC_HEAL_RECEIPTS, f)).mtimeMs >= startedAtMs;
        } catch {
          return false;
        }
      });
      if (fresh) {
        return {
          valid: true,
          reason: `mac-self-heal receipt '${fresh}' written during task window`,
          category: "fresh-receipt",
          evidence: { receipt: fresh },
        };
      }
    }
    return {
      valid: false,
      reason: `no fresh mac-self-heal receipt written during task window (latest.json mtime ${new Date(latestStat.mtimeMs).toISOString()} < startedAt ${new Date(startedAtMs).toISOString()})`,
      category: "stale-state",
      evidence: { latestMtimeMs: latestStat.mtimeMs, startedAtMs },
    };
  }
  return {
    valid: true,
    reason: "mac-self-heal latest.json updated during task window",
    category: "fresh-state",
    evidence: { latestMtimeMs: latestStat.mtimeMs },
  };
}

function validateLiveScout(task) {
  if (!existsSync(SCOUTS_DIR)) {
    return {
      valid: true,
      reason: "scout receipt directory not found; trusting exit code",
      category: "no-receipt-dir",
      evidence: { scoutsDir: SCOUTS_DIR },
    };
  }
  const startedAtMs = parseStartedAtMs(task);
  const receipts = readdirSync(SCOUTS_DIR).filter((f) => f.endsWith(".json"));
  if (receipts.length === 0) {
    return {
      valid: false,
      reason: "scouts dir exists but has zero receipts after task completion",
      category: "empty-receipts",
      evidence: { scoutsDir: SCOUTS_DIR },
    };
  }
  const fresh = receipts.find((f) => {
    try {
      return statSync(join(SCOUTS_DIR, f)).mtimeMs >= (startedAtMs ?? 0);
    } catch {
      return false;
    }
  });
  if (!fresh) {
    return {
      valid: false,
      reason: "no scout receipt written during task window",
      category: "stale-receipts",
      evidence: { scoutsDir: SCOUTS_DIR, startedAtMs },
    };
  }
  return {
    valid: true,
    reason: `fresh scout receipt '${fresh}' present`,
    category: "fresh-receipt",
    evidence: { receipt: fresh },
  };
}

function validatePriorCapsule(task) {
  if (!existsSync(PRIORS_LATEST)) {
    return {
      valid: false,
      reason: `prior capsule latest.json missing at ${PRIORS_LATEST}`,
      category: "missing-state",
      evidence: { path: PRIORS_LATEST },
    };
  }
  const startedAtMs = parseStartedAtMs(task);
  const st = statSync(PRIORS_LATEST);
  if (startedAtMs && st.mtimeMs < startedAtMs) {
    return {
      valid: false,
      reason: `prior capsule latest.json mtime ${new Date(st.mtimeMs).toISOString()} predates task startedAt ${new Date(startedAtMs).toISOString()}`,
      category: "stale-state",
      evidence: { mtimeMs: st.mtimeMs, startedAtMs },
    };
  }
  return {
    valid: true,
    reason: "prior capsule latest.json updated during task window",
    category: "fresh-state",
    evidence: { mtimeMs: st.mtimeMs },
  };
}

function validateMcpRegistration(task) {
  const intent = task?.intent ?? "";
  const m = intent.match(
    /(?:register|wire)\s+(?:MCP\s+)?["']?([\w][\w-]+)["']?\s+(?:in|across|to)/i,
  );
  if (!m) {
    return {
      valid: true,
      reason: "no MCP name inferred from intent; trusting exit code",
      category: "no-name-inferred",
      evidence: {},
    };
  }
  const name = m[1];
  let codexHas = false,
    openclawHas = false,
    claudeHas = false;
  try {
    codexHas = readFileSync(CODEX_CONFIG, "utf8").includes(`[mcp_servers.${name}]`);
  } catch {
    /* missing config */
  }
  try {
    const oc = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf8"));
    openclawHas = !!(oc?.mcp?.servers?.[name] || oc?.mcpServers?.[name]);
  } catch {
    /* missing config */
  }
  try {
    const cc = JSON.parse(readFileSync(CLAUDE_CONFIG, "utf8"));
    claudeHas = !!cc?.mcpServers?.[name];
  } catch {
    /* missing config */
  }
  const count = (codexHas ? 1 : 0) + (openclawHas ? 1 : 0) + (claudeHas ? 1 : 0);
  if (count === 3) {
    return {
      valid: true,
      reason: `MCP '${name}' registered in 3/3 configs`,
      category: "fully-registered",
      evidence: { name, codex: codexHas, openclaw: openclawHas, claude: claudeHas },
    };
  }
  return {
    valid: false,
    reason: `MCP '${name}' registered in ${count}/3 configs (codex:${codexHas} openclaw:${openclawHas} claude:${claudeHas})`,
    category: "partial-registration",
    evidence: { name, codex: codexHas, openclaw: openclawHas, claude: claudeHas },
  };
}

// ─── Dispatcher ─────────────────────────────────────────────────────────

const VALIDATORS = {
  "claude-cli-build": validateBuildTask,
  "codex-build": validateBuildTask,
  "mac-self-heal": validateMacSelfHeal,
  "live-scout": validateLiveScout,
  "prior-capsule": validatePriorCapsule,
  "mcp-registration": validateMcpRegistration,
};

export async function validateTaskDeliverable(task) {
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
  let heuristic;
  try {
    heuristic = await fn(task);
  } catch (e) {
    return {
      valid: true,
      reason: `validator error: ${e?.message ?? e}; trusting exit code`,
      category: "validator-error",
      evidence: { commandKind: kind, error: e?.message ?? String(e) },
    };
  }
  // For build-class kinds: layer LLM-introspection on top of the heuristic.
  // The LLM call only matters when heuristic.valid === true and the LLM is
  // high-confidence that the deliverable does NOT satisfy intent. Any
  // uncertainty defaults to trusting the heuristic. If heuristic already
  // failed, leave its verdict unchanged.
  if (kind === "claude-cli-build" || kind === "codex-build") {
    if (heuristic.valid !== true) {
      // Already failed at heuristic layer — preserve original category/reason.
      return { ...heuristic, llm: { skipped: true, reason: "heuristic already failed" } };
    }
    try {
      const llm = await validateBuildDeliverableViaLLM(task, heuristic);
      if (llm && llm.valid === false) {
        // LLM flipped a heuristic-pass to a fail. Surface its reason.
        return {
          valid: false,
          reason: llm.reason ?? heuristic.reason,
          category: llm.category ?? "llm-intent-mismatch",
          evidence: { ...(heuristic.evidence ?? {}), ...(llm.evidence ?? {}) },
          llm: llm.llm,
          heuristic: { reason: heuristic.reason, category: heuristic.category },
        };
      }
      // Heuristic verdict stands; attach LLM evidence for transparency.
      return { ...heuristic, llm: llm?.llm };
    } catch (e) {
      // LLM layer failure is never fatal — trust heuristic.
      return {
        ...heuristic,
        llm: { skipped: true, reason: `llm layer threw: ${e?.message ?? e}` },
      };
    }
  }
  return heuristic;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

async function cliValidateOne(path) {
  if (!existsSync(path)) {
    process.stderr.write(`task file not found: ${path}\n`);
    process.exit(2);
  }
  let task;
  try {
    task = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    process.stderr.write(`task file parse failed: ${e?.message ?? e}\n`);
    process.exit(2);
  }
  const result = await validateTaskDeliverable(task);
  process.stdout.write(
    JSON.stringify(
      { taskId: task.id ?? null, commandKind: task.commandKind ?? null, ...result },
      null,
      2,
    ) + "\n",
  );
  process.exit(result.valid ? 0 : 1);
}

async function cliSweep() {
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  if (!existsSync(DOCKET_DIR)) {
    process.stderr.write(`docket dir not found: ${DOCKET_DIR}\n`);
    process.exit(2);
  }
  const files = readdirSync(DOCKET_DIR).filter((f) => f.endsWith(".json"));
  const summary = {
    total: 0,
    valid: 0,
    failedValidation: 0,
    skipped: 0,
    byCategory: {},
    llm: { dispatched: 0, pass: 0, flippedToFail: 0, skippedByGuard: 0, parseErrors: 0 },
    failures: [],
  };
  for (const f of files) {
    const path = join(DOCKET_DIR, f);
    let task;
    try {
      task = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (task?.status !== "completed") continue;
    const finishedAtMs = Date.parse(task?.finishedAt ?? task?.updatedAt ?? "");
    if (Number.isFinite(finishedAtMs) && finishedAtMs < cutoffMs) {
      summary.skipped++;
      continue;
    }
    summary.total++;
    const r = await validateTaskDeliverable(task);
    summary.byCategory[r.category] = (summary.byCategory[r.category] || 0) + 1;
    if (r.valid) summary.valid++;
    else {
      summary.failedValidation++;
      summary.failures.push({
        taskId: task.id ?? null,
        commandKind: task.commandKind ?? null,
        category: r.category,
        reason: r.reason,
      });
    }
    // Roll up LLM-layer telemetry (only present for build-class tasks).
    if (r.llm) {
      if (r.llm.skipped) summary.llm.skippedByGuard++;
      else {
        summary.llm.dispatched++;
        if (r.llm.parseOk === false) summary.llm.parseErrors++;
        else if (r.category === "llm-intent-mismatch") summary.llm.flippedToFail++;
        else if (r.llm.satisfiesIntent === true) summary.llm.pass++;
      }
    }
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "validate") {
    const path = process.argv[3];
    if (!path) {
      process.stderr.write("usage: chuck-task-validator.mjs validate <task-json-path>\n");
      process.exit(2);
    }
    await cliValidateOne(path);
    return;
  }
  if (cmd === "sweep") {
    await cliSweep();
    return;
  }
  process.stderr.write("usage: chuck-task-validator.mjs {validate <path> | sweep}\n");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`[chuck-task-validator] fatal: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
