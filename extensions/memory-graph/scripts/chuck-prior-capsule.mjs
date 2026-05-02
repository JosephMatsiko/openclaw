#!/usr/bin/env node
// =============================================================================
// PARTIAL SALVAGE — Unit 15 of the openclaw-first migration (2026-05-01).
// =============================================================================
// The TYPED WRAPPER lives at:
//   extensions/skill-prior-capsule/src/* (re-exported via
//   @openclaw/skill-prior-capsule api.ts)
//
// This .mjs is the CANONICAL implementation: 1253 LOC of source readers +
// summarizers + renderer + ID generation. v0.1 of the plugin wraps it as a
// subprocess so callers (skill-prior-compaction's approve action,
// skill-docket-executor's prior-refresh hook, the chuck-docket-executor.mjs
// daemon) get a type-safe in-process call site without giving up the
// battle-tested .mjs.
//
// Three subsystems subprocess-spawn this script today:
//   1. chuck-docket-executor.mjs (Unit 6c daemon, line 205)
//   2. extensions/skill-docket-executor/src/commands.ts (line 105)
//   3. extensions/skill-prior-compaction/src/capsule.ts
//      (defaultRefreshPriorCapsule)
//
// EDITS: bug fixes go in BOTH places ONCE the source readers / summarizers /
// renderer are ported into TypeScript. While the plugin remains a thin
// wrapper, this .mjs IS the source of truth — no port duplication risk to
// drift here yet.
//
// FULL TS source-port queued for the openclaw cron / daemon-plugin phase.
// At that point, port the source readers (workingMemory, healthSnapshot,
// modelDoctor, docket, runs, runner executions, posterior deltas, read
// markers, dissent, compactions, fleet health, apex-events, chuck-v2 events,
// design doctrine), the summarizer family, derive helpers
// (deriveOpenQuestions / deriveRecommendedNextActions /
// deriveEvidencePointers), prior hygiene filters
// (filterPriorOpenQuestions / filterPriorRecommendedNextActions), and
// the markdown renderer into ./src/* — then retire the .mjs.
//
// WIRE FORMAT (must stay byte-stable for downstream readers):
//   - Receipt: {priorId, sourceHash, createdAt, path, markdownPath, latestPath}
//   - Capsule: schemaVersion="chuck.prior-capsule.v1", priorId pattern
//     `prior-<compact-iso-ts>-<sha256[:12]>`, sourceHash determinism
//     `sha256(stableStringify(capsuleBase))`
// =============================================================================
//
// Chuck Prior Capsule generator.
//
// This writes the shared, compact, evidence-bearing world-state that every
// family should read before divergent work. It is intentionally a source reader
// and renderer, not a model merger.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_NAME = basename(SCRIPT_PATH);
const HOME = homedir();
const STATE = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V2 = join(STATE, "chuck-v2");
const CHUCK_V3 = join(STATE, "chuck-v3");
const DOCKET_DIR = join(CHUCK_V3, "docket");
const PRIORS_DIR = join(CHUCK_V3, "priors");
const DELTAS_DIR = join(CHUCK_V3, "posterior-deltas");
const READ_MARKERS_DIR = join(CHUCK_V3, "read-markers");
const DISSENT_DIR = join(CHUCK_V3, "dissent");
const COMPACTIONS_DIR = join(CHUCK_V3, "compactions");
const WORKING_MEM = join(STATE, "chuck-working-memory.json");
const HEALTH_SNAPSHOT = join(CHUCK_V3, "health-snapshot.json");
const MODEL_DOCTOR_DIR = join(CHUCK_V2, "model-doctor");
const FLEET_HEALTH = join(CHUCK_V2, "apex-fleet-health.jsonl");
const APEX_EVENTS = join(STATE, "apex-events.jsonl");
const CHUCK_V2_EVENTS = join(CHUCK_V2, "events.jsonl");
const RUNS_DIR = join(CHUCK_V2, "runs");
const RUNNER_EXECUTIONS_DIR = join(CHUCK_V2, "runner-executions");
const DESIGN_DOC = join(
  dirname(SCRIPT_PATH),
  "..",
  "data",
  "chuck-v2-design",
  "09-UNIVERSAL-PRIOR-PERICHORESIS.md",
);

const VERSION = "1";
const DEFAULT_LIMIT = 10;
const EVENT_TAIL_LIMIT = 40;

