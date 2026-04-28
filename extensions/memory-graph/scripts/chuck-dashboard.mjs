#!/usr/bin/env node
// apex-ring: 2
// chuck-dashboard — Chuck's persistent + dynamic status surface.
//
// Joseph wants to *see* Chuck's live state without asking — fleet health,
// principle scores, in-flight processes, recent panels, live event stream —
// all in a single auto-refreshing browser page on localhost.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEvents, stats as eventStats, subscribeFile } from "./apex-event-bus.mjs";
import { wrapLifecycle } from "./apex-lifecycle.mjs";
import { audit as fleetAudit } from "./chuck-fleet.mjs";

const HOME = homedir();
const STATE_DIR = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V2_STATE_DIR = join(STATE_DIR, "chuck-v2");
const BUILDER_RUNS_DIR = join(CHUCK_V2_STATE_DIR, "builder-runs");
const MODEL_DOCTOR_DIR = join(CHUCK_V2_STATE_DIR, "model-doctor");
const ONBOARDING_DIR = join(CHUCK_V2_STATE_DIR, "onboarding");
const RUNNER_EXECUTIONS_DIR = join(CHUCK_V2_STATE_DIR, "runner-executions");
const REPO_HYGIENE_DIR = join(CHUCK_V2_STATE_DIR, "repo-hygiene");
const GITHUB_HYGIENE_DIR = join(CHUCK_V2_STATE_DIR, "github-hygiene");
const UPSTREAM_SYNC_DIR = join(CHUCK_V2_STATE_DIR, "upstream-sync");
const SURFACE_CONTROL_DIR = join(CHUCK_V2_STATE_DIR, "surface-control");
const SURFACE_RETURN_RECEIPTS_DIR = join(SURFACE_CONTROL_DIR, "return-receipts");
const STUCK_SURFACE_CONTRIBUTIONS_DIR = join(CHUCK_V2_STATE_DIR, "stuck-surface-contributions");
const SCORES_PATH = join(STATE_DIR, "apex-principle-scores.json");
const CURATOR_PATH = join(STATE_DIR, "apex-curator-state.json");
const FLEET_ROUTER_PATH = join(STATE_DIR, "fleet-router-scores.json");
let surfaceAtlasCache = null;
let capabilityLedgerCache = null;

const DEFAULT_PORT = 7777;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const CHUCK_V2_RUN = join(REPO_ROOT, "extensions", "memory-graph", "scripts", "chuck-v2-run.ts");
const MAX_COMMAND_BODY_BYTES = 128 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;

function readJsonSafe(path, fallback) {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function safeAsync(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function principleStatus({ topN = 10, bottomN = 5 } = {}) {
  const scores = readJsonSafe(SCORES_PATH, null);
  if (!scores) {
    return { available: false, reason: "scores file missing" };
  }
  const live = Object.entries(scores)
    .filter(([, e]) => !e?.archived)
    .map(([slug, e]) => ({
      slug,
      retrieval_weight: Number(e.retrieval_weight ?? 0),
      score: Number(e.score ?? 0),
      citations: Number(e.citations ?? 0),
      last_cited: e.last_cited_at ? new Date(e.last_cited_at).toISOString() : null,
    }));
  const sorted = [...live].toSorted((a, b) => b.retrieval_weight - a.retrieval_weight);
  return {
    available: true,
    total: Object.keys(scores).length,
    live: live.length,
    archived: Object.values(scores).filter((e) => e?.archived).length,
    top: sorted.slice(0, topN),
    bottom: sorted.slice(-bottomN).toReversed(),
  };
}

function curatorStatus() {
  const data = readJsonSafe(CURATOR_PATH, null);
  if (!data) {
    return { available: false, reason: "no curator state file" };
  }
  const entries = Object.values(data).filter((v) => v && typeof v === "object");
  const archived = entries.filter((e) => e.archived).length;
  const merged = entries.filter(
    (e) => Array.isArray(e.mergedFrom) && e.mergedFrom.length > 0,
  ).length;
  const linked = entries.reduce(
    (n, e) => n + (Array.isArray(e.relatesTo) ? e.relatesTo.length : 0),
    0,
  );
  const lastDecay = entries.reduce((m, e) => {
    const t = Number(e.lastDecayAt ?? 0);
    return t > m ? t : m;
  }, 0);
  return {
    available: true,
    nodes: entries.length,
    archived,
    mergedNodes: merged,
    relatesEdges: linked,
    lastDecayAt: lastDecay > 0 ? new Date(lastDecay).toISOString() : null,
  };
}

function fleetRouterStatus() {
  const data = readJsonSafe(FLEET_ROUTER_PATH, null);
  if (!data || !data.scores) {
    return { available: false, reason: "no fleet-router-scores.json" };
  }
  const rows = [];
  for (const [voice, byClass] of Object.entries(data.scores)) {
    const cells = [];
    for (const [cls, agg] of Object.entries(byClass ?? {})) {
      cells.push({
        class: cls,
        mean: Number(agg?.mean ?? 0),
        n: Number(agg?.n ?? 0),
        lastSeenAt: agg?.lastSeenAt ?? null,
      });
    }
    rows.push({ voice, cells });
  }
  return { available: true, rows };
}

function builderStatus({ limit = 8 } = {}) {
  if (!existsSync(BUILDER_RUNS_DIR)) {
    return {
      available: false,
      reason: "no builder runs yet",
      latest: null,
      pendingApproval: [],
      recent: [],
    };
  }
  const runs = safe(
    () =>
      readdirSync(BUILDER_RUNS_DIR)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readJsonSafe(join(BUILDER_RUNS_DIR, name), null))
        .filter(Boolean),
    [],
  );
  runs.sort(
    (a, b) =>
      Date.parse(b.updatedAt ?? b.createdAt ?? 0) - Date.parse(a.updatedAt ?? a.createdAt ?? 0),
  );
  const recent = runs.slice(0, limit).map(summarizeBuilderRun);
  const pendingApproval = runs
    .filter((run) => run.operatorActionRequired || run.disposition === "docketed-for-approval")
    .slice(0, limit)
    .map(summarizeBuilderRun);
  const active = runs
    .filter(
      (run) =>
        !["applied", "failed-verification", "blocked-by-authority"].includes(run.disposition),
    )
    .slice(0, limit)
    .map(summarizeBuilderRun);
  return {
    available: true,
    total: runs.length,
    latest: runs[0] ? summarizeBuilderRun(runs[0]) : null,
    pendingApproval,
    active,
    recent,
  };
}

function latestJsonInDir(dir) {
  if (!existsSync(dir)) {
    return null;
  }
  const files = safe(
    () =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const path = join(dir, name);
          return { name, path, mtimeMs: safe(() => statSync(path).mtimeMs, 0) };
        })
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name)),
    [],
  );
  const latest = files[0];
  if (!latest) {
    return null;
  }
  const data = readJsonSafe(latest.path, null);
  return data ? { path: latest.path, data } : null;
}

function surfaceControlStatus() {
  const active = readJsonSafe(join(SURFACE_CONTROL_DIR, "active-workstation-lease.json"), null);
  const latestReceipt = latestJsonInDir(SURFACE_RETURN_RECEIPTS_DIR);
  const receipts = safe(
    () =>
      readdirSync(SURFACE_RETURN_RECEIPTS_DIR)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const path = join(SURFACE_RETURN_RECEIPTS_DIR, name);
          return {
            name,
            path,
            mtimeMs: safe(() => statSync(path).mtimeMs, 0),
            data: readJsonSafe(path, null),
          };
        })
        .filter((row) => row.data)
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
        .slice(0, 8)
        .map((row) => ({
          path: row.path,
          leaseId: row.data.leaseId ?? null,
          reason: row.data.reason ?? null,
          endedAt: row.data.endedAt ?? null,
          ok: row.data.result?.ok === true,
          app: row.data.result?.app ?? row.data.origin?.app ?? null,
          restored: row.data.result?.restored ?? null,
          resultReason: row.data.result?.reason ?? row.data.result?.verification?.reason ?? null,
        })),
    [],
  );
  return {
    available: Boolean(active || latestReceipt || receipts.length > 0),
    active: active
      ? {
          leaseId: active.leaseId ?? null,
          status: active.status ?? "unknown",
          reason: active.reason ?? null,
          app: active.workstation?.app ?? null,
          frontWindowTitle: active.workstation?.frontWindowTitle ?? null,
          startedAt: active.startedAt ?? null,
          endedAt: active.endedAt ?? null,
          returnOk: active.returnResult?.ok ?? null,
          returnReason:
            active.returnResult?.reason ?? active.returnResult?.verification?.reason ?? null,
        }
      : null,
    latestReceipt: latestReceipt?.data ?? null,
    recentReceipts: receipts,
  };
}

function lateSurfaceRecoveries() {
  if (!existsSync(STUCK_SURFACE_CONTRIBUTIONS_DIR)) {
    return [];
  }
  const files = safe(
    () =>
      readdirSync(STUCK_SURFACE_CONTRIBUTIONS_DIR)
        .map((name) => {
          const path = join(STUCK_SURFACE_CONTRIBUTIONS_DIR, name);
          const stat = safe(() => statSync(path), null);
          return stat && stat.isFile()
            ? { name, path, mtimeMs: stat.mtimeMs, sizeBytes: stat.size }
            : null;
        })
        .filter(Boolean),
    [],
  );
  const recoveries = [];
  const addRecovery = (surface, family, candidates, label, caveat) => {
    const matches = candidates
      .flatMap((pattern) => files.filter((file) => pattern.test(file.name)))
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    if (matches.length === 0) {
      return;
    }
    const evidence = matches.slice(0, 6).map((file) => ({
      name: file.name,
      path: file.path,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      sizeBytes: file.sizeBytes,
    }));
    const primary = evidence[0];
    recoveries.push({
      surface,
      family,
      status: "recovered-late",
      label,
      caveat,
      updatedAt: primary.updatedAt,
      evidence,
    });
  };
  addRecovery(
    "chatgpt/web-chat",
    "openai",
    [/^chatgpt-20260428-retry\.json$/, /^20260428-perplexity-aistudio-synthesis\.md$/],
    "ChatGPT web rerun captured",
    "Original Fleet Deepen timed out; this late proof was captured by the ChatGPT web driver and must not erase the original failed receipt.",
  );
  addRecovery(
    "perplexity/mac-app",
    "perplexity",
    [
      /^perplexity-20260428-live-proof\.json$/,
      /^perplexity-20260428-page-\d+\.json$/,
      /^perplexity-20260428-ocr-contribution-full\.txt$/,
      /^20260428-perplexity-aistudio-synthesis\.md$/,
    ],
    "Perplexity Scout-missed contribution captured by live OCR/proof",
    "Original driver reply extraction failed; visible answer was recovered from local OCR and proof artifacts.",
  );
  addRecovery(
    "aistudio/web",
    "google",
    [
      /^aistudio-20260428-retry\.json$/,
      /^aistudio-20260428-contribution\.json$/,
      /^20260428-perplexity-aistudio-synthesis\.md$/,
    ],
    "AI Studio rerun captured",
    "AI Studio entitlement remains unverified unless model selector or successful receipt proves it.",
  );
  return recoveries.toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function recoveryForSurface(recoveries, surface) {
  return recoveries.find((recovery) => recovery.surface === surface) ?? null;
}

async function surfaceAtlasStatus({ maxAgeMs = 30_000 } = {}) {
  const now = Date.now();
  if (surfaceAtlasCache && now - surfaceAtlasCache.cachedAt < maxAgeMs) {
    return surfaceAtlasCache.value;
  }
  const run = await runChuckCli(["--surface-atlas", "--json"], {
    timeoutMs: dashboardCommandTimeoutMs({ kind: "surface-atlas" }),
  });
  if (!run.ok || !run.parsed?.summary) {
    const value = {
      available: false,
      reason: run.parseError || run.stderr || run.error || "surface atlas unavailable",
      run,
    };
    surfaceAtlasCache = { cachedAt: now, value };
    return value;
  }
  const value = {
    available: true,
    refreshedAt: run.endedAt,
    text: run.parsed.text,
    ...run.parsed.summary,
  };
  surfaceAtlasCache = { cachedAt: now, value };
  return value;
}

async function capabilityLedgerStatus({ maxAgeMs = 30_000 } = {}) {
  const now = Date.now();
  if (capabilityLedgerCache && now - capabilityLedgerCache.cachedAt < maxAgeMs) {
    return capabilityLedgerCache.value;
  }
  const run = await runChuckCli(["--capability-ledger", "--json"], {
    timeoutMs: dashboardCommandTimeoutMs({ kind: "capability-ledger" }),
  });
  if (!run.ok || !run.parsed?.ledger) {
    const value = {
      available: false,
      reason: run.parseError || run.stderr || run.error || "capability ledger unavailable",
      run,
    };
    capabilityLedgerCache = { cachedAt: now, value };
    return value;
  }
  const value = {
    available: true,
    refreshedAt: run.endedAt,
    text: run.parsed.text,
    summary: run.parsed.summary,
    entries: run.parsed.ledger.entries ?? [],
  };
  capabilityLedgerCache = { cachedAt: now, value };
  return value;
}

function modelDoctorStatus() {
  const latest = latestJsonInDir(MODEL_DOCTOR_DIR);
  if (!latest) {
    return { available: false, reason: "no model doctor run yet" };
  }
  const report = latest.data;
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const nextActions = rows
    .filter((row) => row.status !== "ready" || row.countsAsLoadBearingFamily !== true)
    .map((row) => ({
      family: row.family,
      surface: row.surface,
      status: row.status,
      executionStatus: row.executionStatus,
      nextAction: row.nextAction,
    }));
  return {
    available: true,
    path: latest.path,
    generatedAt: report.generatedAt ?? null,
    configuredVoices: report.configuredVoices ?? rows.length,
    readyFamilies: Array.isArray(report.readyFamilies) ? report.readyFamilies : [],
    executionReadyFamilies: Array.isArray(report.executionReadyFamilies)
      ? report.executionReadyFamilies
      : [],
    blockedFamilies: Array.isArray(report.blockedFamilies) ? report.blockedFamilies : [],
    unknownFamilies: Array.isArray(report.unknownFamilies) ? report.unknownFamilies : [],
    configuredButNotExecutableSurfaces: Array.isArray(report.configuredButNotExecutableSurfaces)
      ? report.configuredButNotExecutableSurfaces
      : [],
    canRunLoadBearingMinimumFleet: Boolean(report.canRunLoadBearingMinimumFleet),
    canRunLoadBearingHighRiskFleet: Boolean(report.canRunLoadBearingHighRiskFleet),
    nextActions,
  };
}

function familyRegistryStatus() {
  const latest = latestJsonInDir(ONBOARDING_DIR);
  if (!latest) {
    return { available: false, reason: "no onboarding registry snapshot yet" };
  }
  const report = latest.data;
  const catalog = Array.isArray(report.familyMemberCatalog) ? report.familyMemberCatalog : [];
  const doctorRows = Array.isArray(report.doctor?.rows) ? report.doctor.rows : [];
  const doctorBySurface = new Map(doctorRows.map((row) => [row.surface, row]));
  const enrichedCatalog = catalog.map((member) => {
    const doctor = doctorBySurface.get(member.surface);
    return Object.assign({}, member, {
      setupStatus: doctor?.status ?? member.status,
      executionStatus: doctor?.executionStatus ?? null,
      countsAsLoadBearingFamily: doctor?.countsAsLoadBearingFamily === true,
      nextAction: doctor?.nextAction ?? "",
    });
  });
  const byFamily = new Map();
  for (const member of enrichedCatalog) {
    const family = String(member.family ?? "unknown");
    const row = byFamily.get(family) ?? {
      family,
      total: 0,
      configured: 0,
      planned: 0,
      primary: 0,
      children: 0,
      cousins: 0,
    };
    row.total += 1;
    if (member.status === "configured") {
      row.configured += 1;
    }
    if (member.status === "planned") {
      row.planned += 1;
    }
    if (member.role === "primary") {
      row.primary += 1;
    }
    if (member.role === "child") {
      row.children += 1;
    }
    if (member.role === "cousin" || member.role === "local-model") {
      row.cousins += 1;
    }
    byFamily.set(family, row);
  }
  return {
    available: true,
    path: latest.path,
    runId: report.runId ?? null,
    generatedAt: report.generatedAt ?? null,
    readinessScore: report.readinessScore ?? null,
    status: report.status ?? "unknown",
    configuredFamilies: report.doctor?.configuredFamilies ?? [],
    executionReadyFamilies: report.doctor?.executionReadyFamilies ?? [],
    familyMemberCount: enrichedCatalog.length,
    configuredMemberCount: enrichedCatalog.filter((member) => member.status === "configured")
      .length,
    plannedMemberCount: enrichedCatalog.filter((member) => member.status === "planned").length,
    loadBearingSurfaceCount: Array.isArray(report.doctor?.rows)
      ? report.doctor.rows.filter((row) => row.countsAsLoadBearingFamily === true).length
      : 0,
    byFamily: [...byFamily.values()].toSorted((a, b) => a.family.localeCompare(b.family)),
    catalog: enrichedCatalog.slice(0, 80),
  };
}

function latestRunnerExecutionStatus({ minimumSurfaces = 1 } = {}) {
  if (!existsSync(RUNNER_EXECUTIONS_DIR)) {
    return { available: false, reason: "no runner executions yet" };
  }
  const files = safe(
    () =>
      readdirSync(RUNNER_EXECUTIONS_DIR)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const path = join(RUNNER_EXECUTIONS_DIR, name);
          return { name, path, mtimeMs: safe(() => statSync(path).mtimeMs, 0) };
        })
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name)),
    [],
  );
  for (const file of files) {
    const data = readJsonSafe(file.path, null);
    const executions = Array.isArray(data?.executions) ? data.executions : [];
    if (executions.length < minimumSurfaces) {
      continue;
    }
    const receipts = Array.isArray(data?.receipts) ? data.receipts : [];
    const lateRecoveries = lateSurfaceRecoveries();
    const completed = executions.filter((execution) => execution?.status === "completed");
    const failed = executions.filter((execution) => execution?.status === "failed");
    const skipped = executions.filter((execution) => execution?.status === "skipped");
    const eligibleExecutions = completed.filter(
      (execution) =>
        execution?.countingEligible === true || execution?.receipt?.modelVerified === true,
    );
    const eligibleFamilies = [
      ...new Set(eligibleExecutions.map((execution) => execution.family).filter(Boolean)),
    ];
    const completedSurfaces = completed.map((execution) => ({
      family: execution.family ?? "unknown",
      surface: execution.surface ?? "unknown",
      countingEligible:
        execution.countingEligible === true || execution.receipt?.modelVerified === true,
      modelClaimed: execution.receipt?.modelClaimed ?? null,
      actualRunner: execution.receipt?.actualRunner ?? null,
      lateRecovery: recoveryForSurface(lateRecoveries, execution.surface),
    }));
    const misses = [...failed, ...skipped].map((execution) => ({
      family: execution.family ?? "unknown",
      surface: execution.surface ?? "unknown",
      status:
        recoveryForSurface(lateRecoveries, execution.surface)?.status ??
        execution.status ??
        "unknown",
      originalStatus: execution.status ?? "unknown",
      reason: execution.reason ?? "",
      lateRecovery: recoveryForSurface(lateRecoveries, execution.surface),
    }));
    const recoveredSurfaces = lateRecoveries.filter((recovery) =>
      executions.some((execution) => execution.surface === recovery.surface),
    );
    const lateOnlyRecoveries = lateRecoveries.filter(
      (recovery) => !executions.some((execution) => execution.surface === recovery.surface),
    );
    return {
      available: true,
      path: file.path,
      file: file.name,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      dispatchId: data?.dispatchId ?? null,
      runId: data?.runId ?? null,
      totalTasks: executions.length,
      completedCount: completed.length,
      failedCount: failed.length,
      skippedCount: skipped.length,
      recoveredCount: lateRecoveries.length,
      recoveredInExecutionCount: recoveredSurfaces.length,
      receiptCount: receipts.length,
      eligibleFamilies,
      independentEligibleFamilyCount: eligibleFamilies.length,
      completedSurfaces,
      misses,
      lateRecoveries,
      lateOnlyRecoveries,
    };
  }
  return {
    available: false,
    reason: `no runner execution with at least ${minimumSurfaces} surface(s)`,
  };
}

