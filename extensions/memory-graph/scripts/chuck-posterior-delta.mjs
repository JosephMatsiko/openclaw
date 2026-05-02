#!/usr/bin/env node
// =============================================================================
// TRANSITIONAL DUPLICATE — Unit 13 of the openclaw-first migration (2026-05-01).
// =============================================================================
// The CANONICAL implementation lives at:
//   extensions/skill-posterior-delta/src/* (re-exported via
//   @openclaw/skill-posterior-delta api.ts)
//
// This .mjs is kept alive ONLY because chuck-docket-executor.mjs (Unit 6c)
// subprocess-spawns it after each runner execution:
//   node chuck-posterior-delta.mjs from-runner-execution
//     --runner-execution <path> --task <path> --prior latest --write --json
//
// Vanilla Node ESM cannot import .ts at runtime, so the executor's spawn path
// keeps a duplicate of the bundle/parse/build/validate/write logic until either
// the executor migrates to importing the plugin's runFromExecution() directly,
// or openclaw cron supports long-running plugin daemons.
//
// EDITS: bug fixes go in BOTH places (here AND
// extensions/skill-posterior-delta/src/*.ts). Wire format (delta + read-marker
// JSON, deltaId/markerId pattern, schema versions) MUST stay byte-identical.
// =============================================================================
//
// Chuck Posterior Delta writer.
//
// Converts persisted family runner receipts into schema-validated,
// append-only posterior deltas. This is deliberately mechanical: it preserves
// family attribution and evidence pointers instead of asking a model to merge
// the answers into the shared prior.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020");

const HOME = homedir();
const STATE = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V2 = join(STATE, "chuck-v2");
const CHUCK_V3 = join(STATE, "chuck-v3");
const DELTAS_DIR = join(CHUCK_V3, "posterior-deltas");
const READ_MARKERS_DIR = join(CHUCK_V3, "read-markers");
const PRIORS_DIR = join(CHUCK_V3, "priors");
const LATEST_PRIOR = join(PRIORS_DIR, "latest.json");
const RUNS_DIR = join(CHUCK_V2, "runs");
const DESIGN_DIR = join(process.cwd(), "extensions", "memory-graph", "data", "chuck-v2-design");
const POSTERIOR_SCHEMA = join(DESIGN_DIR, "posterior-delta.schema.json");
const DISSENT_SCHEMA = join(DESIGN_DIR, "dissent-record.schema.json");
const READ_MARKER_SCHEMA = join(DESIGN_DIR, "read-marker.schema.json");

function parseArgs(argv) {
  const options = {
    command: null,
    executionPath: null,
    runPath: null,
    taskPath: null,
    priorPath: "latest",
    write: false,
    json: false,
    includeNonCounting: true,
    writeReadMarkers: true,
  };
  if (argv[0] && !argv[0].startsWith("-")) {
    options.command = argv.shift();
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--runner-execution") {
      options.executionPath = expandPath(argv[++i]);
    } else if (arg === "--run") {
      options.runPath = expandPath(argv[++i]);
    } else if (arg === "--task") {
      options.taskPath = expandPath(argv[++i]);
    } else if (arg === "--prior") {
      options.priorPath = argv[++i] ?? "latest";
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--counting-only") {
      options.includeNonCounting = false;
    } else if (arg === "--no-read-markers") {
      options.writeReadMarkers = false;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.command !== "from-runner-execution") {
    printUsage();
    process.exit(2);
  }
  if (!options.executionPath) {
    throw new Error("--runner-execution is required");
  }
  options.priorPath = resolvePriorPath(options.priorPath);
  return options;
}