function parseArgs(argv) {
  const options = {
    write: false,
    markdown: false,
    json: false,
    fullJson: false,
    sourceTask: null,
    limit: DEFAULT_LIMIT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") {
      options.write = true;
    } else if (arg === "--markdown") {
      options.markdown = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--full-json") {
      options.fullJson = true;
      options.json = true;
    } else if (arg === "--source-task") {
      options.sourceTask = argv[++i] ?? null;
    } else if (arg === "--limit") {
      options.limit = parsePositiveInt(argv[++i], "--limit");
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.log(`Usage:
  node extensions/memory-graph/scripts/chuck-prior-capsule.mjs [--write] [--markdown]

Options:
  --write               Write prior-*.json and latest.json under chuck-v3/priors.
  --markdown            With --write, also write a compact prior-*.md rendering.
  --json                Print a receipt when writing, otherwise print the capsule.
  --full-json           Print the full capsule even when writing.
  --source-task <path>  Include the docket task that triggered this refresh.
  --limit <n>           Latest docket/run/ledger item count. Default: 10.`);
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { capsule, receipt } = buildPriorCapsule(options);
  let writeReceipt = receipt;
  if (options.write) {
    writeReceipt = writeCapsule(capsule, options);
  }

  if (options.json) {
    const payload = options.fullJson || !options.write ? capsule : writeReceipt;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (options.write) {
    process.stdout.write(
      `wrote ${writeReceipt.priorId} -> ${displayPath(writeReceipt.path)} (${writeReceipt.sourceHash})\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify(capsule, null, 2)}\n`);
  }
}

function buildPriorCapsule(options) {
  const sources = [];
  const now = new Date().toISOString();

  const workingMemory = readJsonSource(WORKING_MEM, "working-memory", sources);
  const healthSnapshot = readJsonSource(HEALTH_SNAPSHOT, "health-snapshot", sources);
  const modelDoctorFile = latestJsonFiles(MODEL_DOCTOR_DIR, 1)[0] ?? null;
  const modelDoctor = readJsonSource(modelDoctorFile?.path, "model-doctor.latest", sources);
  const sourceTask = readJsonSource(options.sourceTask, "source-task", sources);
  const compactionFiles = compactionDecisionFiles();
  const compactionDecisions = compactionFiles
    .map((file, index) =>
      readCompactionDecisionSource(file.path, `compaction.applied.${index}`, sources),
    )
    .filter(Boolean);
  const latestCompactionFile = compactionFiles.at(-1) ?? null;
  const latestCompactionDecision = compactionDecisions.at(-1) ?? null;
  readTextSource(DESIGN_DOC, "doctrine.universal-prior-perichoresis", sources);

  const docketFiles = latestJsonFiles(DOCKET_DIR, options.limit);
  const docket = docketFiles.map((file, index) =>
    summarizeDocketTask(readJsonSource(file.path, `docket.${index}`, sources), file),
  );
  const activeTasks = docket.filter(
    (task) => !["completed", "done", "closed"].includes(task.status),
  );

  const latestRuns = latestJsonFiles(RUNS_DIR, options.limit).map((file, index) =>
    summarizeRun(readJsonSource(file.path, `run.${index}`, sources), file),
  );
  const latestRunnerExecutions = latestJsonFiles(RUNNER_EXECUTIONS_DIR, 5).map((file, index) =>
    summarizeRunnerExecution(readJsonSource(file.path, `runner-execution.${index}`, sources), file),
  );
  const recentPosteriorDeltas = latestLedgerObjects(DELTAS_DIR, options.limit).map(
    ({ data, file }) => summarizePosteriorDelta(data, file),
  );
  const recentReadMarkers = latestLedgerObjects(READ_MARKERS_DIR, options.limit).map(
    ({ data, file }) => summarizeReadMarker(data, file),
  );
  const ledgerState = summarizeLedgerState();
  const compactionState = summarizeCompactionDecision(
    latestCompactionDecision,
    latestCompactionFile,
  );
  const compactionCursor = summarizeCompactionCursor(latestCompactionDecision);
  const compactedClaims = summarizeCompactedClaims(compactionDecisions);

  const fleetHealthTail = tailJsonLinesSource(FLEET_HEALTH, "fleet-health.tail", 5, sources);
  const apexEventTail = tailJsonLinesSource(
    APEX_EVENTS,
    "apex-events.tail",
    EVENT_TAIL_LIMIT,
    sources,
  );
  const chuckEventTail = tailJsonLinesSource(
    CHUCK_V2_EVENTS,
    "chuck-v2-events.tail",
    EVENT_TAIL_LIMIT,
    sources,
  );
  const priorHygieneContext = { ledgerState, compactionState };
  const openQuestions = filterPriorOpenQuestions(
    uniqueStrings([
      ...compactedOpenQuestions(compactionDecisions),
      ...deriveOpenQuestions(docket, latestRuns, sourceTask, ledgerState),
    ]),
    priorHygieneContext,
  );
  const recommendedNextActions = filterPriorRecommendedNextActions(
    uniqueStrings([
      ...compactedRecommendedNextActions(compactionDecisions),
      ...deriveRecommendedNextActions(docket, latestRuns, ledgerState, compactionState),
    ]),
    priorHygieneContext,
  );

  const capsuleBase = {
    schemaVersion: "chuck.prior-capsule.v1",
    priorId: "prior-pending-000000000000",
    createdAt: now,
    sourceHash: "sha256:pending",
    generatedBy: {
      script: `extensions/memory-graph/scripts/${SCRIPT_NAME}`,
      version: VERSION,
      node: process.version,
    },
    doctrine: {
      name: "Universal Prior And Perichoresis",
      claim:
        "Chuck's moat is shared evidence-bearing world-state: shared prior, family-specific posteriors, returned typed deltas.",
      loop: [
        "source readers",
        "universal prior capsule",
        "family-specific work",
        "posterior delta",
        "validation and dissent extraction",
        "append-only shared ledger",
        "read markers for the next family",
      ],
    },
    authorityModel: {
      mergeMode: "append-only-deltas-before-compaction",
      compactionGate:
        "No posterior delta may silently rewrite the prior body; promotion requires an explicit compaction decision with provenance.",
      dissentPolicy:
        "Dissent is a permanent sidecar until validated, overruled by evidence, operator-resolved, or deliberately deferred.",
      promotionRules: [
        "Facts require evidence references before promotion.",
        "Conflicts branch into dissent records instead of overwriting claims.",
        "Medium/high-risk mutations require Joseph approval before executor pickup.",
        "A family may propose prior changes but cannot grant itself command authority by being last to speak.",
      ],
    },
    operatorIntent: summarizeWorkingMemory(workingMemory),
    systemState: {
      modelReadiness: summarizeModelDoctor(modelDoctor),
      healthSnapshot: summarizeHealthSnapshot(healthSnapshot),
      executor: summarizeExecutor(),
      fleetRecency: summarizeFleetRecency(fleetHealthTail),
    },
    activeTasks,
    recentDocket: docket,
    recentRuns: latestRuns,
    recentRunnerExecutions: latestRunnerExecutions,
    recentPosteriorDeltas,
    recentReadMarkers,
    recentEvents: summarizeEvents(apexEventTail, chuckEventTail),
    ledgerState,
    compactionState,
    compactionCursor,
    compactedClaims,
    knownDisagreements: latestLedgerObjects(DISSENT_DIR, options.limit).map(({ data, file }) =>
      summarizeLedgerObject(data, file),
    ),
    openQuestions,
    recommendedNextActions,
    hardConstraints: [
      "Executor concurrency is one in-flight task at a time.",
      "Executor only auto-picks low-risk allowlisted commandKind tasks.",
      "Universal prior generation reads source files and writes artifacts; it does not ask a model to merge truth.",
      "Prior body mutation is gated; deltas are append-only until an explicit compaction pass.",
      "Dissent must remain queryable outside prose summaries.",
      "Credentials and pairing approvals stay operator-controlled.",
      "Clean ledger discipline is mandatory: every family handoff distinguishes pre-existing local state, current-turn writes, verification receipts, and unresolved risk.",
    ],
    approvalGates: [
      {
        gate: "risk",
        rule: "medium/high-risk docket work requires explicit Joseph approval before executor pickup",
      },
      {
        gate: "authority",
        rule: "changes to permissions, credentials, launchd agents, or policy require explicit approval records",
      },
      {
        gate: "prior-compaction",
        rule: "promoting posterior deltas into the compact prior body requires a separate compaction decision",
      },
    ],
    resourceBudget: {
      executorConcurrency: 1,
      executorTimeoutMs: 300000,
      executorLoopIntervalMs: 60000,
      defaultDocketRiskAllowed: ["low"],
      eventTailLimit: EVENT_TAIL_LIMIT,
      itemLimit: options.limit,
    },
    evidencePointers: deriveEvidencePointers({
      sources,
      sourceTask,
      latestRuns,
      latestRunnerExecutions,
      docket,
    }),
    sources,
  };

  const sourceHash = `sha256:${sha256(stableStringify(capsuleBase))}`;
  const priorId = `prior-${compactTimestamp(now)}-${sourceHash.slice("sha256:".length, "sha256:".length + 12)}`;
  const capsule = {
    ...capsuleBase,
    priorId,
    sourceHash,
    compactionState: finalizeCompactionState(capsuleBase.compactionState, priorId),
    compactionCursor: finalizeCompactionCursor(capsuleBase.compactionCursor, priorId),
  };

  return {
    capsule,
    receipt: {
      priorId,
      sourceHash,
      createdAt: now,
      path: null,
      markdownPath: null,
      latestPath: null,
    },
  };
}

function writeCapsule(capsule, options) {
  mkdirSync(PRIORS_DIR, { recursive: true });
  mkdirSync(DELTAS_DIR, { recursive: true });
  mkdirSync(READ_MARKERS_DIR, { recursive: true });
  mkdirSync(DISSENT_DIR, { recursive: true });
  mkdirSync(COMPACTIONS_DIR, { recursive: true });

  const path = join(PRIORS_DIR, `${capsule.priorId}.json`);
  writeJsonAtomic(path, capsule);
  const latestPath = join(PRIORS_DIR, "latest.json");
  writeJsonAtomic(latestPath, capsule);

  let markdownPath = null;
  if (options.markdown) {
    markdownPath = join(PRIORS_DIR, `${capsule.priorId}.md`);
    writeTextAtomic(markdownPath, renderMarkdown(capsule));
    writeTextAtomic(join(PRIORS_DIR, "latest.md"), renderMarkdown(capsule));
  }

  return {
    priorId: capsule.priorId,
    sourceHash: capsule.sourceHash,
    createdAt: capsule.createdAt,
    path,
    markdownPath,
    latestPath,
  };
}

function readJsonSource(path, label, sources) {
  if (!path) {
    sources.push({
      label,
      path: null,
      ok: false,
      mtime: null,
      sha256: null,
      bytes: null,
      reason: "missing path",
    });
    return null;
  }
  try {
    const text = readFileSync(path, "utf8");
    const stat = statSync(path);
    sources.push({
      label,
      path,
      ok: true,
      mtime: stat.mtime.toISOString(),
      sha256: `sha256:${sha256(text)}`,
      bytes: Buffer.byteLength(text),
    });
    return JSON.parse(text);
  } catch (err) {
    sources.push({
      label,
      path,
      ok: false,
      mtime: null,
      sha256: null,
      bytes: null,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function readCompactionDecisionSource(path, label, sources) {
  if (!path) {
    sources.push({
      label,
      path: null,
      ok: false,
      mtime: null,
      sha256: null,
      bytes: null,
      reason: "missing path",
    });
    return null;
  }
  try {
    const text = readFileSync(path, "utf8");
    const decision = JSON.parse(text);
    const stableDecision = {
      ...decision,
      resultingPriorId: null,
      result: null,
    };
    const stableText = stableStringify(stableDecision);
    const stat = statSync(path);
    sources.push({
      label,
      path,
      ok: true,
      mtime: stat.mtime.toISOString(),
      sha256: `sha256:${sha256(stableText)}`,
      bytes: Buffer.byteLength(stableText),
      projection: "compaction-decision-without-result-receipt",
    });
    return decision;
  } catch (err) {
    sources.push({
      label,
      path,
      ok: false,
      mtime: null,
      sha256: null,
      bytes: null,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function readTextSource(path, label, sources) {
  if (!path) {
    sources.push({
      label,
      path: null,
      ok: false,
      mtime: null,
      sha256: null,
      bytes: null,
      reason: "missing path",
    });
    return "";
  }
  try {
    const text = readFileSync(path, "utf8");
    const stat = statSync(path);
    sources.push({
      label,
      path,
      ok: true,
      mtime: stat.mtime.toISOString(),
      sha256: `sha256:${sha256(text)}`,
      bytes: Buffer.byteLength(text),
    });
    return text;
  } catch (err) {
    sources.push({
      label,
      path,
      ok: false,
      mtime: null,
      sha256: null,
      bytes: null,
      reason: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

function tailJsonLinesSource(path, label, limit, sources) {
  const text = readTextSource(path, label, sources);
  if (!text) {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { malformed: true, raw: line.slice(0, 240) };
      }
    });
}

function latestJsonFiles(dir, limit) {
  if (!dir || !existsSync(dir)) {
    return [];
  }
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const path = join(dir, name);
        try {
          const stat = statSync(path);
          if (!stat.isFile()) {
            return null;
          }
          return {
            name,
            path,
            mtimeMs: stat.mtimeMs,
            mtime: stat.mtime.toISOString(),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function compactionDecisionFiles() {
  const candidates = latestJsonFiles(COMPACTIONS_DIR, 80)
    .map((file) => {
      try {
        return { file, data: JSON.parse(readFileSync(file.path, "utf8")) };
      } catch {
        return null;
      }
    })
    .filter(
      (entry) =>
        entry?.data?.schemaVersion === "chuck.prior-compaction-decision.v1" &&
        ["approved", "applied"].includes(entry.data.status),
    )
    .toSorted((a, b) => {
      const aTime =
        Date.parse(a.data.appliedAt ?? a.data.approvedAt ?? a.data.createdAt ?? "") || 0;
      const bTime =
        Date.parse(b.data.appliedAt ?? b.data.approvedAt ?? b.data.createdAt ?? "") || 0;
      return aTime - bTime || a.file.path.localeCompare(b.file.path);
    });
  return candidates.map((entry) => entry.file);
}

function summarizeCompactionDecision(decision, file) {
  if (!decision) {
    return {
      present: false,
      status: "none",
      decisionId: null,
      sourcePriorId: null,
      resultingPriorId: null,
      includedDeltaCount: 0,
      eligibleDeltaCount: 0,
      deferredDeltaCount: 0,
      promotedClaimCount: 0,
      deferredClaimCount: 0,
      openQuestionCount: 0,
      recommendedNextActionCount: 0,
      dissentRefCount: 0,
      path: null,
    };
  }
  return {
    present: true,
    status: decision.status ?? "unknown",
    decisionId: decision.decisionId ?? null,
    sourcePriorId: decision.sourcePriorId ?? null,
    resultingPriorId: decision.resultingPriorId ?? null,
    createdAt: decision.createdAt ?? file?.mtime ?? null,
    approvedAt: decision.approvedAt ?? null,
    appliedAt: decision.appliedAt ?? null,
    includedDeltaCount: Array.isArray(decision.includedDeltaIds)
      ? decision.includedDeltaIds.length
      : 0,
    eligibleDeltaCount: Array.isArray(decision.eligibleDeltaIds)
      ? decision.eligibleDeltaIds.length
      : 0,
    deferredDeltaCount: Array.isArray(decision.deferredDeltaIds)
      ? decision.deferredDeltaIds.length
      : 0,
    promotedClaimCount: Array.isArray(decision.promotedClaims) ? decision.promotedClaims.length : 0,
    deferredClaimCount: Array.isArray(decision.deferredClaims) ? decision.deferredClaims.length : 0,
    openQuestionCount: Array.isArray(decision.openQuestions) ? decision.openQuestions.length : 0,
    recommendedNextActionCount: Array.isArray(decision.recommendedNextActions)
      ? decision.recommendedNextActions.length
      : 0,
    dissentRefCount: Array.isArray(decision.dissentRefs) ? decision.dissentRefs.length : 0,
    path: file?.path ?? null,
    note:
      decision.status === "approved"
        ? "approved compaction is being applied into this prior capsule"
        : "latest applied compaction is included in this prior capsule",
  };
}

function summarizeCompactionCursor(decision) {
  if (!decision) {
    return {
      decisionId: null,
      status: "none",
      sourcePriorId: null,
      resultingPriorId: null,
      includedDeltaIds: [],
    };
  }
  return {
    decisionId: decision.decisionId ?? null,
    status: decision.status ?? "unknown",
    sourcePriorId: decision.sourcePriorId ?? null,
    resultingPriorId: decision.resultingPriorId ?? null,
    approvedAt: decision.approvedAt ?? null,
    appliedAt: decision.appliedAt ?? null,
    includedDeltaIds: Array.isArray(decision.includedDeltaIds) ? decision.includedDeltaIds : [],
  };
}

function finalizeCompactionState(state, priorId) {
  if (!state?.present) {
    return state;
  }
  return {
    ...state,
    resultingPriorId: state.resultingPriorId ?? priorId,
    includedInPriorId: priorId,
  };
}

function finalizeCompactionCursor(cursor, priorId) {
  if (!cursor?.decisionId) {
    return cursor;
  }
  return {
    ...cursor,
    resultingPriorId: cursor.resultingPriorId ?? priorId,
    includedInPriorId: priorId,
  };
}

function summarizeCompactedClaims(decisions) {
  const list = Array.isArray(decisions) ? decisions : decisions ? [decisions] : [];
  if (!list.length) {
    return [];
  }
  const byKey = new Map();
  for (const decision of list) {
    for (const claim of Array.isArray(decision?.promotedClaims) ? decision.promotedClaims : []) {
      const key = claim.claimKey ?? `claim-${sha256(normalizeText(claim.text ?? "")).slice(0, 12)}`;
      const existing = byKey.get(key);
      byKey.set(key, {
        claimKey: key,
        text: claim.text ?? existing?.text ?? "",
        confidence: strongerConfidence(existing?.confidence, claim.confidence),
        authorityImpact: strongerAuthorityImpact(existing?.authorityImpact, claim.authorityImpact),
        families: union(existing?.families, claim.families),
        surfaces: union(existing?.surfaces, claim.surfaces),
        sourceDeltaIds: union(existing?.sourceDeltaIds, claim.sourceDeltaIds),
        sourceClaimIds: union(existing?.sourceClaimIds, claim.sourceClaimIds),
        evidenceRefs: union(existing?.evidenceRefs, claim.evidenceRefs),
      });
    }
  }
  return [...byKey.values()].slice(0, 120);
}

function compactedOpenQuestions(decisions) {
  const list = Array.isArray(decisions) ? decisions : decisions ? [decisions] : [];
  return list.flatMap((decision) =>
    Array.isArray(decision?.openQuestions) ? decision.openQuestions : [],
  );
}

function compactedRecommendedNextActions(decisions) {
  const list = Array.isArray(decisions) ? decisions : decisions ? [decisions] : [];
  return list.flatMap((decision) =>
    Array.isArray(decision?.recommendedNextActions) ? decision.recommendedNextActions : [],
  );
}

function union(left, right) {
  const out = [];
  for (const value of [
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : []),
  ]) {
    if (value != null && !out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function strongerConfidence(left = "low", right = "low") {
  const order = { low: 1, medium: 2, high: 3 };
  return (order[right] ?? 0) >= (order[left] ?? 0)
    ? (right ?? left ?? "low")
    : (left ?? right ?? "low");
}

function strongerAuthorityImpact(left = "none", right = "none") {
  const order = { none: 1, proposal: 2, "approval-required": 3, blocked: 4 };
  return (order[right] ?? 0) >= (order[left] ?? 0)
    ? (right ?? left ?? "none")
    : (left ?? right ?? "none");
}

function summarizeWorkingMemory(wm) {
  const recentActions = Array.isArray(wm?.recentActions)
    ? [...wm.recentActions]
        .toSorted((a, b) => (Date.parse(b?.ts) || 0) - (Date.parse(a?.ts) || 0))
        .slice(0, 8)
        .map((action) => ({
          ts: action.ts ?? null,
          surface: action.surface ?? action.source ?? null,
          summary: action.summary ?? action.detail ?? action.action ?? "",
        }))
    : [];
  const openLoops = Array.isArray(wm?.openLoops)
    ? wm.openLoops.slice(0, 12).map((loop) => ({
        id: loop.id ?? loop.taskId ?? null,
        summary: loop.summary ?? loop.description ?? String(loop),
        status: loop.status ?? null,
      }))
    : [];
  return {
    focus: wm?.session?.currentFocus ?? null,
    lastTurn: wm?.session?.lastTurn
      ? {
          ts: wm.session.lastTurn.ts ?? null,
          surface: wm.session.lastTurn.surface ?? null,
        }
      : null,
    openLoopCount: Array.isArray(wm?.openLoops) ? wm.openLoops.length : 0,
    openLoops,
    recentActions,
  };
}

function summarizeModelDoctor(modelDoctor) {
  const rows = Array.isArray(modelDoctor?.rows) ? modelDoctor.rows : [];
  return {
    present: Boolean(modelDoctor),
    generatedAt: modelDoctor?.generatedAt ?? null,
    configuredVoices: modelDoctor?.configuredVoices ?? null,
    configuredFamilies: Array.isArray(modelDoctor?.configuredFamilies)
      ? modelDoctor.configuredFamilies
      : [],
    readyFamilies: Array.isArray(modelDoctor?.readyFamilies) ? modelDoctor.readyFamilies : [],
    blockedFamilies: Array.isArray(modelDoctor?.blockedFamilies) ? modelDoctor.blockedFamilies : [],
    executionReadyFamilies: Array.isArray(modelDoctor?.executionReadyFamilies)
      ? modelDoctor.executionReadyFamilies
      : [],
    canRunMinimumFleet: modelDoctor?.canRunMinimumFleet ?? null,
    canRunHighRiskFleet: modelDoctor?.canRunHighRiskFleet ?? null,
    canRunLoadBearingMinimumFleet: modelDoctor?.canRunLoadBearingMinimumFleet ?? null,
    canRunLoadBearingHighRiskFleet: modelDoctor?.canRunLoadBearingHighRiskFleet ?? null,
    byStatus: countBy(rows, (row) => row.status ?? "unknown"),
    degradedSurfaces: rows
      .filter((row) => /degrad|provisional|unknown/i.test(String(row?.status ?? "")))
      .map((row) => row.surface ?? row.voice ?? row.family)
      .filter(Boolean)
      .slice(0, 12),
    blockedSurfaces: rows
      .filter((row) =>
        /block|quarantine/i.test(`${row?.status ?? ""} ${row?.executionStatus ?? ""}`),
      )
      .map((row) => row.surface ?? row.voice ?? row.family)
      .filter(Boolean)
      .slice(0, 12),
  };
}

function summarizeHealthSnapshot(snapshot) {
  if (!snapshot) {
    return { present: false };
  }
  const voices = Array.isArray(snapshot.voices) ? snapshot.voices : [];
  return {
    present: true,
    generatedAt: snapshot.generatedAt ?? null,
    summary: snapshot.summary ?? null,
    byStatus: snapshot.summary?.byStatus ?? countBy(voices, (voice) => voice.status ?? "unknown"),
    blockers: voices
      .filter((voice) => Array.isArray(voice.blockers) && voice.blockers.length)
      .map((voice) => ({
        voice: voice.voice ?? voice.worker ?? null,
        family: voice.family ?? null,
        blockers: voice.blockers.slice(0, 4),
      }))
      .slice(0, 12),
    errors: Array.isArray(snapshot.errors) ? snapshot.errors.slice(0, 8) : [],
  };
}

function summarizeExecutor() {
  const service = "com.openclaw.chuck-docket-executor";
  try {
    const output = execFileSync("launchctl", ["print", `gui/${process.getuid()}/${service}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return {
      service,
      present: true,
      state: firstMatch(output, /^\s*state = (.+)$/m),
      pid: numberOrNull(firstMatch(output, /^\s*pid = ([0-9]+)$/m)),
      runs: numberOrNull(firstMatch(output, /^\s*runs = ([0-9]+)$/m)),
    };
  } catch {
    return {
      service,
      present: false,
      state: "unknown",
      pid: null,
      runs: null,
    };
  }
}

function summarizeDocketTask(task, file) {
  const heartbeats = Array.isArray(task?.heartbeats) ? task.heartbeats : [];
  const lastHeartbeat = heartbeats.at(-1) ?? null;
  return {
    taskId: task?.id ?? task?.taskId ?? file?.name?.replace(/\.json$/, "") ?? null,
    title: task?.title ?? task?.summary ?? null,
    status: String(task?.status ?? "unknown").toLowerCase(),
    risk: task?.risk ?? null,
    commandKind: task?.commandKind ?? null,
    surface: task?.surface ?? null,
    updatedAt: task?.updatedAt ?? task?.finishedAt ?? task?.startedAt ?? file?.mtime ?? null,
    startedAt: task?.startedAt ?? null,
    finishedAt: task?.finishedAt ?? null,
    exitCode: task?.exitCode ?? null,
    timedOut: task?.timedOut ?? null,
    lastHeartbeat: lastHeartbeat
      ? {
          at: lastHeartbeat.at ?? null,
          phase: lastHeartbeat.phase ?? null,
          message: lastHeartbeat.message ?? null,
        }
      : null,
    priorCapsule: task?.priorCapsule ?? null,
    expectedDelta: task?.expectedDelta ?? null,
    file: file?.path ?? null,
  };
}

function summarizeRun(run, file) {
  return {
    runId: run?.runId ?? file?.name?.replace(/\.json$/, "") ?? null,
    createdAt: run?.createdAt ?? file?.mtime ?? null,
    mode: run?.mode ?? null,
    disposition: run?.disposition ?? run?.traceRecord?.finalDisposition ?? null,
    finalAction: run?.finalAction ?? null,
    operatorActionRequired: run?.operatorActionRequired ?? null,
    requestText: truncate(run?.requestText, 280),
    usableFamilies:
      run?.events?.find?.((event) => event.type === "fleet.scout.resolve")?.payload
        ?.usableFamilies ??
      run?.traceRecord?.scoutFamilies ??
      [],
    failures: run?.traceRecord?.failures ?? [],
    docketId: run?.docketItem?.docketId ?? null,
    file: file?.path ?? null,
  };
}

function summarizeRunnerExecution(execution, file) {
  const executions = Array.isArray(execution?.executions) ? execution.executions : [];
  return {
    dispatchId: execution?.dispatchId ?? null,
    runId: execution?.runId ?? null,
    file: file?.path ?? null,
    statuses: executions.map((item) => ({
      family: item.family ?? null,
      surface: item.surface ?? null,
      status: item.status ?? null,
      countingEligible: item.countingEligible ?? null,
      reason: item.reason ?? null,
      textPreview: truncate(item.text, 180),
    })),
  };
}

function summarizeFleetRecency(events) {
  const clean = events.filter((event) => !event.malformed);
  const latest = clean.at(-1) ?? null;
  return {
    latestAt: latest?.ts ?? latest?.occurredAt ?? null,
    latestType: latest?.type ?? null,
    latestMcp: latest?.mcp ?? latest?.server ?? null,
    recent: clean.slice(-5).map((event) => ({
      ts: event.ts ?? event.occurredAt ?? null,
      type: event.type ?? null,
      mcp: event.mcp ?? event.server ?? null,
      ok: typeof event.ok === "boolean" ? event.ok : null,
      toolCount: event.tool_count ?? event.toolCount ?? null,
    })),
  };
}

function summarizeEvents(apexEvents, chuckEvents) {
  const normalized = [
    ...apexEvents.map((event) => summarizeEvent(event, "apex-events")),
    ...chuckEvents.map((event) => summarizeEvent(event, "chuck-v2-events")),
  ].filter(Boolean);
  return normalized
    .toSorted((a, b) => (Date.parse(b.occurredAt) || 0) - (Date.parse(a.occurredAt) || 0))
    .slice(0, EVENT_TAIL_LIMIT);
}

function summarizeEvent(event, source) {
  if (!event || event.malformed) {
    return null;
  }
  return {
    source,
    eventId: event.eventId ?? event.id ?? null,
    type: event.type ?? null,
    occurredAt: event.occurredAt ?? event.ts ?? null,
    actor: event.actor ?? null,
    eventSource: event.source ?? null,
    runId: event.runId ?? event.payload?.runId ?? null,
    taskId: event.payload?.taskId ?? null,
    surface: event.payload?.surface ?? null,
    family: event.payload?.family ?? null,
    summary: event.payload?.title ?? event.payload?.stage ?? event.payload?.summary ?? null,
  };
}

function summarizeLedgerState() {
  const priors = latestJsonFiles(PRIORS_DIR, 1);
  const deltas = latestJsonFiles(DELTAS_DIR, 1);
  const markers = latestJsonFiles(READ_MARKERS_DIR, 1);
  const dissents = latestJsonFiles(DISSENT_DIR, 1);
  return {
    priorCount: countJsonFiles(PRIORS_DIR),
    posteriorDeltaCount: countJsonFiles(DELTAS_DIR),
    readMarkerCount: countJsonFiles(READ_MARKERS_DIR),
    dissentCount: countJsonFiles(DISSENT_DIR),
    latestPrior: priors[0]?.path ?? null,
    latestPosteriorDelta: deltas[0]?.path ?? null,
    latestReadMarker: markers[0]?.path ?? null,
    latestDissent: dissents[0]?.path ?? null,
  };
}

function latestLedgerObjects(dir, limit) {
  return latestJsonFiles(dir, limit).map((file) => {
    try {
      return { file, data: JSON.parse(readFileSync(file.path, "utf8")) };
    } catch {
      return { file, data: null };
    }
  });
}

function summarizeLedgerObject(data, file) {
  if (!data) {
    return { file: file.path, ok: false };
  }
  return {
    file: file.path,
    ok: true,
    id:
      data.dissentId ??
      data.deltaId ??
      data.markerId ??
      data.priorId ??
      file.name.replace(/\.json$/, ""),
    status: data.status ?? data.result ?? null,
    createdAt: data.createdAt ?? data.seenAt ?? file.mtime ?? null,
    summary: truncate(data.reason ?? data.notes ?? data.claim ?? data.title, 240),
  };
}

function summarizePosteriorDelta(data, file) {
  if (!data) {
    return { file: file.path, ok: false };
  }
  return {
    file: file.path,
    ok: true,
    deltaId: data.deltaId ?? file.name.replace(/\.json$/, ""),
    priorId: data.priorId ?? null,
    taskId: data.taskId ?? null,
    createdAt: data.createdAt ?? file.mtime ?? null,
    producer: data.producer ?? null,
    confidence: data.confidence ?? null,
    authorityImpact: data.authorityImpact ?? null,
    claimCount: Array.isArray(data.claims) ? data.claims.length : 0,
    openQuestionCount: Array.isArray(data.openQuestions) ? data.openQuestions.length : 0,
    recommendedNextActionCount: Array.isArray(data.recommendedNextActions)
      ? data.recommendedNextActions.length
      : 0,
    claimPreview: Array.isArray(data.claims)
      ? data.claims.slice(0, 2).map((claim) => claim.text)
      : [],
  };
}

function summarizeReadMarker(data, file) {
  if (!data) {
    return { file: file.path, ok: false };
  }
  return {
    file: file.path,
    ok: true,
    markerId: data.markerId ?? file.name.replace(/\.json$/, ""),
    priorId: data.priorId ?? null,
    seenAt: data.seenAt ?? file.mtime ?? null,
    reader: data.reader ?? null,
    result: data.result ?? null,
    scope: data.scope ?? null,
    deltaIds: Array.isArray(data.deltaIds) ? data.deltaIds.slice(0, 6) : [],
  };
}

function deriveOpenQuestions(docket, runs, sourceTask, ledgerState) {
  const questions = new Set();
  if (docket.some((task) => task.title?.includes("Universal Prior"))) {
    questions.add("What compaction gate promotes append-only deltas into the compact prior body?");
    questions.add(
      "How should concurrent family reads be versioned so stale read markers are visible?",
    );
  }
  if ((ledgerState?.posteriorDeltaCount ?? 0) === 0) {
    questions.add(
      "What exact Delta Contract v1 fields are mandatory before prior mutation is allowed?",
    );
  }
  if (runs.some((run) => Array.isArray(run.failures) && run.failures.length)) {
    questions.add(
      "Which scout failures are capacity/auth/tooling failures versus doctrine disagreement?",
    );
  }
  if (sourceTask?.commandKind === "live-scout" && (ledgerState?.posteriorDeltaCount ?? 0) === 0) {
    questions.add(
      "Which non-counting scout outputs should be converted into posterior delta candidates?",
    );
  }
  return [...questions];
}

function deriveRecommendedNextActions(docket, runs, ledgerState, compactionState = null) {
  const actions = new Set();
  if (compactionState?.present) {
    actions.add(
      "Maintain the compaction cursor and review newly appended posterior deltas through the gated compaction lane.",
    );
  } else {
    actions.add("Keep prior refresh append-only until a separate compaction decision exists.");
  }
  if ((ledgerState?.posteriorDeltaCount ?? 0) === 0) {
    actions.add("Implement Delta Contract v1 as the only admissible posterior-delta shape.");
  } else if (!compactionState?.present) {
    actions.add(
      "Build the explicit prior compaction gate for promoting deltas into the compact prior body.",
    );
    actions.add("Expose prior, posterior deltas, read markers, and open dissent in the dashboard.");
  } else {
    actions.add("Keep the cockpit compaction gate current as new posterior deltas arrive.");
  }
  if ((ledgerState?.readMarkerCount ?? 0) === 0) {
    actions.add("Add read markers when a family consumes a prior or delta.");
  } else {
    actions.add(
      "Expand read marker coverage to every family runner, not only executor-launched live scouts.",
    );
  }
  if (
    docket.some((task) => task.commandKind === "live-scout" && task.status === "completed") &&
    (ledgerState?.posteriorDeltaCount ?? 0) === 0
  ) {
    actions.add(
      "Convert the universal-prior fleet scout into family-attributed posterior delta candidates.",
    );
  }
  if (runs.some((run) => run.disposition === "deepen")) {
    actions.add(
      "Run a bounded deepen pass after Delta Contract v1 exists so critique lands in schema, not prose.",
    );
  }
  return [...actions];
}

function deriveEvidencePointers({
  sources,
  sourceTask,
  latestRuns,
  latestRunnerExecutions,
  docket,
}) {
  const pointers = sources
    .filter((source) => source.ok && source.path)
    .map((source) => ({
      kind: "file",
      label: source.label,
      ref: source.path,
      sha256: source.sha256,
    }));
  if (sourceTask?.id || sourceTask?.taskId) {
    pointers.push({
      kind: "docket-task",
      label: "source-task",
      ref: sourceTask.id ?? sourceTask.taskId,
      path: sourceTask.file ?? null,
    });
  }
  for (const run of latestRuns.slice(0, 3)) {
    if (run.file) {
      pointers.push({ kind: "run", label: run.runId, ref: run.file });
    }
  }
  for (const execution of latestRunnerExecutions.slice(0, 2)) {
    if (execution.file) {
      pointers.push({ kind: "runner-execution", label: execution.dispatchId, ref: execution.file });
    }
  }
  for (const task of docket.slice(0, 3)) {
    if (task.file) {
      pointers.push({ kind: "docket-task", label: task.taskId, ref: task.file });
    }
  }
  return pointers.slice(0, 80);
}

function countJsonFiles(dir) {
  if (!existsSync(dir)) {
    return 0;
  }
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json") && name !== "latest.json")
      .length;
  } catch {
    return 0;
  }
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? "").trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  return out;
}

function filterPriorOpenQuestions(values, { ledgerState, compactionState } = {}) {
  return (Array.isArray(values) ? values : []).filter(
    (value) => !isResolvedPriorQuestion(value, { ledgerState, compactionState }),
  );
}

function filterPriorRecommendedNextActions(values, { ledgerState, compactionState } = {}) {
  return (Array.isArray(values) ? values : []).filter(
    (value) => !isStalePriorAction(value, { ledgerState, compactionState }),
  );
}

function isResolvedPriorQuestion(value, { ledgerState, compactionState } = {}) {
  const text = normalizeText(value);
  const hasCompaction = compactionState?.present === true;
  const hasDeltas = Number(ledgerState?.posteriorDeltaCount ?? 0) > 0;
  const hasReadMarkers = Number(ledgerState?.readMarkerCount ?? 0) > 0;
  if (isOperationalNoise(value)) {
    return true;
  }
  if (
    hasCompaction &&
    /(compaction gate|compaction policy|promot.*compact prior|append-only deltas)/.test(text)
  ) {
    return true;
  }
  if (
    hasCompaction &&
    /(deterministic merge rules|returned deltas survive|full loop|delta.*prior update)/.test(text)
  ) {
    return true;
  }
  if (
    hasDeltas &&
    /(posterior delta|delta contract|delta schema|type definitions|typed delta|full round-trip|schema definition|example delta)/.test(
      text,
    )
  ) {
    return true;
  }
  if (
    hasReadMarkers &&
    /(read[- ]?marker|versioned read|family consumption|same prior capsule|cross-family evidence|concurrent family reads)/.test(
      text,
    )
  ) {
    return true;
  }
  return /(prior.*differs.*shared prior|clarification.*prior.*differs|explicit mapping of how this proposal|prior compilation algorithm|degree of agreement.*cannot be verified)/.test(
    text,
  );
}

function isStalePriorAction(value, { ledgerState, compactionState } = {}) {
  const text = normalizeText(value);
  const hasCompaction = compactionState?.present === true;
  const hasDeltas = Number(ledgerState?.posteriorDeltaCount ?? 0) > 0;
  if (isOperationalNoise(value)) {
    return true;
  }
  if (
    hasDeltas &&
    /(define and enforce.*delta contract|strict.*delta contract|delta contract v1)/.test(text)
  ) {
    return true;
  }
  if (
    hasCompaction &&
    /(build the explicit prior compaction gate|expose compacted claims|unapplied delta count)/.test(
      text,
    )
  ) {
    return true;
  }
  return /prompt does not provide the current universal prior/.test(text);
}

function isOperationalNoise(value) {
  const text = normalizeText(value);
  return /(this model is overloaded|spawn .* enoent|enoent$)/.test(text);
}

function firstMatch(text, pattern) {
  const match = text.match(pattern);
  return match?.[1] ?? null;
}

function numberOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function compactTimestamp(iso) {
  return iso.replace(/[-:.]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function truncate(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 3)}...`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function writeJsonAtomic(path, value) {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function renderMarkdown(capsule) {
  const lines = [];
  lines.push(`# Chuck Prior Capsule ${capsule.priorId}`);
  lines.push("");
  lines.push(`- created: ${capsule.createdAt}`);
  lines.push(`- hash: ${capsule.sourceHash}`);
  lines.push(`- focus: ${capsule.operatorIntent.focus ?? "(unset)"}`);
  lines.push(
    `- models ready: ${capsule.systemState.modelReadiness.readyFamilies.length}/${capsule.systemState.modelReadiness.configuredFamilies.length}`,
  );
  lines.push(
    `- executor: ${capsule.systemState.executor.state ?? "unknown"} pid=${capsule.systemState.executor.pid ?? "?"}`,
  );
  lines.push(`- active tasks: ${capsule.activeTasks.length}`);
  lines.push(`- recent deltas: ${capsule.recentPosteriorDeltas.length}`);
  lines.push(`- recent read markers: ${capsule.recentReadMarkers.length}`);
  lines.push(
    `- prior/delta/read/dissent counts: ${capsule.ledgerState.priorCount}/${capsule.ledgerState.posteriorDeltaCount}/${capsule.ledgerState.readMarkerCount}/${capsule.ledgerState.dissentCount}`,
  );
  lines.push("");
  lines.push("## Current Tasks");
  if (capsule.recentDocket.length === 0) {
    lines.push("- none");
  } else {
    for (const task of capsule.recentDocket.slice(0, 8)) {
      lines.push(`- ${task.taskId} [${task.status}] ${task.title ?? ""}`);
    }
  }
  lines.push("");
  lines.push("## Open Questions");
  if (!capsule.openQuestions.length) {
    lines.push("- none");
  } else {
    for (const question of capsule.openQuestions) {
      lines.push(`- ${question}`);
    }
  }
  lines.push("");
  lines.push("## Next Actions");
  for (const action of capsule.recommendedNextActions) {
    lines.push(`- ${action}`);
  }
  lines.push("");
  lines.push("## Evidence");
  for (const source of capsule.sources.filter((item) => item.ok).slice(0, 20)) {
    lines.push(`- ${source.label}: ${displayPath(source.path)} ${source.sha256}`);
  }
  return `${lines.join("\n")}\n`;
}

function displayPath(path) {
  return path ? path.replace(HOME, "~") : null;
}

process.on("SIGINT", () => {
  process.exit(130);
});

try {
  main();
} catch (err) {
  process.stderr.write(
    `[chuck-prior-capsule] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