function summarizeBuilderRun(run) {
  const tests = Array.isArray(run.tests) ? run.tests : [];
  return {
    runId: run.runId ?? "(unknown)",
    objective: run.objective ?? "",
    stage: run.stage ?? "unknown",
    disposition: run.disposition ?? "unknown",
    operatorActionRequired: Boolean(run.operatorActionRequired),
    updatedAt: run.updatedAt ?? run.createdAt ?? null,
    createdAt: run.createdAt ?? null,
    targetFiles: Array.isArray(run.targetFiles) ? run.targetFiles : [],
    authorityDiffId: run.authorityDiffId ?? null,
    intentAnchorId: run.intentAnchorId ?? null,
    intentAnchorPath: run.intentAnchorPath ?? null,
    worktreePath: run.worktreePath ?? null,
    patchPath: run.patchPath ?? run.patch?.patchPath ?? null,
    planPath: run.planPath ?? null,
    proposedFiles: Array.isArray(run.implementationPlan?.proposedFiles)
      ? run.implementationPlan.proposedFiles
      : [],
    planSummary: run.implementationPlan?.summary ?? null,
    testsPassed: tests.filter((test) => test?.passed).length,
    testsTotal: tests.length,
    reasons: Array.isArray(run.reasons) ? run.reasons.slice(0, 6) : [],
  };
}

function listProcesses() {
  let r;
  try {
    r = spawnSync("pgrep", ["-af", "apex-|chuck-|node.*apex"], { encoding: "utf8", timeout: 4000 });
  } catch {
    return { available: false, reason: "pgrep not callable" };
  }
  if (r.error) {
    return { available: false, reason: r.error.message ?? r.error };
  }
  const out = (r.stdout ?? "").trim();
  if (!out) {
    return { available: true, processes: [] };
  }
  const me = process.pid;
  const procs = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) {
      continue;
    }
    const pid = Number(m[1]);
    if (pid === me) {
      continue;
    }
    const cmd = m[2];
    if (!/(apex-|chuck-)/.test(cmd)) {
      continue;
    }
    let etime = null;
    let rss = null;
    try {
      const ps = spawnSync("ps", ["-o", "etime=,rss=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2000,
      });
      const t = (ps.stdout ?? "").trim();
      if (t) {
        const parts = t.split(/\s+/);
        etime = parts[0] ?? null;
        rss = parts[1] ? Number(parts[1]) * 1024 : null;
      }
    } catch {
      /* ignore */
    }
    procs.push({
      pid,
      command: cmd.length > 240 ? cmd.slice(0, 237) + "…" : cmd,
      shortName: shortNameForCmd(cmd),
      etime,
      rss,
    });
  }
  procs.sort((a, b) => a.shortName.localeCompare(b.shortName));
  return { available: true, processes: procs };
}

function repoHygieneStatus() {
  let result;
  try {
    result = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 5000,
    });
  } catch {
    return { available: false, reason: "git status not callable" };
  }
  if (result.error) {
    return { available: false, reason: result.error.message ?? result.error };
  }
  if (result.status !== 0) {
    return {
      available: false,
      reason: (result.stderr ?? "").trim() || `git status exited ${result.status}`,
    };
  }
  const entries = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const path = rawPath.includes(" -> ") ? (rawPath.split(" -> ").at(-1) ?? rawPath) : rawPath;
      const bucket = repoHygieneBucket(path);
      return {
        status,
        path,
        bucket,
        tracked: status !== "??",
        untracked: status === "??",
        modified: status !== "??",
      };
    });
  const buckets = new Map();
  for (const entry of entries) {
    const bucket = buckets.get(entry.bucket) ?? {
      bucket: entry.bucket,
      total: 0,
      tracked: 0,
      untracked: 0,
      examples: [],
    };
    bucket.total += 1;
    if (entry.tracked) {
      bucket.tracked += 1;
    }
    if (entry.untracked) {
      bucket.untracked += 1;
    }
    if (bucket.examples.length < 8) {
      bucket.examples.push({ status: entry.status, path: entry.path });
    }
    buckets.set(entry.bucket, bucket);
  }
  const trackedModified = entries.filter((entry) => entry.tracked).length;
  const untracked = entries.filter((entry) => entry.untracked).length;
  return {
    available: true,
    clean: entries.length === 0,
    total: entries.length,
    trackedModified,
    untracked,
    buckets: [...buckets.values()].toSorted(
      (a, b) => b.total - a.total || a.bucket.localeCompare(b.bucket),
    ),
    blockers: repoHygieneBlockers(entries),
    policy: [
      "runtime state belongs under ~/.openclaw/workspace/state, not the repo",
      "self-build patches must run in shadow worktrees and refuse dirty target files",
      "old salvage should be archived or committed intentionally, not left as ambiguous untracked work",
      "same-session work should land as small checkpoints once tests pass",
    ],
  };
}

function latestRepoHygieneCheckpointStatus() {
  if (!existsSync(REPO_HYGIENE_DIR)) {
    return { available: false, reason: "no repo hygiene checkpoints yet" };
  }
  const dirs = safe(
    () =>
      readdirSync(REPO_HYGIENE_DIR)
        .map((name) => {
          const path = join(REPO_HYGIENE_DIR, name);
          return { name, path, mtimeMs: safe(() => statSync(path).mtimeMs, 0) };
        })
        .filter((entry) => safe(() => statSync(entry.path).isDirectory(), false))
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name)),
    [],
  );
  const latest = dirs[0];
  if (!latest) {
    return { available: false, reason: "no repo hygiene checkpoints yet" };
  }
  const planPath = join(latest.path, "plan.json");
  const reportPath = join(latest.path, "report.json");
  const remediationMarkdownPath = join(latest.path, "remediation.md");
  const commandPlanPath = join(latest.path, "commands.review-only.sh");
  const laneManifestDir = join(latest.path, "lanes");
  const plan = readJsonSafe(planPath, null);
  const report = readJsonSafe(reportPath, null);
  const lanes = existsSync(laneManifestDir)
    ? safe(
        () =>
          readdirSync(laneManifestDir)
            .filter((name) => name.endsWith(".json"))
            .map((name) => readJsonSafe(join(laneManifestDir, name), null))
            .filter(Boolean)
            .map((lane) => ({
              laneId: lane.laneId,
              title: lane.title,
              disposition: lane.disposition,
              risk: lane.risk,
              pathCount: Array.isArray(lane.paths) ? lane.paths.length : 0,
              pathsFile: join(laneManifestDir, `${lane.laneId}.paths`),
            }))
            .toSorted((a, b) => a.laneId.localeCompare(b.laneId)),
        [],
      )
    : [];
  return {
    available: true,
    checkpointId: latest.name,
    checkpointDir: latest.path,
    updatedAt: new Date(latest.mtimeMs).toISOString(),
    broadSelfBuildAllowed: Boolean(plan?.broadSelfBuildAllowed),
    targetedSelfBuildAllowed: Boolean(plan?.targetedSelfBuildAllowed),
    totalPaths: report?.available ? report.total : null,
    blockers: report?.available && Array.isArray(report.blockers) ? report.blockers : [],
    laneManifestDir,
    remediationMarkdownPath,
    commandPlanPath,
    planPath,
    reportPath,
    lanes,
  };
}

function latestGitHubHygieneCheckpointStatus() {
  if (!existsSync(GITHUB_HYGIENE_DIR)) {
    return { available: false, reason: "no GitHub hygiene checkpoints yet" };
  }
  const dirs = safe(
    () =>
      readdirSync(GITHUB_HYGIENE_DIR)
        .map((name) => {
          const path = join(GITHUB_HYGIENE_DIR, name);
          return { name, path, mtimeMs: safe(() => statSync(path).mtimeMs, 0) };
        })
        .filter((entry) => safe(() => statSync(entry.path).isDirectory(), false))
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name)),
    [],
  );
  const latest = dirs[0];
  if (!latest) {
    return { available: false, reason: "no GitHub hygiene checkpoints yet" };
  }
  const reportPath = join(latest.path, "report.json");
  const branchManifestPath = join(latest.path, "branch-manifest.json");
  const deletionCandidatePath = join(latest.path, "delete-candidates.review-only.txt");
  const remediationMarkdownPath = join(latest.path, "remediation.md");
  const commandPlanPath = join(latest.path, "commands.review-only.sh");
  const report = readJsonSafe(reportPath, null);
  return {
    available: true,
    checkpointId: latest.name,
    checkpointDir: latest.path,
    updatedAt: new Date(latest.mtimeMs).toISOString(),
    forkRemote: report?.available ? report.forkRemote : null,
    upstreamRemote: report?.available ? report.upstreamRemote : null,
    currentBranch: report?.available ? report.currentBranch : null,
    totalForkBranches: report?.available ? report.totalForkBranches : null,
    totalUpstreamBranches: report?.available ? report.totalUpstreamBranches : null,
    forkOnlyCount: report?.available ? report.forkOnlyCount : null,
    deleteCandidateCount: report?.available ? report.deleteCandidateCount : null,
    protectedCount: report?.available ? report.protectedCount : null,
    blockers: report?.available && Array.isArray(report.blockers) ? report.blockers : [],
    categories: report?.available && Array.isArray(report.categories) ? report.categories : [],
    reportPath,
    branchManifestPath,
    deletionCandidatePath,
    remediationMarkdownPath,
    commandPlanPath,
  };
}

function latestUpstreamSyncCheckpointStatus() {
  if (!existsSync(UPSTREAM_SYNC_DIR)) {
    return { available: false, reason: "no upstream sync checkpoints yet" };
  }
  const dirs = safe(
    () =>
      readdirSync(UPSTREAM_SYNC_DIR)
        .map((name) => {
          const path = join(UPSTREAM_SYNC_DIR, name);
          return { name, path, mtimeMs: safe(() => statSync(path).mtimeMs, 0) };
        })
        .filter((entry) => safe(() => statSync(entry.path).isDirectory(), false))
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name)),
    [],
  );
  const latest = dirs[0];
  if (!latest) {
    return { available: false, reason: "no upstream sync checkpoints yet" };
  }
  const reportPath = join(latest.path, "report.json");
  const remediationMarkdownPath = join(latest.path, "remediation.md");
  const commandPlanPath = join(latest.path, "commands.review-only.sh");
  const report = readJsonSafe(reportPath, null);
  return {
    available: true,
    checkpointId: latest.name,
    checkpointDir: latest.path,
    updatedAt: new Date(latest.mtimeMs).toISOString(),
    currentBranch: report?.available ? report.currentBranch : null,
    packageVersion: report?.available ? report.packageVersion : null,
    describe: report?.available ? report.describe : null,
    latestStableTag: report?.available ? report.latestStableTag : null,
    stableContained: report?.available ? report.stableContained : null,
    stableMissingCommits: report?.available ? report.stableMissingCommits : null,
    localCommitsAfterStable: report?.available ? report.localCommitsAfterStable : null,
    mainMissingCommits: report?.available ? report.mainMissingCommits : null,
    localCommitsAheadOfMain: report?.available ? report.localCommitsAheadOfMain : null,
    stableBehind: report?.available ? report.stableBehind : null,
    mainBehind: report?.available ? report.mainBehind : null,
    localDirty: report?.available ? report.localDirty : null,
    broadSyncAllowed: report?.available ? report.broadSyncAllowed : false,
    blockers: report?.available && Array.isArray(report.blockers) ? report.blockers : [],
    nextActions: report?.available && Array.isArray(report.nextActions) ? report.nextActions : [],
    reportPath,
    remediationMarkdownPath,
    commandPlanPath,
  };
}

function repoHygieneBucket(path) {
  if (path.startsWith("extensions/memory-graph/src/chuck-v2/")) {
    return "chuck-v2-source";
  }
  if (
    path.startsWith("extensions/memory-graph/scripts/chuck-") ||
    path.startsWith("extensions/memory-graph/scripts/research-")
  ) {
    return "chuck-surface-drivers";
  }
  if (path.startsWith("extensions/memory-graph/data/chuck-v2-design/")) {
    return "chuck-v3-docs";
  }
  if (path.startsWith("extensions/memory-graph/scripts/apex-") || path.startsWith("skills/apex-")) {
    return "apex-salvage";
  }
  if (path.startsWith("extensions/memory-graph/")) {
    return "memory-graph-extension";
  }
  if (path.startsWith("ui-phone") || path.startsWith("ui-phone-v3")) {
    return "phone-ui";
  }
  if (path.startsWith("src/") || path.startsWith("test/") || path.startsWith("ui/")) {
    return "openclaw-core";
  }
  if (path.startsWith(".") || path.startsWith("tmp/") || path.startsWith("analysis/")) {
    return "local-generated";
  }
  return "other";
}