function printUsage() {
  console.log(`Usage:
  node extensions/memory-graph/scripts/chuck-posterior-delta.mjs from-runner-execution \\
    --runner-execution <path> [--run <path>] [--task <path>] [--prior latest] [--write]

Options:
  --write              Persist deltas under chuck-v3/posterior-deltas.
  --json               Print machine-readable receipt.
  --counting-only      Skip non-counting/degraded surfaces.
  --no-read-markers    Do not write read markers even when a prior was injected.`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const validator = createValidators();
  const execution = readJson(options.executionPath);
  const run = options.runPath ? readJson(options.runPath) : readRunForExecution(execution);
  const task = options.taskPath && existsSync(options.taskPath) ? readJson(options.taskPath) : null;
  const prior =
    options.priorPath && existsSync(options.priorPath) ? readJson(options.priorPath) : null;
  const deltas = [];
  const readMarkers = [];

  for (const item of Array.isArray(execution.executions) ? execution.executions : []) {
    if (!options.includeNonCounting && item.countingEligible !== true) {
      continue;
    }
    const delta = buildDelta({
      execution,
      run,
      task,
      prior,
      item,
      executionPath: options.executionPath,
    });
    validateOrThrow(
      validator.validateDelta,
      delta,
      `posterior delta for ${item.surface ?? "unknown"}`,
    );
    deltas.push(delta);
    const marker = buildReadMarker({ task, prior, item, delta });
    if (marker) {
      validateOrThrow(
        validator.validateReadMarker,
        marker,
        `read marker for ${item.surface ?? "unknown"}`,
      );
      readMarkers.push(marker);
    }
  }

  const writtenDeltas = options.write ? deltas.map((delta) => writeDelta(delta)) : [];
  const writtenReadMarkers =
    options.write && options.writeReadMarkers
      ? readMarkers.map((marker) => writeReadMarker(marker))
      : [];

  const receipt = {
    ok: true,
    executionPath: options.executionPath,
    runId: execution.runId ?? run?.runId ?? null,
    priorId: prior?.priorId ?? task?.priorCapsuleBefore?.priorId ?? "prior-unknown",
    deltaCount: deltas.length,
    readMarkerCount: options.writeReadMarkers ? readMarkers.length : 0,
    deltas: deltas.map((delta, index) => ({
      deltaId: delta.deltaId,
      path: writtenDeltas[index]?.path ?? null,
      family: delta.producer.family,
      surface: delta.producer.surface,
      confidence: delta.confidence,
      authorityImpact: delta.authorityImpact,
      claimCount: delta.claims.length,
      openQuestionCount: delta.openQuestions.length,
      recommendedNextActionCount: delta.recommendedNextActions.length,
    })),
    readMarkers: readMarkers.map((marker, index) => ({
      markerId: marker.markerId,
      path: writtenReadMarkers[index]?.path ?? null,
      family: marker.reader.family,
      surface: marker.reader.surface,
      result: marker.result,
    })),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    process.stdout.write(
      `wrote ${writtenDeltas.length} posterior delta(s), ${writtenReadMarkers.length} read marker(s)\n`,
    );
  }
}

function createValidators() {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const dissentSchema = readJson(DISSENT_SCHEMA);
  const deltaSchema = readJson(POSTERIOR_SCHEMA);
  const readMarkerSchema = readJson(READ_MARKER_SCHEMA);
  ajv.addSchema(dissentSchema, "dissent-record.schema.json");
  return {
    validateDelta: ajv.compile(deltaSchema),
    validateReadMarker: ajv.compile(readMarkerSchema),
  };
}

function buildDelta({ execution, run, task, prior, item, executionPath }) {
  const receipt = item.receipt ?? {};
  const createdAt =
    receipt.endedAt ?? receipt.startedAt ?? run?.createdAt ?? new Date().toISOString();
  const priorId = task?.priorCapsuleBefore?.priorId ?? prior?.priorId ?? "prior-unknown";
  const text = String(item.text ?? item.reason ?? "");
  const sections = parseScoutSections(text);
  const producer = {
    family: item.family ?? receipt.actualFamily ?? "unknown",
    surface: item.surface ?? receipt.surface ?? "unknown",
    voice: receipt.declaredVoice ?? null,
    modelClaimed: receipt.modelClaimed ?? null,
    modelVerified: typeof receipt.modelVerified === "boolean" ? receipt.modelVerified : null,
  };
  const seed = stableStringify({
    priorId,
    runId: execution.runId ?? run?.runId ?? null,
    dispatchId: execution.dispatchId ?? null,
    family: producer.family,
    surface: producer.surface,
    transcriptSha256: receipt.transcriptSha256 ?? null,
    status: item.status ?? null,
  });
  const suffix = sha256(seed).slice(0, 12);
  const deltaId = `delta-${compactTimestamp(createdAt)}-${suffix}`;
  const taskId =
    task?.id ??
    task?.taskId ??
    run?.docketItem?.docketId ??
    run?.runId ??
    execution.runId ??
    "task-unknown";
  const evidence = buildEvidence({
    deltaId,
    item,
    run,
    task,
    prior,
    executionPath,
  });
  const claims = buildClaims({
    deltaId,
    item,
    sections,
    producer,
    evidence,
  });
  const recommendedNextActions = extractRecommendations(text, sections);
  const openQuestions = [...sections.missingEvidence, ...statusOpenQuestions(item)].slice(0, 12);
  const confidence = confidenceForExecution(item);
  const authorityImpact =
    item.status === "failed" ? "blocked" : recommendedNextActions.length > 0 ? "proposal" : "none";

  return {
    schemaVersion: "chuck.posterior-delta.v1",
    deltaId,
    priorId,
    producer,
    taskId: String(taskId),
    createdAt,
    claims,
    changedFiles: [],
    evidence,
    dissent: [],
    openQuestions,
    recommendedNextActions,
    confidence,
    authorityImpact,
    mergePolicy: {
      mode: "append-only",
      mayMutatePriorBody: false,
      requiresCompactionGate: true,
      notes:
        "This delta is evidence-bearing input to the shared prior. It cannot rewrite the compact prior body without a separate compaction decision.",
    },
  };
}

function buildClaims({ deltaId, item, sections, producer, evidence }) {
  const evidenceRefs = evidence.map((entry) => entry.evidenceId);
  const sectionClaims = sections.claims.slice(0, 12).map((text, index) => ({
    claimId: `${deltaId}:claim-${index + 1}`,
    text,
    status: item.countingEligible === true ? "supported" : "proposed",
    confidence: confidenceForExecution(item),
    evidenceRefs,
    dissentRefs: [],
  }));
  if (sectionClaims.length > 0) {
    return sectionClaims;
  }
  const statusText =
    item.status === "failed"
      ? `${producer.surface} failed to produce a usable family posterior: ${item.reason ?? "unknown failure"}`
      : `${producer.surface} produced a non-counting or weakly structured family posterior.`;
  return [
    {
      claimId: `${deltaId}:claim-1`,
      text: statusText,
      status: item.status === "failed" ? "contested" : "proposed",
      confidence: "low",
      evidenceRefs,
      dissentRefs: [],
    },
  ];
}

function buildEvidence({ deltaId, item, run, task, prior, executionPath }) {
  const evidence = [];
  const receipt = item.receipt ?? {};
  if (receipt.transcriptPath) {
    evidence.push({
      evidenceId: `${deltaId}:evidence-transcript`,
      kind: "transcript",
      ref: receipt.transcriptPath,
      sha256: normalizeSha(receipt.transcriptSha256),
      observedAt: receipt.endedAt ?? receipt.startedAt ?? null,
    });
  }
  evidence.push({
    evidenceId: `${deltaId}:evidence-runner-execution`,
    kind: "run",
    ref: executionPath,
    sha256: fileSha(executionPath),
    observedAt: null,
  });
  if (run?.runId) {
    const runPath = join(RUNS_DIR, `${run.runId}.json`);
    if (existsSync(runPath)) {
      evidence.push({
        evidenceId: `${deltaId}:evidence-run`,
        kind: "run",
        ref: runPath,
        sha256: fileSha(runPath),
        observedAt: run.createdAt ?? null,
      });
    }
  }
  if (task?._path) {
    evidence.push({
      evidenceId: `${deltaId}:evidence-task`,
      kind: "file",
      ref: task._path,
      sha256: fileSha(task._path),
      observedAt: task.updatedAt ?? task.createdAt ?? null,
    });
  }
  if (prior?._path) {
    evidence.push({
      evidenceId: `${deltaId}:evidence-prior`,
      kind: "file",
      ref: prior._path,
      sha256: fileSha(prior._path),
      observedAt: prior.createdAt ?? null,
    });
  }
  return evidence;
}

function buildReadMarker({ task, prior, item, delta }) {
  if (task?.priorCapsuleBefore?.injectedIntoPrompt !== true) {
    return null;
  }
  if (item.status !== "completed") {
    return null;
  }
  const receipt = item.receipt ?? {};
  const seenAt = receipt.startedAt ?? delta.createdAt;
  const seed = stableStringify({
    priorId: delta.priorId,
    deltaId: delta.deltaId,
    family: delta.producer.family,
    surface: delta.producer.surface,
    seenAt,
  });
  return {
    schemaVersion: "chuck.read-marker.v1",
    markerId: `read-${compactTimestamp(seenAt)}-${sha256(seed).slice(0, 12)}`,
    reader: {
      family: delta.producer.family,
      surface: delta.producer.surface,
      voice: delta.producer.voice,
    },
    priorId: delta.priorId,
    deltaIds: [delta.deltaId],
    seenAt,
    scope: task.priorCapsuleBefore.scope ?? "summary",
    result: item.countingEligible === true ? "accepted" : "needs-more-context",
    notes: `Prior ${prior?.priorId ?? delta.priorId} was injected into the executor prompt before dispatch.`,
  };
}

function parseScoutSections(text) {
  const sections = {
    claims: [],
    risks: [],
    missingEvidence: [],
    deepenNeeded: "unknown",
  };
  let current = null;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const label = line.match(
      /^(?:#+\s*)?(CLAIMS|RISKS|MISSING[_ ]EVIDENCE|DEEPEN_NEEDED)\s*:?\s*(.*)$/i,
    );
    if (label) {
      current = labelName(label[1]);
      if (label[2]) {
        addSectionLine(sections, current, label[2]);
      }
      continue;
    }
    if (
      /^(?:#+\s*)?(Family-Specific Critique|Verdict|Strongest Insight|Protocol Failure|One Concrete Implementation Recommendation|Concrete Implementation Recommendation|Recommendation|Recommended Next Actions)\s*:?/i.test(
        line,
      )
    ) {
      current = null;
    }
    addSectionLine(sections, current, line);
  }
  return sections;
}

function labelName(label) {
  const normalized = label.toUpperCase().replace(/\s+/g, "_");
  if (normalized === "CLAIMS") {
    return "claims";
  }
  if (normalized === "RISKS") {
    return "risks";
  }
  if (normalized === "MISSING_EVIDENCE") {
    return "missingEvidence";
  }
  return "deepenNeeded";
}

function addSectionLine(sections, current, line) {
  if (!current) {
    return;
  }
  const cleaned = cleanBullet(line);
  if (!cleaned) {
    return;
  }
  if (current === "deepenNeeded") {
    if (/\byes\b/i.test(cleaned)) {
      sections.deepenNeeded = "yes";
    } else if (/\bno\b/i.test(cleaned)) {
      sections.deepenNeeded = "no";
    }
    return;
  }
  sections[current].push(cleaned);
}

function extractRecommendations(text, sections) {
  const recommendations = [];
  const lines = String(text ?? "").split(/\r?\n/);
  let collecting = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (collecting) {
        break;
      }
      continue;
    }
    if (
      /^(?:#+\s*)?(One Concrete Implementation Recommendation|Concrete Implementation Recommendation|Recommendation|Recommended Next Actions)\s*:?/i.test(
        line,
      )
    ) {
      collecting = true;
      const after = line.replace(
        /^(?:#+\s*)?(One Concrete Implementation Recommendation|Concrete Implementation Recommendation|Recommendation|Recommended Next Actions)\s*:?\s*/i,
        "",
      );
      if (after) {
        recommendations.push(cleanBullet(after));
      }
      continue;
    }
    if (
      collecting &&
      /^(?:#+\s*)?(CLAIMS|RISKS|MISSING[_ ]EVIDENCE|DEEPEN_NEEDED|Verdict|Strongest Insight|Protocol Failure)\s*:?/i.test(
        line,
      )
    ) {
      break;
    }
    if (collecting) {
      recommendations.push(cleanBullet(line));
    }
  }
  if (recommendations.length === 0 && String(text).length < 500 && sections.claims.length === 0) {
    recommendations.push(cleanBullet(text));
  }
  return recommendations.filter(Boolean).slice(0, 8);
}

