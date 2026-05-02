#!/usr/bin/env node
// =============================================================================
// TRANSITIONAL DUPLICATE — Unit 14 of the openclaw-first migration (2026-05-01).
// =============================================================================
// The CANONICAL implementation lives at:
//   extensions/skill-prior-compaction/src/* (re-exported via
//   @openclaw/skill-prior-compaction api.ts)
//
// This .mjs is kept alive ONLY because chuck-dashboard.mjs (Unit ~16+ candidate,
// still .mjs daemon) subprocess-spawns it via `runPriorCompaction`:
//   spawnSync(node, [chuck-prior-compaction.mjs, ...args])
//
// Vanilla Node ESM cannot import .ts at runtime, so the dashboard's spawn path
// keeps a duplicate of the parse/build/promote/validate/write logic until the
// dashboard migrates to importing the plugin's buildStatus/previewDecision/
// approveDecision directly, or openclaw cron supports long-running plugin
// daemons.
//
// EDITS: bug fixes go in BOTH places (here AND
// extensions/skill-prior-compaction/src/*.ts). Wire format (decision JSON,
// decisionId pattern, schema version, confirm token, bus event names) MUST
// stay byte-identical.
// =============================================================================
//
// Chuck Prior Compaction Gate.
//
// This is deliberately mechanical. It drafts and applies Joseph-gated
// compaction decisions from typed posterior deltas; it does not ask a model to
// merge the truth or grant any family silent editor authority over the prior.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emit } from "./apex-event-bus.mjs";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020");

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const SCRIPT_NAME = basename(SCRIPT_PATH);
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const HOME = homedir();
const STATE = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V3 = join(STATE, "chuck-v3");
const PRIORS_DIR = join(CHUCK_V3, "priors");
const LATEST_PRIOR = join(PRIORS_DIR, "latest.json");
const DELTAS_DIR = join(CHUCK_V3, "posterior-deltas");
const DOCKET_DIR = join(CHUCK_V3, "docket");
const COMPACTIONS_DIR = join(CHUCK_V3, "compactions");
const DESIGN_DIR = join(REPO_ROOT, "extensions", "memory-graph", "data", "chuck-v2-design");
const COMPACTION_SCHEMA = join(DESIGN_DIR, "prior-compaction-decision.schema.json");
const PRIOR_CAPSULE_SCRIPT = join(SCRIPT_DIR, "chuck-prior-capsule.mjs");
const APPROVAL_TOKEN = "APPROVE_PRIOR_COMPACTION";
const DEFAULT_LIMIT = 1000;

function parseArgs(argv) {
  const options = {
    command: null,
    json: false,
    write: false,
    decision: null,
    confirm: null,
    approvedBy: "operator/cockpit",
    limit: DEFAULT_LIMIT,
  };
  if (argv[0] && !argv[0].startsWith("-")) {
    options.command = argv.shift();
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--decision") {
      options.decision = argv[++i] ?? null;
    } else if (arg === "--confirm") {
      options.confirm = argv[++i] ?? null;
    } else if (arg === "--approved-by") {
      options.approvedBy = argv[++i] ?? "operator/cockpit";
    } else if (arg === "--limit") {
      options.limit = parsePositiveInt(argv[++i], "--limit");
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.command) {
    options.command = "status";
  }
  return options;
}