function repoHygieneBlockers(entries) {
  const blockers = [];
  const trackedCore = entries.filter(
    (entry) => entry.tracked && ["openclaw-core", "memory-graph-extension"].includes(entry.bucket),
  );
  if (trackedCore.length > 0) {
    blockers.push(
      `${trackedCore.length} tracked core/extension file(s) need checkpoint, stash, or explicit ownership before broad self-build`,
    );
  }
  const apexSalvage = entries.filter((entry) => entry.bucket === "apex-salvage");
  if (apexSalvage.length > 20) {
    blockers.push(
      `${apexSalvage.length} Apex salvage file(s) should be archived, promoted, or excluded from active build scope`,
    );
  }
  const untrackedSource = entries.filter(
    (entry) =>
      entry.untracked &&
      !["local-generated", "chuck-v3-docs", "apex-salvage"].includes(entry.bucket),
  );
  if (untrackedSource.length > 0) {
    blockers.push(`${untrackedSource.length} untracked source-like file(s) need classification`);
  }
  return blockers;
}

function shortNameForCmd(cmd) {
  const m = cmd.match(/(apex-[a-z0-9-]+|chuck-[a-z0-9-]+)/);
  return m ? m[1] : cmd.slice(0, 40);
}

function panelsFromAudit(audit) {
  const last = audit?.recentPanelReturns?.lastPanel;
  if (!last?.runAtMs) {
    return { available: true, runs: [] };
  }
  const successes = (last.files ?? []).filter((f) => !f.isFail);
  const fleet = audit.fleet ?? [];
  const total = fleet.length || 11;
  const sortedBySize = [...successes].toSorted((a, b) => b.bytes - a.bytes);
  const big = sortedBySize[0] ?? null;
  const small = sortedBySize[sortedBySize.length - 1] ?? null;
  const runs = [
    {
      stem: last.stem ?? "(unknown)",
      runAtMs: last.runAtMs,
      runAtIso: new Date(last.runAtMs).toISOString(),
      returnRate: `${successes.length}/${total}`,
      largest: big ? { label: big.label, bytes: big.bytes } : null,
      smallest: small ? { label: small.label, bytes: small.bytes } : null,
      filesCount: (last.files ?? []).length,
    },
  ];
  return { available: true, runs };
}

function eventsLast24h() {
  let total = 0;
  let recent = [];
  try {
    const evts = readEvents({ since: "24h" });
    total = evts.length;
    recent = evts.slice(-30).toReversed();
  } catch {
    /* unreadable */
  }
  let global = null;
  try {
    global = eventStats();
  } catch {
    /* noop */
  }
  return {
    total24h: total,
    recent,
    global: global ? { total: global.total, bytes: global.bytes } : null,
  };
}

async function buildSnapshot() {
  const fleet = await safeAsync(fleetAudit, null);
  const principles = safe(principleStatus, { available: false });
  const processes = safe(listProcesses, { available: false });
  const repoHygiene = safe(repoHygieneStatus, {
    available: false,
    reason: "repo hygiene unavailable",
  });
  const repoHygieneCheckpoint = safe(latestRepoHygieneCheckpointStatus, {
    available: false,
    reason: "repo hygiene checkpoint unavailable",
  });
  const githubHygieneCheckpoint = safe(latestGitHubHygieneCheckpointStatus, {
    available: false,
    reason: "GitHub hygiene checkpoint unavailable",
  });
  const upstreamSyncCheckpoint = safe(latestUpstreamSyncCheckpointStatus, {
    available: false,
    reason: "upstream sync checkpoint unavailable",
  });
  const curator = safe(curatorStatus, { available: false });
  const scorer = principles;
  const router = safe(fleetRouterStatus, { available: false });
  const builder = safe(builderStatus, {
    available: false,
    reason: "builder status unavailable",
    latest: null,
    pendingApproval: [],
    recent: [],
  });
  const modelDoctor = safe(modelDoctorStatus, {
    available: false,
    reason: "model doctor unavailable",
  });
  const familyRegistry = safe(familyRegistryStatus, {
    available: false,
    reason: "family registry unavailable",
  });
  const latestFleetRun = safe(() => latestRunnerExecutionStatus({ minimumSurfaces: 3 }), {
    available: false,
    reason: "latest fleet run unavailable",
  });
  const latestRunnerExecution = safe(() => latestRunnerExecutionStatus({ minimumSurfaces: 1 }), {
    available: false,
    reason: "latest runner execution unavailable",
  });
  const surfaceControl = safe(surfaceControlStatus, {
    available: false,
    reason: "surface control unavailable",
  });
  const surfaceAtlas = await safeAsync(surfaceAtlasStatus, {
    available: false,
    reason: "surface atlas unavailable",
  });
  const capabilityLedger = await safeAsync(capabilityLedgerStatus, {
    available: false,
    reason: "capability ledger unavailable",
  });
  const panels = safe(() => panelsFromAudit(fleet), { available: false, runs: [] });
  const events = safe(eventsLast24h, { total24h: 0, recent: [], global: null });
  return {
    time: new Date().toISOString(),
    fleet,
    principles,
    processes,
    repoHygiene,
    repoHygieneCheckpoint,
    githubHygieneCheckpoint,
    upstreamSyncCheckpoint,
    panels,
    curator,
    scorer,
    router,
    builder,
    modelDoctor,
    familyRegistry,
    latestFleetRun,
    latestRunnerExecution,
    surfaceControl,
    surfaceAtlas,
    capabilityLedger,
    recentEvents: events,
  };
}

function jsonResponse(res, code, body) {
  const txt = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(txt);
}

function htmlResponse(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

function methodNotAllowed(res) {
  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("method not allowed");
}

function httpError(message, statusCode = 500) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function readRequestJson(req, { maxBytes = MAX_COMMAND_BODY_BYTES } = {}) {
  return new Promise((resolveRequest, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(httpError("request body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolveRequest({});
        return;
      }
      try {
        resolveRequest(JSON.parse(raw));
      } catch {
        reject(httpError("invalid JSON body", 400));
      }
    });
    req.on("error", reject);
  });
}

function parseJsonStdout(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    throw new Error("command returned empty stdout");
  }
  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf("{");
    const firstBracket = text.indexOf("[");
    const starts = [firstBrace, firstBracket].filter((n) => n >= 0);
    if (starts.length === 0) {
      throw new Error("command stdout did not contain JSON");
    }
    const start = Math.min(...starts);
    return JSON.parse(text.slice(start));
  }
}

function dashboardCommandTimeoutMs({ kind, prompt = "", autoDeepen = true } = {}) {
  if (kind === "doctor") {
    return 180_000;
  }
  if (kind === "docket") {
    return 20_000;
  }
  if (kind === "surface-atlas") {
    return 20_000;
  }
  if (kind === "capability-ledger") {
    return 20_000;
  }
  if (kind === "build-plan") {
    return 25 * 60_000;
  }
  if (kind === "build-patch") {
    return 25 * 60_000;
  }
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const promptSeconds = Math.ceil(promptBytes / 1000) * 15_000;
  const deepenBudget = autoDeepen ? 8 * 60_000 : 0;
  return Math.min(30 * 60_000, 7 * 60_000 + promptSeconds + deepenBudget);
}

function runChuckCli(args, { timeoutMs, maxBufferBytes = 12 * 1024 * 1024 } = {}) {
  return new Promise((resolveRun) => {
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, ["--import", "tsx", CHUCK_V2_RUN, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CHUCK_WORKSTATION_RETURN_APP: process.env.CHUCK_WORKSTATION_RETURN_APP ?? "Codex",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      return next.length > maxBufferBytes ? next.slice(next.length - maxBufferBytes) : next;
    };
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill("SIGKILL");
        }
      }, 3000).unref();
    }, timeoutMs);
    timer.unref();
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({
        ok: false,
        timedOut,
        exitCode: null,
        signal: null,
        startedAt,
        endedAt: new Date().toISOString(),
        args,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      let parsed = null;
      let parseError = null;
      if (exitCode === 0 && !timedOut) {
        try {
          parsed = parseJsonStdout(stdout);
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }
      }
      resolveRun({
        ok: exitCode === 0 && !timedOut && !parseError,
        timedOut,
        exitCode,
        signal,
        startedAt,
        endedAt: new Date().toISOString(),
        args,
        stdout: parsed ? undefined : stdout.slice(-16_000),
        stderr: stderr.slice(-16_000),
        parsed,
        parseError,
      });
    });
  });
}

async function handleChuckDoctor(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const run = await runChuckCli(["--doctor", "--probe", "--json"], {
    timeoutMs: dashboardCommandTimeoutMs({ kind: "doctor" }),
  });
  return jsonResponse(res, run.ok ? 200 : 500, run);
}

async function handleChuckDocket(req, res) {
  if (req.method !== "GET") {
    return methodNotAllowed(res);
  }
  const run = await runChuckCli(["--docket", "--json"], {
    timeoutMs: dashboardCommandTimeoutMs({ kind: "docket" }),
  });
  return jsonResponse(res, run.ok ? 200 : 500, run);
}

async function handleRepoHygieneCheckpoint(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const run = await runChuckCli(["--repo-hygiene-checkpoint", "--json"], {
    timeoutMs: 60_000,
  });
  return jsonResponse(res, run.ok ? 200 : 500, run);
}

async function handleGitHubHygieneCheckpoint(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const run = await runChuckCli(["--github-hygiene-checkpoint", "--json"], {
    timeoutMs: 120_000,
  });
  return jsonResponse(res, run.ok ? 200 : 500, run);
}

async function handleUpstreamSyncCheckpoint(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const run = await runChuckCli(["--upstream-sync-checkpoint", "--json"], {
    timeoutMs: 120_000,
  });
  return jsonResponse(res, run.ok ? 200 : 500, run);
}

async function handleChuckOnboard(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = req.method === "POST" ? await readRequestJson(req) : {};
  const prompt = String(body.prompt ?? "").trim();
  const candidate = parseOnboardCandidatePrompt(prompt);
  const member = parseOnboardMemberPrompt(prompt);
  const proveSurface = parseOnboardProvePrompt(prompt);
  const args = candidate
    ? ["--onboard-candidate", candidate.familyOrProduct, candidate.surface, "--json"]
    : member
      ? ["--onboard-member", member.family, member.surface, "--json"]
      : proveSurface
        ? ["--onboard-prove", proveSurface, "--json"]
        : [body.repair === true ? "--onboard-repair" : "--onboard", "--json"];
  const run = await runChuckCli(args, {
    timeoutMs: dashboardCommandTimeoutMs({ kind: "doctor" }),
  });
  return jsonResponse(res, run.ok ? 200 : 500, run);
}

function parseOnboardCandidatePrompt(prompt) {
  const parts = prompt.split(/\s+/).filter(Boolean);
  if (parts[0]?.toLowerCase() !== "candidate") {
    return null;
  }
  const familyOrProduct = parts[1]?.trim();
  const surface = parts[2]?.trim();
  if (!familyOrProduct || !surface) {
    throw httpError("candidate onboarding needs: candidate <family-or-product> <surface>", 400);
  }
  return { familyOrProduct, surface };
}

function parseOnboardMemberPrompt(prompt) {
  const parts = prompt.split(/\s+/).filter(Boolean);
  const command = parts[0]?.toLowerCase();
  if (command !== "member" && command !== "surface" && command !== "child") {
    return null;
  }
  const family = parts[1]?.trim();
  const surface = parts[2]?.trim();
  if (!family || !surface) {
    throw httpError("family-member onboarding needs: member <family> <surface>", 400);
  }
  return { family, surface };
}

function parseOnboardProvePrompt(prompt) {
  const parts = prompt.split(/\s+/).filter(Boolean);
  const command = parts[0]?.toLowerCase();
  if (command !== "prove" && command !== "proof") {
    return null;
  }
  const surface = parts[1]?.trim();
  if (!surface) {
    throw httpError("surface proof needs: prove <surface>", 400);
  }
  return surface;
}

async function handleChuckScout(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) {
    throw httpError("prompt is required", 400);
  }
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw httpError("prompt too large for dashboard command surface", 413);
  }
  const autoDeepen = body.autoDeepen !== false;
  const args = ["--live-scout", "--json"];
  if (!autoDeepen) {
    args.push("--no-auto-deepen");
  }
  if (body.includeProvisional === true) {
    args.push("--include-provisional");
  }
  if (Array.isArray(body.onlySurfaces) && body.onlySurfaces.length > 0) {
    const surfaces = body.onlySurfaces
      .map((value) => String(value).trim())
      .filter(Boolean)
      .join(",");
    if (surfaces) {
      args.push("--only-surfaces", surfaces);
    }
  }
  args.push(prompt);
  const run = await runChuckCli(args, {
    timeoutMs: dashboardCommandTimeoutMs({ kind: "scout", prompt, autoDeepen }),
  });
  return jsonResponse(res, run.ok ? 200 : 500, run);
}

async function handleChuckBuildPlan(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const objective = String(body.objective ?? body.prompt ?? "").trim();
  if (!objective) {
    throw httpError("objective is required", 400);
  }
  if (Buffer.byteLength(objective, "utf8") > MAX_PROMPT_BYTES) {
    throw httpError("objective too large for dashboard builder surface", 413);
  }
  const run = await runChuckCli(["--build-plan", "--json", objective], {
    timeoutMs: dashboardCommandTimeoutMs({ kind: "build-plan", prompt: objective }),
  });
  return jsonResponse(res, run.ok ? 200 : 500, run);
}

async function handleChuckBuildPatch(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const objective = String(body.objective ?? body.prompt ?? "").trim();
  const patchFile = String(body.patchFile ?? "").trim();
  if (!objective) {
    throw httpError("objective is required", 400);
  }
  if (!patchFile) {
    throw httpError("patchFile is required", 400);
  }
  if (Buffer.byteLength(objective, "utf8") > MAX_PROMPT_BYTES) {
    throw httpError("objective too large for dashboard builder surface", 413);
  }
  const args = ["--build-patch-file", "--json", "--patch-file", patchFile];
  if (Array.isArray(body.targetFiles)) {
    const targets = body.targetFiles
      .map((value) => String(value).trim())
      .filter(Boolean)
      .join(",");
    if (targets) {
      args.push("--target", targets);
    }
  }
  args.push(objective);
  const run = await runChuckCli(args, {
    timeoutMs: dashboardCommandTimeoutMs({ kind: "build-patch", prompt: objective }),
  });
  return jsonResponse(res, run.ok ? 200 : 500, run);
}