function statusOpenQuestions(item) {
  if (item.status === "failed") {
    return [
      `Investigate ${item.surface ?? "unknown surface"} failure: ${item.reason ?? "unknown reason"}`,
    ];
  }
  if (item.countingEligible !== true) {
    return [
      `Harden ${item.surface ?? "unknown surface"} so it returns the required scout structure.`,
    ];
  }
  return [];
}

function confidenceForExecution(item) {
  if (item.status !== "completed") {
    return "low";
  }
  if (item.countingEligible === true && item.calibration?.verdict === "usable") {
    return "high";
  }
  if (item.countingEligible === true) {
    return "medium";
  }
  return "low";
}

function writeDelta(delta) {
  mkdirSync(DELTAS_DIR, { recursive: true });
  const path = join(DELTAS_DIR, `${delta.deltaId}.json`);
  writeJsonAtomic(path, delta);
  return { deltaId: delta.deltaId, path };
}

function writeReadMarker(marker) {
  mkdirSync(READ_MARKERS_DIR, { recursive: true });
  const path = join(READ_MARKERS_DIR, `${marker.markerId}.json`);
  writeJsonAtomic(path, marker);
  return { markerId: marker.markerId, path };
}

function readRunForExecution(execution) {
  const runId = execution?.runId;
  if (!runId) {
    return null;
  }
  const path = join(RUNS_DIR, `${runId}.json`);
  if (!existsSync(path)) {
    return null;
  }
  return readJson(path);
}