function printUsage() {
  console.log(`Usage:
  node extensions/memory-graph/scripts/${SCRIPT_NAME} status [--json]
  node extensions/memory-graph/scripts/${SCRIPT_NAME} preview [--write] [--json]
  node extensions/memory-graph/scripts/${SCRIPT_NAME} approve --decision <id-or-path> --confirm ${APPROVAL_TOKEN} [--json]

Commands:
  status    Summarize latest compaction state and current unapplied deltas.
  preview   Produce a deterministic draft compaction. Writes only with --write.
  approve   Mark a draft approved, refresh the prior capsule, then mark applied.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const validateDecision = createDecisionValidator();
  if (options.command === "status") {
    const status = buildStatus({ validateDecision, limit: options.limit });
    writeOutput(status, options);
    return;
  }
  if (options.command === "preview") {
    const decision = buildPreviewDecision({ validateDecision, limit: options.limit });
    let receipt = {
      ok: true,
      command: "preview",
      writes: false,
      path: null,
      decision,
    };
    if (options.write) {
      const written = writeDecision(decision, validateDecision);
      await emit({
        source: "chuck-prior-compaction",
        type: "chuck.prior-compaction.draft-written",
        payload: {
          decisionId: decision.decisionId,
          path: written.path,
          includedDeltaCount: decision.includedDeltaIds.length,
          promotedClaimCount: decision.promotedClaims.length,
          deferredClaimCount: decision.deferredClaims.length,
        },
      });
      receipt = { ...receipt, writes: true, path: written.path };
    }
    writeOutput(receipt, options);
    return;
  }
  if (options.command === "approve") {
    const receipt = await approveDecision(options, validateDecision);
    writeOutput(receipt, options);
    return;
  }
  throw new Error(`unknown command: ${options.command}`);
}

function createDecisionValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  return ajv.compile(readJson(COMPACTION_SCHEMA));
}

function buildStatus({ validateDecision, limit }) {
  const latestDecision = latestCompactionDecision();
  const latestAppliedDecision = latestCompactionDecision(["applied"]);
  const latestDraftDecision = latestCompactionDecision(["draft"]);
  const preview = buildPreviewDecision({ validateDecision, limit });
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    compactionsPath: COMPACTIONS_DIR,
    latestDecision: summarizeDecision(latestDecision),
    latestAppliedDecision: summarizeDecision(latestAppliedDecision),
    latestDraftDecision: summarizeDecision(latestDraftDecision),
    unappliedDeltaCount: preview.includedDeltaIds.length,
    promotedClaimCount: preview.promotedClaims.length,
    deferredClaimCount: preview.deferredClaims.length,
    openQuestionCount: preview.openQuestions.length,
    recommendedNextActionCount: preview.recommendedNextActions.length,
    draftPreview: summarizeDecision({ data: preview, path: null, mtimeMs: 0 }),
  };
}

function buildPreviewDecision({ validateDecision, limit = DEFAULT_LIMIT }) {
  const prior = readLatestPrior();
  const applied = appliedCompactionCursor();
  const appliedDeltaIds = new Set(applied.appliedDeltaIds);
  const allDeltas = latestJsonFiles(DELTAS_DIR, { limit })
    .map((file) => ({ file, data: file.data }))
    .filter((entry) => entry.data)
    .toSorted(
      (a, b) =>
        compareIso(a.data.createdAt, b.data.createdAt) || a.file.name.localeCompare(b.file.name),
    );
  const candidates = allDeltas.filter((entry) => {
    const id = entry.data?.deltaId ?? entry.file.name.replace(/\.json$/, "");
    return !appliedDeltaIds.has(id);
  });

  const promotedByKey = new Map();
  const deferredClaims = [];
  const eligibleDeltaIds = [];
  const deferredDeltaIds = new Set();
  const openQuestions = new Set();
  const recommendedNextActions = new Set();
  const dissentRefs = new Set();

  for (const { data: delta } of candidates) {
    const deltaId = delta.deltaId;
    const assessment = assessDelta(delta);
    const receiptOnlyReason = receiptOnlyDeferralReason(delta);
    if (assessment.eligible) {
      eligibleDeltaIds.push(deltaId);
    } else {
      deferredDeltaIds.add(deltaId);
    }
    if (!receiptOnlyReason) {
      collectStrings(delta.openQuestions, openQuestions);
      collectStrings(delta.recommendedNextActions, recommendedNextActions);
    }
    collectDissentRefs(delta, dissentRefs);
    const claims = Array.isArray(delta.claims) ? delta.claims : [];
    if (!claims.length) {
      deferredClaims.push(
        deferredClaimForDelta(
          delta,
          receiptOnlyReason || assessment.reasons.join("; ") || "delta has no claims",
        ),
      );
      if (receiptOnlyReason) {
        deferredDeltaIds.add(deltaId);
      }
      continue;
    }
    for (const claim of claims) {
      const reason = receiptOnlyReason || claimDeferralReason(delta, claim, assessment.reasons);
      if (reason) {
        deferredDeltaIds.add(deltaId);
        deferredClaims.push(deferredClaim(delta, claim, reason));
        continue;
      }
      promoteClaim(promotedByKey, delta, claim);
    }
  }

  const includedDeltaIds = candidates.map(({ data }) => data.deltaId);
  const createdAt = deterministicDecisionTime(
    prior,
    candidates.map(({ data }) => data),
  );
  const decisionSeed = stableStringify({
    sourcePriorId: prior.priorId,
    includedDeltaIds,
    promotedClaimKeys: [...promotedByKey.keys()].toSorted(),
    deferredClaimIds: deferredClaims.map((claim) => claim.claimId).toSorted(),
  });
  const decisionId = `compaction-${compactTimestamp(createdAt)}-${sha256(decisionSeed).slice(0, 12)}`;
  const promotedClaims = [...promotedByKey.values()].map((claim) => ({
    ...claim,
    families: claim.families.toSorted(),
    surfaces: claim.surfaces.toSorted(),
    sourceDeltaIds: claim.sourceDeltaIds.toSorted(),
    sourceClaimIds: claim.sourceClaimIds.toSorted(),
    evidenceRefs: claim.evidenceRefs.toSorted(),
  }));
  const decision = {
    schemaVersion: "chuck.prior-compaction-decision.v1",
    decisionId,
    status: "draft",
    sourcePriorId: prior.priorId,
    sourcePriorPath: prior.path,
    sourcePriorHash: prior.sourceHash,
    createdAt,
    cursor: {
      previousDecisionId: applied.latestDecisionId,
      previousResultingPriorId: applied.latestResultingPriorId,
      appliedDeltaIds: [...appliedDeltaIds].toSorted(),
    },
    includedDeltaIds,
    eligibleDeltaIds: eligibleDeltaIds.toSorted(),
    deferredDeltaIds: [...deferredDeltaIds].toSorted(),
    promotedClaims,
    deferredClaims: deferredClaims.toSorted((a, b) => a.claimId.localeCompare(b.claimId)),
    openQuestions: [...openQuestions].toSorted(),
    recommendedNextActions: [...recommendedNextActions].toSorted(),
    dissentRefs: [...dissentRefs].toSorted(),
    counts: {
      posteriorDeltaCount: allDeltas.length,
      alreadyAppliedDeltaCount: appliedDeltaIds.size,
      includedDeltaCount: includedDeltaIds.length,
      eligibleDeltaCount: eligibleDeltaIds.length,
      deferredDeltaCount: deferredDeltaIds.size,
      promotedClaimCount: promotedClaims.length,
      deferredClaimCount: deferredClaims.length,
      openQuestionCount: openQuestions.size,
      recommendedNextActionCount: recommendedNextActions.size,
      dissentRefCount: dissentRefs.size,
    },
    approval: null,
    approvedAt: null,
    appliedAt: null,
    rejectedAt: null,
    rejection: null,
    resultingPriorId: null,
    result: null,
  };
  validateOrThrow(validateDecision, decision, "prior compaction decision preview");
  return decision;
}

async function approveDecision(options, validateDecision) {
  if (!options.decision) {
    throw new Error("--decision is required");
  }
  if (options.confirm !== APPROVAL_TOKEN) {
    throw new Error(`--confirm must equal ${APPROVAL_TOKEN}`);
  }
  const path = resolveDecisionPath(options.decision);
  if (!existsSync(path)) {
    throw new Error(`compaction decision not found: ${path}`);
  }
  const current = readJson(path);
  validateOrThrow(validateDecision, current, "prior compaction decision");
  if (current.status === "applied") {
    return {
      ok: true,
      command: "approve",
      alreadyApplied: true,
      path,
      decisionId: current.decisionId,
      resultingPriorId: current.resultingPriorId,
      decision: current,
    };
  }
  if (!["draft", "approved"].includes(current.status)) {
    throw new Error(`decision status must be draft or approved, got ${current.status}`);
  }

  const approvedAt = new Date().toISOString();
  const approved = {
    ...current,
    status: "approved",
    approval: {
      at: approvedAt,
      by: String(options.approvedBy ?? "operator/cockpit").slice(0, 120),
      confirm: APPROVAL_TOKEN,
      note: "Joseph-approved compaction gate. This approval mutates only the compact prior capsule, not executor intake.",
    },
    approvedAt,
  };
  validateOrThrow(validateDecision, approved, "approved prior compaction decision");
  writeJsonAtomic(path, approved);
  await emit({
    source: "chuck-prior-compaction",
    type: "chuck.prior-compaction.approved",
    payload: {
      decisionId: approved.decisionId,
      path,
      includedDeltaCount: approved.includedDeltaIds.length,
      promotedClaimCount: approved.promotedClaims.length,
      deferredClaimCount: approved.deferredClaims.length,
    },
  });

  const appliedAt = new Date().toISOString();
  const applying = {
    ...approved,
    status: "applied",
    appliedAt,
    resultingPriorId: null,
    result: null,
  };
  validateOrThrow(validateDecision, applying, "applying prior compaction decision");
  writeJsonAtomic(path, applying);
  const priorReceipt = refreshPriorCapsule();
  const applied = {
    ...applying,
    status: "applied",
    resultingPriorId: priorReceipt.priorId ?? null,
    result: {
      priorReceipt,
      appliedBy: `extensions/memory-graph/scripts/${SCRIPT_NAME}`,
      appliedAt,
    },
  };
  validateOrThrow(validateDecision, applied, "applied prior compaction decision");
  writeJsonAtomic(path, applied);
  await emit({
    source: "chuck-prior-compaction",
    type: "chuck.prior-compaction.applied",
    payload: {
      decisionId: applied.decisionId,
      path,
      resultingPriorId: applied.resultingPriorId,
      priorPath: priorReceipt.path ?? null,
      latestPath: priorReceipt.latestPath ?? null,
    },
  });
  return {
    ok: true,
    command: "approve",
    path,
    decisionId: applied.decisionId,
    resultingPriorId: applied.resultingPriorId,
    priorReceipt,
    decision: applied,
  };
}

function refreshPriorCapsule() {
  const stdout = execFileSync(
    process.execPath,
    [PRIOR_CAPSULE_SCRIPT, "--write", "--markdown", "--json"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const text = stdout.trim();
  if (!text) {
    throw new Error("prior capsule refresh returned empty stdout");
  }
  return JSON.parse(text);
}

function assessDelta(delta) {
  const reasons = [];
  if (!delta || delta.schemaVersion !== "chuck.posterior-delta.v1") {
    reasons.push("invalid posterior delta schema version");
  }
  if (!delta?.deltaId) {
    reasons.push("missing delta id");
  }
  if (!Array.isArray(delta?.evidence) || delta.evidence.length === 0) {
    reasons.push("missing evidence pointers");
  }
  if (!Array.isArray(delta?.claims) || delta.claims.length === 0) {
    reasons.push("missing claims");
  }
  if (delta?.authorityImpact === "blocked") {
    reasons.push("authority impact is blocked");
  }
  if (Array.isArray(delta?.dissent) && delta.dissent.length > 0) {
    reasons.push("delta carries dissent sidecar");
  }
  return { eligible: reasons.length === 0, reasons };
}

function claimDeferralReason(delta, claim, deltaReasons) {
  if (deltaReasons.length > 0) {
    return deltaReasons.join("; ");
  }
  if (!claim || typeof claim.text !== "string" || !claim.text.trim()) {
    return "claim text is missing";
  }
  if (["contested", "retracted"].includes(String(claim.status ?? "").toLowerCase())) {
    return `claim status is ${claim.status}`;
  }
  if (Array.isArray(claim.dissentRefs) && claim.dissentRefs.length > 0) {
    return "claim has dissent references";
  }
  return null;
}

function receiptOnlyDeferralReason(delta) {
  const text = [
    delta?.taskId,
    delta?.taskTitle,
    delta?.title,
    delta?.intent,
    delta?.taskIntent,
    docketTaskForDelta(delta)?.title,
    docketTaskForDelta(delta)?.ledgerIntent,
    docketTaskForDelta(delta)?.intent,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text.includes("read canary") && !text.includes("read-canary")) {
    return null;
  }
  return "receipt-only read canary; preserve source delta/read marker, but do not promote canary observations into compact prior claims";
}

function docketTaskForDelta(delta) {
  const taskId = typeof delta?.taskId === "string" ? delta.taskId : null;
  if (!taskId) {
    return null;
  }
  const path = join(DOCKET_DIR, `${taskId}.json`);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

function promoteClaim(map, delta, claim) {
  const text = cleanClaimText(claim.text);
  const key = `claim-${sha256(normalizeText(text)).slice(0, 12)}`;
  const evidenceRefs = evidenceRefsFor(delta, claim);
  if (!map.has(key)) {
    map.set(key, {
      claimKey: key,
      text,
      status: claim.status ?? "supported",
      confidence: claim.confidence ?? delta.confidence ?? "low",
      authorityImpact: delta.authorityImpact ?? "none",
      families: [],
      surfaces: [],
      sourceDeltaIds: [],
      sourceClaimIds: [],
      evidenceRefs: [],
    });
  }
  const entry = map.get(key);
  entry.status = strongerStatus(entry.status, claim.status ?? "supported");
  entry.confidence = strongerConfidence(
    entry.confidence,
    claim.confidence ?? delta.confidence ?? "low",
  );
  entry.authorityImpact = strongerAuthorityImpact(
    entry.authorityImpact,
    delta.authorityImpact ?? "none",
  );
  pushUnique(entry.families, delta.producer?.family ?? "unknown");
  pushUnique(entry.surfaces, delta.producer?.surface ?? "unknown");
  pushUnique(entry.sourceDeltaIds, delta.deltaId);
  pushUnique(entry.sourceClaimIds, claim.claimId ?? `${delta.deltaId}:claim-unknown`);
  for (const ref of evidenceRefs) {
    pushUnique(entry.evidenceRefs, ref);
  }
}

function deferredClaim(delta, claim, reason) {
  return {
    claimId: claim?.claimId ?? `${delta.deltaId}:claim-unknown`,
    text: truncate(cleanClaimText(claim?.text ?? `Delta ${delta.deltaId} was deferred.`), 500),
    sourceDeltaId: delta.deltaId,
    family: delta.producer?.family ?? null,
    surface: delta.producer?.surface ?? null,
    confidence: claim?.confidence ?? delta.confidence ?? "low",
    authorityImpact: delta.authorityImpact ?? "none",
    evidenceRefs: evidenceRefsFor(delta, claim),
    reason,
  };
}

function deferredClaimForDelta(delta, reason) {
  return {
    claimId: `${delta.deltaId ?? "delta-unknown"}:delta`,
    text: `Delta ${delta.deltaId ?? "unknown"} could not be promoted mechanically.`,
    sourceDeltaId: delta.deltaId ?? "delta-unknown",
    family: delta.producer?.family ?? null,
    surface: delta.producer?.surface ?? null,
    confidence: delta.confidence ?? "low",
    authorityImpact: delta.authorityImpact ?? "none",
    evidenceRefs: evidenceRefsFor(delta, null),
    reason,
  };
}

function evidenceRefsFor(delta, claim) {
  const refs = Array.isArray(claim?.evidenceRefs) ? claim.evidenceRefs.filter(Boolean) : [];
  if (refs.length) {
    return [...new Set(refs)];
  }
  return (Array.isArray(delta?.evidence) ? delta.evidence : [])
    .map((entry) => entry?.evidenceId)
    .filter(Boolean);
}

function collectDissentRefs(delta, out) {
  if (Array.isArray(delta?.dissent)) {
    for (const item of delta.dissent) {
      if (item?.dissentId) {
        out.add(item.dissentId);
      }
    }
  }
  for (const claim of Array.isArray(delta?.claims) ? delta.claims : []) {
    for (const ref of Array.isArray(claim?.dissentRefs) ? claim.dissentRefs : []) {
      if (ref) {
        out.add(ref);
      }
    }
  }
}

function appliedCompactionCursor() {
  const applied = compactionDecisionFiles(["applied"]).toSorted(
    (a, b) => compareIso(a.data.appliedAt, b.data.appliedAt) || a.path.localeCompare(b.path),
  );
  const deltaIds = new Set();
  let latest = null;
  for (const file of applied) {
    latest = file;
    for (const id of Array.isArray(file.data?.includedDeltaIds) ? file.data.includedDeltaIds : []) {
      deltaIds.add(id);
    }
  }
  return {
    latestDecisionId: latest?.data?.decisionId ?? null,
    latestResultingPriorId: latest?.data?.resultingPriorId ?? null,
    appliedDeltaIds: [...deltaIds].toSorted(),
  };
}

function compactionDecisionFiles(statuses = null) {
  const statusSet = Array.isArray(statuses) ? new Set(statuses) : null;
  return latestJsonFiles(COMPACTIONS_DIR, { limit: DEFAULT_LIMIT })
    .filter((file) => file.data?.schemaVersion === "chuck.prior-compaction-decision.v1")
    .filter((file) => !statusSet || statusSet.has(file.data?.status));
}

function latestCompactionDecision(statuses = null) {
  return compactionDecisionFiles(statuses)[0] ?? null;
}

function summarizeDecision(file) {
  const decision = file?.data ?? null;
  if (!decision) {
    return null;
  }
  return {
    decisionId: decision.decisionId ?? null,
    status: decision.status ?? null,
    sourcePriorId: decision.sourcePriorId ?? null,
    createdAt: decision.createdAt ?? null,
    approvedAt: decision.approvedAt ?? null,
    appliedAt: decision.appliedAt ?? null,
    resultingPriorId: decision.resultingPriorId ?? null,
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
    path: file.path ?? null,
    promotedClaimPreview: Array.isArray(decision.promotedClaims)
      ? decision.promotedClaims.slice(0, 5).map((claim) => ({
          claimKey: claim.claimKey,
          text: truncate(claim.text, 220),
          families: claim.families,
          confidence: claim.confidence,
          authorityImpact: claim.authorityImpact,
        }))
      : [],
    deferredClaimPreview: Array.isArray(decision.deferredClaims)
      ? decision.deferredClaims.slice(0, 5).map((claim) => ({
          claimId: claim.claimId,
          text: truncate(claim.text, 180),
          reason: claim.reason,
        }))
      : [],
  };
}

function readLatestPrior() {
  if (!existsSync(LATEST_PRIOR)) {
    return {
      priorId: "prior-missing",
      createdAt: new Date().toISOString(),
      sourceHash: null,
      path: null,
    };
  }
  const prior = readJson(LATEST_PRIOR);
  return {
    ...prior,
    priorId: prior.priorId ?? "prior-unknown",
    createdAt: prior.createdAt ?? new Date().toISOString(),
    sourceHash: prior.sourceHash ?? fileSha(LATEST_PRIOR),
    path: LATEST_PRIOR,
  };
}

function writeDecision(decision, validateDecision) {
  validateOrThrow(validateDecision, decision, "prior compaction decision");
  mkdirSync(COMPACTIONS_DIR, { recursive: true });
  const path = join(COMPACTIONS_DIR, `${decision.decisionId}.json`);
  if (existsSync(path)) {
    const existing = readJson(path);
    if (existing.status !== "draft" && existing.status !== decision.status) {
      throw new Error(`refusing to overwrite non-draft compaction decision: ${path}`);
    }
  }
  writeJsonAtomic(path, decision);
  return { decisionId: decision.decisionId, path };
}

function latestJsonFiles(dir, { limit = DEFAULT_LIMIT } = {}) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
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
          data: readJson(path),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
    .slice(0, limit);
}

function deterministicDecisionTime(prior, deltas) {
  const times = [prior?.createdAt, ...deltas.map((delta) => delta?.createdAt)]
    .map((value) => Date.parse(value ?? ""))
    .filter((value) => Number.isFinite(value));
  if (!times.length) {
    return new Date().toISOString();
  }
  return new Date(Math.max(...times)).toISOString();
}

function compareIso(a, b) {
  return (Date.parse(a ?? "") || 0) - (Date.parse(b ?? "") || 0);
}

function strongerStatus(a, b) {
  const order = { retracted: 0, contested: 1, proposed: 2, supported: 3, "operator-resolved": 4 };
  return (order[b] ?? 0) > (order[a] ?? 0) ? b : a;
}

function strongerConfidence(a, b) {
  const order = { low: 0, medium: 1, high: 2 };
  return (order[b] ?? 0) > (order[a] ?? 0) ? b : a;
}

function strongerAuthorityImpact(a, b) {
  const order = { none: 0, proposal: 1, "approval-required": 2, blocked: 3 };
  return (order[b] ?? 0) > (order[a] ?? 0) ? b : a;
}

function collectStrings(values, out) {
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? "").trim();
    if (text) {
      out.add(text);
    }
  }
}

function pushUnique(array, value) {
  if (value && !array.includes(value)) {
    array.push(value);
  }
}

function cleanClaimText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return cleanClaimText(value).toLowerCase();
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function resolveDecisionPath(value) {
  const expanded = expandPath(String(value ?? ""));
  if (expanded.endsWith(".json") || expanded.includes("/")) {
    return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  }
  return join(COMPACTIONS_DIR, `${expanded}.json`);
}

function expandPath(path) {
  if (path === "~") {
    return HOME;
  }
  if (path.startsWith("~/")) {
    return join(HOME, path.slice(2));
  }
  return path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

function truncate(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 3)}...`;
}

function writeOutput(value, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (value.command === "preview") {
    process.stdout.write(
      `${value.writes ? "wrote" : "previewed"} ${value.decision.decisionId}: ` +
        `${value.decision.includedDeltaIds.length} delta(s), ` +
        `${value.decision.promotedClaims.length} promoted claim(s), ` +
        `${value.decision.deferredClaims.length} deferred claim(s)\n`,
    );
    return;
  }
  if (value.command === "approve") {
    process.stdout.write(
      `applied ${value.decisionId} -> ${value.resultingPriorId ?? "prior-unknown"}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

process.on("SIGINT", () => {
  process.exit(130);
});

main().catch((err) => {
  process.stderr.write(
    `[chuck-prior-compaction] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