async function handleChuckBuildGenerate(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const objective = String(body.objective ?? body.prompt ?? "").trim();
  if (!objective) {
    throw httpError("objective is required", 400);
  }
  if (Buffer.byteLength(objective, "utf8") > MAX_PROMPT_BYTES) {
    throw httpError("objective too large for dashboard builder surface", 413);
  }
  const args = ["--build-generate-patch", "--json"];
  if (Array.isArray(body.targetFiles)) {
    const targets = body.targetFiles
      .map((value) => String(value).trim())
      .filter(Boolean)
      .join(",");
    if (targets) {
      args.push("--target", targets);
    }
  }
  args.push(objective);
  const run = await runChuckCli(args, {
    timeoutMs: dashboardCommandTimeoutMs({ kind: "build-patch", prompt: objective }),
  });
  return jsonResponse(res, run.ok ? 200 : 500, run);
}

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url || "/", "http://localhost");
  const url = parsedUrl.pathname;
  try {
    if (url === "/") {
      return htmlResponse(res, DASHBOARD_HTML);
    }
    if (url === "/api/snapshot") {
      return jsonResponse(res, 200, await buildSnapshot());
    }
    if (url === "/api/fleet") {
      return jsonResponse(res, 200, await safeAsync(fleetAudit, { available: false }));
    }
    if (url === "/api/principles") {
      return jsonResponse(res, 200, principleStatus());
    }
    if (url === "/api/processes") {
      return jsonResponse(res, 200, listProcesses());
    }
    if (url === "/api/repo-hygiene") {
      return jsonResponse(res, 200, repoHygieneStatus());
    }
    if (url === "/api/repo-hygiene/latest-checkpoint") {
      return jsonResponse(res, 200, latestRepoHygieneCheckpointStatus());
    }
    if (url === "/api/repo-hygiene/checkpoint") {
      return await handleRepoHygieneCheckpoint(req, res);
    }
    if (url === "/api/github-hygiene/latest-checkpoint") {
      return jsonResponse(res, 200, latestGitHubHygieneCheckpointStatus());
    }
    if (url === "/api/github-hygiene/checkpoint") {
      return await handleGitHubHygieneCheckpoint(req, res);
    }
    if (url === "/api/upstream-sync/latest-checkpoint") {
      return jsonResponse(res, 200, latestUpstreamSyncCheckpointStatus());
    }
    if (url === "/api/upstream-sync/checkpoint") {
      return await handleUpstreamSyncCheckpoint(req, res);
    }
    if (url === "/api/panels") {
      const a = await safeAsync(fleetAudit, null);
      return jsonResponse(res, 200, panelsFromAudit(a));
    }
    if (url === "/api/curator") {
      return jsonResponse(res, 200, curatorStatus());
    }
    if (url === "/api/scorer") {
      return jsonResponse(res, 200, principleStatus());
    }
    if (url === "/api/router") {
      return jsonResponse(res, 200, fleetRouterStatus());
    }
    if (url === "/api/chuck-v2/build/status" || url === "/api/chuck-v2/build/docket") {
      return jsonResponse(res, 200, builderStatus());
    }
    if (url === "/api/chuck-v2/build") {
      return await handleChuckBuildPlan(req, res);
    }
    if (url === "/api/chuck-v2/build/generate") {
      return await handleChuckBuildGenerate(req, res);
    }
    if (url === "/api/chuck-v2/build/patch") {
      return await handleChuckBuildPatch(req, res);
    }
    if (url === "/api/chuck-v2/doctor") {
      return await handleChuckDoctor(req, res);
    }
    if (url === "/api/chuck-v2/onboard") {
      return await handleChuckOnboard(req, res);
    }
    if (url === "/api/chuck-v2/docket") {
      return await handleChuckDocket(req, res);
    }
    if (url === "/api/chuck-v2/scout") {
      return await handleChuckScout(req, res);
    }
    if (url === "/api/chuck-v2/surface-control") {
      return jsonResponse(res, 200, surfaceControlStatus());
    }
    if (url === "/api/chuck-v2/surface-atlas") {
      return jsonResponse(res, 200, await surfaceAtlasStatus({ maxAgeMs: 0 }));
    }
    if (url === "/api/chuck-v2/capability-ledger") {
      return jsonResponse(res, 200, await capabilityLedgerStatus({ maxAgeMs: 0 }));
    }
    if (url === "/api/chuck-v2/latest-fleet-run") {
      return jsonResponse(res, 200, latestRunnerExecutionStatus({ minimumSurfaces: 3 }));
    }
    if (url === "/events") {
      return handleSse(req, res);
    }
    return notFound(res);
  } catch (err) {
    const statusCode = Number(err?.statusCode ?? 500);
    res.writeHead(statusCode, { "Content-Type": "text/plain" });
    res.end(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 5000\n\n");
  res.write(`: connected ${new Date().toISOString()}\n\n`);
  const hb = setInterval(() => {
    try {
      res.write(`: hb ${Date.now()}\n\n`);
    } catch {
      /* noop */
    }
  }, 15_000);
  let off = null;
  try {
    off = subscribeFile({}, (evt) => {
      try {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      } catch {
        /* dropped */
      }
    });
  } catch {
    res.write(`event: error\ndata: ${JSON.stringify({ error: "subscribeFile unavailable" })}\n\n`);
  }
  const cleanup = () => {
    clearInterval(hb);
    try {
      off?.();
    } catch {
      /* noop */
    }
    try {
      res.end();
    } catch {
      /* noop */
    }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Chuck Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --bg-2: #161b22; --bg-3: #1f2530;
    --fg: #e6edf3; --fg-dim: #8b949e; --fg-faint: #6e7681;
    --border: #30363d;
    --ok: #3fb950; --warn: #d29922; --err: #f85149; --info: #58a6ff; --accent: #bc8cff;
    --vendor-anthropic: #d97757; --vendor-openai: #10a37f; --vendor-google: #4285f4;
    --vendor-xai: #8b5cf6; --vendor-perplexity: #ec4899; --vendor-meta-local: #6b7280; --vendor-unknown: #475569;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: var(--sans); font-size: 14px; }
  a { color: var(--info); }
  header.topbar { position: sticky; top: 0; z-index: 10; background: var(--bg-2); border-bottom: 1px solid var(--border);
    padding: 10px 20px; display: flex; align-items: center; gap: 24px; font-family: var(--mono); font-size: 13px; }
  header.topbar .title { font-weight: 600; color: var(--accent); letter-spacing: 0.05em; }
  header.topbar .pill { background: var(--bg-3); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; color: var(--fg-dim); }
  header.topbar .pill b { color: var(--fg); font-weight: 500; }
  main { padding: 20px; max-width: 1500px; margin: 0 auto; }
  section { margin-bottom: 28px; }
  h2.section { font-family: var(--mono); font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--fg-dim); margin: 0 0 10px 0; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .grid { display: grid; gap: 12px; }
  .grid.cards { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  .grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  @media (max-width: 900px) { .grid.three { grid-template-columns: 1fr; } }
  .card { background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; transition: border-color 0.15s; }
  .card.voice { display: flex; flex-direction: column; gap: 6px; position: relative; }
  .card.voice .vrow { display: flex; justify-content: space-between; align-items: baseline; }
  .card.voice .vid { font-family: var(--mono); font-size: 13px; color: var(--fg); font-weight: 500; }
  .card.voice .mark { font-family: var(--mono); font-size: 14px; }
  .card.voice .mark.ok { color: var(--ok); }
  .card.voice .mark.warn { color: var(--warn); }
  .card.voice .mark.err { color: var(--err); }
  .card.voice .mark.unk { color: var(--fg-faint); }
  .card.voice .meta { font-size: 11px; color: var(--fg-dim); font-family: var(--mono); }
  .card.voice .ago { color: var(--fg-faint); font-size: 11px; }
  .card.voice .ratebar { display: flex; gap: 1px; height: 6px; margin-top: 4px; background: var(--bg-3); border-radius: 2px; overflow: hidden; }
  .card.voice .ratebar .fill { background: linear-gradient(90deg, var(--ok), var(--info)); height: 100%; }
  .card.voice[data-vendor="anthropic"]   { border-left: 3px solid var(--vendor-anthropic); }
  .card.voice[data-vendor="openai"]      { border-left: 3px solid var(--vendor-openai); }
  .card.voice[data-vendor="google"]      { border-left: 3px solid var(--vendor-google); }
  .card.voice[data-vendor="xai"]         { border-left: 3px solid var(--vendor-xai); }
  .card.voice[data-vendor="perplexity"]  { border-left: 3px solid var(--vendor-perplexity); }
  .card.voice[data-vendor="meta-local"]  { border-left: 3px solid var(--vendor-meta-local); }
  .card.voice[data-vendor="unknown"]     { border-left: 3px solid var(--vendor-unknown); }
  table.proc { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }
  table.proc th, table.proc td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); }
  table.proc th { color: var(--fg-dim); font-weight: 500; text-transform: uppercase; font-size: 10px; letter-spacing: 0.08em; }
  table.proc tr.hi td { background: var(--bg-3); }
  table.proc td.cmd { color: var(--fg-dim); max-width: 600px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  table.proc td.cmd b { color: var(--fg); }
  table.proc td.num { color: var(--info); text-align: right; }
  ul.princ { list-style: none; padding: 0; margin: 0; font-family: var(--mono); font-size: 12px; }
  ul.princ li { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px dashed var(--border); }
  ul.princ li .slug { color: var(--fg); }
  ul.princ li .w { color: var(--info); }
  table.heat { font-family: var(--mono); font-size: 11px; border-collapse: collapse; }
  table.heat th, table.heat td { padding: 4px 6px; border: 1px solid var(--border); text-align: center; }
  table.heat th { color: var(--fg-dim); }
  table.heat td.cell { background: var(--bg-3); color: var(--fg); }
  .command-panel { background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; }
  .command-panel textarea {
    width: 100%; min-height: 104px; resize: vertical; background: #0b0f15; color: var(--fg);
    border: 1px solid var(--border); border-radius: 4px; padding: 10px; font: 13px/1.45 var(--mono);
  }
  .command-panel input[type="text"] {
    width: 100%; background: #0b0f15; color: var(--fg);
    border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; font: 12px/1.35 var(--mono);
    margin-top: 8px;
  }
  .command-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
  .command-row button {
    background: var(--bg-3); color: var(--fg); border: 1px solid var(--border); border-radius: 4px;
    padding: 8px 10px; font: 12px var(--mono); cursor: pointer;
  }
  .command-row button.primary { border-color: var(--info); color: var(--info); }
  .command-row button:disabled { opacity: 0.55; cursor: progress; }
  .command-row label { color: var(--fg-dim); font: 12px var(--mono); display: inline-flex; gap: 5px; align-items: center; }
  #command-status { margin-top: 8px; color: var(--fg-dim); font: 12px var(--mono); min-height: 18px; }
  #command-result { margin-top: 12px; }
  .run-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .metric { background: #0b0f15; border: 1px solid var(--border); border-radius: 4px; padding: 8px; }
  .metric .k { color: var(--fg-dim); font: 10px var(--mono); text-transform: uppercase; letter-spacing: 0.08em; }
  .metric .v { color: var(--fg); font: 13px var(--mono); margin-top: 3px; overflow-wrap: anywhere; }
  .receipt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; }
  .receipt { background: #0b0f15; border: 1px solid var(--border); border-left: 3px solid var(--vendor-unknown); border-radius: 4px; padding: 8px; font: 12px var(--mono); }
  .receipt[data-family="anthropic"] { border-left-color: var(--vendor-anthropic); }
  .receipt[data-family="openai"] { border-left-color: var(--vendor-openai); }
  .receipt[data-family="google"] { border-left-color: var(--vendor-google); }
  .receipt[data-family="perplexity"] { border-left-color: var(--vendor-perplexity); }
  .receipt[data-family="xai"] { border-left-color: var(--vendor-xai); }
  .receipt[data-family="sovereign-local"] { border-left-color: var(--vendor-meta-local); }
  .receipt .top { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
  .receipt .family { color: var(--fg); font-weight: 600; }
  .receipt .status.ok { color: var(--ok); }
  .receipt .status.warn { color: var(--warn); }
  .receipt .status.err { color: var(--err); }
  .raw-json { margin-top: 10px; background: #0b0f15; border: 1px solid var(--border); border-radius: 4px; padding: 8px; max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-word; font: 11px var(--mono); color: var(--fg-dim); }
  ul.panels { list-style: none; padding: 0; margin: 0; font-family: var(--mono); font-size: 12px; }
  ul.panels li { padding: 8px 12px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 4px; margin-bottom: 6px; }
  ul.panels li .stem { color: var(--accent); font-weight: 500; }
  ul.panels li .meta { color: var(--fg-dim); font-size: 11px; margin-top: 2px; }
  #event-stream { background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px;
    height: 380px; overflow-y: auto; font-family: var(--mono); font-size: 11px; padding: 6px; }
  .ev { padding: 3px 6px; border-bottom: 1px dashed var(--border); cursor: pointer; }
  .ev:hover { background: var(--bg-3); }
  .ev .ts { color: var(--fg-faint); }
  .ev .src { color: var(--accent); }
  .ev .typ { color: var(--info); }
  .ev .pl { color: var(--fg-dim); }
  .ev.expanded .pl { white-space: pre-wrap; word-break: break-all; }
  .ev.new { animation: flash 0.6s ease-out; }
  @keyframes flash { from { background: rgba(88, 166, 255, 0.15); } to { background: transparent; } }
  .empty { color: var(--fg-faint); font-style: italic; padding: 8px 0; font-size: 12px; }
  .col-title { font-family: var(--mono); font-size: 11px; color: var(--fg-dim); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.08em; }
  .indicator-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--fg-faint); margin-right: 4px; vertical-align: middle; }
  .indicator-dot.live { background: var(--ok); box-shadow: 0 0 6px var(--ok); animation: pulse 1.6s infinite ease-in-out; }
  .indicator-dot.degraded { background: var(--warn); }
  .indicator-dot.dead { background: var(--err); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
</head>
<body>
<header class="topbar">
  <span class="title">CHUCK · DASHBOARD</span>
  <span class="pill"><span id="indicator" class="indicator-dot"></span><b id="hdr-time">—</b></span>
  <span class="pill">events 24h: <b id="hdr-events">—</b></span>
  <span class="pill">processes: <b id="hdr-procs">—</b></span>
  <span class="pill">builder: <b id="hdr-builder">—</b></span>
  <span class="pill">families: <b id="hdr-families">—</b></span>
	  <span class="pill">members: <b id="hdr-members">—</b></span>
	  <span class="pill">kernel-ready: <b id="hdr-kernel-ready">—</b></span>
	  <span class="pill">latest fleet: <b id="hdr-latest-fleet">—</b></span>
  <span class="pill">surface: <b id="hdr-surface">—</b></span>
  <span class="pill">atlas: <b id="hdr-atlas">—</b></span>
  <span class="pill">repo: <b id="hdr-repo">—</b></span>
  <span class="pill">last refresh: <b id="hdr-refresh">—</b></span>
  <span class="pill" id="hdr-sse" title="event stream connection">stream: <b id="hdr-sse-state">…</b></span>
</header>
<main>
<section><h2 class="section">Chuck Command Surface</h2>
  <div class="command-panel">
    <textarea id="command-prompt" spellcheck="false" placeholder="Ask Chuck to run a live Fleet Scout..."></textarea>
    <input id="command-patch-file" type="text" spellcheck="false" placeholder="Patch file path for Builder Patch" />
    <div class="command-row">
      <button id="command-run" class="primary">Run Fleet Scout</button>
      <button id="command-build">Builder Plan</button>
      <button id="command-build-generate">Builder Generate</button>
      <button id="command-build-patch">Builder Patch</button>
      <button id="command-onboard">Onboard</button>
      <button id="command-hygiene-checkpoint">Hygiene Checkpoint</button>
      <button id="command-github-checkpoint">GitHub Checkpoint</button>
      <button id="command-upstream-checkpoint">Upstream Checkpoint</button>
      <button id="command-doctor">Model Doctor</button>
      <button id="command-atlas">Surface Atlas</button>
      <button id="command-docket">Docket</button>
      <button id="command-clear">Clear</button>
      <label><input id="command-auto-deepen" type="checkbox" checked /> auto deepen</label>
      <label><input id="command-provisional" type="checkbox" /> include provisional surfaces</label>
    </div>
    <div id="command-status"></div>
    <div id="command-result"><div class="empty">ready</div></div>
  </div>
	</section>
	<section><h2 class="section">Fleet Readiness Board</h2><div id="capability-ledger"><div class="empty">loading…</div></div></section>
	<section><h2 class="section">Latest Fleet Run</h2><div id="latest-fleet-run"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Surface Return</h2><div id="surface-control"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Surface Atlas</h2><div id="surface-atlas"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Repo Hygiene</h2><div id="repo-hygiene"><div class="empty">loading…</div></div></section>
<section><h2 class="section">GitHub Hygiene</h2><div id="github-hygiene"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Upstream Sync</h2><div id="upstream-sync"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Chuck Builder</h2><div id="builder"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Model Doctor</h2><div id="model-doctor"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Family Registry</h2><div id="family-registry"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Chuck Fleet</h2><div id="fleet" class="grid cards"><div class="empty">loading…</div></div></section>
<section><h2 class="section">In-flight Processes</h2><div id="procs"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Phase A status</h2>
  <div class="grid three">
    <div class="card"><div class="col-title">Principle Scorer</div><div id="scorer"><div class="empty">loading…</div></div></div>
    <div class="card"><div class="col-title">Memory Curator</div><div id="curator"><div class="empty">loading…</div></div></div>
    <div class="card"><div class="col-title">Fleet Router</div><div id="router"><div class="empty">loading…</div></div></div>
  </div>
</section>
<section><h2 class="section">Recent Panels</h2><ul id="panels" class="panels"><li class="empty">loading…</li></ul></section>
<section><h2 class="section">Live Event Stream</h2><div id="event-stream"><div class="empty">connecting…</div></div></section>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const fmtBytes = (n) => {
    if (n == null) return "—";
    if (n < 1024) return n + "B";
    if (n < 1024*1024) return (n/1024).toFixed(1) + "KB";
    return (n/(1024*1024)).toFixed(1) + "MB";
  };
  const fmtAgo = (iso) => {
    if (!iso) return "never";
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const s = Math.floor(ms/1000);
    if (s < 60) return s + "s ago";
    const m = Math.floor(s/60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m/60);
    if (h < 48) return h + "h ago";
    return Math.floor(h/24) + "d ago";
  };
  const escHtml = (s) => String(s == null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

  const commandButtons = () => ["command-run", "command-build", "command-build-generate", "command-build-patch", "command-onboard", "command-hygiene-checkpoint", "command-github-checkpoint", "command-upstream-checkpoint", "command-doctor", "command-atlas", "command-docket"].map($).filter(Boolean);
  const setCommandBusy = (busy) => {
    for (const btn of commandButtons()) btn.disabled = busy;
  };
  const setCommandStatus = (text, tone) => {
    const el = $("command-status");
    el.textContent = text || "";
    el.style.color = tone === "err" ? "var(--err)" : tone === "ok" ? "var(--ok)" : "var(--fg-dim)";
  };
  const metric = (key, value) => '<div class="metric"><div class="k">' + escHtml(key) + '</div><div class="v">' + escHtml(value == null ? "—" : value) + '</div></div>';
  const rawBlock = (obj) => '<details><summary style="cursor:pointer;color:var(--fg-dim);font:12px var(--mono);">raw JSON</summary><pre class="raw-json">' + escHtml(JSON.stringify(obj, null, 2)) + '</pre></details>';
  const runSeconds = (run) => {
    const start = Date.parse(run?.startedAt || "");
    const end = Date.parse(run?.endedAt || "");
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
    return ((end - start) / 1000).toFixed(1) + "s";
  };

  async function fetchJsonOrThrow(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { ok: false, error: text }; }
    if (!response.ok) {
      const message = body?.error || body?.parseError || body?.stderr || "HTTP " + response.status;
      const err = new Error(String(message).slice(0, 500));
      err.body = body;
      throw err;
    }
    return body;
  }

  function renderCommandFailure(error) {
    const body = error?.body;
    $("command-result").innerHTML = '<div class="metric"><div class="k">failure</div><div class="v">' + escHtml(error?.message || error) + '</div></div>' + (body ? rawBlock(body) : "");
  }

	  function renderDoctorRun(run) {
	    const p = run.parsed || {};
	    const ledger = p.capabilityLedgerSummary || {};
	    const rows = [
	      metric("configured voices", p.configuredVoices),
	      metric("ready families", (p.readyFamilies || []).join(", ") || "none"),
	      metric("execution ready", (p.executionReadyFamilies || []).join(", ") || "none"),
	      metric("kernel-ready", (ledger.independentLoadBearingFamilies || []).join(", ") || "none"),
	      metric("load-bearing surfaces", ledger.loadBearingSurfaces),
	      metric("blocked", (p.blockedFamilies || []).join(", ") || "none"),
      metric("minimum fleet", p.canRunLoadBearingMinimumFleet ? "ready" : "not ready"),
      metric("high risk fleet", p.canRunLoadBearingHighRiskFleet ? "ready" : "not ready"),
      metric("elapsed", runSeconds(run)),
    ].join("");
    const actions = (p.nextActions || []).slice(0, 10).map((item) =>
      '<div class="receipt" data-family="' + escHtml(item.family) + '"><div class="top"><span class="family">' +
      escHtml(item.family + " · " + item.surface) + '</span><span class="status warn">' + escHtml(item.status) +
      '</span></div><div style="color:var(--fg-dim);">' + escHtml(item.nextAction || "") + '</div></div>'
    ).join("");
    $("command-result").innerHTML = '<div class="run-summary">' + rows + '</div>' +
      (actions ? '<div class="receipt-grid">' + actions + '</div>' : '<div class="empty">no next actions</div>') +
      rawBlock(p);
  }

  function renderDocketRun(run) {
    const rows = Array.isArray(run.parsed) ? run.parsed : [];
    if (!rows.length) {
      $("command-result").innerHTML = '<div class="empty">docket is empty</div>' + rawBlock(run.parsed || []);
      return;
    }
    $("command-result").innerHTML = '<div class="receipt-grid">' + rows.slice(0, 20).map((item) =>
      '<div class="receipt"><div class="top"><span class="family">' + escHtml(item.status || "open") +
      '</span><span class="status warn">' + escHtml((item.createdAt || "").slice(0, 10)) + '</span></div>' +
      '<div style="color:var(--fg);">' + escHtml(item.title || item.runId || "(untitled)") + '</div>' +
      '<div style="color:var(--fg-dim);margin-top:4px;">' + escHtml(item.runId || "") + '</div></div>'
    ).join("") + '</div>' + rawBlock(rows);
  }

  function renderScoutRun(run) {
    const p = run.parsed || {};
    const scout = p.scoutResolve || {};
    const deepen = p.deepenResolve || {};
    const receipts = p.runnerExecution?.receipts || [];
    const executions = p.runnerExecution?.executions || [];
    const statusForSurface = new Map(executions.map((item) => [item.surface, item.status]));
    const summary = [
      metric("run", p.runId),
      metric("stake", [p.stakeClass, p.taskClass].filter(Boolean).join(" / ")),
      metric("resolve", scout.disposition || p.disposition),
      metric("families", scout.independentUsableFamilyCount),
      metric("surfaces", (scout.usableSurfaces || []).length),
      metric("receipts", receipts.length),
      metric("deepen", deepen.disposition || (p.deepenPlan ? "planned" : "not run")),
      metric("elapsed", runSeconds(run)),
    ].join("");
    const cards = receipts.map((receipt) => {
      const status = statusForSurface.get(receipt.surface) || "completed";
      const cls = status === "completed" ? "ok" : status === "timeout" ? "warn" : "err";
      return '<div class="receipt" data-family="' + escHtml(receipt.actualFamily) + '">' +
        '<div class="top"><span class="family">' + escHtml(receipt.actualFamily) + '</span><span class="status ' + cls + '">' + escHtml(status) + '</span></div>' +
        '<div>' + escHtml(receipt.surface) + '</div>' +
        '<div style="color:var(--fg-dim);margin-top:4px;">' + escHtml(receipt.actualRunner || "") + '</div>' +
        '<div style="color:var(--fg-dim);margin-top:4px;">verified: ' + escHtml(receipt.modelVerified ? "yes" : "no") + '</div>' +
      '</div>';
    }).join("");
    const missing = executions.filter((execution) => execution.status !== "completed").map((execution) =>
      '<div class="receipt"><div class="top"><span class="family">' + escHtml(execution.surface) +
      '</span><span class="status err">' + escHtml(execution.status) + '</span></div><div style="color:var(--fg-dim);">' +
      escHtml(execution.reason || "") + '</div></div>'
    ).join("");
    $("command-result").innerHTML = '<div class="run-summary">' + summary + '</div>' +
      '<div class="receipt-grid">' + (cards || '<div class="empty">no receipts</div>') + missing + '</div>' +
      rawBlock(p);
  }

  async function runFleetScout() {
    const prompt = $("command-prompt").value.trim();
    if (!prompt) { setCommandStatus("Enter a prompt first.", "err"); return; }
    setCommandBusy(true);
    setCommandStatus("running live Fleet Scout...", "");
    $("command-result").innerHTML = '<div class="empty">dispatching sealed first passes…</div>';
    const started = Date.now();
    try {
      const run = await fetchJsonOrThrow("/api/chuck-v2/scout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          autoDeepen: $("command-auto-deepen").checked,
          includeProvisional: $("command-provisional").checked,
        }),
      });
      renderScoutRun(run);
      setCommandStatus("Fleet run complete in " + ((Date.now() - started) / 1000).toFixed(1) + "s.", run.ok ? "ok" : "err");
      pollSnapshot();
    } catch (error) {
      renderCommandFailure(error);
      setCommandStatus("Fleet run failed.", "err");
    } finally {
      setCommandBusy(false);
    }
  }

  async function runDoctorCommand() {
    setCommandBusy(true);
    setCommandStatus("probing model surfaces...", "");
    $("command-result").innerHTML = '<div class="empty">running model doctor…</div>';
    try {
      const run = await fetchJsonOrThrow("/api/chuck-v2/doctor", { method: "POST" });
      renderDoctorRun(run);
      setCommandStatus("doctor complete.", run.ok ? "ok" : "err");
      pollSnapshot();
    } catch (error) {
      renderCommandFailure(error);
      setCommandStatus("doctor failed.", "err");
    } finally {
      setCommandBusy(false);
    }
  }

  async function runDocketCommand() {
    setCommandBusy(true);
    setCommandStatus("loading docket...", "");
    try {
      const run = await fetchJsonOrThrow("/api/chuck-v2/docket", { method: "GET" });
      renderDocketRun(run);
      setCommandStatus("docket loaded.", run.ok ? "ok" : "err");
    } catch (error) {
      renderCommandFailure(error);
      setCommandStatus("docket failed.", "err");
    } finally {
      setCommandBusy(false);
    }
  }

  async function runSurfaceAtlasCommand() {
    setCommandBusy(true);
    setCommandStatus("loading Surface Atlas...", "");
    $("command-result").innerHTML = '<div class="empty">reading controls, shortcuts, abilities, tool routes, leases, and gaps…</div>';
    try {
      const atlas = await fetchJsonOrThrow("/api/chuck-v2/surface-atlas", { method: "GET" });
      renderSurfaceAtlas(atlas);
      $("command-result").innerHTML = '<div class="run-summary">' + [
        metric("surfaces", atlas.totalSurfaces),
        metric("configured", atlas.configuredSurfaces),
        metric("controls", atlas.controls),
        metric("shortcuts", atlas.shortcuts),
        metric("abilities", atlas.abilities),
        metric("return-required", atlas.returnRequired),
      ].join("") + '</div>' + rawBlock(atlas);
      setCommandStatus("Surface Atlas loaded.", atlas.available ? "ok" : "err");
      pollSnapshot();
    } catch (error) {
      renderCommandFailure(error);
      setCommandStatus("Surface Atlas failed.", "err");
    } finally {
      setCommandBusy(false);
    }
  }

  async function runHygieneCheckpointCommand() {
    setCommandBusy(true);
    setCommandStatus("freezing repo hygiene checkpoint...", "");
    $("command-result").innerHTML = '<div class="empty">writing status, diffs, manifest, and cleanup plan under Chuck state…</div>';
    try {
      const run = await fetchJsonOrThrow("/api/repo-hygiene/checkpoint", { method: "POST" });
      const parsed = run.parsed || {};
      const checkpoint = parsed.checkpoint || {};
      $("command-result").innerHTML = '<div class="run-summary">' + [
        metric("checkpoint", checkpoint.checkpointId),
        metric("directory", checkpoint.checkpointDir),
        metric("broad self-build", checkpoint.plan?.broadSelfBuildAllowed ? "allowed" : "blocked"),
        metric("targeted self-build", checkpoint.plan?.targetedSelfBuildAllowed ? "allowed with clean targets" : "blocked"),
      ].join("") + '</div>' + rawBlock(parsed || run);
      setCommandStatus("hygiene checkpoint complete.", run.ok ? "ok" : "err");
      pollSnapshot();
    } catch (error) {
      renderCommandFailure(error);
      setCommandStatus("hygiene checkpoint failed.", "err");
    } finally {
      setCommandBusy(false);
    }
  }

  async function runGitHubCheckpointCommand() {
    setCommandBusy(true);
    setCommandStatus("freezing GitHub hygiene checkpoint...", "");
    $("command-result").innerHTML = '<div class="empty">fetching remotes and writing branch manifests under Chuck state…</div>';
    try {
      const run = await fetchJsonOrThrow("/api/github-hygiene/checkpoint", { method: "POST" });
      const parsed = run.parsed || {};
      const checkpoint = parsed.checkpoint || {};
      const report = checkpoint.report || {};
      $("command-result").innerHTML = '<div class="run-summary">' + [
        metric("checkpoint", checkpoint.checkpointId),
        metric("directory", checkpoint.checkpointDir),
        metric("fork branches", report.totalForkBranches),
        metric("delete candidates", report.deleteCandidateCount),
      ].join("") + '</div>' + rawBlock(parsed || run);
      setCommandStatus("GitHub checkpoint complete.", run.ok ? "ok" : "err");
      pollSnapshot();
    } catch (error) {
      renderCommandFailure(error);
      setCommandStatus("GitHub checkpoint failed.", "err");
    } finally {
      setCommandBusy(false);
    }
  }

  async function runUpstreamCheckpointCommand() {
    setCommandBusy(true, "creating upstream sync checkpoint...");
    try {
      const run = await fetchJsonOrThrow("/api/upstream-sync/checkpoint", { method: "POST" });
      $("command-result").innerHTML = '<pre>' + escHtml(JSON.stringify(run.parsed ?? run, null, 2)) + '</pre>';
      await pollSnapshot();
      setCommandBusy(false, "upstream sync checkpoint complete");
    } catch (err) {
      setCommandBusy(false, "error: " + err.message);
      $("command-result").innerHTML = '<pre>' + escHtml(err.stack || err.message) + '</pre>';
    }
  }

  async function runOnboardCommand() {
    setCommandBusy(true);
    setCommandStatus("checking Chuck onboarding readiness...", "");
    const prompt = $("command-prompt").value.trim();
    const lowerPrompt = prompt.toLowerCase();
    $("command-result").innerHTML = '<div class="empty">' + (lowerPrompt.startsWith("candidate ")
      ? "registering candidate surface…"
      : lowerPrompt.startsWith("member ") || lowerPrompt.startsWith("surface ") || lowerPrompt.startsWith("child ")
        ? "registering family member surface…"
      : lowerPrompt.startsWith("prove ") || lowerPrompt.startsWith("proof ")
        ? "running surface proof…"
        : "running onboarding doctor…") + '</div>';
    try {
      const run = await fetchJsonOrThrow("/api/chuck-v2/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      $("command-result").innerHTML = '<div class="raw-json">' + escHtml(JSON.stringify(run.parsed ?? run, null, 2)) + '</div>';
      setCommandStatus("onboarding check complete.", run.ok ? "ok" : "err");
      pollSnapshot();
    } catch (error) {
      renderCommandFailure(error);
      setCommandStatus("onboarding check failed.", "err");
    } finally {
      setCommandBusy(false);
    }
  }

  async function runBuildPlanCommand() {
    const objective = $("command-prompt").value.trim();
    if (!objective) { setCommandStatus("Enter a builder objective first.", "err"); return; }
    setCommandBusy(true);
    setCommandStatus("running governed Builder Plan...", "");
    $("command-result").innerHTML = '<div class="empty">running Fleet Scout and writing BuilderRun plan…</div>';
    const started = Date.now();
    try {
      const run = await fetchJsonOrThrow("/api/chuck-v2/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective }),
      });
      $("command-result").innerHTML = '<div class="raw-json">' + escHtml(JSON.stringify(run.parsed ?? run, null, 2)) + '</div>';
      setCommandStatus("Builder Plan complete in " + ((Date.now() - started) / 1000).toFixed(1) + "s.", run.ok ? "ok" : "err");
      pollSnapshot();
    } catch (error) {
      renderCommandFailure(error);
      setCommandStatus("Builder Plan failed.", "err");
    } finally {
      setCommandBusy(false);
    }
  }

  async function runBuildPatchCommand() {
    const objective = $("command-prompt").value.trim();
    const patchFile = $("command-patch-file").value.trim();
    if (!objective) { setCommandStatus("Enter a builder objective first.", "err"); return; }
    if (!patchFile) { setCommandStatus("Enter a patch file path first.", "err"); return; }
    setCommandBusy(true);
    setCommandStatus("running governed Builder Patch...", "");
    $("command-result").innerHTML = '<div class="empty">creating shadow worktree, applying patch, and running verifiers…</div>';
    const started = Date.now();
    try {
      const run = await fetchJsonOrThrow("/api/chuck-v2/build/patch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective, patchFile }),
      });
      $("command-result").innerHTML = '<div class="raw-json">' + escHtml(JSON.stringify(run.parsed ?? run, null, 2)) + '</div>';
      setCommandStatus("Builder Patch complete in " + ((Date.now() - started) / 1000).toFixed(1) + "s.", run.ok ? "ok" : "err");
      pollSnapshot();
    } catch (error) {
      renderCommandFailure(error);
      setCommandStatus("Builder Patch failed.", "err");
    } finally {
      setCommandBusy(false);
    }
  }

  async function runBuildGenerateCommand() {
    const objective = $("command-prompt").value.trim();
    if (!objective) { setCommandStatus("Enter a builder objective first.", "err"); return; }
    setCommandBusy(true);
    setCommandStatus("asking Fleet for a governed patch candidate...", "");
    $("command-result").innerHTML = '<div class="empty">running Fleet Scout/Deepen, extracting a diff, and verifying if safe…</div>';
    const started = Date.now();
    try {
      const run = await fetchJsonOrThrow("/api/chuck-v2/build/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective }),
      });
      $("command-result").innerHTML = '<div class="raw-json">' + escHtml(JSON.stringify(run.parsed ?? run, null, 2)) + '</div>';
      setCommandStatus("Builder Generate complete in " + ((Date.now() - started) / 1000).toFixed(1) + "s.", run.ok ? "ok" : "err");
      pollSnapshot();
    } catch (error) {
      renderCommandFailure(error);
      setCommandStatus("Builder Generate failed.", "err");
    } finally {
      setCommandBusy(false);
    }
  }

  $("command-run").addEventListener("click", runFleetScout);
  $("command-build").addEventListener("click", runBuildPlanCommand);
  $("command-build-generate").addEventListener("click", runBuildGenerateCommand);
  $("command-build-patch").addEventListener("click", runBuildPatchCommand);
  $("command-onboard").addEventListener("click", runOnboardCommand);
  $("command-hygiene-checkpoint").addEventListener("click", runHygieneCheckpointCommand);
  $("command-github-checkpoint").addEventListener("click", runGitHubCheckpointCommand);
  $("command-upstream-checkpoint").addEventListener("click", runUpstreamCheckpointCommand);
  $("command-doctor").addEventListener("click", runDoctorCommand);
  $("command-atlas").addEventListener("click", runSurfaceAtlasCommand);
  $("command-docket").addEventListener("click", runDocketCommand);
  $("command-clear").addEventListener("click", () => {
    $("command-prompt").value = "";
    $("command-patch-file").value = "";
    $("command-result").innerHTML = '<div class="empty">ready</div>';
    setCommandStatus("");
  });

  function renderFleet(audit, registry) {
    const root = $("fleet");
    if (registry?.available && Array.isArray(registry.catalog) && registry.catalog.length > 0) {
      const order = ["anthropic", "openai", "google", "perplexity", "xai", "sovereign-local", "unknown"];
      const catalog = [...registry.catalog].sort((a, b) => {
        const ai = order.indexOf(a.family); const bi = order.indexOf(b.family);
        if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        if (a.status !== b.status) return a.status === "configured" ? -1 : 1;
        return String(a.surface).localeCompare(String(b.surface));
      });
      root.innerHTML = catalog.map((member) => {
        let mark = "?", cls = "unk";
        if (member.countsAsLoadBearingFamily) { mark = "✓"; cls = "ok"; }
        else if (member.status === "configured") { mark = "◐"; cls = "warn"; }
        const state = member.status === "configured"
          ? (member.executionStatus ? String(member.executionStatus) : "configured")
          : "planned";
        const tipParts = [
          "family: " + member.family,
          "surface: " + member.surface,
          "role: " + (member.role ?? "member"),
          member.executionStatus ? "execution: " + member.executionStatus : null,
          member.nextAction ? "next: " + member.nextAction : null,
        ].filter(Boolean).join("\\n");
        const fill = member.countsAsLoadBearingFamily ? 100 : member.status === "configured" ? 45 : 5;
        return '<div class="card voice" data-vendor="' + escHtml(member.family) + '" title="' + escHtml(tipParts) + '">' +
          '<div class="vrow"><span class="vid">' + escHtml(member.surface) + '</span><span class="mark ' + cls + '">' + mark + '</span></div>' +
          '<div class="meta">' + escHtml(member.label || member.family) + '</div>' +
          '<div class="vrow"><span class="ago">' + escHtml(member.family) + '</span><span class="ago">' + escHtml(state) + '</span></div>' +
          '<div class="ratebar"><div class="fill" style="width:' + fill + '%"></div></div>' +
        '</div>';
      }).join("");
      return;
    }
    if (!audit || !Array.isArray(audit.fleet)) { root.innerHTML = '<div class="empty">fleet data unavailable</div>'; return; }
    const fleet = audit.fleet;
    const order = ["anthropic", "openai", "google", "xai", "perplexity", "meta-local", "unknown"];
    fleet.sort((a,b) => {
      const ai = order.indexOf(a.vendor); const bi = order.indexOf(b.vendor);
      if (ai !== bi) return (ai<0?99:ai) - (bi<0?99:bi);
      return a.id.localeCompare(b.id);
    });
    const html = fleet.map((v) => {
      let mark = "?", cls = "unk";
      if (v.healthy === true && !v.lastWasFail) { mark = "✓"; cls = "ok"; }
      else if (v.healthy === false) { mark = "✗"; cls = "err"; }
      else if (v.lastWasFail) { mark = "⚠"; cls = "warn"; }
      else if (v.healthy === null) { mark = "?"; cls = "unk"; }
      const rate = v.recentReturnRate;
      const ratePct = (rate == null) ? "—" : Math.round(rate*100) + "%";
      const fillPct = (rate == null) ? 0 : Math.max(0, Math.min(1, rate)) * 100;
      const ago = fmtAgo(v.lastPanelReturn);
      const tipParts = [
        v.modelName ? "model: " + v.modelName : null,
        v.healthDetail ? "health: " + v.healthDetail : null,
        v.healthStale ? "(health probe stale)" : null,
        "vendor: " + v.vendor,
        "fallback: " + (v.hasFallback ? "yes" : "no"),
      ].filter(Boolean).join("\\n");
      return \`<div class="card voice" data-vendor="\${escHtml(v.vendor)}" title="\${escHtml(tipParts)}">
        <div class="vrow"><span class="vid">\${escHtml(v.id)}</span><span class="mark \${cls}">\${mark}</span></div>
        <div class="meta">\${escHtml(v.label)}</div>
        <div class="vrow"><span class="ago">\${ago}</span><span class="ago">\${ratePct} (30d)</span></div>
        <div class="ratebar"><div class="fill" style="width:\${fillPct}%"></div></div>
      </div>\`;
    }).join("");
    root.innerHTML = html;
  }

  function renderProcs(p) {
    const root = $("procs");
    if (!p?.available) { root.innerHTML = '<div class="empty">processes unavailable: ' + escHtml(p?.reason ?? "n/a") + '</div>'; return; }
    if (!p.processes.length) { root.innerHTML = '<div class="empty">no apex-/chuck- processes running</div>'; return; }
    const rows = p.processes.map((proc) => {
      const isHi = /apex-panel-ask|apex-pipeline|watcher/.test(proc.command);
      return \`<tr class="\${isHi?"hi":""}">
        <td>\${proc.pid}</td><td><b>\${escHtml(proc.shortName)}</b></td>
        <td class="cmd" title="\${escHtml(proc.command)}">\${escHtml(proc.command)}</td>
        <td class="num">\${escHtml(proc.etime ?? "—")}</td>
        <td class="num">\${fmtBytes(proc.rss)}</td>
      </tr>\`;
    }).join("");
    root.innerHTML = \`<table class="proc"><thead><tr><th>pid</th><th>name</th><th>command</th><th>elapsed</th><th>rss</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  }

  function renderScorer(s) {
    const root = $("scorer");
    if (!s?.available) { root.innerHTML = '<div class="empty">' + escHtml(s?.reason ?? "n/a") + '</div>'; return; }
    const top = (s.top ?? []).slice(0, 5);
    const lis = top.map((p) => \`<li><span class="slug">\${escHtml(p.slug)}</span><span class="w">\${p.retrieval_weight.toFixed(3)}</span></li>\`).join("");
    root.innerHTML = \`<div style="font-family:var(--mono);font-size:11px;color:var(--fg-dim);margin-bottom:6px;">total \${s.total} · live \${s.live} · archived \${s.archived}</div>
      <ul class="princ">\${lis || '<li class="empty">no principles scored</li>'}</ul>\`;
  }

  function renderCurator(c) {
    const root = $("curator");
    if (!c?.available) { root.innerHTML = '<div class="empty">' + escHtml(c?.reason ?? "n/a") + '</div>'; return; }
    root.innerHTML = \`<ul class="princ">
      <li><span class="slug">tracked nodes</span><span class="w">\${c.nodes}</span></li>
      <li><span class="slug">archived</span><span class="w">\${c.archived}</span></li>
      <li><span class="slug">merged nodes</span><span class="w">\${c.mergedNodes}</span></li>
      <li><span class="slug">relates-to edges</span><span class="w">\${c.relatesEdges}</span></li>
      <li><span class="slug">last decay</span><span class="w">\${escHtml(c.lastDecayAt ?? "never")}</span></li>
    </ul>\`;
  }

  function renderRouter(r) {
    const root = $("router");
    if (!r?.available) { root.innerHTML = '<div class="empty">' + escHtml(r?.reason ?? "n/a") + '</div>'; return; }
    if (!r.rows.length) { root.innerHTML = '<div class="empty">no router data yet</div>'; return; }
    const classes = new Set();
    for (const row of r.rows) for (const c of row.cells) classes.add(c.class);
    const cols = [...classes].sort();
    const head = '<tr><th>voice</th>' + cols.map((c) => '<th>'+escHtml(c)+'</th>').join("") + '</tr>';
    const body = r.rows.map((row) => {
      const cells = cols.map((c) => {
        const cell = row.cells.find((x) => x.class === c);
        if (!cell) return '<td class="cell">—</td>';
        const bg = cell.mean >= 0 ? \`rgba(63,185,80,\${Math.min(1, cell.mean)})\` : 'rgba(248,81,73,0.4)';
        return \`<td class="cell" style="background:\${bg}" title="n=\${cell.n}">\${cell.mean.toFixed(2)}</td>\`;
      }).join("");
      return '<tr><td class="cell">'+escHtml(row.voice)+'</td>' + cells + '</tr>';
    }).join("");
    root.innerHTML = \`<table class="heat"><thead>\${head}</thead><tbody>\${body}</tbody></table>\`;
  }

  function renderBuilder(b) {
    const root = $("builder");
    if (!b?.available) { root.innerHTML = '<div class="empty">' + escHtml(b?.reason ?? "no builder runs yet") + '</div>'; return; }
    const latest = b.latest;
    const summary = latest ? [
      metric("latest", latest.runId),
      metric("stage", latest.stage),
      metric("disposition", latest.disposition),
      metric("approval", latest.operatorActionRequired ? "required" : "not required"),
      metric("intent anchor", latest.intentAnchorId || "none"),
      metric("tests", latest.testsTotal ? latest.testsPassed + "/" + latest.testsTotal + " passed" : "not run"),
      metric("updated", fmtAgo(latest.updatedAt)),
    ].join("") : '<div class="empty">no builder runs yet</div>';
    const pending = (b.pendingApproval || []);
    const recent = (b.recent || []);
    const cardsFor = (runs, emptyText) => {
      if (!runs.length) return '<div class="empty">' + escHtml(emptyText) + '</div>';
      return '<ul class="princ">' + runs.map((run) => {
        const files = (run.targetFiles || []).slice(0, 4).join(", ") || "no target files";
        const proposed = (run.proposedFiles || []).slice(0, 4).join(", ");
        const reason = (run.reasons || [])[0] || "";
        return '<li style="display:block;"><div style="display:flex;justify-content:space-between;gap:10px;">' +
          '<span class="slug">' + escHtml(run.objective || run.runId) + '</span><span class="w">' + escHtml(run.disposition) + '</span></div>' +
          '<div style="color:var(--fg-dim);margin-top:3px;">' + escHtml(run.runId + " · " + run.stage) + '</div>' +
          '<div style="color:var(--fg-dim);margin-top:3px;">files: ' + escHtml(files) + '</div>' +
          (proposed ? '<div style="color:var(--fg-dim);margin-top:3px;">proposed: ' + escHtml(proposed) + '</div>' : '') +
          (run.planSummary ? '<div style="color:var(--fg-dim);margin-top:3px;">plan: ' + escHtml(run.planSummary) + '</div>' : '') +
          (reason ? '<div style="color:var(--fg-dim);margin-top:3px;">' + escHtml(reason) + '</div>' : '') +
          '</li>';
      }).join("") + '</ul>';
    };
    root.innerHTML = '<div class="run-summary">' + summary + '</div>' +
      '<div class="grid three">' +
      '<div class="card"><div class="col-title">Pending Approval</div>' + cardsFor(pending, "no authority gates pending") + '</div>' +
      '<div class="card"><div class="col-title">Active</div>' + cardsFor(b.active || [], "no active builder runs") + '</div>' +
      '<div class="card"><div class="col-title">Recent</div>' + cardsFor(recent, "no recent builder runs") + '</div>' +
      '</div>';
  }

  function renderCapabilityLedger(ledger) {
    const root = $("capability-ledger");
    if (!root) { return; }
    if (!ledger?.available) {
      root.innerHTML = '<div class="empty">' + escHtml(ledger?.reason ?? "capability ledger unavailable") + '</div>';
      return;
    }
    const summary = ledger.summary || {};
    const families = summary.independentLoadBearingFamilies || [];
    const entries = ledger.entries || [];
    const summaryHtml = [
      metric("kernel-ready families", (summary.independentLoadBearingFamilyCount || 0) + (families.length ? " / " + families.join(", ") : "")),
      metric("load-bearing", summary.loadBearingSurfaces || 0),
      metric("provisional", summary.provisionalSurfaces || 0),
      metric("degraded", summary.degradedSurfaces || 0),
      metric("blocked", summary.blockedSurfaces || 0),
      metric("refreshed", fmtAgo(ledger.refreshedAt)),
    ].join("");
    const sorted = [...entries].sort((a, b) => {
      const order = { "load-bearing": 0, provisional: 1, degraded: 2, blocked: 3 };
      const ai = order[a.readiness] ?? 9;
      const bi = order[b.readiness] ?? 9;
      if (ai !== bi) return ai - bi;
      if (a.family !== b.family) return String(a.family).localeCompare(String(b.family));
      return String(a.surface).localeCompare(String(b.surface));
    });
    const cards = sorted.slice(0, 24).map((entry) => {
      const cls = entry.readiness === "load-bearing" ? "ok" : entry.readiness === "blocked" ? "err" : "warn";
      const caveats = (entry.caveats || []).slice(0, 3).join("; ");
      const proof = "prompt " + (entry.promptDeliveryProof?.verdict || "missing") +
        " · answer " + (entry.answerAttributionProof?.verdict || "missing") +
        " · " + (entry.extractionMethod || "unknown");
      return '<div class="receipt" data-family="' + escHtml(entry.family) + '"><div class="top"><span class="family">' +
        escHtml(entry.family + " · " + entry.surface) + '</span><span class="status ' + cls + '">' + escHtml(entry.readiness) +
        '</span></div><div style="color:var(--fg-dim);">' + escHtml(proof) + '</div>' +
        '<div style="color:var(--fg-dim);margin-top:3px;">count-family: ' + escHtml(entry.countsAsIndependentFamily ? "yes" : "no") +
        ' · confidence: ' + escHtml(entry.confidence || "unknown") +
        ' · age: ' + escHtml(fmtAgo(entry.lastProofAt)) + '</div>' +
        (caveats ? '<div style="color:var(--warn);margin-top:3px;">' + escHtml(caveats) + '</div>' : '') +
        '<div style="color:var(--fg-faint);font:11px var(--mono);margin-top:3px;">next: ' + escHtml(entry.nextRepairAction || "") + '</div>' +
        '</div>';
    }).join("");
    root.innerHTML = '<div class="run-summary">' + summaryHtml + '</div>' +
      '<div class="receipt-grid">' + (cards || '<div class="empty">no capability entries</div>') + '</div>' +
      '<div style="color:var(--fg-faint);font:11px var(--mono);margin-top:8px;">The Kernel relies on load-bearing surfaces only. Late OCR/recovery evidence remains visible but degraded until normal proof succeeds.</div>';
  }

  function renderLatestFleetRun(run) {
    const root = $("latest-fleet-run");
    if (!run?.available) {
      root.innerHTML = '<div class="empty">' + escHtml(run?.reason ?? "no broad Fleet run yet") + '</div>';
      return;
    }
    const misses = run.misses || [];
    const completed = run.completedSurfaces || [];
    const summary = [
      metric("run", run.runId || run.dispatchId),
      metric("eligible families", (run.independentEligibleFamilyCount || 0) + " / " + (run.eligibleFamilies || []).join(", ")),
      metric("surfaces", (run.completedCount || 0) + "/" + (run.totalTasks || 0) + " completed"),
      metric("receipts", run.receiptCount || 0),
      metric("failures", (run.failedCount || 0) + " failed, " + (run.skippedCount || 0) + " skipped"),
      metric("late recovered", run.recoveredCount || 0),
      metric("updated", fmtAgo(run.updatedAt)),
    ].join("");
    const surfaceCards = completed.map((surface) =>
      '<div class="receipt" data-family="' + escHtml(surface.family) + '"><div class="top"><span class="family">' +
      escHtml(surface.family + " · " + surface.surface) + '</span><span class="status ' +
      (surface.countingEligible ? "ok" : "warn") + '">' + escHtml(surface.countingEligible ? "eligible" : "same-family signal") +
      '</span></div><div style="color:var(--fg-dim);">' + escHtml(surface.actualRunner || surface.modelClaimed || "") +
      '</div>' + (surface.modelClaimed ? '<div style="color:var(--fg-dim);margin-top:3px;">' + escHtml(surface.modelClaimed) + '</div>' : '') +
      (surface.lateRecovery ? '<div style="color:var(--ok);margin-top:3px;">late proof: ' + escHtml(surface.lateRecovery.label) + '</div>' : '') +
      '</div>'
    ).join("");
    const missCards = misses.map((miss) =>
      '<div class="receipt" data-family="' + escHtml(miss.family) + '"><div class="top"><span class="family">' +
      escHtml(miss.family + " · " + miss.surface) + '</span><span class="status ' + (miss.status === "recovered-late" ? "ok" : "err") + '">' +
      escHtml(miss.status === "recovered-late" ? "recovered" : miss.status) +
      '</span></div><div style="color:var(--fg-dim);">' +
      escHtml(miss.status === "recovered-late" ? (miss.lateRecovery?.label || "late recovery") : (miss.reason || "")) + '</div>' +
      (miss.status === "recovered-late" ? '<div style="color:var(--warn);margin-top:3px;">original: ' + escHtml(miss.originalStatus || "failed") + ' · ' + escHtml(miss.reason || "") + '</div>' : '') +
      (miss.lateRecovery?.evidence?.length ? '<details style="margin-top:6px;"><summary style="cursor:pointer;color:var(--fg-dim);">proof files</summary><ul class="princ" style="margin-top:6px;">' +
        miss.lateRecovery.evidence.map((file) => '<li><span class="slug">' + escHtml(file.name) + '</span><span class="w">' + escHtml(fmtAgo(file.updatedAt)) + '</span></li>').join("") +
        '</ul></details>' : '') +
      '</div>'
    ).join("");
    const lateOnlyCards = (run.lateOnlyRecoveries || []).map((recovery) =>
      '<div class="receipt" data-family="' + escHtml(recovery.family) + '"><div class="top"><span class="family">' +
      escHtml(recovery.family + " · " + recovery.surface) + '</span><span class="status ok">recovered</span></div>' +
      '<div style="color:var(--fg-dim);">' + escHtml(recovery.label || "late recovery") + '</div>' +
      '<div style="color:var(--warn);margin-top:3px;">not in latest execution file; carried from rerun/proof artifacts</div>' +
      (recovery.evidence?.length ? '<details style="margin-top:6px;"><summary style="cursor:pointer;color:var(--fg-dim);">proof files</summary><ul class="princ" style="margin-top:6px;">' +
        recovery.evidence.map((file) => '<li><span class="slug">' + escHtml(file.name) + '</span><span class="w">' + escHtml(fmtAgo(file.updatedAt)) + '</span></li>').join("") +
        '</ul></details>' : '') +
      '</div>'
    ).join("");
    root.innerHTML = '<div class="run-summary">' + summary + '</div>' +
      '<div class="receipt-grid">' + (surfaceCards || '<div class="empty">no completed surfaces</div>') + missCards + lateOnlyCards + '</div>' +
      '<div style="color:var(--fg-faint);font:11px var(--mono);margin-top:8px;">same-family surfaces are visible as children/cousins but never increase independent family count. Late recovery overlays update the dashboard without rewriting original failed receipts.</div>';
  }

  function renderSurfaceControl(surface) {
    const root = $("surface-control");
    if (!surface?.available) {
      root.innerHTML = '<div class="empty">no workstation return leases yet</div>';
      return;
    }
    const active = surface.active;
    const latest = surface.latestReceipt;
    const activeStatus = active
      ? (active.status + (active.app ? " · " + active.app : ""))
      : "none";
    const latestOk = latest?.result?.ok === true;
    const summary = [
      metric("active lease", active?.leaseId ?? "none"),
      metric("status", activeStatus),
      metric("origin", active?.frontWindowTitle ? active.app + " · " + active.frontWindowTitle : (active?.app ?? "—")),
      metric("latest return", latest ? (latestOk ? "ok" : "failed") : "none"),
      metric("updated", fmtAgo(latest?.endedAt ?? active?.endedAt ?? active?.startedAt)),
    ].join("");
    const receipts = (surface.recentReceipts || []).map((receipt) =>
      '<div class="receipt"><div class="top"><span class="family">' + escHtml(receipt.reason || receipt.leaseId || "return") +
      '</span><span class="status ' + (receipt.ok ? "ok" : "err") + '">' + escHtml(receipt.ok ? "returned" : "failed") +
      '</span></div><div style="color:var(--fg-dim);">' + escHtml((receipt.app || "unknown app") + " · " + (receipt.restored || receipt.resultReason || "receipt")) +
      '</div><div style="color:var(--fg-faint);font:11px var(--mono);margin-top:3px;">' + escHtml(fmtAgo(receipt.endedAt)) + '</div></div>'
    ).join("");
    root.innerHTML = '<div class="run-summary">' + summary + '</div>' +
      '<div class="receipt-grid">' + (receipts || '<div class="empty">no return receipts yet</div>') + '</div>' +
      '<div style="color:var(--fg-faint);font:11px var(--mono);margin-top:8px;">Every GUI/app driver should start a workstation lease before leaving and end with a verified return receipt.</div>';
  }

  function renderSurfaceAtlas(atlas) {
    const root = $("surface-atlas");
    if (!root) { return; }
    if (!atlas?.available) {
      root.innerHTML = '<div class="empty">' + escHtml(atlas?.reason ?? "surface atlas unavailable") + '</div>';
      return;
    }
    const entries = atlas.entries || [];
    const summary = [
      metric("surfaces", atlas.totalSurfaces),
      metric("configured", atlas.configuredSurfaces),
      metric("tools/connectors", atlas.availableToolSurfaces),
      metric("planned", atlas.plannedSurfaces),
      metric("controls", atlas.controls),
      metric("shortcuts", atlas.shortcuts),
      metric("abilities", atlas.abilities),
      metric("keep-open", atlas.keepOpenDuringActiveWork),
      metric("return-required", atlas.returnRequired),
    ].join("");
    const important = entries
      .filter((entry) =>
        entry.status === "configured" ||
        entry.leasePolicy?.keepOpenDuringActiveWork ||
        (entry.masteryGaps || []).length > 0 ||
        entry.category === "tool-surface" ||
        entry.category === "connector"
      )
      .slice(0, 16)
      .map((entry) => {
        const controls = (entry.controls || []).slice(0, 4).map((item) => item.label + " (" + item.kind + ")").join(", ") || "no controls catalogued";
        const abilities = (entry.abilities || []).slice(0, 3).map((item) => item.label).join(", ") || "no abilities catalogued";
        const gaps = (entry.masteryGaps || []).slice(0, 2).join("; ");
        const statusClass = entry.status === "configured" || entry.status === "available-tool" ? "ok" : "warn";
        return '<div class="receipt" data-family="' + escHtml(entry.family) + '"><div class="top"><span class="family">' +
          escHtml(entry.family + " · " + entry.surface) + '</span><span class="status ' + statusClass + '">' + escHtml(entry.status) +
          '</span></div><div style="color:var(--fg);">' + escHtml(entry.label || "") + '</div>' +
          '<div style="color:var(--fg-dim);margin-top:3px;">driver: ' + escHtml(entry.preferredDriver + (entry.primaryScript ? " · " + entry.primaryScript : "")) + '</div>' +
          '<div style="color:var(--fg-dim);margin-top:3px;">lease: ' + escHtml(entry.leasePolicy?.mode || "none") +
          ' · keep-open ' + escHtml(entry.leasePolicy?.keepOpenDuringActiveWork ? "yes" : "no") +
          ' · return ' + escHtml(entry.leasePolicy?.returnRequired ? "yes" : "no") + '</div>' +
          '<div style="color:var(--fg-dim);margin-top:3px;">controls: ' + escHtml(controls) + '</div>' +
          '<div style="color:var(--fg-dim);margin-top:3px;">abilities: ' + escHtml(abilities) + '</div>' +
          (gaps ? '<div style="color:var(--warn);margin-top:3px;">gaps: ' + escHtml(gaps) + '</div>' : '') +
          '</div>';
      }).join("");
    const gapRows = (atlas.masteryGaps || []).slice(0, 12).map((gap) =>
      '<li><span class="slug">' + escHtml(gap.surface) + '</span><span class="w">' + escHtml((gap.gaps || []).join("; ")) + '</span></li>'
    ).join("");
    root.innerHTML = '<div class="run-summary">' + summary + '</div>' +
      '<div class="receipt-grid">' + (important || '<div class="empty">no atlas entries</div>') + '</div>' +
      '<details style="margin-top:10px;"><summary style="cursor:pointer;color:var(--fg-dim);font:12px var(--mono);">mastery gaps / proof targets</summary>' +
      '<ul class="princ" style="margin-top:8px;">' + (gapRows || '<li class="empty">no current mastery gaps</li>') + '</ul></details>' +
      '<div style="color:var(--fg-faint);font:11px var(--mono);margin-top:8px;">Controls are durable operating memory. Unknowns become proof targets, not arbitrary guesses.</div>';
  }

  function renderRepoHygiene(repo, checkpoint) {
    const root = $("repo-hygiene");
    if (!repo?.available) {
      root.innerHTML = '<div class="empty">' + escHtml(repo?.reason ?? "repo hygiene unavailable") + '</div>';
      return;
    }
    const summary = [
      metric("status", repo.clean ? "clean" : "dirty but classified"),
      metric("changed paths", repo.total || 0),
      metric("tracked", repo.trackedModified || 0),
      metric("untracked", repo.untracked || 0),
      metric("blockers", (repo.blockers || []).length),
    ].join("");
    const bucketCards = (repo.buckets || []).map((bucket) =>
      '<div class="receipt"><div class="top"><span class="family">' + escHtml(bucket.bucket) +
      '</span><span class="status ' + (bucket.bucket === "apex-salvage" ? "warn" : "ok") + '">' +
      escHtml(bucket.total + " path(s)") + '</span></div>' +
      '<div style="color:var(--fg-dim);">tracked ' + escHtml(bucket.tracked) + ' · untracked ' + escHtml(bucket.untracked) + '</div>' +
      '<details style="margin-top:6px;"><summary style="cursor:pointer;color:var(--fg-dim);">examples</summary><ul class="princ" style="margin-top:6px;">' +
      (bucket.examples || []).map((entry) => '<li><span class="slug">' + escHtml(entry.path) + '</span><span class="w">' + escHtml(entry.status) + '</span></li>').join("") +
      '</ul></details></div>'
    ).join("");
    const blockers = (repo.blockers || []).map((item) => '<li><span class="slug">' + escHtml(item) + '</span><span class="w">gate</span></li>').join("");
    const policy = (repo.policy || []).map((item) => '<li><span class="slug">' + escHtml(item) + '</span><span class="w">rule</span></li>').join("");
    const checkpointHtml = checkpoint?.available
      ? '<div class="card" style="margin-bottom:10px;"><div class="col-title">Latest Checkpoint</div><div class="run-summary">' + [
          metric("checkpoint", checkpoint.checkpointId),
          metric("broad self-build", checkpoint.broadSelfBuildAllowed ? "allowed" : "blocked"),
          metric("targeted self-build", checkpoint.targetedSelfBuildAllowed ? "allowed with clean targets" : "blocked"),
          metric("lanes", (checkpoint.lanes || []).length),
          metric("remediation", checkpoint.remediationMarkdownPath),
        ].join("") + '</div><div class="receipt-grid">' + (checkpoint.lanes || []).map((lane) =>
          '<div class="receipt"><div class="top"><span class="family">' + escHtml(lane.laneId) +
          '</span><span class="status ' + (lane.risk === "high" ? "warn" : "ok") + '">' + escHtml(lane.pathCount + " path(s)") +
          '</span></div><div style="color:var(--fg);">' + escHtml(lane.title || "") + '</div>' +
          '<div style="color:var(--fg-dim);margin-top:3px;">' + escHtml(lane.disposition + " · " + lane.risk) + '</div>' +
          '<div style="color:var(--fg-dim);margin-top:3px;">' + escHtml(lane.pathsFile || "") + '</div></div>'
        ).join("") + '</div></div>'
      : '';
    root.innerHTML = '<div class="run-summary">' + summary + '</div>' +
      checkpointHtml +
      (blockers ? '<div class="card" style="margin-bottom:10px;"><div class="col-title">Cleanliness Gates</div><ul class="princ">' + blockers + '</ul></div>' : '') +
      '<div class="receipt-grid">' + (bucketCards || '<div class="empty">repo is clean</div>') + '</div>' +
      '<details style="margin-top:10px;"><summary style="cursor:pointer;color:var(--fg-dim);font:12px var(--mono);">policy</summary><ul class="princ" style="margin-top:8px;">' +
      policy + '</ul></details>';
  }

  function renderGitHubHygiene(checkpoint) {
    const root = $("github-hygiene");
    if (!checkpoint?.available) {
      root.innerHTML = '<div class="empty">' + escHtml(checkpoint?.reason ?? "GitHub hygiene checkpoint unavailable") + '</div>';
      return;
    }
    const summary = [
      metric("checkpoint", checkpoint.checkpointId),
      metric("fork remote", checkpoint.forkRemote || "fork"),
      metric("upstream", checkpoint.upstreamRemote || "origin"),
      metric("current branch", checkpoint.currentBranch || "unknown"),
      metric("fork branches", checkpoint.totalForkBranches),
      metric("upstream branches", checkpoint.totalUpstreamBranches),
      metric("fork-only", checkpoint.forkOnlyCount),
      metric("delete candidates", checkpoint.deleteCandidateCount),
    ].join("");
    const blockers = (checkpoint.blockers || []).map((item) => '<li><span class="slug">' + escHtml(item) + '</span><span class="w">gate</span></li>').join("");
    const categories = (checkpoint.categories || []).map((category) =>
      '<div class="receipt"><div class="top"><span class="family">' + escHtml(category.category) +
      '</span><span class="status ' + (category.deleteCandidates > 0 ? "warn" : "ok") + '">' +
      escHtml(category.total + " branch(es)") + '</span></div>' +
      '<div style="color:var(--fg-dim);">delete candidates ' + escHtml(category.deleteCandidates || 0) + '</div>' +
      '<details style="margin-top:6px;"><summary style="cursor:pointer;color:var(--fg-dim);">examples</summary><ul class="princ" style="margin-top:6px;">' +
      (category.examples || []).map((name) => '<li><span class="slug">' + escHtml(name) + '</span><span class="w">branch</span></li>').join("") +
      '</ul></details></div>'
    ).join("");
    root.innerHTML = '<div class="run-summary">' + summary + '</div>' +
      '<div class="card" style="margin-bottom:10px;"><div class="col-title">Review Manifests</div><div class="run-summary">' + [
        metric("manifest", checkpoint.branchManifestPath),
        metric("delete candidates", checkpoint.deletionCandidatePath),
        metric("remediation", checkpoint.remediationMarkdownPath),
      ].join("") + '</div></div>' +
      (blockers ? '<div class="card" style="margin-bottom:10px;"><div class="col-title">Remote Cleanup Gates</div><ul class="princ">' + blockers + '</ul></div>' : '') +
      '<div class="receipt-grid">' + (categories || '<div class="empty">no branch categories</div>') + '</div>';
  }

  function renderUpstreamSync(checkpoint) {
    const root = $("upstream-sync");
    if (!checkpoint?.available) {
      root.innerHTML = '<div class="empty">' + escHtml(checkpoint?.reason ?? "upstream sync checkpoint unavailable") + '</div>';
      return;
    }
    const summary = [
      metric("checkpoint", checkpoint.checkpointId),
      metric("package", checkpoint.packageVersion || "unknown"),
      metric("branch", checkpoint.currentBranch || "unknown"),
      metric("latest stable", checkpoint.latestStableTag || "unknown"),
      metric("stable sync", upstreamStableLabel(checkpoint)),
      metric("after stable", checkpoint.localCommitsAfterStable == null ? "unknown" : checkpoint.localCommitsAfterStable + " local"),
      metric("local dirt", checkpoint.localDirty ? "yes" : "no"),
      metric("broad sync", checkpoint.broadSyncAllowed ? "allowed" : "blocked"),
    ].join("");
    const blockers = (checkpoint.blockers || []).map((item) => '<li><span class="slug">' + escHtml(item) + '</span><span class="w">gate</span></li>').join("");
    const next = (checkpoint.nextActions || []).map((item) => '<li><span class="slug">' + escHtml(item) + '</span><span class="w">next</span></li>').join("");
    root.innerHTML = '<div class="run-summary">' + summary + '</div>' +
      '<div class="card" style="margin-bottom:10px;"><div class="col-title">Review Artifacts</div><div class="run-summary">' + [
        metric("report", checkpoint.reportPath),
        metric("remediation", checkpoint.remediationMarkdownPath),
        metric("commands", checkpoint.commandPlanPath),
      ].join("") + '</div></div>' +
      (blockers ? '<div class="card" style="margin-bottom:10px;"><div class="col-title">Sync Gates</div><ul class="princ">' + blockers + '</ul></div>' : '') +
      '<div class="card"><div class="col-title">Next</div><ul class="princ">' + (next || '<li><span class="slug">no upstream sync action needed</span><span class="w">ok</span></li>') + '</ul></div>';
  }

  function upstreamStableLabel(checkpoint) {
    if (!checkpoint?.latestStableTag) { return "unknown"; }
    if (checkpoint.stableBehind) {
      const n = checkpoint.stableMissingCommits == null ? "?" : checkpoint.stableMissingCommits;
      return "behind by " + n;
    }
    if (checkpoint.stableContained) { return "current"; }
    return "different";
  }

  function renderModelDoctor(d) {
    const root = $("model-doctor");
    if (!d?.available) {
      root.innerHTML = '<div class="empty">' + escHtml(d?.reason ?? "no model doctor run yet") + '</div>';
      return;
    }
    const ready = (d.executionReadyFamilies || []);
    const configuredButNotExecutable = (d.configuredButNotExecutableSurfaces || []);
    const summary = [
      metric("execution-ready families", ready.length + (d.configuredVoices ? " / " + new Set([...(d.readyFamilies || []), ...(d.unknownFamilies || []), ...(d.blockedFamilies || [])]).size : "")),
      metric("families", ready.join(", ") || "none"),
      metric("minimum fleet", d.canRunLoadBearingMinimumFleet ? "ready" : "not ready"),
      metric("high-risk fleet", d.canRunLoadBearingHighRiskFleet ? "ready" : "not ready"),
      metric("blocked", (d.blockedFamilies || []).join(", ") || "none"),
      metric("unknown", (d.unknownFamilies || []).join(", ") || "none"),
      metric("not executable", configuredButNotExecutable.join(", ") || "none"),
      metric("checked", fmtAgo(d.generatedAt)),
    ].join("");
    const actions = (d.nextActions || []).slice(0, 8).map((item) =>
      '<div class="receipt" data-family="' + escHtml(item.family) + '"><div class="top"><span class="family">' +
      escHtml(item.family + " · " + item.surface) + '</span><span class="status warn">' +
      escHtml(item.executionStatus || item.status || "unknown") + '</span></div><div style="color:var(--fg-dim);">' +
      escHtml(item.nextAction || "") + '</div></div>'
    ).join("");
    root.innerHTML = '<div class="run-summary">' + summary + '</div>' +
      (actions ? '<div class="receipt-grid">' + actions + '</div>' : '<div class="empty">no operator setup actions</div>');
  }

  function renderFamilyRegistry(registry) {
    const root = $("family-registry");
    if (!registry?.available) {
      root.innerHTML = '<div class="empty">' + escHtml(registry?.reason ?? "no family registry snapshot yet") + '</div>';
      return;
    }
    const summary = [
      metric("execution-ready families", (registry.executionReadyFamilies || []).length),
      metric("families", (registry.executionReadyFamilies || []).join(", ") || "none"),
      metric("catalogued members", registry.familyMemberCount),
      metric("configured members", registry.configuredMemberCount),
      metric("load-bearing surfaces", registry.loadBearingSurfaceCount),
      metric("planned members", registry.plannedMemberCount),
      metric("readiness", registry.readinessScore == null ? "—" : registry.readinessScore + "/100"),
      metric("status", registry.status),
      metric("updated", fmtAgo(registry.generatedAt)),
    ].join("");
    const familyRows = (registry.byFamily || []).map((row) =>
      '<div class="receipt" data-family="' + escHtml(row.family) + '"><div class="top"><span class="family">' +
      escHtml(row.family) + '</span><span class="status ok">' + escHtml(row.configured + "/" + row.total + " wired") +
      '</span></div><div style="color:var(--fg-dim);">primary ' + escHtml(row.primary) +
      ' · children ' + escHtml(row.children) + ' · cousins/local ' + escHtml(row.cousins) +
      ' · planned ' + escHtml(row.planned) + '</div></div>'
    ).join("");
    const memberRows = (registry.catalog || []).map((member) =>
      '<li style="display:block;"><div style="display:flex;justify-content:space-between;gap:10px;">' +
      '<span class="slug">' + escHtml(member.family + " · " + member.surface) + '</span>' +
      '<span class="w">' + escHtml((member.status || "unknown") + " / " + (member.role || "member")) + '</span></div>' +
      '<div style="color:var(--fg-dim);margin-top:3px;">' + escHtml(member.label || "") + '</div></li>'
    ).join("");
    root.innerHTML = '<div class="run-summary">' + summary + '</div>' +
      '<div class="receipt-grid">' + (familyRows || '<div class="empty">no families catalogued</div>') + '</div>' +
      '<details style="margin-top:10px;"><summary style="cursor:pointer;color:var(--fg-dim);font:12px var(--mono);">show family members / children / cousins</summary>' +
      '<ul class="princ" style="margin-top:8px;">' + (memberRows || '<li class="empty">no members catalogued</li>') + '</ul></details>';
  }

  function renderPanels(p) {
    const root = $("panels");
    if (!p?.available || !p.runs?.length) { root.innerHTML = '<li class="empty">no panel artifacts found</li>'; return; }
    root.innerHTML = p.runs.map((r) => \`<li>
      <span class="stem">\${escHtml(r.stem)}</span>
      <span style="color:var(--fg-dim);"> · \${fmtAgo(r.runAtIso)} · returned \${escHtml(r.returnRate)}</span>
      <div class="meta">
        \${r.largest ? "largest: "+escHtml(r.largest.label)+" ("+fmtBytes(r.largest.bytes)+")" : ""}
        \${r.smallest && r.smallest !== r.largest ? " · smallest: "+escHtml(r.smallest.label)+" ("+fmtBytes(r.smallest.bytes)+")" : ""}
      </div></li>\`).join("");
  }

  function renderHeader(snap) {
    $("hdr-time").textContent = new Date(snap.time).toLocaleTimeString();
    $("hdr-events").textContent = snap.recentEvents?.total24h ?? "—";
    $("hdr-procs").textContent = snap.processes?.processes?.length ?? "—";
    $("hdr-builder").textContent = snap.builder?.latest?.disposition ?? "—";
    $("hdr-families").textContent = snap.modelDoctor?.available
      ? (snap.modelDoctor.executionReadyFamilies?.length ?? 0) + " ready"
      : "—";
    $("hdr-members").textContent = snap.familyRegistry?.available
      ? (snap.familyRegistry.configuredMemberCount ?? 0) + "/" + (snap.familyRegistry.familyMemberCount ?? 0)
      : "—";
    $("hdr-kernel-ready").textContent = snap.capabilityLedger?.available
      ? (snap.capabilityLedger.summary?.independentLoadBearingFamilyCount ?? 0) + " families"
      : "—";
    $("hdr-latest-fleet").textContent = snap.latestFleetRun?.available
      ? (snap.latestFleetRun.completedCount ?? 0) + "/" + (snap.latestFleetRun.totalTasks ?? 0)
      : "—";
    $("hdr-surface").textContent = snap.surfaceControl?.active
      ? (snap.surfaceControl.active.returnOk === false ? "return failed" : snap.surfaceControl.active.status)
      : (snap.surfaceControl?.latestReceipt?.result?.ok === true ? "returned" : "—");
    $("hdr-atlas").textContent = snap.surfaceAtlas?.available
      ? (snap.surfaceAtlas.configuredSurfaces ?? 0) + "/" + (snap.surfaceAtlas.totalSurfaces ?? 0)
      : "—";
    $("hdr-repo").textContent = snap.repoHygiene?.available
      ? (snap.repoHygiene.clean ? "clean" : (snap.repoHygiene.total ?? 0) + " dirty")
      : "—";
    $("hdr-refresh").textContent = new Date().toLocaleTimeString();
    $("indicator").className = "indicator-dot " + (snap.fleet?.fleet ? "live" : "degraded");
  }

  let lastSnapshotOk = false;
  async function pollSnapshot() {
    try {
      const r = await fetch("/api/snapshot", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP "+r.status);
      const snap = await r.json();
      lastSnapshotOk = true;
      renderHeader(snap); renderFleet(snap.fleet, snap.familyRegistry); renderProcs(snap.processes);
      renderScorer(snap.scorer); renderCurator(snap.curator); renderRouter(snap.router);
      renderBuilder(snap.builder);
      renderCapabilityLedger(snap.capabilityLedger);
      renderLatestFleetRun(snap.latestFleetRun);
      renderSurfaceControl(snap.surfaceControl);
      renderSurfaceAtlas(snap.surfaceAtlas);
      renderRepoHygiene(snap.repoHygiene, snap.repoHygieneCheckpoint);
      renderGitHubHygiene(snap.githubHygieneCheckpoint);
      renderUpstreamSync(snap.upstreamSyncCheckpoint);
      renderModelDoctor(snap.modelDoctor);
      renderFamilyRegistry(snap.familyRegistry);
      renderPanels(snap.panels);
      if (!eventStreamSeeded) { seedEventStream(snap.recentEvents?.recent ?? []); eventStreamSeeded = true; }
    } catch (err) {
      lastSnapshotOk = false;
      $("hdr-refresh").textContent = "error: " + err.message;
    }
  }

  let eventStreamSeeded = false;
  const MAX_EVENTS_DISPLAY = 60;
  function seedEventStream(events) {
    const root = $("event-stream");
    if (!events.length) { root.innerHTML = '<div class="empty">no recent events in last 24h</div>'; return; }
    root.innerHTML = "";
    for (const evt of events) appendEvent(evt, false);
  }
  function appendEvent(evt, animate) {
    const root = $("event-stream");
    if (root.querySelector(".empty")) root.innerHTML = "";
    const div = document.createElement("div");
    div.className = "ev" + (animate ? " new" : "");
    const ts = (evt.ts || "").slice(11, 19);
    const src = String(evt.source || "?");
    const typ = String(evt.type || "?");
    const pl = evt.payload ? JSON.stringify(evt.payload) : "";
    const plShort = pl.length > 120 ? pl.slice(0, 117) + "…" : pl;
    div.innerHTML = \`<span class="ts">\${escHtml(ts)}</span> <span class="src">\${escHtml(src)}</span> <span class="typ">\${escHtml(typ)}</span> <span class="pl">\${escHtml(plShort)}</span>\`;
    div._fullPayload = pl;
    div.addEventListener("click", () => {
      if (div.classList.contains("expanded")) {
        div.classList.remove("expanded");
        div.querySelector(".pl").textContent = plShort;
      } else {
        div.classList.add("expanded");
        div.querySelector(".pl").textContent = pl || "(empty payload)";
      }
    });
    root.insertBefore(div, root.firstChild);
    while (root.children.length > MAX_EVENTS_DISPLAY) root.removeChild(root.lastChild);
  }

  function connectSse() {
    const stateEl = $("hdr-sse-state");
    let es;
    try { es = new EventSource("/events"); } catch { stateEl.textContent = "n/a"; return; }
    es.addEventListener("open", () => { stateEl.textContent = "live"; });
    es.addEventListener("error", () => { stateEl.textContent = "reconnecting…"; });
    es.addEventListener("message", (m) => {
      try { appendEvent(JSON.parse(m.data), true); } catch { /* ignore */ }
    });
  }

  pollSnapshot();
  setInterval(pollSnapshot, 5000);
  connectSse();
})();
</script>
</body>
</html>`;

function parseArgs(argv) {
  const a = argv.slice(2);
  const out = {
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    open: true,
    once: false,
    help: false,
  };
  for (let i = 0; i < a.length; i += 1) {
    const t = a[i];
    if (t === "--port") {
      out.port = Number(a[i + 1] ?? DEFAULT_PORT);
      i += 1;
    } else if (t === "--no-open") {
      out.open = false;
    } else if (t === "--once") {
      out.once = true;
    } else if (t === "--help" || t === "-h") {
      out.help = true;
    }
  }
  if (!Number.isFinite(out.port) || out.port <= 0 || out.port > 65535) {
    out.port = DEFAULT_PORT;
  }
  return out;
}

function printHelp() {
  console.log(`chuck-dashboard.mjs — Chuck's persistent + dynamic dashboard.

  node chuck-dashboard.mjs [--port N] [--no-open] [--once]

    --port N      HTTP port (default ${DEFAULT_PORT}; PORT env also honored)
    --no-open     don't auto-launch the browser
    --once        snapshot once to stdout (JSON) and exit (for scripts)
    --help        this message
`);
}

export async function startServer({ port = DEFAULT_PORT, open: openBrowser = true } = {}) {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      try {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("server error");
      } catch {
        /* noop */
      }
    });
  });
  server.keepAliveTimeout = 0;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const url = `http://localhost:${port}`;
  console.log(`[chuck-dashboard] serving on ${url} (loopback only)`);
  if (openBrowser) {
    try {
      const child = spawn("open", [url], { stdio: "ignore", detached: true });
      child.unref();
    } catch {
      /* noop */
    }
  }
  return server;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return null;
  }
  if (args.once) {
    const snap = await buildSnapshot();
    console.log(JSON.stringify(snap, null, 2));
    return { mode: "once" };
  }
  const server = await startServer({ port: args.port, open: args.open });
  const shutdown = (sig) => {
    console.log(`[chuck-dashboard] shutting down (${sig})`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return new Promise(() => {});
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  wrapLifecycle("chuck-dashboard", main).catch((err) => {
    console.error(`[chuck-dashboard] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