function readJson(path) {
  const text = readFileSync(path, "utf8");
  const data = JSON.parse(text);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    data._path = path;
  }
  return data;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function validateOrThrow(validate, value, label) {
  if (validate(value)) {
    return;
  }
  const detail = validate.errors
    ?.map((err) => `${err.instancePath || "/"} ${err.message}`)
    .join("; ");
  throw new Error(`${label} failed schema validation: ${detail}`);
}

function cleanBullet(line) {
  return String(line ?? "")
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^[0-9]+[.)]\s+/, "")
    .trim();
}

function normalizeSha(value) {
  if (!value) {
    return null;
  }
  return String(value).startsWith("sha256:") ? String(value) : `sha256:${value}`;
}

function fileSha(path) {
  if (!path || !existsSync(path)) {
    return null;
  }
  return `sha256:${sha256(readFileSync(path))}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compactTimestamp(iso) {
  return String(iso ?? new Date().toISOString())
    .replace(/[-:.]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
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

function expandPath(path) {
  if (!path) {
    return path;
  }
  if (path === "~") {
    return HOME;
  }
  if (path.startsWith("~/")) {
    return join(HOME, path.slice(2));
  }
  return resolve(path);
}

function resolvePriorPath(value) {
  if (!value || value === "latest") {
    return LATEST_PRIOR;
  }
  return expandPath(value);
}

process.on("SIGINT", () => {
  process.exit(130);
});

try {
  main();
} catch (err) {
  process.stderr.write(
    `[chuck-posterior-delta] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
