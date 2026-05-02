#!/usr/bin/env node
// apex-ring: 2
// =============================================================================
// PARTIAL SALVAGE — Unit 17 of the openclaw-first migration (2026-05-01).
// =============================================================================
// The TYPED HTTP CLIENT lives at:
//   extensions/skill-dashboard/src/* (re-exported via
//   @openclaw/skill-dashboard api.ts)
//
// This .mjs is the CANONICAL implementation: 9454 LOC of HTTP server +
// state aggregation across ~50 /api/* endpoints + per-endpoint handlers +
// the operator cockpit Joseph reads in his browser at localhost:7777.
//
// LaunchAgent: ~/Library/LaunchAgents/com.openclaw.chuck-dashboard.plist
// runs the daemon under KeepAlive=true. It stays the cockpit until openclaw
// supports long-running plugin daemons AND the TS port lands.
//
// What the typed plugin gives in-process callers (introspect, morning-digest,
// cross-plugin status surfaces): a typed HTTP client (`dashboard` tool with
// query/health/status actions; programmatic fetchDashboardEndpoint /
// checkDashboardHealth / readLaunchAgentStatus). The plugin is READ-ONLY by
// design — it never POSTs / never restarts the daemon.
//
// FULL TS source-port queued for the openclaw daemon-plugin phase. At that
// point port the routing layer + ~50 per-endpoint handlers + state aggregation
// pipeline into ./src/* — then retire BOTH the .mjs AND the LaunchAgent. The
// plugin's typed query surface stays the public contract; the in-process call
// path replaces the HTTP round-trip.
//
// WIRE FORMAT (must stay byte-stable for downstream readers):
//   - Every /api/* response shape (chuck-v3 perichoresis / compaction /
//     docket-drafts / executor / authority-gates / self-improvement-lab /
//     push; chuck-v2 build / work-ledger / live-build / doctor /
//     family-registry / latest-fleet-run / surface-control / surface-atlas /
//     capability-ledger / transport-audit; top-level snapshot / fleet /
//     principles / processes / mac-health / mac-self-heal / repo-hygiene /
//     github-hygiene / upstream-sync / panels / curator / scorer / router)
//   - Default port 7777, loopback-only bind (127.0.0.1)
//   - LaunchAgent label "com.openclaw.chuck-dashboard"
// =============================================================================
//
// chuck-dashboard — Chuck's persistent + dynamic status surface.
//
// Joseph wants to *see* Chuck's live state without asking — fleet health,
// principle scores, in-flight processes, recent panels, live event stream —
// all in a single auto-refreshing browser page on localhost.

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { cpus, freemem, homedir, loadavg, totalmem, uptime } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emit, readEvents, stats as eventStats, subscribeFile } from "./apex-event-bus.mjs";
import { wrapLifecycle } from "./apex-lifecycle.mjs";
import { audit as fleetAudit } from "./chuck-fleet.mjs";
import {
  loadVapidKeys as loadWebPushVapid,
  listSubscriptions as listWebPushSubscriptions,
  saveSubscription as saveWebPushSubscription,
  removeSubscription as removeWebPushSubscription,
} from "./chuck-web-push.mjs";

const HOME = homedir();
const STATE_DIR = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V2_STATE_DIR = join(STATE_DIR, "chuck-v2");
const CHUCK_V3_STATE_DIR = join(STATE_DIR, "chuck-v3");
const CHUCK_V3_DOCKET_DIR = join(CHUCK_V3_STATE_DIR, "docket");
const EXECUTOR_CONTROL_PATH = join(CHUCK_V3_STATE_DIR, "executor-control.json");
const PRIORS_DIR = join(CHUCK_V3_STATE_DIR, "priors");
const LATEST_PRIOR_PATH = join(PRIORS_DIR, "latest.json");
const POSTERIOR_DELTAS_DIR = join(CHUCK_V3_STATE_DIR, "posterior-deltas");
const READ_MARKERS_DIR = join(CHUCK_V3_STATE_DIR, "read-markers");
const DISSENT_DIR = join(CHUCK_V3_STATE_DIR, "dissent");
const COMPACTIONS_DIR = join(CHUCK_V3_STATE_DIR, "compactions");
const AUTHORITY_GATES_DIR = join(CHUCK_V3_STATE_DIR, "authority-gates");
const AUTHORITY_GATE_STATE_PATH = join(AUTHORITY_GATES_DIR, "skill-quarantine.json");
const AUTHORITY_GATE_RECEIPTS_DIR = join(AUTHORITY_GATES_DIR, "receipts");
const SELF_IMPROVEMENT_LAB_DIR = join(CHUCK_V3_STATE_DIR, "self-improvement-lab");
const SELF_IMPROVEMENT_PROPOSALS_DIR = join(SELF_IMPROVEMENT_LAB_DIR, "proposals");
const SELF_IMPROVEMENT_RECEIPTS_DIR = join(SELF_IMPROVEMENT_LAB_DIR, "receipts");
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
const WORK_LEDGER_PATH = join(CHUCK_V2_STATE_DIR, "parallel-work-ledger.jsonl");
const WORK_LEDGER_LATEST_PATH = join(CHUCK_V2_STATE_DIR, "parallel-work-latest.json");
const LIVE_BUILD_EVENTS_PATH = join(CHUCK_V2_STATE_DIR, "live-build-events.jsonl");
const LIVE_BUILD_LATEST_PATH = join(CHUCK_V2_STATE_DIR, "live-build-latest.json");
const SCORES_PATH = join(STATE_DIR, "apex-principle-scores.json");
const CURATOR_PATH = join(STATE_DIR, "apex-curator-state.json");
const FLEET_ROUTER_PATH = join(STATE_DIR, "fleet-router-scores.json");
let surfaceAtlasCache = null;
let capabilityLedgerCache = null;
let transportAuditCache = null;
const launchdStatusCache = new Map();
let macExecutionGateCache = null;

const DEFAULT_PORT = 7777;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const CHUCK_V2_RUN = join(REPO_ROOT, "extensions", "memory-graph", "scripts", "chuck-v2-run.ts");
const CHUCK_PRIOR_COMPACTION = join(
  REPO_ROOT,
  "extensions",
  "memory-graph",
  "scripts",
  "chuck-prior-compaction.mjs",
);
const CHUCK_MAC_SELF_HEAL = join(
  REPO_ROOT,
  "extensions",
  "memory-graph",
  "scripts",
  "chuck-mac-self-heal.mjs",
);
const MAC_SELF_HEAL_STATE_DIR = join(CHUCK_V3_STATE_DIR, "mac-self-heal");
const MAC_SELF_HEAL_RECEIPTS_DIR = join(MAC_SELF_HEAL_STATE_DIR, "receipts");
const MAC_SELF_HEAL_ARCHIVES_DIR = join(MAC_SELF_HEAL_STATE_DIR, "archives");
const MAC_SELF_HEAL_PURGE_RECEIPTS_DIR = join(MAC_SELF_HEAL_STATE_DIR, "local-purges");
const MAX_COMMAND_BODY_BYTES = 128 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const DOCKET_EXECUTOR_LABEL = "com.openclaw.chuck-docket-executor";
const OPENCLAW_LOG_DIR = join(HOME, ".openclaw", "logs");
const EXECUTOR_STDOUT_LOG = join(OPENCLAW_LOG_DIR, "chuck-docket-executor.out.log");
const EXECUTOR_STDERR_LOG = join(OPENCLAW_LOG_DIR, "chuck-docket-executor.err.log");
const STALE_RUNNING_MS = 2 * 60 * 60 * 1000;
const EXECUTOR_LOG_TAIL_CHARS = 12 * 1024;
const TASK_LOG_TAIL_CHARS = 2800;
const SELF_IMPROVEMENT_APPROVE_TOKEN = "APPROVE_SELF_IMPROVEMENT_PROPOSAL";
const SELF_IMPROVEMENT_REJECT_TOKEN = "REJECT_SELF_IMPROVEMENT_PROPOSAL";
const EXECUTOR_COMMAND_KINDS = new Set([
  "bootstrap",
  "doctor",
  "capability-ledger",
  "docket-list",
  "prior-capsule",
  "live-scout",
  "codex-build",
  "claude-cli-build",
  "mac-self-heal",
]);
const EXECUTOR_GLOBAL_RUNNING_CAP = 3;
const EXECUTOR_COMMAND_LANES = new Map([
  ["bootstrap", "diagnostic"],
  ["doctor", "diagnostic"],
  ["capability-ledger", "diagnostic"],
  ["docket-list", "diagnostic"],
  ["prior-capsule", "memory"],
  ["live-scout", "scout"],
  ["codex-build", "build"],
  ["claude-cli-build", "build"],
  ["mac-self-heal", "maintenance"],
]);
const EXECUTOR_LANE_POLICY = new Map([
  ["diagnostic", { maxRunning: 1 }],
  ["memory", { maxRunning: 1 }],
  ["scout", { maxRunning: 1 }],
  ["build", { maxRunning: 1 }],
  ["maintenance", { maxRunning: 1 }],
]);
const EXECUTOR_LANE_TIMEOUT_POLICY = new Map([
  ["diagnostic", { defaultMs: 5 * 60 * 1000, longMs: 5 * 60 * 1000, maxMs: 15 * 60 * 1000 }],
  ["memory", { defaultMs: 10 * 60 * 1000, longMs: 20 * 60 * 1000, maxMs: 30 * 60 * 1000 }],
  ["maintenance", { defaultMs: 20 * 60 * 1000, longMs: 45 * 60 * 1000, maxMs: 60 * 60 * 1000 }],
  ["scout", { defaultMs: 45 * 60 * 1000, longMs: 90 * 60 * 1000, maxMs: 2 * 60 * 60 * 1000 }],
  ["build", { defaultMs: 45 * 60 * 1000, longMs: 2 * 60 * 60 * 1000, maxMs: 2 * 60 * 60 * 1000 }],
]);
const MAC_GATE_EXEMPT_COMMAND_KINDS = new Set([
  "bootstrap",
  "doctor",
  "capability-ledger",
  "docket-list",
  "prior-capsule",
  "mac-self-heal",
]);
const MAC_GATE_THRESHOLDS = {
  diskWarnFreePercent: 0.1,
  diskMinFreeBytes: 25 * 1024 ** 3,
  swapWarnUsedBytes: 10 * 1024 ** 3,
};
const MAC_GATE_CACHE_MS = 5000;

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

function readJsonlTail(path, { limit = 20 } = {}) {
  if (!existsSync(path)) {
    return [];
  }
  return safe(
    () =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line))
        .toReversed(),
    [],
  );
}

function dashboardGitSnapshot({ limit = 80 } = {}) {
  const status = spawnSync("git", ["status", "--short"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 5000,
  });
  const branch = spawnSync("git", ["branch", "--show-current"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 3000,
  });
  if (status.status !== 0) {
    return {
      available: false,
      reason: status.stderr || "git status failed",
      branch: branch.stdout?.trim() || null,
      dirtyCount: 0,
      files: [],
    };
  }
  const files = (status.stdout ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const renameIndex = rawPath.lastIndexOf(" -> ");
      const path = renameIndex >= 0 ? rawPath.slice(renameIndex + 4).trim() : rawPath;
      return { code, path };
    });
  return {
    available: true,
    branch: branch.stdout?.trim() || null,
    dirtyCount: files.length,
    files: files.slice(0, limit),
  };
}

function workLedgerStatus({ limit = 12 } = {}) {
  const latest = readJsonSafe(WORK_LEDGER_LATEST_PATH, null);
  const events = latest?.events?.length
    ? latest.events.slice(0, limit)
    : readJsonlTail(WORK_LEDGER_PATH, { limit });
  const git = dashboardGitSnapshot({ limit: 80 });
  if (!latest && events.length === 0) {
    return {
      available: false,
      reason: "no parallel work ledger yet",
      ledgerPath: WORK_LEDGER_PATH,
      latestPath: WORK_LEDGER_LATEST_PATH,
      events: [],
      lanes: [],
      git,
    };
  }
  const byLane = new Map();
  for (const event of [...events].toReversed()) {
    const lane = event.lane ?? "default";
    if (!byLane.has(lane)) {
      byLane.set(lane, event);
    }
  }
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    ledgerPath: WORK_LEDGER_PATH,
    latestPath: WORK_LEDGER_LATEST_PATH,
    latestEvent: latest?.latestEvent ?? events[0] ?? null,
    events,
    lanes: [...byLane.values()].map((event) => ({
      lane: event.lane ?? "default",
      agent: event.agent ?? "unknown",
      status: event.status ?? "unknown",
      summary: event.summary ?? "",
      updatedAt: event.createdAt ?? event.updatedAt ?? null,
      files: event.files ?? [],
    })),
    git,
  };
}

function liveBuildStatus({ limit = 20 } = {}) {
  const latest = readJsonSafe(LIVE_BUILD_LATEST_PATH, null);
  const events = latest?.events?.length
    ? latest.events.slice(0, limit)
    : readJsonlTail(LIVE_BUILD_EVENTS_PATH, { limit });
  const active = new Map();
  for (const event of [...events].toReversed()) {
    const runId = event.runId ?? event.id;
    if (!runId) {
      continue;
    }
    const existing = active.get(runId);
    if (!existing || Date.parse(event.createdAt ?? 0) >= Date.parse(existing.createdAt ?? 0)) {
      active.set(runId, event);
    }
  }
  const activeRuns = [...active.values()]
    .filter((event) => ["started", "running"].includes(event.status))
    .toSorted((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0));
  return {
    available: latest !== null || events.length > 0,
    generatedAt: new Date().toISOString(),
    eventsPath: LIVE_BUILD_EVENTS_PATH,
    latestPath: LIVE_BUILD_LATEST_PATH,
    latestEvent: latest?.latestEvent ?? events[0] ?? null,
    activeRuns,
    events,
  };
}

function appendLiveBuildEvent(event) {
  const entry = {
    id: `live-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    ...event,
  };
  const dir = dirname(LIVE_BUILD_EVENTS_PATH);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(LIVE_BUILD_EVENTS_PATH, `${JSON.stringify(entry)}\n`, "utf8");
    const events = readJsonlTail(LIVE_BUILD_EVENTS_PATH, { limit: 30 });
    const latest = {
      available: true,
      generatedAt: new Date().toISOString(),
      eventsPath: LIVE_BUILD_EVENTS_PATH,
      latestPath: LIVE_BUILD_LATEST_PATH,
      latestEvent: entry,
      events,
    };
    writeFileSync(LIVE_BUILD_LATEST_PATH, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  } catch {
    /* live events must never break the command path */
  }
  return entry;
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

function writeJsonAtomicSync(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function resolvedPathInside(child, root) {
  const resolvedChild = resolve(child);
  const resolvedRoot = resolve(root);
  return resolvedChild === resolvedRoot || resolvedChild.startsWith(`${resolvedRoot}/`);
}

function executorControlStatus() {
  if (!existsSync(EXECUTOR_CONTROL_PATH)) {
    return {
      available: true,
      mode: "active",
      paused: false,
      reason: "default active; no control file",
      updatedAt: null,
      updatedBy: null,
      path: EXECUTOR_CONTROL_PATH,
    };
  }
  try {
    const control = JSON.parse(readFileSync(EXECUTOR_CONTROL_PATH, "utf8"));
    const mode = control?.mode === "paused" ? "paused" : "active";
    return {
      available: true,
      mode,
      paused: mode === "paused",
      reason: typeof control?.reason === "string" ? control.reason : "",
      updatedAt: control?.updatedAt ?? null,
      updatedBy: control?.updatedBy ?? null,
      path: EXECUTOR_CONTROL_PATH,
    };
  } catch (err) {
    return {
      available: false,
      mode: "paused",
      paused: true,
      reason: `fail-closed: executor control unreadable (${err.message})`,
      updatedAt: null,
      updatedBy: "chuck-dashboard",
      path: EXECUTOR_CONTROL_PATH,
      failClosed: true,
    };
  }
}

function writeExecutorControl({ mode, reason = "", updatedBy = "operator/cockpit" }) {
  const normalizedMode = mode === "paused" ? "paused" : "active";
  const now = new Date().toISOString();
  const control = {
    mode: normalizedMode,
    paused: normalizedMode === "paused",
    reason: String(
      reason ||
        (normalizedMode === "paused"
          ? "operator paused executor intake"
          : "operator resumed executor intake"),
    ).slice(0, 300),
    updatedAt: now,
    updatedBy: String(updatedBy || "operator/cockpit").slice(0, 120),
    path: EXECUTOR_CONTROL_PATH,
  };
  writeJsonAtomicSync(EXECUTOR_CONTROL_PATH, control);
  return control;
}

function executorIntakePaused(control) {
  return control?.paused === true || control?.mode === "paused";
}

function latestJsonFiles(dir, { limit = 8 } = {}) {
  if (!existsSync(dir)) {
    return [];
  }
  return safe(
    () =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const path = join(dir, name);
          return {
            name,
            path,
            mtimeMs: safe(() => statSync(path).mtimeMs, 0),
          };
        })
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
        .slice(0, limit)
        .map((file) => ({
          ...file,
          data: readJsonSafe(file.path, null),
        }))
        .filter((file) => file.data)
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name)),
    [],
  );
}

function countJsonFiles(dir) {
  if (!existsSync(dir)) {
    return 0;
  }
  return safe(() => readdirSync(dir).filter((name) => name.endsWith(".json")).length, 0);
}

function truncateText(value, max = 260) {
  const text = String(value ?? "").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function tailText(value, max = 2000) {
  const text = String(value ?? "");
  if (text.length <= max) {
    return text;
  }
  return text.slice(Math.max(0, text.length - max));
}

function tailFileText(path, { maxChars = EXECUTOR_LOG_TAIL_CHARS } = {}) {
  if (!existsSync(path)) {
    return {
      available: false,
      path,
      reason: "log file missing",
      bytes: 0,
      text: "",
    };
  }
  try {
    const stat = statSync(path);
    const text = tailText(readFileSync(path, "utf8"), maxChars);
    return {
      available: true,
      path,
      bytes: stat.size,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      truncated: stat.size > Buffer.byteLength(text, "utf8"),
      text,
    };
  } catch (err) {
    return {
      available: false,
      path,
      reason: err.message,
      bytes: 0,
      text: "",
    };
  }
}

function parseTimeMs(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function firstMatch(text, pattern) {
  const match = String(text ?? "").match(pattern);
  return match ? match[1] : null;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function launchdServiceStatus(label) {
  const cached = launchdStatusCache.get(label);
  if (cached && Date.now() - cached.at < 30_000) {
    return cached.value;
  }
  try {
    const result = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1000,
    });
    if (result.status !== 0) {
      const missing = {
        service: label,
        present: false,
        state: "missing",
        pid: null,
        runs: null,
        reason: (result.stderr ?? "").trim() || `launchctl exited ${result.status}`,
      };
      launchdStatusCache.set(label, { at: Date.now(), value: missing });
      return missing;
    }
    const output = result.stdout ?? "";
    const status = {
      service: label,
      present: true,
      state: firstMatch(output, /^\s*state = (.+)$/m) ?? "unknown",
      pid: numberOrNull(firstMatch(output, /^\s*pid = ([0-9]+)$/m)),
      runs: numberOrNull(firstMatch(output, /^\s*runs = ([0-9]+)$/m)),
      lastExitStatus: numberOrNull(firstMatch(output, /^\s*last exit code = (-?[0-9]+)$/m)),
    };
    launchdStatusCache.set(label, { at: Date.now(), value: status });
    return status;
  } catch (err) {
    const unavailable = {
      service: label,
      present: false,
      state: "unknown",
      pid: null,
      runs: null,
      reason: err instanceof Error ? err.message : String(err),
    };
    launchdStatusCache.set(label, { at: Date.now(), value: unavailable });
    return unavailable;
  }
}

function summarizeV3DocketTask(task, file) {
  const heartbeats = Array.isArray(task?.heartbeats) ? task.heartbeats : [];
  const lastHeartbeat = heartbeats.at(-1) ?? null;
  return {
    taskId: task?.id ?? task?.taskId ?? file.name.replace(/\.json$/, ""),
    title: task?.title ?? task?.summary ?? "(untitled)",
    status: String(task?.status ?? "unknown").toLowerCase(),
    risk: task?.risk ?? null,
    commandKind: task?.commandKind ?? null,
    surface: task?.surface ?? null,
    updatedAt:
      task?.updatedAt ??
      task?.finishedAt ??
      task?.startedAt ??
      new Date(file.mtimeMs).toISOString(),
    startedAt: task?.startedAt ?? null,
    finishedAt: task?.finishedAt ?? null,
    exitCode: task?.exitCode ?? null,
    timedOut: task?.timedOut ?? null,
    durationMs: task?.durationMs ?? null,
    lastHeartbeat: lastHeartbeat
      ? {
          at: lastHeartbeat.at ?? null,
          phase: lastHeartbeat.phase ?? null,
          message: lastHeartbeat.message ?? null,
        }
      : null,
    priorCapsuleBefore: task?.priorCapsuleBefore
      ? {
          priorId: task.priorCapsuleBefore.priorId ?? null,
          sourceHash: task.priorCapsuleBefore.sourceHash ?? null,
          injectedIntoPrompt: task.priorCapsuleBefore.injectedIntoPrompt ?? null,
        }
      : null,
    posteriorDeltas: task?.posteriorDeltas
      ? {
          deltaCount: task.posteriorDeltas.deltaCount ?? 0,
          readMarkerCount: task.posteriorDeltas.readMarkerCount ?? 0,
        }
      : null,
    file: file.path,
  };
}

function summarizePriorCapsule(prior) {
  if (!prior) {
    return null;
  }
  return {
    priorId: prior.priorId ?? null,
    createdAt: prior.createdAt ?? null,
    sourceHash: prior.sourceHash ?? null,
    path: LATEST_PRIOR_PATH,
    doctrine: {
      name: prior.doctrine?.name ?? null,
      claim: prior.doctrine?.claim ?? null,
      loop: Array.isArray(prior.doctrine?.loop) ? prior.doctrine.loop : [],
    },
    authorityModel: prior.authorityModel ?? null,
    compactionState: prior.compactionState ?? null,
    compactionCursor: prior.compactionCursor ?? null,
    compactedClaimCount: Array.isArray(prior.compactedClaims) ? prior.compactedClaims.length : 0,
    compactedClaims: Array.isArray(prior.compactedClaims)
      ? prior.compactedClaims.slice(0, 6).map((claim) => ({
          claimKey: claim.claimKey ?? null,
          text: truncateText(claim.text, 240),
          confidence: claim.confidence ?? null,
          authorityImpact: claim.authorityImpact ?? null,
          families: Array.isArray(claim.families) ? claim.families : [],
        }))
      : [],
    focus: prior.operatorIntent?.focus ?? null,
    lastTurn: prior.operatorIntent?.lastTurn ?? null,
    modelReadiness: prior.systemState?.modelReadiness ?? null,
    priorExecutorSnapshot: prior.systemState?.executor ?? null,
    activeTaskCount: Array.isArray(prior.activeTasks) ? prior.activeTasks.length : 0,
    recentDocketCount: Array.isArray(prior.recentDocket) ? prior.recentDocket.length : 0,
    recentDeltaCount: Array.isArray(prior.recentPosteriorDeltas)
      ? prior.recentPosteriorDeltas.length
      : 0,
    recentReadMarkerCount: Array.isArray(prior.recentReadMarkers)
      ? prior.recentReadMarkers.length
      : 0,
    openQuestions: Array.isArray(prior.openQuestions) ? prior.openQuestions.slice(0, 8) : [],
    recommendedNextActions: Array.isArray(prior.recommendedNextActions)
      ? prior.recommendedNextActions.slice(0, 8)
      : [],
    hardConstraints: Array.isArray(prior.hardConstraints) ? prior.hardConstraints.slice(0, 8) : [],
    approvalGates: Array.isArray(prior.approvalGates) ? prior.approvalGates.slice(0, 8) : [],
    evidencePointers: Array.isArray(prior.evidencePointers)
      ? prior.evidencePointers.slice(0, 8)
      : [],
  };
}

function summarizePosteriorDelta(delta, file) {
  const claims = Array.isArray(delta?.claims) ? delta.claims : [];
  const recommendedNextActions = Array.isArray(delta?.recommendedNextActions)
    ? delta.recommendedNextActions
    : [];
  const openQuestions = Array.isArray(delta?.openQuestions) ? delta.openQuestions : [];
  return {
    deltaId: delta?.deltaId ?? file.name.replace(/\.json$/, ""),
    priorId: delta?.priorId ?? null,
    taskId: delta?.taskId ?? null,
    createdAt: delta?.createdAt ?? new Date(file.mtimeMs).toISOString(),
    producer: delta?.producer ?? null,
    family: delta?.producer?.family ?? "unknown",
    surface: delta?.producer?.surface ?? "unknown",
    confidence: delta?.confidence ?? null,
    authorityImpact: delta?.authorityImpact ?? null,
    claimCount: claims.length,
    evidenceCount: Array.isArray(delta?.evidence) ? delta.evidence.length : 0,
    dissentCount: Array.isArray(delta?.dissent) ? delta.dissent.length : 0,
    openQuestionCount: openQuestions.length,
    recommendedNextActionCount: recommendedNextActions.length,
    claimsPreview: claims.slice(0, 3).map((claim) => ({
      claimId: claim?.claimId ?? null,
      status: claim?.status ?? null,
      confidence: claim?.confidence ?? null,
      text: truncateText(claim?.text, 240),
    })),
    openQuestions: openQuestions.slice(0, 3).map((item) => truncateText(item, 180)),
    recommendedNextActions: recommendedNextActions
      .slice(0, 3)
      .map((item) => truncateText(item, 220)),
    file: file.path,
  };
}

function summarizeReadMarker(marker, file) {
  return {
    markerId: marker?.markerId ?? file.name.replace(/\.json$/, ""),
    priorId: marker?.priorId ?? null,
    seenAt: marker?.seenAt ?? new Date(file.mtimeMs).toISOString(),
    reader: marker?.reader ?? null,
    family: marker?.reader?.family ?? "unknown",
    surface: marker?.reader?.surface ?? "unknown",
    result: marker?.result ?? null,
    scope: marker?.scope ?? null,
    deltaIds: Array.isArray(marker?.deltaIds) ? marker.deltaIds.slice(0, 8) : [],
    notes: truncateText(marker?.notes, 220),
    file: file.path,
  };
}

function summarizeDissentRecord(dissent, file) {
  return {
    dissentId: dissent?.dissentId ?? file.name.replace(/\.json$/, ""),
    claimId: dissent?.claimId ?? null,
    raisedBy: dissent?.raisedBy ?? null,
    family: dissent?.raisedBy?.family ?? "unknown",
    surface: dissent?.raisedBy?.surface ?? "unknown",
    against: Array.isArray(dissent?.against) ? dissent.against.slice(0, 8) : [],
    reason: truncateText(dissent?.reason, 260),
    evidenceCount: Array.isArray(dissent?.evidence) ? dissent.evidence.length : 0,
    status: dissent?.status ?? "unknown",
    createdAt: dissent?.createdAt ?? new Date(file.mtimeMs).toISOString(),
    resolvedAt: dissent?.resolvedAt ?? null,
    file: file.path,
  };
}

function proposalLaneFromDeltas(deltas) {
  return deltas
    .filter(
      (delta) =>
        delta.authorityImpact === "proposal" ||
        delta.recommendedNextActionCount > 0 ||
        delta.authorityImpact === "blocked",
    )
    .slice(0, 8)
    .map((delta) => {
      const action =
        delta.recommendedNextActions?.[0] ??
        delta.claimsPreview?.[0]?.text ??
        `${delta.family}/${delta.surface} produced a ${delta.authorityImpact ?? "candidate"} delta.`;
      const status =
        delta.authorityImpact === "blocked"
          ? "blocked"
          : delta.authorityImpact === "proposal"
            ? "needs-compaction-gate"
            : "candidate";
      return {
        proposalId: `proposal-${delta.deltaId}`,
        status,
        title: truncateText(action, 180),
        deltaId: delta.deltaId,
        priorId: delta.priorId,
        producer: delta.producer,
        family: delta.family,
        surface: delta.surface,
        confidence: delta.confidence,
        authorityImpact: delta.authorityImpact,
        createdAt: delta.createdAt,
      };
    });
}

function compactionDecisionFiles({ limit = 40, statuses = null } = {}) {
  const statusSet = Array.isArray(statuses) ? new Set(statuses) : null;
  return latestJsonFiles(COMPACTIONS_DIR, { limit })
    .filter((file) => file.data?.schemaVersion === "chuck.prior-compaction-decision.v1")
    .filter((file) => !statusSet || statusSet.has(file.data?.status));
}

function summarizeCompactionDecision(decision, file = null) {
  if (!decision) {
    return null;
  }
  return {
    decisionId: decision.decisionId ?? null,
    status: decision.status ?? "unknown",
    sourcePriorId: decision.sourcePriorId ?? null,
    resultingPriorId: decision.resultingPriorId ?? null,
    createdAt: decision.createdAt ?? (file ? new Date(file.mtimeMs).toISOString() : null),
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
    promotedClaimPreview: Array.isArray(decision.promotedClaims)
      ? decision.promotedClaims.slice(0, 4).map((claim) => ({
          claimKey: claim.claimKey,
          text: truncateText(claim.text, 220),
          families: claim.families,
          confidence: claim.confidence,
          authorityImpact: claim.authorityImpact,
        }))
      : [],
    deferredClaimPreview: Array.isArray(decision.deferredClaims)
      ? decision.deferredClaims.slice(0, 4).map((claim) => ({
          claimId: claim.claimId,
          text: truncateText(claim.text, 180),
          reason: truncateText(claim.reason, 180),
        }))
      : [],
  };
}

function runPriorCompaction(args, { timeoutMs = 20_000 } = {}) {
  const result = spawnSync(process.execPath, [CHUCK_PRIOR_COMPACTION, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw httpError(result.error.message, 500);
  }
  if (result.status !== 0) {
    throw httpError(
      String(result.stderr || result.stdout || "prior compaction command failed").trim(),
      500,
    );
  }
  return parseJsonStdout(result.stdout);
}

function compactionStatus() {
  const status = runPriorCompaction(["status", "--json"], { timeoutMs: 20_000 });
  const latestFiles = compactionDecisionFiles({ limit: 8 });
  return {
    ...status,
    apiPath: "/api/chuck-v3/compaction",
    latestDecisions: latestFiles.map((file) => summarizeCompactionDecision(file.data, file)),
  };
}

async function handleCompactionPreview(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const args = ["preview", "--json"];
  if (body.write === true) {
    args.push("--write");
  }
  const result = runPriorCompaction(args, { timeoutMs: 20_000 });
  await emit({
    source: "chuck-dashboard",
    type:
      body.write === true
        ? "chuck.prior-compaction.preview-written"
        : "chuck.prior-compaction.previewed",
    payload: {
      decisionId: result.decision?.decisionId ?? null,
      writes: result.writes === true,
      path: result.path ?? null,
      includedDeltaCount: result.decision?.includedDeltaIds?.length ?? 0,
      promotedClaimCount: result.decision?.promotedClaims?.length ?? 0,
      deferredClaimCount: result.decision?.deferredClaims?.length ?? 0,
    },
  });
  return jsonResponse(res, body.write === true ? 201 : 200, result);
}

async function handleCompactionApprove(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  if (body.confirm !== "APPROVE_PRIOR_COMPACTION") {
    throw httpError("confirm must equal APPROVE_PRIOR_COMPACTION", 409);
  }
  const decision = String(body.decisionId ?? body.decision ?? "").trim();
  if (!decision) {
    throw httpError("decisionId is required", 400);
  }
  const result = runPriorCompaction(
    [
      "approve",
      "--decision",
      decision,
      "--confirm",
      "APPROVE_PRIOR_COMPACTION",
      "--approved-by",
      String(body.approvedBy ?? "operator/cockpit").slice(0, 120),
      "--json",
    ],
    { timeoutMs: 60_000 },
  );
  await emit({
    source: "chuck-dashboard",
    type: "chuck.prior-compaction.approve-requested",
    payload: {
      decisionId: result.decisionId ?? decision,
      resultingPriorId: result.resultingPriorId ?? null,
      path: result.path ?? null,
    },
  });
  return jsonResponse(res, 200, result);
}

function perichoresisStatus({ limit = 8 } = {}) {
  const prior = readJsonSafe(LATEST_PRIOR_PATH, null);
  const docket = latestJsonFiles(CHUCK_V3_DOCKET_DIR, { limit }).map((file) =>
    summarizeV3DocketTask(file.data, file),
  );
  const posteriorDeltas = latestJsonFiles(POSTERIOR_DELTAS_DIR, { limit }).map((file) =>
    summarizePosteriorDelta(file.data, file),
  );
  const readMarkers = latestJsonFiles(READ_MARKERS_DIR, { limit }).map((file) =>
    summarizeReadMarker(file.data, file),
  );
  const dissent = latestJsonFiles(DISSENT_DIR, { limit }).map((file) =>
    summarizeDissentRecord(file.data, file),
  );
  const ledger = {
    priorCount: countJsonFiles(PRIORS_DIR),
    posteriorDeltaCount: countJsonFiles(POSTERIOR_DELTAS_DIR),
    readMarkerCount: countJsonFiles(READ_MARKERS_DIR),
    dissentCount: countJsonFiles(DISSENT_DIR),
    latestPrior: existsSync(LATEST_PRIOR_PATH) ? LATEST_PRIOR_PATH : null,
    latestPosteriorDelta: posteriorDeltas[0]?.file ?? null,
    latestReadMarker: readMarkers[0]?.file ?? null,
    latestDissent: dissent[0]?.file ?? null,
  };
  const activeTasks = docket.filter(
    (task) => !["completed", "done", "closed", "failed", "cancelled"].includes(task.status),
  );
  return {
    available: Boolean(prior),
    reason: prior ? null : "no latest prior capsule yet",
    generatedAt: new Date().toISOString(),
    apiPath: "/api/chuck-v3/perichoresis",
    prior: summarizePriorCapsule(prior),
    ledger,
    executor: launchdServiceStatus(DOCKET_EXECUTOR_LABEL),
    activeTasks,
    recentDocket: docket,
    posteriorDeltas,
    readMarkers,
    dissent,
    proposals: proposalLaneFromDeltas(posteriorDeltas),
  };
}

function docketDraftId() {
  return `task-cockpit-proposal-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function buildProposalDocketDraft(proposal, { createdBy = "chuck-cockpit" } = {}) {
  const now = new Date().toISOString();
  const id = docketDraftId();
  const producer = [proposal.family, proposal.surface].filter(Boolean).join("/");
  const intent = [
    "Review this posterior proposal against the current universal prior.",
    `Proposal: ${proposal.title}`,
    `Producer: ${producer || "unknown"}`,
    `Prior: ${proposal.priorId ?? "unknown"}`,
    `Delta: ${proposal.deltaId ?? "unknown"}`,
    "Return CLAIMS, RISKS, MISSING_EVIDENCE, and DEEPEN_NEEDED.",
    "Do not mutate files; this draft only prepares evidence for a later compaction decision.",
  ].join("\n");
  return {
    id,
    title: `Draft review: ${truncateText(proposal.title, 120)}`,
    status: "draft",
    risk: "low",
    commandKind: "live-scout",
    surface: "chuck-cockpit",
    intent,
    createdAt: now,
    updatedAt: now,
    createdBy,
    source: {
      kind: "perichoresis-proposal",
      proposalId: proposal.proposalId,
      deltaId: proposal.deltaId,
      priorId: proposal.priorId,
      family: proposal.family,
      surface: proposal.surface,
      confidence: proposal.confidence,
      authorityImpact: proposal.authorityImpact,
      status: proposal.status,
    },
    heartbeats: [
      {
        at: now,
        phase: "drafted",
        message:
          "Created from cockpit proposal lane. Executor ignores draft status until a separate approval promotes it.",
      },
    ],
  };
}

function docketDraftFiles({ limit = 40 } = {}) {
  return latestJsonFiles(CHUCK_V3_DOCKET_DIR, { limit: Math.max(limit, 80) }).filter(
    (file) => String(file.data?.status ?? "").toLowerCase() === "draft",
  );
}

function executorEligibilityBlockers(
  task,
  { requirePending = true, control = null, activeTasks = [] } = {},
) {
  const blockers = [];
  const status = String(task?.status ?? "").toLowerCase();
  const commandKind = String(task?.commandKind ?? "");
  if (requirePending && executorIntakePaused(control)) {
    blockers.push("executor intake is paused");
  }
  if (requirePending && status !== "pending") {
    blockers.push("status is not pending");
  }
  if (task?.risk !== "low") {
    blockers.push("risk is not low");
  }
  if (!EXECUTOR_COMMAND_KINDS.has(commandKind)) {
    blockers.push("commandKind is not executor-allowlisted");
  }
  if (commandKind === "live-scout" && !String(task?.intent ?? task?.prompt ?? "").trim()) {
    blockers.push("live-scout is missing intent/prompt");
  }
  if (requirePending && EXECUTOR_COMMAND_KINDS.has(commandKind)) {
    blockers.push(...executorMacGateBlockers(task));
  }
  if (requirePending && status === "pending" && blockers.length === 0) {
    blockers.push(...executorLaneBlockers(task, activeTasks));
  }
  return blockers;
}

function summarizeDocketDraft(task, file) {
  const blockers = executorEligibilityBlockers(task, { requirePending: false });
  if (String(task?.status ?? "").toLowerCase() !== "draft") {
    blockers.push("not a draft");
  }
  return {
    taskId: task?.id ?? task?.taskId ?? file.name.replace(/\.json$/, ""),
    title: task?.title ?? "(untitled draft)",
    status: String(task?.status ?? "unknown").toLowerCase(),
    risk: task?.risk ?? null,
    commandKind: task?.commandKind ?? null,
    surface: task?.surface ?? null,
    createdAt: task?.createdAt ?? new Date(file.mtimeMs).toISOString(),
    updatedAt: task?.updatedAt ?? task?.createdAt ?? new Date(file.mtimeMs).toISOString(),
    source: task?.source ?? null,
    intentPreview: truncateText(task?.intent, 260),
    file: file.path,
    promotablePreview: blockers.length === 0,
    promotionBlockers: blockers,
  };
}

function docketDraftsStatus() {
  const drafts = docketDraftFiles({ limit: 80 }).map((file) =>
    summarizeDocketDraft(file.data, file),
  );
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    apiPath: "/api/chuck-v3/docket-drafts",
    draftCount: drafts.length,
    promotablePreviewCount: drafts.filter((draft) => draft.promotablePreview).length,
    drafts,
  };
}

function allDocketTaskFiles({ limit = 160 } = {}) {
  return latestJsonFiles(CHUCK_V3_DOCKET_DIR, { limit });
}

function docketTaskId(task, file) {
  return task?.id ?? task?.taskId ?? file.name.replace(/\.json$/, "");
}

function findDocketTaskById(taskId) {
  return allDocketTaskFiles({ limit: 500 }).find(
    (file) => docketTaskId(file.data, file) === taskId,
  );
}

function docketTaskLockStatus(path) {
  const lockPath = `${path}.lock`;
  if (!existsSync(lockPath)) {
    return { present: false, path: lockPath };
  }
  const mtimeMs = safe(() => statSync(lockPath).mtimeMs, null);
  const ageMs = mtimeMs ? Date.now() - mtimeMs : null;
  return {
    present: true,
    path: lockPath,
    ageMs,
    stale: ageMs !== null ? ageMs > STALE_RUNNING_MS : false,
    updatedAt: mtimeMs ? new Date(mtimeMs).toISOString() : null,
  };
}

function retryEligibilityBlockers(task) {
  return executorEligibilityBlockers(
    { ...task, status: "pending" },
    { control: { mode: "active", paused: false } },
  );
}

function executorCommandLane(commandKind) {
  return EXECUTOR_COMMAND_LANES.get(String(commandKind ?? "")) ?? null;
}

function parseOptionalPositiveInt(value) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function executorTimeoutPolicy(task) {
  if (task?.command?.timeoutPolicy && typeof task.command.timeoutPolicy === "object") {
    return task.command.timeoutPolicy;
  }
  const lane = executorCommandLane(task?.commandKind) ?? "unknown";
  const policy = EXECUTOR_LANE_TIMEOUT_POLICY.get(lane) ?? {
    defaultMs: 30 * 60 * 1000,
    longMs: 30 * 60 * 1000,
    maxMs: 30 * 60 * 1000,
  };
  const taskRequestedMs = parseOptionalPositiveInt(
    task?.timeoutMs ??
      task?.requestedTimeoutMs ??
      task?.expectedTimeoutMs ??
      task?.estimatedTimeoutMs,
  );
  const longRequested =
    task?.longRunning === true ||
    task?.timeoutClass === "long" ||
    task?.expectedDuration === "long" ||
    task?.durationClass === "long";
  let source = longRequested ? "task-long-running" : "lane-default";
  let requestedMs = longRequested ? policy.longMs : policy.defaultMs;
  if (taskRequestedMs !== null) {
    source = "task-requested";
    requestedMs = taskRequestedMs;
  }
  const timeoutMs = Math.min(requestedMs, policy.maxMs);
  return {
    lane,
    source,
    timeoutMs,
    requestedMs,
    defaultMs: policy.defaultMs,
    longMs: policy.longMs,
    maxMs: policy.maxMs,
    capped: requestedMs > policy.maxMs,
    longRunning: longRequested,
  };
}

function executorLaneBlockers(task, activeTasks = []) {
  const commandKind = String(task?.commandKind ?? "");
  const lane = executorCommandLane(commandKind);
  if (!lane) {
    return [];
  }
  const running = activeTasks.filter(
    (active) => String(active?.status ?? "").toLowerCase() === "running",
  );
  const laneRunning = running.filter((active) => executorCommandLane(active?.commandKind) === lane);
  const lanePolicy = EXECUTOR_LANE_POLICY.get(lane);
  const blockers = [];
  if (running.length >= EXECUTOR_GLOBAL_RUNNING_CAP) {
    blockers.push(`global running cap ${EXECUTOR_GLOBAL_RUNNING_CAP} reached`);
  }
  if (lanePolicy && laneRunning.length >= lanePolicy.maxRunning) {
    blockers.push(`lane ${lane} running cap ${lanePolicy.maxRunning} reached`);
  }
  return blockers;
}

function docketTaskActionHints(task, file) {
  const status = String(task?.status ?? "unknown").toLowerCase();
  const startedMs = parseTimeMs(task?.startedAt ?? task?.updatedAt ?? task?.createdAt);
  const runningAgeMs = status === "running" && startedMs !== null ? Date.now() - startedMs : null;
  const staleRunning = runningAgeMs !== null && runningAgeMs > STALE_RUNNING_MS;
  const retryBlockers = retryEligibilityBlockers(task);
  return {
    canCancel: ["draft", "pending"].includes(status),
    canRetry: ["failed", "completed", "cancelled"].includes(status) && retryBlockers.length === 0,
    canMarkStaleFailed: staleRunning,
    staleRunning,
    runningAgeMs,
    lock: docketTaskLockStatus(file.path),
    retryBlockers,
    confirmTokens: {
      cancel: "CANCEL_DOCKET_TASK",
      retry: "RETRY_DOCKET_TASK",
      markStaleFailed: "MARK_STALE_TASK_FAILED",
    },
  };
}

function summarizeExecutorQueueTask(task, file, { control = null, activeTasks = [] } = {}) {
  const status = String(task?.status ?? "unknown").toLowerCase();
  const heartbeats = Array.isArray(task?.heartbeats) ? task.heartbeats : [];
  const lastHeartbeat = heartbeats.at(-1) ?? null;
  const blockers = executorEligibilityBlockers(task, { control, activeTasks });
  return {
    taskId: docketTaskId(task, file),
    title: task?.title ?? task?.summary ?? "(untitled)",
    status,
    risk: task?.risk ?? null,
    commandKind: task?.commandKind ?? null,
    lane: executorCommandLane(task?.commandKind),
    timeoutPolicy: executorTimeoutPolicy(task),
    surface: task?.surface ?? null,
    createdAt: task?.createdAt ?? new Date(file.mtimeMs).toISOString(),
    updatedAt:
      task?.updatedAt ??
      task?.finishedAt ??
      task?.createdAt ??
      new Date(file.mtimeMs).toISOString(),
    startedAt: task?.startedAt ?? null,
    finishedAt: task?.finishedAt ?? null,
    promotedAt: task?.promotedAt ?? null,
    executorRunId: task?.executorRunId ?? null,
    exitCode: task?.exitCode ?? null,
    signal: task?.signal ?? null,
    timedOut: task?.timedOut === true,
    durationMs: task?.durationMs ?? null,
    file: file.path,
    mtimeMs: file.mtimeMs,
    executorEligible: blockers.length === 0,
    eligibilityBlockers: blockers,
    actionHints: docketTaskActionHints(task, file),
    hasStdout: Boolean(task?.stdoutTail),
    hasStderr: Boolean(task?.stderrTail),
    heartbeatPhase: lastHeartbeat?.phase ?? null,
    heartbeatAt: lastHeartbeat?.at ?? null,
    intentPreview: truncateText(task?.intent ?? task?.prompt, 180),
  };
}

function executorQueueStatus() {
  const control = executorControlStatus();
  const files = allDocketTaskFiles({ limit: 160 });
  const activeTasks = files.map((file) => file.data).filter(Boolean);
  const tasks = files
    .map((file) => summarizeExecutorQueueTask(file.data, file, { control, activeTasks }))
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  const drafts = tasks.filter((task) => task.status === "draft");
  const pending = tasks
    .filter((task) => task.status === "pending")
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs);
  const running = tasks
    .filter((task) => task.status === "running")
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs);
  const recentFinished = tasks
    .filter((task) => ["completed", "failed", "cancelled", "closed"].includes(task.status))
    .slice(0, 8);
  const eligiblePending = pending.filter((task) => task.executorEligible);
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    apiPath: "/api/chuck-v3/executor-queue",
    executor: launchdServiceStatus(DOCKET_EXECUTOR_LABEL),
    control,
    lanePolicy: Object.fromEntries(EXECUTOR_LANE_POLICY.entries()),
    timeoutPolicy: Object.fromEntries(EXECUTOR_LANE_TIMEOUT_POLICY.entries()),
    globalRunningCap: EXECUTOR_GLOBAL_RUNNING_CAP,
    recoveryActionsAvailable: true,
    staleRunningMs: STALE_RUNNING_MS,
    counts: {
      draft: drafts.length,
      pending: pending.length,
      running: running.length,
      eligiblePending: eligiblePending.length,
      recentFinished: recentFinished.length,
      totalScanned: tasks.length,
    },
    nextEligible: eligiblePending[0] ?? null,
    drafts: drafts.slice(0, 8),
    pending: pending.slice(0, 12),
    running: running.slice(0, 8),
    recentFinished,
  };
}

function findDraftByTaskId(taskId) {
  return docketDraftFiles({ limit: 120 }).find((file) => {
    const id = file.data?.id ?? file.data?.taskId ?? file.name.replace(/\.json$/, "");
    return id === taskId;
  });
}

function findDraftByProposalId(proposalId) {
  return docketDraftFiles({ limit: 120 }).find(
    (file) =>
      file.data?.source?.kind === "perichoresis-proposal" &&
      file.data?.source?.proposalId === proposalId,
  );
}

function buildDocketPromotionPreview(task, file) {
  const draft = summarizeDocketDraft(task, file);
  const now = new Date().toISOString();
  return {
    ok: true,
    dryRun: true,
    writes: false,
    executorTriggered: false,
    executorNote: "Preview only. No file is written and the executor still ignores this draft.",
    draft,
    pendingPreview: {
      ...task,
      status: "pending",
      updatedAt: now,
      heartbeats: [
        ...(Array.isArray(task?.heartbeats) ? task.heartbeats : []),
        {
          at: now,
          phase: "promotion-preview",
          message: "Dry-run preview from cockpit. This heartbeat is not written.",
        },
      ],
    },
  };
}

function promoteDraftTask(task, file, { approvedBy = "operator/cockpit" } = {}) {
  const draft = summarizeDocketDraft(task, file);
  if (!draft.promotablePreview) {
    throw httpError(`draft is not promotable: ${draft.promotionBlockers.join(", ")}`, 409);
  }
  const now = new Date().toISOString();
  const promoted = {
    ...task,
    status: "pending",
    updatedAt: now,
    promotedAt: now,
    approval: {
      at: now,
      by: approvedBy,
      mechanism: "cockpit-draft-promotion",
      note: "Operator promoted draft to pending. The docket executor may pick this up on its next tick.",
    },
    heartbeats: [
      ...(Array.isArray(task?.heartbeats) ? task.heartbeats : []),
      {
        at: now,
        phase: "promoted-to-pending",
        message:
          "Cockpit operator promotion. Executor eligibility now depends on normal docket rules.",
      },
    ],
  };
  writeJsonAtomicSync(file.path, promoted);
  return promoted;
}

async function handleProposalDocketDraft(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const proposalId = String(body.proposalId ?? "").trim();
  if (!proposalId) {
    throw httpError("proposalId is required", 400);
  }
  const perichoresis = perichoresisStatus({ limit: 24 });
  const proposal = perichoresis.proposals.find((item) => item.proposalId === proposalId);
  if (!proposal) {
    throw httpError("proposal not found in current perichoresis lane", 404);
  }
  const existing = findDraftByProposalId(proposalId);
  if (existing) {
    const existingTask = summarizeDocketDraft(existing.data, existing);
    return jsonResponse(res, 200, {
      ok: true,
      reused: true,
      dryRun: body.dryRun === true,
      task: existing.data,
      summary: existingTask,
      path: existing.path,
    });
  }
  const task = buildProposalDocketDraft(proposal);
  const path = join(CHUCK_V3_DOCKET_DIR, `${task.id}.json`);
  if (body.dryRun === true) {
    return jsonResponse(res, 200, { ok: true, dryRun: true, task, path });
  }
  mkdirSync(CHUCK_V3_DOCKET_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await emit({
    source: "chuck-dashboard",
    type: "chuck.proposal.docket-draft.created",
    payload: {
      taskId: task.id,
      proposalId: proposal.proposalId,
      deltaId: proposal.deltaId,
      path,
      status: task.status,
    },
  });
  return jsonResponse(res, 201, { ok: true, dryRun: false, task, path });
}

async function handleDocketDrafts(req, res) {
  if (req.method !== "GET") {
    return methodNotAllowed(res);
  }
  return jsonResponse(res, 200, docketDraftsStatus());
}

async function handleDocketDraftPreview(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const taskId = String(body.taskId ?? "").trim();
  if (!taskId) {
    throw httpError("taskId is required", 400);
  }
  const file = findDraftByTaskId(taskId);
  if (!file) {
    throw httpError("draft task not found", 404);
  }
  return jsonResponse(res, 200, buildDocketPromotionPreview(file.data, file));
}

async function handleDocketDraftPromote(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const taskId = String(body.taskId ?? "").trim();
  if (!taskId) {
    throw httpError("taskId is required", 400);
  }
  const file = findDraftByTaskId(taskId);
  if (!file) {
    throw httpError("draft task not found", 404);
  }
  if (body.dryRun === true) {
    return jsonResponse(res, 200, buildDocketPromotionPreview(file.data, file));
  }
  if (body.confirm !== "PROMOTE_DRAFT_TO_PENDING") {
    throw httpError("confirm must equal PROMOTE_DRAFT_TO_PENDING", 409);
  }
  const promoted = promoteDraftTask(file.data, file, {
    approvedBy: String(body.approvedBy ?? "operator/cockpit").slice(0, 120),
  });
  const control = executorControlStatus();
  const executorEligible = executorEligibilityBlockers(promoted, { control }).length === 0;
  await emit({
    source: "chuck-dashboard",
    type: "chuck.docket-draft.promoted",
    payload: {
      taskId,
      path: file.path,
      status: promoted.status,
      commandKind: promoted.commandKind,
      risk: promoted.risk,
      executorEligible,
      executorPaused: control.paused,
    },
  });
  return jsonResponse(res, 200, {
    ok: true,
    dryRun: false,
    path: file.path,
    task: promoted,
    executorTriggered: false,
    executorEligible,
    executorControl: control,
    executorNote: control.paused
      ? "Promotion wrote status pending, but executor intake is paused. Resume intake before the launchd executor can claim it."
      : "Promotion wrote status pending. The launchd executor may pick it up on its next tick.",
  });
}

function recentExecutorEvents({ limit = 14 } = {}) {
  try {
    return readEvents({ since: "24h" })
      .filter((event) => {
        const type = String(event?.type ?? "");
        const source = String(event?.source ?? "");
        return type.includes("docket") || type.includes("executor") || source.includes("docket");
      })
      .slice(-limit)
      .toReversed()
      .map((event) => ({
        ts: event.ts ?? event.createdAt ?? null,
        type: event.type ?? event.id ?? "event",
        source: event.source ?? null,
        taskId: event.payload?.taskId ?? event.payload?.id ?? null,
        status: event.payload?.status ?? event.payload?.mode ?? null,
        path: event.payload?.path ?? null,
      }));
  } catch {
    return [];
  }
}

function executorInspectStatus({ taskId = "" } = {}) {
  const queue = executorQueueStatus();
  const staleRunning = [
    ...(Array.isArray(queue.running) ? queue.running : []),
    ...(Array.isArray(queue.pending) ? queue.pending : []),
    ...(Array.isArray(queue.drafts) ? queue.drafts : []),
  ].filter((task) => task.actionHints?.staleRunning);
  const file = taskId ? findDocketTaskById(taskId) : null;
  const taskDetail = file
    ? {
        ...summarizeExecutorQueueTask(file.data, file, { control: queue.control }),
        stdoutTail: tailText(file.data?.stdoutTail, TASK_LOG_TAIL_CHARS),
        stderrTail: tailText(file.data?.stderrTail, TASK_LOG_TAIL_CHARS),
        heartbeats: Array.isArray(file.data?.heartbeats) ? file.data.heartbeats.slice(-8) : [],
      }
    : null;
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    apiPath: "/api/chuck-v3/executor-inspect",
    recoveryActionsAvailable: true,
    recoveryRules: {
      cancel: "draft|pending only; appends cancelled heartbeat and never deletes the task file",
      retry:
        "failed|completed|cancelled only; creates a new low-risk pending copy and preserves retryOf",
      markStaleFailed: "running only after staleRunningMs; appends failed recovery heartbeat",
      staleRunningMs: STALE_RUNNING_MS,
    },
    control: queue.control,
    executor: queue.executor,
    counts: queue.counts,
    task: taskDetail,
    staleRunning,
    recentEvents: recentExecutorEvents(),
    logs: {
      stdout: tailFileText(EXECUTOR_STDOUT_LOG),
      stderr: tailFileText(EXECUTOR_STDERR_LOG),
    },
  };
}

function appendTaskHeartbeat(task, heartbeat) {
  return [...(Array.isArray(task?.heartbeats) ? task.heartbeats : []), heartbeat];
}

function retryTaskId(baseId) {
  const safeBase = String(baseId || "task")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 80);
  return `task-retry-${safeBase}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function buildRetryTask(task, file, { operator = "operator/cockpit", reason = "" } = {}) {
  const sourceId = docketTaskId(task, file);
  const now = new Date().toISOString();
  const id = retryTaskId(sourceId);
  const source =
    task?.source && typeof task.source === "object" && !Array.isArray(task.source)
      ? { ...task.source }
      : {};
  const retry = {
    ...task,
    id,
    taskId: undefined,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    promotedAt: now,
    startedAt: undefined,
    finishedAt: undefined,
    executorRunId: undefined,
    exitCode: undefined,
    signal: undefined,
    timedOut: undefined,
    durationMs: undefined,
    cancelledAt: undefined,
    cancellation: undefined,
    command: undefined,
    stdoutTail: undefined,
    stderrTail: undefined,
    posteriorDeltas: undefined,
    priorCapsule: undefined,
    priorCapsuleBefore: undefined,
    retryOf: sourceId,
    retrySourcePath: file.path,
    source: {
      ...source,
      retryOf: sourceId,
      retrySourcePath: file.path,
    },
    approval: {
      at: now,
      by: operator,
      mechanism: "cockpit-docket-retry",
      note: reason || "Operator requested a guarded retry from the cockpit.",
    },
    heartbeats: [
      {
        at: now,
        phase: "retry-created",
        executor: "chuck-dashboard",
        sourceTaskId: sourceId,
        sourceTaskPath: file.path,
        message:
          "Cockpit recovery created a new pending copy. The source task was not deleted or rewritten.",
      },
    ],
  };
  return { retry, path: join(CHUCK_V3_DOCKET_DIR, `${id}.json`) };
}

async function handleDocketTaskAction(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const action = String(body.action ?? "")
    .trim()
    .toLowerCase();
  const taskId = String(body.taskId ?? "").trim();
  if (!taskId) {
    throw httpError("taskId is required", 400);
  }
  if (!["cancel", "retry", "mark-stale-failed"].includes(action)) {
    throw httpError("action must be cancel, retry, or mark-stale-failed", 400);
  }
  const file = findDocketTaskById(taskId);
  if (!file) {
    throw httpError("docket task not found", 404);
  }
  const task = file.data;
  const status = String(task?.status ?? "unknown").toLowerCase();
  const operator = String(body.operator ?? body.updatedBy ?? "operator/cockpit").slice(0, 120);
  const reason = String(body.reason ?? "").slice(0, 300);
  const now = new Date().toISOString();
  const hints = docketTaskActionHints(task, file);

  if (action === "cancel") {
    if (body.confirm !== "CANCEL_DOCKET_TASK") {
      throw httpError("confirm must equal CANCEL_DOCKET_TASK", 409);
    }
    if (!hints.canCancel) {
      throw httpError("only draft or pending tasks can be cancelled from the cockpit", 409);
    }
    const cancelled = {
      ...task,
      status: "cancelled",
      updatedAt: now,
      cancelledAt: now,
      cancellation: {
        at: now,
        by: operator,
        reason: reason || "operator cancelled task from cockpit",
        previousStatus: status,
      },
      heartbeats: appendTaskHeartbeat(task, {
        at: now,
        phase: "cancelled",
        executor: "chuck-dashboard",
        previousStatus: status,
        message: reason || "Operator cancelled task from cockpit. Task file preserved for audit.",
      }),
    };
    writeJsonAtomicSync(file.path, cancelled);
    await emit({
      source: "chuck-dashboard",
      type: "chuck.docket-task.cancelled",
      payload: { taskId, path: file.path, previousStatus: status, status: cancelled.status },
    });
    return jsonResponse(res, 200, { ok: true, action, taskId, path: file.path, task: cancelled });
  }

  if (action === "retry") {
    if (body.confirm !== "RETRY_DOCKET_TASK") {
      throw httpError("confirm must equal RETRY_DOCKET_TASK", 409);
    }
    if (!hints.canRetry) {
      throw httpError(`task is not retryable: ${hints.retryBlockers.join(", ") || status}`, 409);
    }
    const { retry, path } = buildRetryTask(task, file, { operator, reason });
    if (existsSync(path)) {
      throw httpError("retry task id collision", 409);
    }
    writeJsonAtomicSync(path, retry);
    const sourceWithHeartbeat = {
      ...task,
      updatedAt: now,
      heartbeats: appendTaskHeartbeat(task, {
        at: now,
        phase: "retry-source-linked",
        executor: "chuck-dashboard",
        retryTaskId: retry.id,
        retryTaskPath: path,
      }),
    };
    writeJsonAtomicSync(file.path, sourceWithHeartbeat);
    await emit({
      source: "chuck-dashboard",
      type: "chuck.docket-task.retry-created",
      payload: { taskId, retryTaskId: retry.id, sourcePath: file.path, path, status: retry.status },
    });
    return jsonResponse(res, 201, {
      ok: true,
      action,
      taskId,
      retryTaskId: retry.id,
      path,
      task: retry,
    });
  }

  if (body.confirm !== "MARK_STALE_TASK_FAILED") {
    throw httpError("confirm must equal MARK_STALE_TASK_FAILED", 409);
  }
  if (status !== "running" || !hints.staleRunning) {
    throw httpError("only stale running tasks can be marked failed from the cockpit", 409);
  }
  const recovered = {
    ...task,
    status: "failed",
    updatedAt: now,
    finishedAt: task?.finishedAt ?? now,
    timedOut: true,
    staleRecoveredAt: now,
    recovery: {
      at: now,
      by: operator,
      reason: reason || "operator marked stale running task failed from cockpit",
      previousStatus: status,
      runningAgeMs: hints.runningAgeMs,
      lock: hints.lock,
    },
    heartbeats: appendTaskHeartbeat(task, {
      at: now,
      phase: "stale-marked-failed",
      executor: "chuck-dashboard",
      runningAgeMs: hints.runningAgeMs,
      lockPresent: hints.lock.present,
      message:
        reason || "Operator marked stale running task failed. Task file preserved for audit.",
    }),
  };
  writeJsonAtomicSync(file.path, recovered);
  await emit({
    source: "chuck-dashboard",
    type: "chuck.docket-task.marked-failed",
    payload: {
      taskId,
      path: file.path,
      previousStatus: status,
      status: recovered.status,
      runningAgeMs: hints.runningAgeMs,
    },
  });
  return jsonResponse(res, 200, { ok: true, action, taskId, path: file.path, task: recovered });
}

function authorityGateDefinitions() {
  return [
    {
      capabilityId: "openclaw.skill-firehose",
      label: "OpenClaw skill firehose",
      surface: "openclaw/channels",
      family: "platform",
      riskClass: "medium",
      authority: "requires-approval",
      defaultState: "quarantined",
      reason:
        "ClawHub/public skills can expand local tool reach and must enter through quarantine before trust.",
      evidenceRefs: [
        "extensions/memory-graph/data/chuck-v2-design/frontier-lab-primitive-harvest.md",
        "extensions/memory-graph/src/chuck-v2/surface-atlas.ts",
      ],
    },
    {
      capabilityId: "openclaw.tools-action",
      label: "OpenClaw tools and channels",
      surface: "openclaw/channels",
      family: "platform",
      riskClass: "medium",
      authority: "can-act-with-policy",
      defaultState: "policy-gated",
      reason:
        "OpenClaw is Chuck's body/channels, but actions still inherit Joseph approval and transmission gates.",
      evidenceRefs: ["extensions/memory-graph/data/chuck-v2-design/10-OPENCLAW-SURFACE-AUDIT.md"],
    },
    {
      capabilityId: "codex.skill-load",
      label: "Codex curated skill loading",
      surface: "codex/plugins-skills",
      family: "operator-tool",
      riskClass: "low",
      authority: "can-act-with-policy",
      defaultState: "policy-gated",
      reason:
        "Known curated/system skills may be loaded for matching tasks, but they do not bypass confirmation policy.",
      evidenceRefs: ["extensions/memory-graph/src/chuck-v2/surface-atlas.ts"],
    },
    {
      capabilityId: "codex.connector-work",
      label: "Codex connector work",
      surface: "codex/plugins-skills",
      family: "operator-tool",
      riskClass: "medium",
      authority: "can-act-with-policy",
      defaultState: "policy-gated",
      reason:
        "Connectors can touch sensitive cloud data, so reads/writes remain gated by destination and data class.",
      evidenceRefs: ["extensions/memory-graph/src/chuck-v2/surface-atlas.ts"],
    },
    {
      capabilityId: "codex.computer-use.general-hand",
      label: "Computer Use general hand",
      surface: "codex/computer-use",
      family: "operator-tool",
      riskClass: "medium",
      authority: "requires-approval",
      defaultState: "blocked",
      reason:
        "Current Computer Use proof is unreliable/blocked; deterministic drivers remain preferred until repaired.",
      evidenceRefs: ["extensions/memory-graph/src/chuck-v2/surface-atlas.ts"],
    },
    {
      capabilityId: "chuck.self-improvement.authority-diff",
      label: "Self-improvement authority expansion",
      surface: "chuck/kernel",
      family: "sovereign-local",
      riskClass: "high",
      authority: "requires-approval",
      defaultState: "quarantined",
      reason:
        "Self-improvement Lab proposals require authority-diff, protected-path checks, and explicit Joseph approval.",
      evidenceRefs: [
        "extensions/memory-graph/data/chuck-v2-design/phase0-metrics.md",
        "extensions/memory-graph/data/chuck-v2-design/authority-diff.schema.json",
      ],
    },
  ];
}

function readAuthorityGateState() {
  const state = readJsonSafe(AUTHORITY_GATE_STATE_PATH, null);
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return {
      version: 1,
      updatedAt: null,
      updatedBy: null,
      gates: {},
      receipts: [],
      path: AUTHORITY_GATE_STATE_PATH,
    };
  }
  return {
    version: Number(state.version ?? 1),
    updatedAt: state.updatedAt ?? null,
    updatedBy: state.updatedBy ?? null,
    gates:
      state.gates && typeof state.gates === "object" && !Array.isArray(state.gates)
        ? state.gates
        : {},
    receipts: Array.isArray(state.receipts) ? state.receipts : [],
    path: AUTHORITY_GATE_STATE_PATH,
  };
}

function normalizeAuthorityState(value, fallback = "quarantined") {
  const state = String(value ?? fallback).toLowerCase();
  return ["approved", "policy-gated", "quarantined", "blocked"].includes(state) ? state : fallback;
}

function authorityGateActionHints(gate) {
  const state = normalizeAuthorityState(gate.state);
  return {
    canApprove: state !== "approved",
    canQuarantine: state !== "quarantined",
    canBlock: state !== "blocked",
    confirmTokens: {
      approve: "APPROVE_SKILL_AUTHORITY",
      quarantine: "QUARANTINE_SKILL_AUTHORITY",
      block: "BLOCK_SKILL_AUTHORITY",
    },
  };
}

function authorityGateRows() {
  const state = readAuthorityGateState();
  return authorityGateDefinitions().map((definition) => {
    const override = state.gates?.[definition.capabilityId] ?? {};
    const currentState = normalizeAuthorityState(override.state, definition.defaultState);
    const row = {
      ...definition,
      state: currentState,
      defaultState: definition.defaultState,
      stateSource: override.state ? "operator-state" : "default-policy",
      updatedAt: override.updatedAt ?? state.updatedAt ?? null,
      updatedBy: override.updatedBy ?? state.updatedBy ?? null,
      operatorReason: override.reason ?? null,
      latestReceiptId: override.latestReceiptId ?? null,
    };
    return {
      ...row,
      actionHints: authorityGateActionHints(row),
    };
  });
}

function recentAuthorityReceipts({ limit = 10 } = {}) {
  return latestJsonFiles(AUTHORITY_GATE_RECEIPTS_DIR, { limit }).map((file) => ({
    receiptId: file.data?.receiptId ?? file.name.replace(/\.json$/, ""),
    capabilityId: file.data?.capabilityId ?? null,
    action: file.data?.action ?? null,
    fromState: file.data?.fromState ?? null,
    toState: file.data?.toState ?? null,
    operator: file.data?.operator ?? null,
    reason: file.data?.reason ?? null,
    createdAt: file.data?.createdAt ?? new Date(file.mtimeMs).toISOString(),
    path: file.path,
  }));
}

function authorityGatesStatus() {
  const rows = authorityGateRows();
  const counts = rows.reduce(
    (acc, row) => {
      acc.total += 1;
      acc[row.state] = (acc[row.state] ?? 0) + 1;
      if (row.authority === "requires-approval") {
        acc.requiresApproval += 1;
      }
      return acc;
    },
    { total: 0, approved: 0, "policy-gated": 0, quarantined: 0, blocked: 0, requiresApproval: 0 },
  );
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    apiPath: "/api/chuck-v3/authority-gates",
    statePath: AUTHORITY_GATE_STATE_PATH,
    receiptsDir: AUTHORITY_GATE_RECEIPTS_DIR,
    counts,
    gates: rows,
    recentReceipts: recentAuthorityReceipts(),
    rules: {
      approvalToken: "APPROVE_SKILL_AUTHORITY",
      quarantineToken: "QUARANTINE_SKILL_AUTHORITY",
      blockToken: "BLOCK_SKILL_AUTHORITY",
      note: "This gate records Chuck policy authority. It does not install software, grant OS permissions, or bypass Joseph confirmation policy.",
    },
  };
}

function authorityReceiptId() {
  return `authgate-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

async function handleAuthorityGateAction(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const capabilityId = String(body.capabilityId ?? "").trim();
  const action = String(body.action ?? "")
    .trim()
    .toLowerCase();
  const actionToState = {
    approve: "approved",
    quarantine: "quarantined",
    block: "blocked",
  };
  const actionToToken = {
    approve: "APPROVE_SKILL_AUTHORITY",
    quarantine: "QUARANTINE_SKILL_AUTHORITY",
    block: "BLOCK_SKILL_AUTHORITY",
  };
  if (!capabilityId) {
    throw httpError("capabilityId is required", 400);
  }
  if (!actionToState[action]) {
    throw httpError("action must be approve, quarantine, or block", 400);
  }
  if (body.confirm !== actionToToken[action]) {
    throw httpError(`confirm must equal ${actionToToken[action]}`, 409);
  }
  const definition = authorityGateDefinitions().find((gate) => gate.capabilityId === capabilityId);
  if (!definition) {
    throw httpError("authority gate capability not found", 404);
  }
  const state = readAuthorityGateState();
  const previous = state.gates?.[capabilityId] ?? {};
  const fromState = normalizeAuthorityState(previous.state, definition.defaultState);
  const toState = actionToState[action];
  const now = new Date().toISOString();
  const operator = String(body.operator ?? body.updatedBy ?? "operator/cockpit").slice(0, 120);
  const reason = String(body.reason ?? "")
    .trim()
    .slice(0, 500);
  const receiptId = authorityReceiptId();
  const receiptPath = join(AUTHORITY_GATE_RECEIPTS_DIR, `${receiptId}.json`);
  const receipt = {
    receiptId,
    createdAt: now,
    operator,
    capabilityId,
    label: definition.label,
    action,
    fromState,
    toState,
    riskClass: definition.riskClass,
    authority: definition.authority,
    reason: reason || `${operator} set ${capabilityId} to ${toState} from cockpit`,
    confirm: actionToToken[action],
    evidenceRefs: definition.evidenceRefs,
    nonEffects: [
      "does not install or run new software",
      "does not grant OS/browser/cloud permissions",
      "does not resume executor intake",
      "does not bypass Joseph action-time confirmations",
    ],
  };
  const nextState = {
    version: 1,
    updatedAt: now,
    updatedBy: operator,
    gates: {
      ...state.gates,
      [capabilityId]: {
        state: toState,
        updatedAt: now,
        updatedBy: operator,
        reason: receipt.reason,
        latestReceiptId: receiptId,
      },
    },
    receipts: [receiptId, ...state.receipts].slice(0, 50),
    path: AUTHORITY_GATE_STATE_PATH,
  };
  writeJsonAtomicSync(receiptPath, receipt);
  writeJsonAtomicSync(AUTHORITY_GATE_STATE_PATH, nextState);
  await emit({
    source: "chuck-dashboard",
    type: "chuck.authority-gate.updated",
    payload: {
      receiptId,
      capabilityId,
      action,
      fromState,
      toState,
      riskClass: definition.riskClass,
      path: AUTHORITY_GATE_STATE_PATH,
      receiptPath,
    },
  });
  return jsonResponse(res, 200, {
    ok: true,
    action,
    capabilityId,
    fromState,
    toState,
    receipt,
    state: nextState,
    status: authorityGatesStatus(),
  });
}

function selfImprovementProposalId() {
  return `selflab-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${Math.random().toString(16).slice(2, 10)}`;
}

function selfImprovementReceiptId() {
  return `selflab-receipt-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function selfImprovementProposalFiles({ limit = 12 } = {}) {
  return latestJsonFiles(SELF_IMPROVEMENT_PROPOSALS_DIR, { limit });
}

function protectedPathReason(path) {
  const text = String(path ?? "");
  if (!text) {
    return null;
  }
  if (text.startsWith("/") || text.startsWith("~")) {
    return "absolute or home-relative path";
  }
  if (text.startsWith(".git/") || text === ".git") {
    return "git internals";
  }
  if (
    /Library\/LaunchAgents|\.openclaw\/openclaw\.json|credential|secret|token|\.env/i.test(text)
  ) {
    return "protected credential, launch agent, or secret-like path";
  }
  return null;
}

function gitStatusEntriesForPaths(paths) {
  const targets = [
    ...new Set(
      (Array.isArray(paths) ? paths : []).map((path) => String(path).trim()).filter(Boolean),
    ),
  ];
  if (targets.length === 0) {
    return { available: true, entries: [], targets };
  }
  let result;
  try {
    result = spawnSync("git", ["status", "--porcelain=v1", "--", ...targets], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 5000,
    });
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      entries: [],
      targets,
    };
  }
  if (result.error) {
    return {
      available: false,
      reason: result.error.message ?? String(result.error),
      entries: [],
      targets,
    };
  }
  if (result.status !== 0) {
    return {
      available: false,
      reason: (result.stderr ?? "").trim() || `git status exited ${result.status}`,
      entries: [],
      targets,
    };
  }
  const entries = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      return {
        status,
        path: rawPath.includes(" -> ") ? (rawPath.split(" -> ").at(-1) ?? rawPath) : rawPath,
      };
    });
  return { available: true, entries, targets };
}

function selfImprovementTargetLanes(prior) {
  const questions = Array.isArray(prior?.openQuestions)
    ? prior.openQuestions.map((q) => String(q))
    : [];
  const actions = Array.isArray(prior?.recommendedNextActions)
    ? prior.recommendedNextActions.map((q) => String(q))
    : [];
  const signal = [...questions, ...actions].join("\n").toLowerCase();
  const lanes = [
    {
      laneId: "read-marker-coverage",
      title: "Expand read marker coverage",
      objective:
        "Extend read marker coverage to every family runner path so prior consumption is visible beyond executor-launched live scouts.",
      targetFiles: [
        "extensions/memory-graph/src/chuck-v2/runner-executor.ts",
        "extensions/memory-graph/src/chuck-v2/chuck-v2.test.ts",
        "test/vitest/vitest.extension-memory-paths.mjs",
      ],
      evidenceRefs: [
        "state/chuck-v3/priors/latest.json#recommendedNextActions",
        "state/chuck-v3/read-markers",
      ],
      match: /read marker|read-marker|family runner|prior consumption/.test(signal),
    },
    {
      laneId: "dissent-boundary",
      title: "Dissent boundary hardening",
      objective:
        "Make dissent ledger boundaries explicit so compaction preserves unresolved disagreement as sidecar state instead of prose.",
      targetFiles: [
        "extensions/memory-graph/scripts/chuck-prior-compaction.mjs",
        "extensions/memory-graph/scripts/chuck-prior-capsule.mjs",
        "extensions/memory-graph/data/chuck-v2-design/dissent-record.schema.json",
      ],
      evidenceRefs: [
        "state/chuck-v3/priors/latest.json#openQuestions",
        "extensions/memory-graph/data/chuck-v2-design/09-UNIVERSAL-PRIOR-PERICHORESIS.md",
      ],
      match: /dissent|conflict resolution|compaction boundary/.test(signal),
    },
    {
      laneId: "surface-structure-hardening",
      title: "Surface posterior structure hardening",
      objective:
        "Harden weak family surfaces so they return structured scout posteriors with usable evidence and low-noise open questions.",
      targetFiles: [
        "extensions/memory-graph/src/chuck-v2/runner-executor.ts",
        "extensions/memory-graph/scripts/research-comet-chat.mjs",
        "extensions/memory-graph/scripts/apex-panel-ask.mjs",
      ],
      evidenceRefs: [
        "state/chuck-v3/posterior-deltas",
        "state/chuck-v3/priors/latest.json#openQuestions",
      ],
      match: /harden|weakly structured|grok|ollama|perplexity|spawn codex/.test(signal),
    },
    {
      laneId: "cockpit-lab-governance",
      title: "Self-Improvement Lab governance",
      objective:
        "Keep Chuck self-build work visible in the cockpit with explicit authority diffs, target ownership, and verification receipts.",
      targetFiles: ["extensions/memory-graph/scripts/chuck-dashboard.mjs"],
      evidenceRefs: [
        "state/chuck-v3/authority-gates",
        "state/chuck-v3/priors/latest.json#hardConstraints",
      ],
      match: true,
    },
  ];
  return lanes;
}

function chooseSelfImprovementLane(prior, requestedLaneId = "") {
  const lanes = selfImprovementTargetLanes(prior);
  if (requestedLaneId) {
    const requested = lanes.find((lane) => lane.laneId === requestedLaneId);
    if (requested) {
      return requested;
    }
  }
  return lanes.find((lane) => lane.match) ?? lanes.at(-1);
}

function selfImprovementAuthorityGate() {
  return (
    authorityGateRows().find(
      (gate) => gate.capabilityId === "chuck.self-improvement.authority-diff",
    ) ?? null
  );
}

function buildSelfImprovementProposal({
  objective = "",
  laneId = "",
  createdBy = "operator/cockpit",
} = {}) {
  const now = new Date().toISOString();
  const prior = readJsonSafe(LATEST_PRIOR_PATH, null);
  const lane = chooseSelfImprovementLane(prior, laneId);
  const targetFiles = [...lane.targetFiles];
  const dirty = gitStatusEntriesForPaths(targetFiles);
  const protectedTargets = targetFiles
    .map((path) => ({ path, reason: protectedPathReason(path) }))
    .filter((entry) => entry.reason);
  const authorityGate = selfImprovementAuthorityGate();
  const dirtyPaths = dirty.entries.map((entry) => entry.path);
  const patchBlockers = [
    ...(authorityGate?.state === "approved"
      ? []
      : ["self-improvement authority gate is not approved"]),
    ...(dirty.available ? [] : [`target ownership unreadable: ${dirty.reason}`]),
    ...(dirtyPaths.length > 0 ? ["target files have pre-existing local changes"] : []),
    ...(protectedTargets.length > 0 ? ["proposal touches protected paths"] : []),
  ];
  const proposalId = selfImprovementProposalId();
  const authorityDiffId = `authority-diff-${proposalId}`;
  const requestedObjective = String(objective || "").trim();
  return {
    proposalId,
    status: "draft",
    version: 1,
    createdAt: now,
    updatedAt: now,
    createdBy,
    title: lane.title,
    objective: requestedObjective || lane.objective,
    sourcePriorId: prior?.priorId ?? null,
    sourcePriorHash: prior?.sourceHash ?? null,
    laneId: lane.laneId,
    risk: "medium",
    targetFiles,
    evidenceRefs: lane.evidenceRefs,
    authorityDiff: {
      authorityDiffId,
      capabilityId: "chuck.self-improvement.authority-diff",
      gateState: authorityGate?.state ?? "missing",
      gateReceiptId: authorityGate?.latestReceiptId ?? null,
      requestedAuthority: "targeted self-build proposal only",
      expandsAuthority: false,
      protectedTargets,
      patchApplicationAllowed: false,
      patchApplicationBlockers: patchBlockers.length
        ? patchBlockers
        : ["patch application requires a separate Joseph-approved build/patch action"],
      requiredApprovals: [SELF_IMPROVEMENT_APPROVE_TOKEN],
      nonEffects: [
        "does not run a model",
        "does not create a patch",
        "does not apply source edits",
        "does not create or promote a docket task",
        "does not resume executor intake",
        "does not change credentials, pairing, launchd, or OS permissions",
      ],
    },
    cleanLedger: {
      preExistingDirtyTargetFiles: dirty.available ? dirty.entries : [],
      currentTurnWrites: [],
      verificationReceipts: [],
      unresolvedRisk: patchBlockers,
    },
    proposedNextActions: [
      "Review this proposal and authority diff in the cockpit.",
      "Approve or reject the proposal; approval writes a receipt only.",
      "After approval, run a separate targeted build-plan or build-generate-patch action with explicit scope.",
      "Apply any generated patch only after tests pass and target ownership is clean.",
    ],
  };
}

function summarizeSelfImprovementProposal(proposal, file = null) {
  const authorityDiff = proposal?.authorityDiff ?? {};
  const cleanLedger = proposal?.cleanLedger ?? {};
  const dirtyTargets = Array.isArray(cleanLedger.preExistingDirtyTargetFiles)
    ? cleanLedger.preExistingDirtyTargetFiles
    : [];
  const blockers = Array.isArray(authorityDiff.patchApplicationBlockers)
    ? authorityDiff.patchApplicationBlockers
    : [];
  return {
    proposalId: proposal?.proposalId ?? file?.name?.replace(/\.json$/, "") ?? "(unknown)",
    status: String(proposal?.status ?? "unknown").toLowerCase(),
    title: proposal?.title ?? "(untitled proposal)",
    objective: truncateText(proposal?.objective, 260),
    laneId: proposal?.laneId ?? null,
    risk: proposal?.risk ?? null,
    sourcePriorId: proposal?.sourcePriorId ?? null,
    createdAt: proposal?.createdAt ?? (file?.mtimeMs ? new Date(file.mtimeMs).toISOString() : null),
    updatedAt:
      proposal?.updatedAt ??
      proposal?.createdAt ??
      (file?.mtimeMs ? new Date(file.mtimeMs).toISOString() : null),
    approvedAt: proposal?.approvedAt ?? null,
    rejectedAt: proposal?.rejectedAt ?? null,
    targetFiles: Array.isArray(proposal?.targetFiles) ? proposal.targetFiles : [],
    targetFileCount: Array.isArray(proposal?.targetFiles) ? proposal.targetFiles.length : 0,
    dirtyTargetCount: dirtyTargets.length,
    dirtyTargets: dirtyTargets.slice(0, 8),
    authorityDiffId: authorityDiff.authorityDiffId ?? null,
    authorityGateState: authorityDiff.gateState ?? null,
    patchApplicationAllowed: authorityDiff.patchApplicationAllowed === true,
    patchApplicationBlockers: blockers.slice(0, 8),
    nonEffects: Array.isArray(authorityDiff.nonEffects) ? authorityDiff.nonEffects : [],
    receiptId: proposal?.approval?.receiptId ?? proposal?.rejection?.receiptId ?? null,
    path: file?.path ?? proposal?.path ?? null,
  };
}

function selfImprovementLabStatus() {
  const files = selfImprovementProposalFiles({ limit: 16 });
  const proposals = files.map((file) => summarizeSelfImprovementProposal(file.data, file));
  const latestProposal = proposals[0] ?? null;
  const latestDraftProposal = proposals.find((proposal) => proposal.status === "draft") ?? null;
  const latestApprovedProposal =
    proposals.find((proposal) => proposal.status === "approved") ?? null;
  const authorityGate = selfImprovementAuthorityGate();
  const queue = executorQueueStatus();
  const repo = repoHygieneStatus();
  const preview = summarizeSelfImprovementProposal(
    buildSelfImprovementProposal({ createdBy: "chuck-dashboard/preview" }),
  );
  const blockers = [
    ...(authorityGate?.state === "approved"
      ? []
      : ["self-improvement authority gate is not approved"]),
    ...(queue.counts?.pending || queue.counts?.running ? ["executor queue is not idle"] : []),
    ...(Array.isArray(repo.blockers) ? repo.blockers : []),
  ];
  const counts = proposals.reduce(
    (acc, proposal) => {
      acc.total += 1;
      acc[proposal.status] = (acc[proposal.status] ?? 0) + 1;
      return acc;
    },
    { total: 0, draft: 0, approved: 0, rejected: 0 },
  );
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    apiPath: "/api/chuck-v3/self-improvement-lab",
    proposalsDir: SELF_IMPROVEMENT_PROPOSALS_DIR,
    receiptsDir: SELF_IMPROVEMENT_RECEIPTS_DIR,
    counts,
    readiness: {
      state: blockers.length ? "gated" : "ready",
      blockers,
      authorityGate: authorityGate
        ? {
            capabilityId: authorityGate.capabilityId,
            state: authorityGate.state,
            riskClass: authorityGate.riskClass,
            latestReceiptId: authorityGate.latestReceiptId,
          }
        : null,
      executorIdle:
        (queue.counts?.pending ?? 0) === 0 &&
        (queue.counts?.running ?? 0) === 0 &&
        (queue.counts?.eligiblePending ?? 0) === 0,
      repoClean: repo.clean === true,
    },
    latestProposal,
    latestDraftProposal,
    latestApprovedProposal,
    draftPreview: preview,
    proposals,
    rules: {
      approvalToken: SELF_IMPROVEMENT_APPROVE_TOKEN,
      rejectionToken: SELF_IMPROVEMENT_REJECT_TOKEN,
      note: "Approval marks a self-improvement proposal as approved. It does not run a model, apply a patch, or promote a docket task.",
    },
  };
}

function findSelfImprovementProposalById(proposalId) {
  return selfImprovementProposalFiles({ limit: 200 }).find((file) => {
    const id = file.data?.proposalId ?? file.name.replace(/\.json$/, "");
    return id === proposalId;
  });
}

async function handleSelfImprovementProposal(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const proposal = buildSelfImprovementProposal({
    objective: body.objective,
    laneId: body.laneId,
    createdBy: String(body.createdBy ?? "operator/cockpit").slice(0, 120),
  });
  const path = join(SELF_IMPROVEMENT_PROPOSALS_DIR, `${proposal.proposalId}.json`);
  if (body.dryRun === true) {
    return jsonResponse(res, 200, { ok: true, dryRun: true, writes: false, proposal, path });
  }
  const withLedger = {
    ...proposal,
    path,
    cleanLedger: {
      ...proposal.cleanLedger,
      currentTurnWrites: [
        {
          kind: "self-improvement-proposal",
          path,
          at: proposal.createdAt,
        },
      ],
    },
  };
  mkdirSync(SELF_IMPROVEMENT_PROPOSALS_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(withLedger, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await emit({
    source: "chuck-dashboard",
    type: "chuck.self-improvement.proposal-created",
    payload: {
      proposalId: withLedger.proposalId,
      status: withLedger.status,
      laneId: withLedger.laneId,
      path,
      targetFileCount: withLedger.targetFiles.length,
      dirtyTargetCount: withLedger.cleanLedger.preExistingDirtyTargetFiles.length,
    },
  });
  return jsonResponse(res, 201, {
    ok: true,
    dryRun: false,
    writes: true,
    proposal: withLedger,
    path,
  });
}

async function handleSelfImprovementAction(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const action = String(body.action ?? "")
    .trim()
    .toLowerCase();
  const proposalId = String(body.proposalId ?? "").trim();
  if (!proposalId) {
    throw httpError("proposalId is required", 400);
  }
  if (!["approve", "reject"].includes(action)) {
    throw httpError("action must be approve or reject", 400);
  }
  const token =
    action === "approve" ? SELF_IMPROVEMENT_APPROVE_TOKEN : SELF_IMPROVEMENT_REJECT_TOKEN;
  if (body.confirm !== token) {
    throw httpError(`confirm must equal ${token}`, 409);
  }
  const file = findSelfImprovementProposalById(proposalId);
  if (!file) {
    throw httpError("self-improvement proposal not found", 404);
  }
  const proposal = file.data;
  const status = String(proposal?.status ?? "").toLowerCase();
  if (status !== "draft") {
    throw httpError(`only draft proposals can be ${action}d`, 409);
  }
  const authorityGate = selfImprovementAuthorityGate();
  if (action === "approve" && authorityGate?.state !== "approved") {
    throw httpError(
      "self-improvement authority gate must be approved before proposal approval",
      409,
    );
  }
  const now = new Date().toISOString();
  const operator = String(body.operator ?? body.updatedBy ?? "operator/cockpit").slice(0, 120);
  const reason = String(body.reason ?? "")
    .trim()
    .slice(0, 500);
  const receiptId = selfImprovementReceiptId();
  const receiptPath = join(SELF_IMPROVEMENT_RECEIPTS_DIR, `${receiptId}.json`);
  const nextStatus = action === "approve" ? "approved" : "rejected";
  const receipt = {
    receiptId,
    createdAt: now,
    operator,
    proposalId,
    action,
    fromStatus: status,
    toStatus: nextStatus,
    confirm: token,
    reason: reason || `${operator} ${action}d self-improvement proposal ${proposalId}`,
    authorityDiffId: proposal.authorityDiff?.authorityDiffId ?? null,
    nonEffects: proposal.authorityDiff?.nonEffects ?? [],
  };
  const updated = {
    ...proposal,
    status: nextStatus,
    updatedAt: now,
    ...(action === "approve" ? { approvedAt: now } : { rejectedAt: now }),
    [action === "approve" ? "approval" : "rejection"]: {
      at: now,
      by: operator,
      receiptId,
      receiptPath,
      reason: receipt.reason,
      note: "This approval/rejection updates the proposal ledger only; no patch or docket task is run.",
    },
    cleanLedger: {
      ...(proposal.cleanLedger ?? {}),
      currentTurnWrites: [
        ...(proposal.cleanLedger && Array.isArray(proposal.cleanLedger.currentTurnWrites)
          ? proposal.cleanLedger.currentTurnWrites
          : []),
        {
          kind: "self-improvement-receipt",
          path: receiptPath,
          at: now,
        },
        {
          kind: "self-improvement-proposal-status",
          path: file.path,
          at: now,
        },
      ],
      verificationReceipts: [
        ...(proposal.cleanLedger && Array.isArray(proposal.cleanLedger.verificationReceipts)
          ? proposal.cleanLedger.verificationReceipts
          : []),
        receiptId,
      ],
    },
  };
  writeJsonAtomicSync(receiptPath, receipt);
  writeJsonAtomicSync(file.path, updated);
  await emit({
    source: "chuck-dashboard",
    type: `chuck.self-improvement.proposal-${nextStatus}`,
    payload: {
      proposalId,
      action,
      status: nextStatus,
      receiptId,
      path: file.path,
      receiptPath,
    },
  });
  return jsonResponse(res, 200, {
    ok: true,
    action,
    proposalId,
    status: nextStatus,
    path: file.path,
    receipt,
    proposal: updated,
    lab: selfImprovementLabStatus(),
  });
}

async function handleExecutorControl(req, res) {
  if (req.method === "GET") {
    return jsonResponse(res, 200, executorControlStatus());
  }
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  const action = String(body.action ?? "")
    .trim()
    .toLowerCase();
  if (action === "pause") {
    const control = writeExecutorControl({
      mode: "paused",
      reason: body.reason ?? "operator paused executor intake from cockpit",
      updatedBy: body.updatedBy ?? "operator/cockpit",
    });
    await emit({
      source: "chuck-dashboard",
      type: "chuck.executor-control.updated",
      payload: {
        mode: control.mode,
        paused: control.paused,
        reason: control.reason,
        path: control.path,
      },
    });
    return jsonResponse(res, 200, { ok: true, control });
  }
  if (action === "resume") {
    if (body.confirm !== "RESUME_EXECUTOR") {
      throw httpError("confirm must equal RESUME_EXECUTOR", 409);
    }
    const control = writeExecutorControl({
      mode: "active",
      reason: body.reason ?? "operator resumed executor intake from cockpit",
      updatedBy: body.updatedBy ?? "operator/cockpit",
    });
    await emit({
      source: "chuck-dashboard",
      type: "chuck.executor-control.updated",
      payload: {
        mode: control.mode,
        paused: control.paused,
        reason: control.reason,
        path: control.path,
      },
    });
    return jsonResponse(res, 200, { ok: true, control });
  }
  throw httpError("action must be pause or resume", 400);
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
  const run = await runChuckCli(["--capability-ledger", "--probe", "--json"], {
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

async function transportAuditStatus({ maxAgeMs = 30_000 } = {}) {
  const now = Date.now();
  if (transportAuditCache && now - transportAuditCache.cachedAt < maxAgeMs) {
    return transportAuditCache.value;
  }
  const run = await runChuckCli(["--transport-audit", "--json"], {
    timeoutMs: dashboardCommandTimeoutMs({ kind: "surface-atlas" }),
  });
  if (!run.ok || !run.parsed?.audit) {
    const value = {
      available: false,
      reason: run.parseError || run.stderr || run.error || "transport audit unavailable",
      run,
    };
    transportAuditCache = { cachedAt: now, value };
    return value;
  }
  const audit = run.parsed.audit;
  const value = {
    available: true,
    refreshedAt: run.endedAt,
    text: run.parsed.text,
    summary: {
      totalSurfaces: Array.isArray(audit.entries) ? audit.entries.length : 0,
      loadBearing: audit.loadBearing ?? 0,
      partial: audit.partial ?? 0,
      missing: audit.missing ?? 0,
    },
    entries: audit.entries ?? [],
  };
  transportAuditCache = { cachedAt: now, value };
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

function readBatteryStatus() {
  const result = spawnSync("pmset", ["-g", "batt"], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.status !== 0 && !result.stdout) {
    return {
      available: false,
      reason: result.stderr || result.error?.message || "pmset unavailable",
    };
  }
  const text = result.stdout ?? "";
  const percentMatch = text.match(/(\d+)%/);
  const sourceMatch = text.match(/Now drawing from '([^']+)'/);
  const percent = percentMatch ? Number(percentMatch[1]) : null;
  return {
    available: true,
    percent,
    source: sourceMatch ? sourceMatch[1] : null,
    charging: /charging/i.test(text),
    raw: text.trim(),
  };
}

function readDiskStatus() {
  try {
    const stat = statfsSync(HOME);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    return {
      available: true,
      path: HOME,
      totalBytes,
      freeBytes,
      freePercent: totalBytes > 0 ? freeBytes / totalBytes : null,
    };
  } catch (err) {
    return { available: false, path: HOME, reason: err.message };
  }
}

function formatBytes(bytes) {
  const value = Number(bytes ?? 0);
  if (value >= 1024 ** 3) {
    return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  }
  if (value >= 1024 ** 2) {
    return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  }
  return `${Math.round(value)} B`;
}

function readSwapStatus() {
  const result = spawnSync("/usr/sbin/sysctl", ["-n", "vm.swapusage"], {
    encoding: "utf8",
    timeout: 2000,
  });
  const text = result.stdout ?? "";
  const match = text.match(/total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M/i);
  if (!match) {
    return {
      available: false,
      reason: result.stderr || result.error?.message || "swap usage unavailable",
    };
  }
  const totalBytes = Number(match[1]) * 1024 ** 2;
  const usedBytes = Number(match[2]) * 1024 ** 2;
  const freeBytes = Number(match[3]) * 1024 ** 2;
  return {
    available: true,
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: totalBytes > 0 ? usedBytes / totalBytes : null,
    raw: text.trim(),
  };
}

function macExecutionGateFromParts({ disk, swap }) {
  const blockers = [];
  if (!disk?.available) {
    blockers.push("mac health gate cannot read disk status");
  } else if (
    (disk.freePercent ?? 1) < MAC_GATE_THRESHOLDS.diskWarnFreePercent ||
    disk.freeBytes < MAC_GATE_THRESHOLDS.diskMinFreeBytes
  ) {
    blockers.push(
      `mac disk gate: ${formatBytes(disk.freeBytes)} free below ${formatBytes(MAC_GATE_THRESHOLDS.diskMinFreeBytes)} or ${Math.round(MAC_GATE_THRESHOLDS.diskWarnFreePercent * 100)}%`,
    );
  }
  if (swap?.available && swap.usedBytes > MAC_GATE_THRESHOLDS.swapWarnUsedBytes) {
    blockers.push(
      `mac swap gate: ${formatBytes(swap.usedBytes)} used above ${formatBytes(MAC_GATE_THRESHOLDS.swapWarnUsedBytes)}`,
    );
  }
  return {
    state: blockers.length > 0 ? "blocked" : "clear",
    blockers,
    exemptCommandKinds: [...MAC_GATE_EXEMPT_COMMAND_KINDS],
    thresholds: MAC_GATE_THRESHOLDS,
  };
}

function macExecutionGateStatus() {
  if (macExecutionGateCache && Date.now() - macExecutionGateCache.cachedAtMs < MAC_GATE_CACHE_MS) {
    return macExecutionGateCache.value;
  }
  const value = macExecutionGateFromParts({ disk: readDiskStatus(), swap: readSwapStatus() });
  macExecutionGateCache = { cachedAtMs: Date.now(), value };
  return value;
}

function executorMacGateBlockers(task) {
  const commandKind = String(task?.commandKind ?? "");
  if (MAC_GATE_EXEMPT_COMMAND_KINDS.has(commandKind)) {
    return [];
  }
  return macExecutionGateStatus().blockers;
}

function macHealthStatus() {
  const cpuCount = cpus().length || 1;
  const loads = loadavg();
  const totalMemoryBytes = totalmem();
  const freeMemoryBytes = freemem();
  const memoryFreePercent = totalMemoryBytes > 0 ? freeMemoryBytes / totalMemoryBytes : null;
  const disk = readDiskStatus();
  const swap = readSwapStatus();
  const executionGate = macExecutionGateFromParts({ disk, swap });
  const battery = readBatteryStatus();
  const services = [
    { label: "gateway", ...launchdServiceStatus("ai.openclaw.gateway") },
    { label: "dashboard", ...launchdServiceStatus("com.openclaw.chuck-dashboard") },
    { label: "executor", ...launchdServiceStatus(DOCKET_EXECUTOR_LABEL) },
  ];
  const signals = [];
  const loadRatio = loads[0] / cpuCount;
  signals.push({
    category: "mac.load",
    severity: loadRatio > 2 ? "error" : loadRatio > 1.25 ? "warn" : "info",
    summary: `load ${loads[0].toFixed(2)} / ${cpuCount} cores`,
    value: loads[0],
  });
  signals.push({
    category: "mac.memory",
    severity: memoryFreePercent !== null && memoryFreePercent < 0.08 ? "warn" : "info",
    summary: `free memory ${Math.round((memoryFreePercent ?? 0) * 100)}%`,
    value: memoryFreePercent,
  });
  signals.push({
    category: "mac.disk",
    severity: disk.freePercent !== null && disk.freePercent < 0.1 ? "warn" : "info",
    summary: disk.available
      ? `free disk ${Math.round((disk.freePercent ?? 0) * 100)}%`
      : disk.reason,
    value: disk.freePercent,
  });
  if (swap.available) {
    signals.push({
      category: "mac.swap",
      severity: swap.usedBytes > MAC_GATE_THRESHOLDS.swapWarnUsedBytes ? "warn" : "info",
      summary: `${formatBytes(swap.usedBytes)} swap used`,
      value: swap.usedPercent,
    });
  }
  signals.push({
    category: "mac.execution_gate",
    severity: executionGate.state === "blocked" ? "warn" : "info",
    summary: executionGate.blockers.join("; ") || "executor gate clear",
    value: executionGate.blockers.length,
  });
  if (battery.available && battery.percent !== null) {
    const onBattery = battery.source && !/AC Power/i.test(battery.source);
    signals.push({
      category: "mac.power",
      severity: onBattery && battery.percent < 20 ? "warn" : "info",
      summary: `${battery.percent}% / ${battery.source || "power unknown"}`,
      value: battery.percent,
    });
  }
  for (const service of services) {
    signals.push({
      category: `mac.service.${service.label}`,
      severity: service.state === "running" ? "info" : "warn",
      summary: `${service.label} ${service.state || "unknown"}`,
      value: service.pid ?? null,
    });
  }
  const worst = signals.some((signal) => signal.severity === "error")
    ? "error"
    : signals.some((signal) => signal.severity === "warn")
      ? "warn"
      : "info";
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    state: worst === "error" ? "degraded" : worst === "warn" ? "watch" : "ok",
    load: { one: loads[0], five: loads[1], fifteen: loads[2], cpuCount, loadRatio },
    memory: {
      totalBytes: totalMemoryBytes,
      freeBytes: freeMemoryBytes,
      freePercent: memoryFreePercent,
    },
    disk,
    swap,
    battery,
    executionGate,
    uptimeSeconds: uptime(),
    services,
    signals,
  };
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
  // Compatibility path for already-open dashboard tabs. The live dashboard now
  // hydrates each panel through bounded endpoints; this snapshot must stay
  // cheap so an old browser tab cannot pin the single Node event loop.
  const perichoresis = safe(perichoresisStatus, {
    available: false,
    reason: "perichoresis status unavailable",
  });
  const unavailable = (endpoint) => ({
    available: false,
    reason: `legacy snapshot shim; load ${endpoint}`,
  });
  const emptyRun = (endpoint) => ({
    available: false,
    reason: `legacy snapshot shim; load ${endpoint}`,
    events: [],
    lanes: [],
    activeRuns: [],
    runs: [],
  });
  return {
    time: new Date().toISOString(),
    perichoresis,
    fleet: unavailable("/api/fleet"),
    principles: unavailable("/api/principles"),
    processes: { ...unavailable("/api/processes"), processes: [] },
    repoHygiene: unavailable("/api/repo-hygiene"),
    repoHygieneCheckpoint: unavailable("/api/repo-hygiene/latest-checkpoint"),
    githubHygieneCheckpoint: unavailable("/api/github-hygiene/latest-checkpoint"),
    upstreamSyncCheckpoint: unavailable("/api/upstream-sync/latest-checkpoint"),
    panels: emptyRun("/api/panels"),
    curator: unavailable("/api/curator"),
    scorer: unavailable("/api/scorer"),
    router: unavailable("/api/router"),
    builder: {
      ...unavailable("/api/chuck-v2/build/status"),
      latest: null,
      pendingApproval: [],
      recent: [],
    },
    workLedger: emptyRun("/api/chuck-v2/work-ledger"),
    liveBuild: emptyRun("/api/chuck-v2/live-build"),
    modelDoctor: unavailable("/api/chuck-v2/doctor/status"),
    familyRegistry: unavailable("/api/chuck-v2/family-registry"),
    latestFleetRun: unavailable("/api/chuck-v2/latest-fleet-run"),
    latestRunnerExecution: unavailable("/api/chuck-v2/latest-fleet-run"),
    surfaceControl: unavailable("/api/chuck-v2/surface-control"),
    surfaceAtlas: unavailable("/api/chuck-v2/surface-atlas/status"),
    capabilityLedger: unavailable("/api/chuck-v2/capability-ledger/status"),
    transportAudit: unavailable("/api/chuck-v2/transport-audit/status"),
    recentEvents: { total24h: 0, recent: [], global: null },
  };
}

// ---------------------------------------------------------------------------
// Chuck v3 PWA endpoints — docket / status-strip / decisions.
// Wires the inline mocks in ~/.openclaw/workspace/state/chuck-v3/pwa/index.html
// to live state on disk. Read-only; mutations stay on the existing endpoints
// (docket-task-action, docket-draft-promote, executor-control).
// ---------------------------------------------------------------------------

const CHUCK_V3_NOTIFICATION_LEDGER_DIR = join(CHUCK_V3_STATE_DIR, "notification-ledger");
const CHUCK_V3_DECISIONS_DIR = join(CHUCK_V3_STATE_DIR, "decisions");
const CHUCK_V3_HEALTH_SNAPSHOT_PATH = join(CHUCK_V3_STATE_DIR, "health-snapshot.json");
const PWA_DOCKET_RECENT_LIMIT = 10;
const PWA_DECISION_RECENT_LIMIT = 5;
const PWA_QUIET_HOURS_TZ = "America/Chicago";
const PWA_QUIET_HOURS_START = 23; // 23:00 CDT
const PWA_QUIET_HOURS_END = 8; //  8:00 CDT
const PWA_DOCKET_SCAN_LIMIT = 500;

function pwaParseJsonFiles(dir, { limit = PWA_DOCKET_SCAN_LIMIT } = {}) {
  if (!existsSync(dir)) {
    return [];
  }
  return safe(
    () =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".json") && !name.endsWith(".lock"))
        .map((name) => {
          const path = join(dir, name);
          const stat = safe(() => statSync(path), null);
          return {
            name,
            path,
            mtimeMs: stat ? stat.mtimeMs : 0,
          };
        })
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, limit)
        .map((file) => ({ ...file, data: readJsonSafe(file.path, null) }))
        .filter((file) => file.data),
    [],
  );
}

function pwaQuietHoursActive(now = new Date()) {
  // Use Intl to extract the hour in America/Chicago without touching server tz.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: PWA_QUIET_HOURS_TZ,
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour");
  if (!hourPart) {
    return false;
  }
  const hour = Number.parseInt(hourPart.value, 10);
  if (!Number.isFinite(hour)) {
    return false;
  }
  // Quiet hours wrap midnight: [PWA_QUIET_HOURS_START, 24) ∪ [0, PWA_QUIET_HOURS_END).
  if (PWA_QUIET_HOURS_START > PWA_QUIET_HOURS_END) {
    return hour >= PWA_QUIET_HOURS_START || hour < PWA_QUIET_HOURS_END;
  }
  return hour >= PWA_QUIET_HOURS_START && hour < PWA_QUIET_HOURS_END;
}

function pwaPickFinishedTimestamp(task) {
  return task?.finishedAt ?? task?.updatedAt ?? task?.startedAt ?? task?.createdAt ?? null;
}

function pwaDocketStatus() {
  const files = pwaParseJsonFiles(CHUCK_V3_DOCKET_DIR, { limit: PWA_DOCKET_SCAN_LIMIT });
  const tasks = files.map((file) => {
    const task = file.data;
    return {
      ...task,
      // Make sure consumer always has a stable id even if the file omits it.
      id: task?.id ?? task?.taskId ?? file.name.replace(/\.json$/, ""),
      _mtimeMs: file.mtimeMs,
      _path: file.path,
    };
  });
  const counts = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    "failed-validation": 0,
    cancelled: 0,
    draft: 0,
  };
  for (const task of tasks) {
    const status = String(task?.status ?? "").toLowerCase();
    if (status in counts) {
      counts[status] += 1;
    }
  }
  const active = tasks
    .filter((task) => {
      const status = String(task?.status ?? "").toLowerCase();
      return status === "pending" || status === "running";
    })
    .toSorted((a, b) => {
      const aMs = parseTimeMs(a?.createdAt) ?? a._mtimeMs ?? 0;
      const bMs = parseTimeMs(b?.createdAt) ?? b._mtimeMs ?? 0;
      return aMs - bMs;
    })
    .map((task) => {
      const { _mtimeMs, _path, ...clean } = task;
      return clean;
    });
  const recent = tasks
    .toSorted((a, b) => {
      const aMs = parseTimeMs(a?.updatedAt) ?? parseTimeMs(a?.finishedAt) ?? a._mtimeMs ?? 0;
      const bMs = parseTimeMs(b?.updatedAt) ?? parseTimeMs(b?.finishedAt) ?? b._mtimeMs ?? 0;
      return bMs - aMs;
    })
    .slice(0, PWA_DOCKET_RECENT_LIMIT)
    .map((task) => {
      const { _mtimeMs, _path, ...clean } = task;
      return clean;
    });
  return {
    active,
    recent,
    counts,
    ts: new Date().toISOString(),
  };
}

function pwaExecutorProcess() {
  // pgrep is unsigned-bsd; -fl prints `pid command` for each match. We pick the
  // long-lived daemon, not the launchctl helper that briefly spawns it.
  let pid = null;
  let etimeSec = 0;
  let cpuPct = 0;
  try {
    const r = spawnSync("pgrep", ["-fl", "chuck-docket-executor"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1000,
    });
    if (r.status === 0 && typeof r.stdout === "string") {
      const lines = r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.includes("pgrep"));
      // Prefer the node process running the executor script (longer cmdline).
      const candidate =
        lines.find((l) => /node.*chuck-docket-executor/.test(l)) ?? lines[0] ?? null;
      if (candidate) {
        const m = candidate.match(/^(\d+)\s/);
        if (m) {
          pid = Number.parseInt(m[1], 10);
        }
      }
    }
  } catch {
    /* pgrep unavailable */
  }
  if (pid != null) {
    try {
      const ps = spawnSync("ps", ["-p", String(pid), "-o", "etime=,pcpu="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 1000,
      });
      if (ps.status === 0 && typeof ps.stdout === "string") {
        const parts = ps.stdout.trim().split(/\s+/);
        if (parts.length >= 2) {
          etimeSec = pwaParsePsEtime(parts[0]);
          cpuPct = Number.parseFloat(parts[1]);
          if (!Number.isFinite(cpuPct)) {
            cpuPct = 0;
          }
        }
      }
    } catch {
      /* ps unavailable */
    }
  }
  return { alive: pid != null, pid, etimeSec, cpuPct };
}

function pwaParsePsEtime(value) {
  // ps etime: [[DD-]HH:]MM:SS
  const text = String(value ?? "").trim();
  if (!text) {
    return 0;
  }
  const dayMatch = text.match(/^(\d+)-(.+)$/);
  let days = 0;
  let rest = text;
  if (dayMatch) {
    days = Number.parseInt(dayMatch[1], 10) || 0;
    rest = dayMatch[2];
  }
  const segments = rest.split(":").map((s) => Number.parseInt(s, 10) || 0);
  let h = 0;
  let m = 0;
  let s = 0;
  if (segments.length === 3) {
    [h, m, s] = segments;
  } else if (segments.length === 2) {
    [m, s] = segments;
  } else if (segments.length === 1) {
    [s] = segments;
  }
  return days * 86400 + h * 3600 + m * 60 + s;
}

function pwaStatusStripStatus() {
  const control = executorControlStatus();
  const proc = pwaExecutorProcess();
  // Heartbeat proxy: mtime of executor-control.json. The executor rewrites it
  // on lifecycle ticks; if it's stale the executor is wedged or missing.
  let heartbeatAgeSec = Number.POSITIVE_INFINITY;
  const ctrlStat = safe(() => statSync(EXECUTOR_CONTROL_PATH), null);
  if (ctrlStat) {
    heartbeatAgeSec = Math.max(0, Math.floor((Date.now() - ctrlStat.mtimeMs) / 1000));
  }

  // Queue counts — single docket scan reused for 24h slices.
  const files = pwaParseJsonFiles(CHUCK_V3_DOCKET_DIR, { limit: PWA_DOCKET_SCAN_LIMIT });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let pending = 0;
  let running = 0;
  let completedLast24h = 0;
  let failedLast24h = 0;
  let failedValidationLast24h = 0;
  for (const file of files) {
    const task = file.data;
    const status = String(task?.status ?? "").toLowerCase();
    if (status === "pending") {
      pending += 1;
      continue;
    }
    if (status === "running") {
      running += 1;
      continue;
    }
    const finishedMs = parseTimeMs(pwaPickFinishedTimestamp(task)) ?? file.mtimeMs;
    if (finishedMs < cutoff) {
      continue;
    }
    if (status === "completed") {
      completedLast24h += 1;
    } else if (status === "failed") {
      failedLast24h += 1;
    } else if (status === "failed-validation") {
      failedValidationLast24h += 1;
    }
  }

  // Last notification — newest file in notification-ledger/notif-*.json.
  let lastNotif = { id: null, ts: null, deliveredVia: null, subject: null };
  const notifFiles = safe(
    () =>
      readdirSync(CHUCK_V3_NOTIFICATION_LEDGER_DIR)
        .filter((name) => name.startsWith("notif-") && name.endsWith(".json"))
        .map((name) => {
          const path = join(CHUCK_V3_NOTIFICATION_LEDGER_DIR, name);
          return { name, path, mtimeMs: safe(() => statSync(path).mtimeMs, 0) };
        })
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 1),
    [],
  );
  if (notifFiles.length) {
    const data = readJsonSafe(notifFiles[0].path, null);
    if (data) {
      lastNotif = {
        id: data.id ?? notifFiles[0].name.replace(/\.json$/, ""),
        ts: data.ts ?? null,
        deliveredVia: data.deliveredVia ?? null,
        subject: data.payload?.subject ?? null,
      };
    }
  }

  // Open dissents — count of dissent JSON files.
  const openDissents = countJsonFiles(DISSENT_DIR);

  // Open decisions — decision-*.json without applied=true / rejected=true.
  let openDecisions = 0;
  const decisionFiles = pwaParseJsonFiles(CHUCK_V3_DECISIONS_DIR, { limit: 200 });
  for (const file of decisionFiles) {
    if (!file.name.startsWith("decision-")) {
      continue;
    }
    const d = file.data;
    if (d?.applied === true) continue;
    if (d?.rejected === true) continue;
    openDecisions += 1;
  }

  const quietHoursActive = pwaQuietHoursActive();
  const currentMode = control?.paused ? "paused" : quietHoursActive ? "quiet-hours" : "active";

  // Degraded — surfaced from health-snapshot.json if present + flagged.
  let degraded = null;
  const health = readJsonSafe(CHUCK_V3_HEALTH_SNAPSHOT_PATH, null);
  if (health && Array.isArray(health.errors) && health.errors.length > 0) {
    degraded = {
      reason: `health-snapshot reports ${health.errors.length} error(s)`,
      since: health.generatedAt ?? null,
    };
  }
  if (!proc.alive) {
    degraded = {
      reason: "chuck-docket-executor process not running",
      since: control?.updatedAt ?? null,
    };
  }

  return {
    executor: {
      alive: proc.alive,
      pid: proc.pid,
      etimeSec: proc.etimeSec,
      cpuPct: proc.cpuPct,
      heartbeatAgeSec: Number.isFinite(heartbeatAgeSec) ? heartbeatAgeSec : -1,
      mode: control?.paused ? "paused" : "active",
      pauseReason: control?.paused ? (control.reason ?? null) : null,
    },
    queue: {
      pending,
      running,
      completedLast24h,
      failedLast24h,
      failedValidationLast24h,
    },
    lastNotif,
    openDissents,
    openDecisions,
    currentMode,
    quietHoursActive,
    degraded,
    pushDegraded: false,
    ts: new Date().toISOString(),
  };
}

function pwaDecisionsStatus() {
  const files = pwaParseJsonFiles(CHUCK_V3_DECISIONS_DIR, { limit: 200 });
  const decisions = files
    .filter((file) => file.name.startsWith("decision-"))
    .map((file) => ({ ...file.data, _mtimeMs: file.mtimeMs }));
  const open = decisions
    .filter((d) => d.applied !== true && d.rejected !== true)
    .toSorted((a, b) => (b._mtimeMs ?? 0) - (a._mtimeMs ?? 0))
    .map(({ _mtimeMs, ...clean }) => clean);
  const recentApplied = decisions
    .filter((d) => d.applied === true)
    .toSorted((a, b) => (b._mtimeMs ?? 0) - (a._mtimeMs ?? 0))
    .slice(0, PWA_DECISION_RECENT_LIMIT)
    .map(({ _mtimeMs, ...clean }) => clean);
  const recentRejected = decisions
    .filter((d) => d.rejected === true)
    .toSorted((a, b) => (b._mtimeMs ?? 0) - (a._mtimeMs ?? 0))
    .slice(0, PWA_DECISION_RECENT_LIMIT)
    .map(({ _mtimeMs, ...clean }) => clean);
  return {
    open,
    recentApplied,
    recentRejected,
    ts: new Date().toISOString(),
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

function redirectResponse(res, location) {
  res.writeHead(302, {
    Location: location,
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`retired; use ${location}\n`);
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
    return 180_000;
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
    const runId = `dash-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    appendLiveBuildEvent({
      runId,
      status: "started",
      kind: String(args[0] ?? "chuck-cli"),
      args,
      timeoutMs,
      summary: `started ${args.join(" ")}`,
    });
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
      appendLiveBuildEvent({
        runId,
        status: "failed",
        kind: String(args[0] ?? "chuck-cli"),
        args,
        error: error instanceof Error ? error.message : String(error),
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
        summary: `failed to start ${args.join(" ")}`,
      });
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
      const ok = exitCode === 0 && !timedOut && !parseError;
      appendLiveBuildEvent({
        runId,
        status: ok ? "passed" : timedOut ? "timeout" : "failed",
        kind: String(args[0] ?? "chuck-cli"),
        args,
        exitCode,
        signal,
        timedOut,
        parseError,
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
        startedAt,
        endedAt: new Date().toISOString(),
        summary: `${ok ? "passed" : timedOut ? "timed out" : "failed"} ${args.join(" ")}`,
      });
      resolveRun({
        ok,
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

function runNodeJsonScript(
  scriptPath,
  args,
  { timeoutMs = 60_000, maxBufferBytes = 8 * 1024 * 1024 } = {},
) {
  return new Promise((resolveRun) => {
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
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
        parsed,
        parseError,
        stdout: parsed ? undefined : stdout.slice(-16_000),
        stderr: stderr.slice(-16_000),
      });
    });
  });
}

async function handleMacSelfHeal(req, res, mode) {
  if (mode === "status" && req.method !== "GET") {
    return methodNotAllowed(res);
  }
  if (mode !== "status" && req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = mode === "status" ? {} : await readRequestJson(req);
  if (mode === "apply" && body.confirm !== "RUN_MAC_SELF_HEAL") {
    throw httpError("confirm must equal RUN_MAC_SELF_HEAL", 409);
  }
  const args = [mode, "--json"];
  if (Number.isFinite(Number(body.maxActions)) && Number(body.maxActions) > 0) {
    args.push("--max-actions", String(Math.floor(Number(body.maxActions))));
  }
  if (typeof body.cloudTarget === "string" && body.cloudTarget.trim()) {
    args.push("--cloud-target", body.cloudTarget.trim());
  }
  if (body.allowCloudOffload === true) {
    args.push("--allow-cloud-offload");
  }
  const run = await runNodeJsonScript(CHUCK_MAC_SELF_HEAL, args, {
    timeoutMs: mode === "apply" ? 20 * 60_000 : 120_000,
  });
  return jsonResponse(res, run.ok ? 200 : 500, run.ok ? run.parsed : run);
}

function latestVerifiedLocalArchiveCandidate() {
  const receipts = latestJsonFiles(MAC_SELF_HEAL_RECEIPTS_DIR, { limit: 30 });
  for (const file of receipts) {
    const receipt = file.data;
    const results = Array.isArray(receipt?.results) ? receipt.results : [];
    const applied = results.filter(
      (result) =>
        result?.status === "applied" &&
        result?.action === "copied-to-cloud-and-moved-local-archive" &&
        typeof result.cloudPath === "string" &&
        typeof result.localArchivePath === "string",
    );
    if (!applied.length || !receipt?.receiptId) {
      continue;
    }
    const archiveRoot = join(MAC_SELF_HEAL_ARCHIVES_DIR, receipt.receiptId);
    if (!resolvedPathInside(archiveRoot, MAC_SELF_HEAL_ARCHIVES_DIR) || !existsSync(archiveRoot)) {
      continue;
    }
    const missingCloud = applied.filter((result) => !existsSync(result.cloudPath));
    const existingLocal = applied.filter((result) => existsSync(result.localArchivePath));
    if (missingCloud.length) {
      return {
        available: false,
        blocked: true,
        reason: `${missingCloud.length} cloud copy/copies missing; refusing local archive purge`,
        receiptId: receipt.receiptId,
        receiptPath: file.path,
        archiveRoot,
        missingCloudCount: missingCloud.length,
      };
    }
    if (!existingLocal.length) {
      continue;
    }
    return {
      available: true,
      receiptId: receipt.receiptId,
      receiptPath: file.path,
      archiveRoot,
      fileCount: existingLocal.length,
      bytes:
        Number(receipt.appliedBytes) ||
        existingLocal.reduce((sum, result) => sum + (Number(result.bytes) || 0), 0),
      cloudCopiesVerified: applied.length,
    };
  }
  return {
    available: false,
    blocked: false,
    reason: "no verified local archive copy is currently purgeable",
  };
}

async function handleMacLocalArchivePurge(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }
  const body = await readRequestJson(req);
  if (body.confirm !== "PURGE_VERIFIED_LOCAL_ARCHIVE") {
    throw httpError("confirm must equal PURGE_VERIFIED_LOCAL_ARCHIVE", 409);
  }
  const candidate = latestVerifiedLocalArchiveCandidate();
  if (!candidate.available) {
    return jsonResponse(res, candidate.blocked ? 409 : 200, {
      ok: !candidate.blocked,
      ...candidate,
    });
  }
  rmSync(candidate.archiveRoot, { recursive: true, force: false });
  const receipt = {
    schema: "chuck-v3.mac-self-heal.local-archive-purge/1",
    createdAt: new Date().toISOString(),
    operator: "operator/cockpit",
    sourceReceiptId: candidate.receiptId,
    sourceReceiptPath: candidate.receiptPath,
    deletedArchiveRoot: candidate.archiveRoot,
    deletedAppliedFileCount: candidate.fileCount,
    deletedBytesApprox: candidate.bytes,
    cloudCopiesVerifiedBeforeDelete: candidate.cloudCopiesVerified,
    reason:
      "After verified Google Drive offload, remove duplicate local receipt archive copy to recover disk headroom.",
  };
  const path = join(
    MAC_SELF_HEAL_PURGE_RECEIPTS_DIR,
    `local-purge-${new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z")}-${candidate.receiptId}.json`,
  );
  writeJsonAtomicSync(path, receipt);
  try {
    emit("chuck.mac.local_archive_purged", {
      source: "chuck-dashboard",
      receiptId: receipt.sourceReceiptId,
      deletedBytesApprox: receipt.deletedBytesApprox,
      purgeReceiptPath: path,
    });
  } catch {
    // Purge receipt is primary; bus emission is best effort.
  }
  return jsonResponse(res, 200, { ok: true, ...receipt, purgeReceiptPath: path });
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
      args.push("--only-surface", surfaces);
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
      return htmlResponse(res, COCKPIT_HTML);
    }
    if (url === "/cockpit") {
      return htmlResponse(res, COCKPIT_HTML);
    }
    if (url === "/legacy") {
      return redirectResponse(res, "/");
    }
    if (url === "/favicon.ico") {
      res.writeHead(204, { "Cache-Control": "max-age=86400" });
      return res.end();
    }
    // 2026-04-29: serve the Chuck v3 PWA at /pwa. Single-file HTML/JSX/Tailwind
    // built tonight; lives in chuck-v3 state so it persists with the rest of
    // Chuck's surface. Read on each request so edits to the file land without
    // a dashboard restart.
    if (url === "/pwa" || url === "/pwa/" || url === "/pwa/index.html") {
      try {
        const pwaPath = `${HOME}/.openclaw/workspace/state/chuck-v3/pwa/index.html`;
        const html = readFileSync(pwaPath, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        return res.end(html);
      } catch (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end(`PWA not found: ${err?.message ?? err}`);
      }
    }
    // 2026-04-30: web-push wiring for the Chuck v3 PWA. Three endpoints back
    // the PWA's subscribe flow + the cascade enforcer. VAPID keys at
    // ~/.openclaw/credentials/web-push-vapid.json (perms 600); subscriptions
    // at ~/.openclaw/workspace/state/chuck-v3/push-subscriptions/.
    if (url === "/api/chuck-v3/push/vapid-public") {
      try {
        const v = loadWebPushVapid();
        return jsonResponse(res, 200, { publicKey: v.publicKey });
      } catch (err) {
        return jsonResponse(res, 500, { ok: false, error: err?.message || String(err) });
      }
    }
    if (url === "/api/chuck-v3/push/subscribe") {
      if ((req.method || "").toUpperCase() !== "POST") return methodNotAllowed(res);
      try {
        const body = await readRequestJson(req);
        if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
          return jsonResponse(res, 400, {
            ok: false,
            error: "subscription must include endpoint + keys.p256dh + keys.auth",
          });
        }
        // Stamp UA from the request header so we can tell devices apart later.
        const ua = req.headers["user-agent"] || null;
        const result = await saveWebPushSubscription({ ...body, userAgent: body.userAgent || ua });
        try {
          await emit({
            source: "chuck-dashboard",
            type: "chuck.push.subscribed",
            payload: { deduped: result.deduped, file: result.file, ua },
          });
        } catch {
          /* best-effort */
        }
        return jsonResponse(res, result.deduped ? 200 : 201, { ok: true, deduped: result.deduped });
      } catch (err) {
        return jsonResponse(res, err?.statusCode || 500, {
          ok: false,
          error: err?.message || String(err),
        });
      }
    }
    if (url === "/api/chuck-v3/push/unsubscribe") {
      if ((req.method || "").toUpperCase() !== "POST") return methodNotAllowed(res);
      try {
        const body = await readRequestJson(req);
        if (!body?.endpoint) {
          return jsonResponse(res, 400, { ok: false, error: "endpoint is required" });
        }
        const result = await removeWebPushSubscription(body.endpoint);
        try {
          await emit({
            source: "chuck-dashboard",
            type: "chuck.push.unsubscribed",
            payload: { ok: result.ok, file: result.file },
          });
        } catch {
          /* best-effort */
        }
        if (!result.ok) return jsonResponse(res, 404, result);
        return jsonResponse(res, 200, result);
      } catch (err) {
        return jsonResponse(res, err?.statusCode || 500, {
          ok: false,
          error: err?.message || String(err),
        });
      }
    }
    if (url === "/api/chuck-v3/push/status") {
      try {
        const subs = await listWebPushSubscriptions();
        const v = (() => {
          try {
            return loadWebPushVapid();
          } catch {
            return null;
          }
        })();
        return jsonResponse(res, 200, {
          ok: true,
          vapidPresent: !!v,
          subscriptionCount: subs.length,
          createdAt: v?.createdAt || null,
        });
      } catch (err) {
        return jsonResponse(res, 500, { ok: false, error: err?.message || String(err) });
      }
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
    if (url === "/api/mac-health") {
      return jsonResponse(res, 200, macHealthStatus());
    }
    if (url === "/api/mac-self-heal/status") {
      return handleMacSelfHeal(req, res, "status");
    }
    if (url === "/api/mac-self-heal/plan") {
      return handleMacSelfHeal(req, res, "plan");
    }
    if (url === "/api/mac-self-heal/apply") {
      return handleMacSelfHeal(req, res, "apply");
    }
    if (url === "/api/mac-self-heal/purge-local-archive") {
      return handleMacLocalArchivePurge(req, res);
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
    if (url === "/api/chuck-v2/work-ledger") {
      return jsonResponse(res, 200, workLedgerStatus());
    }
    if (url === "/api/chuck-v2/live-build") {
      return jsonResponse(res, 200, liveBuildStatus());
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
    if (url === "/api/chuck-v2/doctor/status") {
      return jsonResponse(res, 200, modelDoctorStatus());
    }
    if (url === "/api/chuck-v2/family-registry") {
      return jsonResponse(res, 200, familyRegistryStatus());
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
    if (url === "/api/chuck-v2/surface-atlas/status") {
      return jsonResponse(
        res,
        200,
        surfaceAtlasCache?.value ?? {
          available: false,
          reason: "no cached surface atlas yet; click Surface Atlas to refresh",
        },
      );
    }
    if (url === "/api/chuck-v2/capability-ledger") {
      return jsonResponse(res, 200, await capabilityLedgerStatus({ maxAgeMs: 0 }));
    }
    if (url === "/api/chuck-v2/capability-ledger/status") {
      return jsonResponse(
        res,
        200,
        capabilityLedgerCache?.value ?? {
          available: false,
          reason: "no cached capability ledger yet; click Model Doctor to refresh",
        },
      );
    }
    if (url === "/api/chuck-v2/transport-audit") {
      return jsonResponse(res, 200, await transportAuditStatus({ maxAgeMs: 0 }));
    }
    if (url === "/api/chuck-v2/transport-audit/status") {
      return jsonResponse(
        res,
        200,
        transportAuditCache?.value ?? {
          available: false,
          reason: "no cached transport audit yet; refresh explicitly when needed",
        },
      );
    }
    if (url === "/api/chuck-v3/perichoresis") {
      return jsonResponse(res, 200, perichoresisStatus());
    }
    if (url === "/api/chuck-v3/compaction") {
      return jsonResponse(res, 200, compactionStatus());
    }
    if (url === "/api/chuck-v3/compaction-preview") {
      return await handleCompactionPreview(req, res);
    }
    if (url === "/api/chuck-v3/compaction-approve") {
      return await handleCompactionApprove(req, res);
    }
    if (url === "/api/chuck-v3/authority-gates") {
      return jsonResponse(res, 200, authorityGatesStatus());
    }
    if (url === "/api/chuck-v3/authority-gate-action") {
      return await handleAuthorityGateAction(req, res);
    }
    if (url === "/api/chuck-v3/self-improvement-lab") {
      return jsonResponse(res, 200, selfImprovementLabStatus());
    }
    if (url === "/api/chuck-v3/self-improvement-proposal") {
      return await handleSelfImprovementProposal(req, res);
    }
    if (url === "/api/chuck-v3/self-improvement-action") {
      return await handleSelfImprovementAction(req, res);
    }
    if (url === "/api/chuck-v3/proposal-docket-draft") {
      return await handleProposalDocketDraft(req, res);
    }
    if (url === "/api/chuck-v3/docket-drafts") {
      return await handleDocketDrafts(req, res);
    }
    if (url === "/api/chuck-v3/docket-draft-preview") {
      return await handleDocketDraftPreview(req, res);
    }
    if (url === "/api/chuck-v3/docket-draft-promote") {
      return await handleDocketDraftPromote(req, res);
    }
    if (url === "/api/chuck-v3/docket-task-action") {
      return await handleDocketTaskAction(req, res);
    }
    if (url === "/api/chuck-v3/docket") {
      return jsonResponse(res, 200, pwaDocketStatus());
    }
    if (url === "/api/chuck-v3/status-strip") {
      return jsonResponse(res, 200, pwaStatusStripStatus());
    }
    if (url === "/api/chuck-v3/decisions") {
      return jsonResponse(res, 200, pwaDecisionsStatus());
    }
    if (url === "/api/chuck-v3/executor-queue") {
      return jsonResponse(res, 200, executorQueueStatus());
    }
    if (url === "/api/chuck-v3/executor-inspect") {
      return jsonResponse(
        res,
        200,
        executorInspectStatus({ taskId: parsedUrl.searchParams.get("taskId") ?? "" }),
      );
    }
    if (url === "/api/chuck-v3/executor-control") {
      return await handleExecutorControl(req, res);
    }
    if (url === "/api/chuck-v2/latest-fleet-run") {
      return jsonResponse(res, 200, latestRunnerExecutionStatus({ minimumSurfaces: 3 }));
    }
    if (url === "/api/recent-events") {
      return jsonResponse(res, 200, eventsLast24h());
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

const COCKPIT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Chuck Cockpit</title>
<style>
  :root {
    --bg: #101215;
    --bg-raised: #171a1f;
    --bg-soft: #1d2228;
    --ink: #f1f4ee;
    --muted: #9ba49a;
    --quiet: #707a74;
    --line: #303841;
    --line-strong: #46515c;
    --green: #6ec18c;
    --yellow: #d9b45c;
    --red: #e07167;
    --blue: #75a7d8;
    --violet: #b5a0e5;
    --paper: #d8d3c2;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    min-height: 100%;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 14px;
  }
  body { overflow-x: hidden; }
  a { color: inherit; text-decoration: none; }
  button, a.button {
    border: 1px solid var(--line-strong);
    background: #222831;
    color: var(--ink);
    border-radius: 6px;
    min-height: 34px;
    padding: 0 12px;
    font: 600 12px/1 var(--mono);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  button:hover, a.button:hover { border-color: var(--blue); background: #27313b; }
  button:disabled { opacity: 0.55; cursor: wait; }
  .app {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 248px minmax(0, 1fr);
  }
  .rail {
    position: sticky;
    top: 0;
    height: 100vh;
    border-right: 1px solid var(--line);
    background: #0d0f12;
    padding: 22px 18px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .brand {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    align-items: center;
    gap: 10px;
  }
  .mark {
    width: 34px;
    height: 34px;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--paper);
    font: 700 15px/1 var(--mono);
    background: #191f25;
  }
  .brand h1 {
    margin: 0;
    font-size: 16px;
    line-height: 1.1;
    font-weight: 700;
    letter-spacing: 0;
  }
  .brand p {
    margin: 3px 0 0;
    color: var(--muted);
    font: 11px/1.3 var(--mono);
  }
  .nav {
    display: grid;
    gap: 8px;
  }
  .nav a {
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--muted);
    padding: 8px 9px;
    font: 600 12px/1.2 var(--mono);
  }
  .nav a:hover { color: var(--ink); border-color: var(--line); background: var(--bg-raised); }
  .railFooter {
    margin-top: auto;
    display: grid;
    gap: 10px;
  }
  .small {
    color: var(--quiet);
    font: 11px/1.45 var(--mono);
    overflow-wrap: anywhere;
  }
  .main {
    min-width: 0;
    padding: 22px;
  }
  .topbar {
    min-height: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 18px;
  }
  .topbar .clock {
    color: var(--muted);
    font: 12px/1.2 var(--mono);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .hero {
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    padding: 24px 0 22px;
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.8fr);
    gap: 24px;
  }
  .label {
    margin: 0 0 8px;
    color: var(--yellow);
    font: 700 11px/1.2 var(--mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .headline {
    margin: 0;
    max-width: 920px;
    font-size: 34px;
    line-height: 1.04;
    letter-spacing: 0;
    font-weight: 720;
  }
  .focus {
    margin: 16px 0 0;
    max-width: 860px;
    color: var(--muted);
    font-size: 15px;
    line-height: 1.55;
  }
  .metaGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .metric {
    min-height: 76px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg-raised);
    padding: 12px;
    display: grid;
    align-content: space-between;
    gap: 8px;
  }
  .metric span {
    color: var(--quiet);
    font: 700 10px/1.2 var(--mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .metric strong {
    font: 700 23px/1 var(--mono);
    overflow-wrap: anywhere;
  }
  .status {
    display: inline-flex;
    width: fit-content;
    max-width: 100%;
    align-items: center;
    gap: 7px;
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    padding: 5px 9px;
    color: var(--muted);
    font: 700 11px/1 var(--mono);
    text-transform: uppercase;
    overflow-wrap: anywhere;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--quiet);
    flex: 0 0 auto;
  }
  .status.ok .dot { background: var(--green); }
  .status.warn .dot { background: var(--yellow); }
  .status.err .dot { background: var(--red); }
  .content {
    padding-top: 20px;
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
    gap: 18px;
    align-items: start;
  }
  .stack { display: grid; gap: 18px; min-width: 0; }
  .panel {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg-raised);
    min-width: 0;
    overflow: hidden;
  }
  .main > .panel {
    margin-top: 18px;
  }
  .panelHead {
    min-height: 46px;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
  }
  .panelHead h2 {
    margin: 0;
    font-size: 13px;
    line-height: 1.2;
    font-weight: 720;
    letter-spacing: 0;
  }
  .panelHead .sub {
    color: var(--quiet);
    font: 11px/1.2 var(--mono);
    white-space: nowrap;
  }
  .panelBody {
    padding: 14px;
  }
  .list {
    display: grid;
    gap: 9px;
  }
  .row {
    min-height: 54px;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 10px;
    background: #14181d;
    display: grid;
    gap: 6px;
  }
  .rowTitle {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }
  .rowTitle strong {
    min-width: 0;
    font-size: 13px;
    line-height: 1.35;
    font-weight: 680;
    overflow-wrap: anywhere;
  }
  .rowTitle code, .tag {
    color: var(--muted);
    font: 11px/1.2 var(--mono);
    white-space: nowrap;
  }
  .row p {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .rowActions, .operatorActions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .rowActions { margin-top: 2px; }
  .rowActions button, .operatorActions button {
    min-height: 30px;
    padding: 0 10px;
    font-size: 11px;
  }
  .controlStrip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 10px;
    background: #11161b;
  }
  .controlText {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  .controlText strong {
    font: 700 12px/1.2 var(--mono);
    color: var(--fg);
    overflow-wrap: anywhere;
  }
  .controlText span {
    color: var(--muted);
    font: 12px/1.35 var(--sans);
    overflow-wrap: anywhere;
  }
  .operatorResult {
    margin-top: 12px;
    max-height: 260px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: #12161a;
    padding: 10px;
    color: var(--muted);
    font: 11px/1.45 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .split {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .field {
    min-height: 58px;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 10px;
    display: grid;
    align-content: start;
    gap: 5px;
    background: #14181d;
  }
  .field span {
    color: var(--quiet);
    font: 700 10px/1.2 var(--mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .field strong, .field p {
    margin: 0;
    color: var(--ink);
    font-size: 12px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .familyGrid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 9px;
  }
  .family {
    min-height: 86px;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 10px;
    background: #14181d;
    display: grid;
    align-content: space-between;
    gap: 8px;
  }
  .family strong {
    font: 700 12px/1.25 var(--mono);
    overflow-wrap: anywhere;
  }
  .family .bars {
    height: 5px;
    border-radius: 999px;
    background: #283039;
    overflow: hidden;
  }
  .family .bars i {
    display: block;
    height: 100%;
    background: var(--green);
  }
  .empty, .errorLine {
    color: var(--quiet);
    font: 12px/1.45 var(--mono);
    border: 1px dashed var(--line);
    border-radius: 6px;
    padding: 12px;
    background: #13171b;
  }
  .errorLine { color: var(--red); border-color: rgba(224, 113, 103, 0.35); }
  .priorLine {
    margin-top: 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .chip {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 5px 8px;
    color: var(--muted);
    font: 11px/1.1 var(--mono);
    background: #14181d;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .chip.ok { color: var(--green); border-color: rgba(110, 193, 140, 0.45); }
  .chip.warn { color: var(--yellow); border-color: rgba(217, 180, 92, 0.45); }
  .chip.err { color: var(--red); border-color: rgba(224, 113, 103, 0.45); }
  .wide { grid-column: 1 / -1; }
  @media (max-width: 1180px) {
    .hero, .content { grid-template-columns: 1fr; }
    .familyGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 780px) {
    .app { grid-template-columns: 1fr; }
    .rail {
      position: static;
      height: auto;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
    .nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .main { padding: 16px; }
    .topbar { align-items: flex-start; flex-direction: column; }
    .actions { justify-content: flex-start; }
    .headline { font-size: 28px; line-height: 1.08; }
    .split, .metaGrid, .familyGrid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="app">
  <aside class="rail">
    <div class="brand">
      <div class="mark">C</div>
      <div>
        <h1>Chuck</h1>
        <p>cockpit / 7777</p>
      </div>
    </div>
    <nav class="nav" aria-label="Cockpit">
      <a href="#alive">Alive</a>
      <a href="#trajectory">10/10</a>
      <a href="#selfLab">Lab</a>
      <a href="#prior">Prior</a>
      <a href="#proposals">Proposals</a>
      <a href="#families">Families</a>
      <a href="#mac">Mac</a>
      <a href="#ledger">Ledger</a>
      <a href="#fleet">Fleet</a>
    </nav>
    <div class="railFooter">
      <div id="executorBadge" class="status warn"><i class="dot"></i><span>loading</span></div>
      <div id="railMeta" class="small">waiting for live state</div>
    </div>
  </aside>
  <main class="main">
    <div class="topbar">
      <div>
        <div id="clock" class="clock">--</div>
        <div id="errorLine" class="small"></div>
      </div>
      <div class="actions">
        <button id="refresh" type="button">Refresh</button>
      </div>
    </div>

    <section id="prior" class="hero" aria-label="Universal prior">
      <div>
        <p class="label">Universal Prior</p>
        <h2 id="priorClaim" class="headline">Loading live prior...</h2>
        <p id="priorFocus" class="focus">Waiting for Chuck's current focus line.</p>
        <div class="priorLine">
          <span id="priorId" class="chip">prior: --</span>
          <span id="priorAge" class="chip">age: --</span>
          <span id="priorSource" class="chip">source: --</span>
        </div>
      </div>
      <div class="metaGrid" aria-label="Current state">
        <div class="metric"><span>Executor</span><strong id="metricExecutor">--</strong></div>
        <div class="metric"><span>Families</span><strong id="metricFamilies">--</strong></div>
        <div class="metric"><span>Deltas</span><strong id="metricDeltas">--</strong></div>
        <div class="metric"><span>Reads</span><strong id="metricReads">--</strong></div>
      </div>
    </section>

    <section id="alive" class="panel">
      <div class="panelHead"><h2>Chuck Alive</h2><span id="aliveSummary" class="sub">--</span></div>
      <div class="panelBody">
        <div class="split">
          <div class="field"><span>State</span><strong id="aliveState">--</strong><p id="aliveReason">--</p></div>
          <div class="field"><span>Pulse</span><strong id="alivePulse">--</strong><p id="alivePulseMeta">--</p></div>
          <div class="field"><span>Queue</span><strong id="aliveQueue">--</strong><p id="aliveQueueMeta">--</p></div>
          <div class="field"><span>Model Doctor</span><strong id="aliveDoctor">--</strong><p id="aliveDoctorMeta">--</p></div>
        </div>
        <div style="height:12px"></div>
        <div id="aliveSignals" class="list"><div class="empty">loading liveness receipts</div></div>
      </div>
    </section>

    <section id="trajectory" class="panel">
      <div class="panelHead"><h2>10/10 Trajectory</h2><span id="tenTenSummary" class="sub">--</span></div>
      <div class="panelBody">
        <div class="split">
          <div class="field"><span>Current Score</span><strong id="tenTenScore">--</strong></div>
          <div class="field"><span>Next Gate</span><strong id="tenTenGate">--</strong></div>
        </div>
        <div style="height:12px"></div>
        <div id="tenTenList" class="list"><div class="empty">loading 10/10 trajectory</div></div>
      </div>
    </section>

    <section class="content">
      <div class="stack">
        <section id="operator" class="panel">
          <div class="panelHead"><h2>Operator Lane</h2><span id="operatorStatus" class="sub">idle</span></div>
          <div class="panelBody">
            <div class="operatorActions">
              <button type="button" data-command="doctor">Run Doctor</button>
              <button type="button" data-command="atlas">Refresh Atlas</button>
              <button type="button" data-command="docket">Read Docket</button>
              <button type="button" data-command="capability">Capability Ledger</button>
            </div>
            <div id="operatorResult" class="operatorResult">No operator command has run from this cockpit.</div>
          </div>
        </section>

        <section id="executorQueue" class="panel">
          <div class="panelHead"><h2>Executor Queue</h2><span id="queueSummary" class="sub">--</span></div>
          <div class="panelBody">
            <div class="controlStrip">
              <div class="controlText">
                <strong id="executorControlMode">Executor intake --</strong>
                <span id="executorControlReason">waiting for control state</span>
              </div>
              <div class="rowActions">
                <button id="inspectExecutor" type="button">Inspect</button>
                <button id="pauseExecutor" type="button">Pause intake</button>
                <button id="resumeExecutor" type="button">Resume intake</button>
              </div>
            </div>
            <div id="queueList" class="list"><div class="empty">loading queue</div></div>
          </div>
        </section>

        <section id="authorityGates" class="panel">
          <div class="panelHead"><h2>Authority Gates</h2><span id="authoritySummary" class="sub">--</span></div>
          <div class="panelBody">
            <div class="split">
              <div class="field"><span>Quarantined</span><strong id="authorityQuarantined">--</strong></div>
              <div class="field"><span>Policy Gated</span><strong id="authorityPolicyGated">--</strong></div>
            </div>
            <div style="height:12px"></div>
            <div id="authorityList" class="list"><div class="empty">loading authority gates</div></div>
          </div>
        </section>

        <section id="selfLab" class="panel">
          <div class="panelHead"><h2>Self-Improvement Lab</h2><span id="selfLabSummary" class="sub">--</span></div>
          <div class="panelBody">
            <div class="split">
              <div class="field"><span>Readiness</span><strong id="selfLabReadiness">--</strong></div>
              <div class="field"><span>Proposals</span><strong id="selfLabProposalCount">--</strong></div>
            </div>
            <div style="height:12px"></div>
            <div class="rowActions">
              <button id="draftSelfLab" type="button">Draft proposal</button>
            </div>
            <div style="height:12px"></div>
            <div id="selfLabList" class="list"><div class="empty">loading self-improvement lab</div></div>
          </div>
        </section>

        <section id="compactionGate" class="panel">
          <div class="panelHead"><h2>Compaction Gate</h2><span id="compactionSummary" class="sub">--</span></div>
          <div class="panelBody">
            <div class="split">
              <div class="field"><span>Unapplied Deltas</span><strong id="compactionUnapplied">--</strong></div>
              <div class="field"><span>Approval State</span><strong id="compactionApproval">--</strong></div>
            </div>
            <div style="height:12px"></div>
            <div class="rowActions">
              <button id="draftCompaction" type="button">Draft compaction</button>
              <button id="approveCompaction" type="button">Approve compaction</button>
            </div>
            <div style="height:12px"></div>
            <div id="compactionList" class="list"><div class="empty">loading compaction gate</div></div>
          </div>
        </section>

        <section id="proposals" class="panel">
          <div class="panelHead"><h2>Proposal Lane</h2><span id="proposalCount" class="sub">--</span></div>
          <div class="panelBody"><div id="proposalList" class="list"><div class="empty">loading proposals</div></div></div>
        </section>

        <section id="drafts" class="panel">
          <div class="panelHead"><h2>Draft Queue</h2><span id="draftCount" class="sub">--</span></div>
          <div class="panelBody"><div id="draftList" class="list"><div class="empty">loading drafts</div></div></div>
        </section>

        <section id="ledger" class="panel">
          <div class="panelHead"><h2>Posterior Deltas</h2><span id="deltaCount" class="sub">--</span></div>
          <div class="panelBody"><div id="deltaList" class="list"><div class="empty">loading deltas</div></div></div>
        </section>

        <section id="docket" class="panel">
          <div class="panelHead"><h2>Docket</h2><span id="docketCount" class="sub">--</span></div>
          <div class="panelBody"><div id="docketList" class="list"><div class="empty">loading docket</div></div></div>
        </section>
      </div>

      <div class="stack">
        <section id="mac" class="panel">
          <div class="panelHead"><h2>Mac Health</h2><span id="macSummary" class="sub">--</span></div>
          <div class="panelBody">
            <div class="split">
              <div class="field"><span>Load</span><strong id="macLoad">--</strong></div>
              <div class="field"><span>Memory</span><strong id="macMemory">--</strong></div>
              <div class="field"><span>Disk</span><strong id="macDisk">--</strong></div>
              <div class="field"><span>Power</span><strong id="macPower">--</strong></div>
              <div class="field"><span>Gate</span><strong id="macGate">--</strong></div>
              <div class="field"><span>Cloud</span><strong id="macCloud">--</strong></div>
            </div>
            <div style="height:12px"></div>
            <div class="rowActions">
              <button id="planMacHeal" type="button">Plan heal</button>
              <button id="runMacHeal" type="button">Run safe heal</button>
              <button id="runMacCloudOffload" type="button">Run cloud offload</button>
              <button id="purgeMacLocalArchive" type="button">Purge local copy</button>
            </div>
            <div style="height:12px"></div>
            <div id="macSignals" class="list"><div class="empty">loading Mac health</div></div>
          </div>
        </section>

        <section class="panel">
          <div class="panelHead"><h2>Prior Body</h2><span id="priorLoopCount" class="sub">--</span></div>
          <div class="panelBody">
            <div class="split">
              <div class="field"><span>Open Questions</span><strong id="openQuestionCount">--</strong></div>
              <div class="field"><span>Dissent</span><strong id="metricDissent">--</strong></div>
            </div>
            <div style="height:12px"></div>
            <div id="questionList" class="list"><div class="empty">loading questions</div></div>
          </div>
        </section>

        <section id="families" class="panel">
          <div class="panelHead"><h2>Family Readiness</h2><span id="familySummary" class="sub">--</span></div>
          <div class="panelBody"><div id="familyGrid" class="familyGrid"><div class="empty">loading families</div></div></div>
        </section>

        <section class="panel">
          <div class="panelHead"><h2>Read Markers</h2><span id="readMarkerCount" class="sub">--</span></div>
          <div class="panelBody"><div id="readList" class="list"><div class="empty">loading reads</div></div></div>
        </section>

        <section id="fleet" class="panel">
          <div class="panelHead"><h2>Fleet Proof</h2><span id="fleetSummary" class="sub">--</span></div>
          <div class="panelBody"><div id="fleetBody" class="list"><div class="empty">loading fleet proof</div></div></div>
        </section>

        <section class="panel">
          <div class="panelHead"><h2>Recent Events</h2><span id="eventSummary" class="sub">--</span></div>
          <div class="panelBody"><div id="eventList" class="list"><div class="empty">loading events</div></div></div>
        </section>
      </div>
    </section>
  </main>
</div>
<script>
(() => {
  "use strict";
  const endpoints = {
    perichoresis: "/api/chuck-v3/perichoresis",
    doctor: "/api/chuck-v2/doctor/status",
    registry: "/api/chuck-v2/family-registry",
    fleet: "/api/chuck-v2/latest-fleet-run",
    events: "/api/recent-events",
    macHealth: "/api/mac-health",
    macSelfHealStatus: "/api/mac-self-heal/status",
    macSelfHealPlan: "/api/mac-self-heal/plan",
    macSelfHealApply: "/api/mac-self-heal/apply",
    macSelfHealPurgeLocalArchive: "/api/mac-self-heal/purge-local-archive",
    proposalDraft: "/api/chuck-v3/proposal-docket-draft",
    drafts: "/api/chuck-v3/docket-drafts",
    draftPreview: "/api/chuck-v3/docket-draft-preview",
    draftPromote: "/api/chuck-v3/docket-draft-promote",
    executorQueue: "/api/chuck-v3/executor-queue",
    executorInspect: "/api/chuck-v3/executor-inspect",
    executorControl: "/api/chuck-v3/executor-control",
    docketTaskAction: "/api/chuck-v3/docket-task-action",
    authorityGates: "/api/chuck-v3/authority-gates",
    authorityGateAction: "/api/chuck-v3/authority-gate-action",
    selfImprovementLab: "/api/chuck-v3/self-improvement-lab",
    selfImprovementProposal: "/api/chuck-v3/self-improvement-proposal",
    selfImprovementAction: "/api/chuck-v3/self-improvement-action",
    compaction: "/api/chuck-v3/compaction",
    compactionPreview: "/api/chuck-v3/compaction-preview",
    compactionApprove: "/api/chuck-v3/compaction-approve",
    doctorCommand: "/api/chuck-v2/doctor",
    atlasCommand: "/api/chuck-v2/surface-atlas",
    docketCommand: "/api/chuck-v2/docket",
    capabilityCommand: "/api/chuck-v2/capability-ledger",
  };
  const state = { loading: false, errors: [], live: {} };
  const clientExecutorGlobalRunningCap = ${EXECUTOR_GLOBAL_RUNNING_CAP};
  const clientExecutorStaleRunningMs = ${STALE_RUNNING_MS};
  const clientExecutorLanePolicy = ${JSON.stringify(Object.fromEntries(EXECUTOR_LANE_POLICY.entries()))};
  const clientExecutorTimeoutPolicy = ${JSON.stringify(Object.fromEntries(EXECUTOR_LANE_TIMEOUT_POLICY.entries()))};
  const clientExecutorCommandLanes = ${JSON.stringify(Object.fromEntries(EXECUTOR_COMMAND_LANES.entries()))};
  const $ = (id) => document.getElementById(id);

  function executorCommandLane(commandKind) {
    return clientExecutorCommandLanes[String(commandKind || "")] || null;
  }

  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = value == null || value === "" ? "--" : String(value);
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function shortId(value) {
    const text = String(value || "");
    if (!text) return "--";
    if (text.startsWith("sha256:")) return text.slice(7, 19);
    return text.length > 28 ? text.slice(0, 18) + "..." + text.slice(-6) : text;
  }

  function age(value) {
    const ts = Date.parse(value || "");
    if (!Number.isFinite(ts)) return "--";
    const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (seconds < 60) return seconds + "s";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m";
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + "h";
    return Math.floor(hours / 24) + "d";
  }

  function duration(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return "--";
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return minutes + "m";
    const hours = Math.round((minutes / 60) * 10) / 10;
    return hours + "h";
  }

  function pct(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) + "%" : "--";
  }

  function gib(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round((n / (1024 ** 3)) * 10) / 10 + " GiB" : "--";
  }

  function elapsedMs(value) {
    const ts = Date.parse(value || "");
    return Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
  }

  function isFresh(value, maxAgeMs) {
    const elapsed = elapsedMs(value);
    return elapsed !== null && elapsed <= maxAgeMs;
  }

  function clampScore(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function statusClass(value) {
    const text = String(value || "").toLowerCase();
    if (["running", "ready", "ok", "completed", "accepted", "passed", "true"].includes(text)) return "ok";
    if (["failed", "blocked", "error", "timeout", "false"].includes(text)) return "err";
    return "warn";
  }

  function signalTone(state) {
    if (state === "ok") return "rgba(110,193,140,0.45)";
    if (state === "err") return "rgba(224,113,103,0.45)";
    return "rgba(217,180,92,0.5)";
  }

  function setBadge(node, label, value) {
    if (!node) return;
    const cls = statusClass(value);
    node.className = "status " + cls;
    clear(node);
    node.appendChild(make("i", "dot"));
    node.appendChild(make("span", null, label));
  }

  function list(id, items, emptyText, render) {
    const node = $(id);
    if (!node) return;
    clear(node);
    const values = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!values.length) {
      node.appendChild(make("div", "empty", emptyText));
      return;
    }
    values.forEach((item) => node.appendChild(render(item)));
  }

  function row(title, meta, body, tone) {
    const item = make("div", "row");
    if (tone) item.style.borderColor = tone;
    const top = make("div", "rowTitle");
    top.appendChild(make("strong", null, title || "--"));
    top.appendChild(make("code", null, meta || ""));
    item.appendChild(top);
    if (body) item.appendChild(make("p", null, body));
    return item;
  }

  async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(response.status + " " + response.statusText);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function postJson(url, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message = data && data.error ? data.error : response.status + " " + response.statusText;
        throw new Error(message);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function showOperator(status, value) {
    setText("operatorStatus", status);
    const node = $("operatorResult");
    if (!node) return;
    if (typeof value === "string") {
      node.textContent = value;
    } else {
      node.textContent = JSON.stringify(value, null, 2);
    }
  }

  function compactCommandResult(kind, data) {
    if (kind === "doctor") {
      const parsed = data && data.parsed ? data.parsed : data;
      return {
        ok: data.ok,
        configuredVoices: parsed.configuredVoices,
        readyFamilies: parsed.readyFamilies,
        blockedFamilies: parsed.blockedFamilies,
        nextActions: parsed.nextActions,
      };
    }
    if (kind === "atlas") {
      return {
        available: data.available,
        totalSurfaces: data.totalSurfaces,
        configuredSurfaces: data.configuredSurfaces,
        controls: data.controls,
        shortcuts: data.shortcuts,
        abilities: data.abilities,
        returnRequired: data.returnRequired,
        refreshedAt: data.refreshedAt,
      };
    }
    if (kind === "capability") {
      return {
        available: data.available,
        summary: data.summary,
        refreshedAt: data.refreshedAt,
      };
    }
    return data;
  }

  function renderPerichoresis(data) {
    state.live.perichoresis = data;
    const prior = data && data.prior ? data.prior : {};
    const ledger = data && data.ledger ? data.ledger : {};
    const executor = data && data.executor ? data.executor : {};
    const doctrine = prior.doctrine || {};
    const claim = doctrine.claim || "No universal prior is available yet.";
    setText("priorClaim", claim);
    setText("priorFocus", prior.focus || "No current focus line is present.");
    setText("priorId", "prior: " + shortId(prior.priorId));
    setText("priorAge", "age: " + age(prior.createdAt || data.generatedAt));
    setText("priorSource", "source: " + shortId(prior.sourceHash));
    setText("metricExecutor", executor.state || "unknown");
    setText("metricDeltas", ledger.posteriorDeltaCount ?? prior.recentDeltaCount ?? 0);
    setText("metricReads", ledger.readMarkerCount ?? prior.recentReadMarkerCount ?? 0);
    setText("metricDissent", ledger.dissentCount ?? 0);
    setText("proposalCount", (data.proposals || []).length + " live");
    setText("deltaCount", (data.posteriorDeltas || []).length + " shown");
    setText("docketCount", (data.recentDocket || []).length + " recent");
    setText("readMarkerCount", (data.readMarkers || []).length + " shown");
    setText("openQuestionCount", (prior.openQuestions || []).length);
    setText("priorLoopCount", Array.isArray(doctrine.loop) ? doctrine.loop.length + " loop steps" : "--");
    setBadge($("executorBadge"), "executor " + (executor.state || "unknown"), executor.state);

    list("proposalList", data.proposals || [], "no proposal deltas", (proposal) => {
      const title = proposal.title || proposal.proposalId;
      const meta = [proposal.family, proposal.status, age(proposal.createdAt)].filter(Boolean).join(" / ");
      const body = [proposal.surface, proposal.confidence, proposal.authorityImpact].filter(Boolean).join(" / ");
      const item = row(title, meta, body, statusClass(proposal.status) === "err" ? "rgba(224,113,103,0.5)" : "");
      const actions = make("div", "rowActions");
      const draft = make("button", null, "Draft task");
      draft.type = "button";
      draft.dataset.action = "draft-proposal";
      draft.dataset.proposalId = proposal.proposalId;
      actions.appendChild(draft);
      item.appendChild(actions);
      return item;
    });

    list("deltaList", data.posteriorDeltas || [], "no posterior deltas", (delta) => {
      const preview = Array.isArray(delta.claimsPreview) && delta.claimsPreview[0] ? delta.claimsPreview[0].text : "";
      const meta = [delta.family, delta.confidence, age(delta.createdAt)].filter(Boolean).join(" / ");
      const body = preview || [delta.claimCount + " claims", delta.evidenceCount + " evidence", delta.openQuestionCount + " questions"].join(" / ");
      return row(delta.surface || delta.deltaId, meta, body);
    });

    list("docketList", data.activeTasks && data.activeTasks.length ? data.activeTasks : (data.recentDocket || []).slice(0, 5), "no active docket items", (task) => {
      const meta = [task.status, task.risk, task.commandKind].filter(Boolean).join(" / ");
      const body = [task.surface, task.durationMs ? Math.round(task.durationMs / 1000) + "s" : "", task.lastHeartbeat && task.lastHeartbeat.phase].filter(Boolean).join(" / ");
      return row(task.title || task.taskId, meta, body);
    });

    list("questionList", prior.openQuestions || [], "no open questions", (question) => row(question, "prior", ""));

    list("readList", data.readMarkers || [], "no read markers", (marker) => {
      const meta = [marker.family, marker.result, age(marker.seenAt)].filter(Boolean).join(" / ");
      const body = marker.notes || [marker.surface, marker.scope].filter(Boolean).join(" / ");
      return row(marker.markerId, meta, body);
    });

    setText("railMeta", "prior " + shortId(prior.priorId) + " / " + age(data.generatedAt || prior.createdAt) + " old");
    renderTenTen();
  }

  function renderDoctor(data) {
    state.live.doctor = data;
    const ready = Array.isArray(data.readyFamilies) ? data.readyFamilies.length : 0;
    const exec = Array.isArray(data.executionReadyFamilies) ? data.executionReadyFamilies.length : 0;
    const configured = data.configuredVoices ?? "--";
    setText("metricFamilies", exec + "/" + ready);
    setText("familySummary", exec + " execution-ready / " + configured + " voices");
  }

  function renderRegistry(data) {
    state.live.registry = data;
    const families = Array.isArray(data.byFamily) ? data.byFamily : [];
    setText("familySummary", (data.executionReadyFamilies || []).length + " ready / " + (data.familyMemberCount ?? families.length) + " members");
    list("familyGrid", families, "no family registry", (item) => {
      const pct = item.total ? Math.max(6, Math.round((item.configured || 0) / item.total * 100)) : 0;
      const box = make("div", "family");
      box.appendChild(make("strong", null, item.family || "unknown"));
      box.appendChild(make("div", "small", (item.configured || 0) + " configured / " + (item.total || 0) + " total"));
      const bar = make("div", "bars");
      const fill = document.createElement("i");
      fill.style.width = pct + "%";
      if ((item.configured || 0) < (item.total || 0)) fill.style.background = "var(--yellow)";
      bar.appendChild(fill);
      box.appendChild(bar);
      return box;
    });
    renderTenTen();
  }

  function renderFleet(data) {
    state.live.fleet = data;
    if (!data || data.available === false) {
      setText("fleetSummary", "no run");
      list("fleetBody", [], "no fleet proof yet", () => document.createElement("div"));
      renderTenTen();
      return;
    }
    const summary = [data.completedCount + "/" + data.totalTasks, data.independentEligibleFamilyCount + " families", age(data.updatedAt)].filter(Boolean).join(" / ");
    setText("fleetSummary", summary);
    const rows = [];
    rows.push({
      title: data.runId || data.dispatchId || "latest run",
      meta: summary,
      body: (data.receiptCount ?? 0) + " receipts / " + (data.failedCount ?? 0) + " failed / " + (data.recoveredCount ?? 0) + " recovered",
    });
    (data.misses || []).slice(0, 3).forEach((miss) => rows.push({
      title: miss.surface || miss.family,
      meta: [miss.status, miss.family].filter(Boolean).join(" / "),
      body: miss.reason || "",
      tone: "rgba(224,113,103,0.5)",
    }));
    list("fleetBody", rows, "no fleet proof yet", (item) => row(item.title, item.meta, item.body, item.tone));
    renderTenTen();
  }

  function renderMacHealth(data) {
    state.live.macHealth = data;
    if (!data || data.available === false) {
      setText("macSummary", data?.reason || "unavailable");
      setText("macCloud", "--");
      list("macSignals", [], data?.reason || "Mac health unavailable", () => document.createElement("div"));
      return;
    }
    const load = data.load || {};
    const memory = data.memory || {};
    const disk = data.disk || {};
    const battery = data.battery || {};
    const gate = data.executionGate || {};
    setText("macSummary", (data.state || "unknown") + " / " + age(data.generatedAt));
    setText("macLoad", Number.isFinite(load.one) ? load.one.toFixed(2) + " / " + load.cpuCount : "--");
    setText("macMemory", pct(memory.freePercent) + " free");
    setText("macDisk", disk.available ? pct(disk.freePercent) + " free" : "unknown");
    setText("macPower", battery.available ? [battery.percent != null ? battery.percent + "%" : null, battery.source].filter(Boolean).join(" / ") : "unknown");
    setText("macGate", gate.state || "--");
    list("macSignals", data.signals || [], "no Mac health signals", (signal) => {
      const meta = [signal.severity, signal.category].filter(Boolean).join(" / ");
      const body = signal.category === "mac.memory"
        ? signal.summary + " / " + gib(memory.freeBytes) + " free"
        : signal.category === "mac.disk" && disk.available
          ? signal.summary + " / " + gib(disk.freeBytes) + " free"
          : signal.category === "mac.swap" && data.swap && data.swap.available
            ? signal.summary + " / " + gib(data.swap.freeBytes) + " swap free"
          : signal.summary;
      return row(signal.category, meta, body, signalTone(signal.severity === "error" ? "err" : signal.severity === "warn" ? "warn" : "ok"));
    });
  }

  function renderMacSelfHealStatus(data) {
    state.live.macSelfHealStatus = data;
    const cloud = data && data.cloud;
    if (!cloud) {
      setText("macCloud", "unknown");
      return;
    }
    const drive = cloud.googleDriveDesktop || {};
    if (cloud.available && cloud.preferred) {
      const matched = cloud.preferred.accountHintMatched ? "matched" : "reachable";
      setText("macCloud", "Drive " + matched);
      return;
    }
    if (drive.installed && !drive.mounted) {
      setText("macCloud", "Drive not mounted");
      return;
    }
    if (!drive.installed) {
      setText("macCloud", "Drive not installed");
      return;
    }
    setText("macCloud", "Drive blocked");
  }

  async function planMacSelfHeal(button) {
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Planning...";
    }
    showOperator("planning Mac self-heal", { writes: false });
    try {
      const result = await postJson(endpoints.macSelfHealPlan, {}, 120000);
      showOperator("Mac self-heal plan ready", {
        actionCount: result.actionCount,
        reclaimable: gib(result.reclaimableBytes),
        blockedCount: result.blockedCount,
        blockedBytes: gib(result.blockedBytes),
        cloud: result.cloud && result.cloud.recommendation,
      });
    } catch (error) {
      showOperator("Mac self-heal plan failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Plan heal";
      }
    }
  }

  async function runMacSelfHeal(button) {
    const warning = [
      "Run safe Mac self-heal?",
      "",
      "Chuck will only apply allowlisted, regenerable cleanup or verified cloud offload. Active browser profiles, repo files, state, and review-only browser support data stay untouched.",
      "",
      "A receipt will be written under ~/.openclaw/workspace/state/chuck-v3/mac-self-heal."
    ].join("\\n");
    if (!window.confirm(warning)) {
      showOperator("Mac self-heal cancelled", { writes: false });
      return;
    }
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Healing...";
    }
    showOperator("running Mac self-heal", { maxActions: 24 });
    try {
      const result = await postJson(endpoints.macSelfHealApply, {
        confirm: "RUN_MAC_SELF_HEAL",
        maxActions: 24,
      }, 10 * 60 * 1000);
      showOperator("Mac self-heal applied", {
        receiptId: result.receiptId,
        appliedCount: result.appliedCount,
        failedCount: result.failedCount,
        reclaimed: gib(result.appliedBytes),
        path: result.path,
      });
      await refresh();
    } catch (error) {
      showOperator("Mac self-heal failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Run safe heal";
      }
    }
  }

  async function runMacCloudOffload(button) {
    const warning = [
      "Run approved cloud evidence offload?",
      "",
      "This copies eligible old OpenClaw evidence files to the configured Google Drive archive, verifies copied size, then moves the local originals into the self-heal receipt archive.",
      "",
      "Destination: Google Drive / My Drive / OpenClaw Archives / mac-self-heal",
      "",
      "This transmits local evidence files to Google Drive."
    ].join("\\n");
    if (!window.confirm(warning)) {
      showOperator("Mac cloud offload cancelled", { writes: false });
      return;
    }
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Offloading...";
    }
    showOperator("running Mac cloud offload", { maxActions: 60, allowCloudOffload: true });
    try {
      const result = await postJson(endpoints.macSelfHealApply, {
        confirm: "RUN_MAC_SELF_HEAL",
        maxActions: 60,
        allowCloudOffload: true,
      }, 20 * 60 * 1000);
      showOperator("Mac cloud offload applied", {
        receiptId: result.receiptId,
        appliedCount: result.appliedCount,
        failedCount: result.failedCount,
        reclaimed: gib(result.appliedBytes),
        path: result.path,
      });
      await refresh();
    } catch (error) {
      showOperator("Mac cloud offload failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Run cloud offload";
      }
    }
  }

  async function purgeMacLocalArchive(button) {
    const warning = [
      "Purge verified local archive copy?",
      "",
      "Chuck will delete only the duplicate local self-heal archive copy after verifying the Google Drive copies still exist.",
      "",
      "The JSON receipt and Google Drive archive remain."
    ].join("\\n");
    if (!window.confirm(warning)) {
      showOperator("Local archive purge cancelled", { writes: false });
      return;
    }
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Purging...";
    }
    showOperator("purging verified local archive copy", { confirm: "PURGE_VERIFIED_LOCAL_ARCHIVE" });
    try {
      const result = await postJson(endpoints.macSelfHealPurgeLocalArchive, {
        confirm: "PURGE_VERIFIED_LOCAL_ARCHIVE",
      }, 120000);
      showOperator(result.ok ? "Local archive purge complete" : "Local archive purge unavailable", {
        receiptId: result.sourceReceiptId,
        deleted: gib(result.deletedBytesApprox),
        count: result.deletedAppliedFileCount,
        path: result.purgeReceiptPath,
        reason: result.reason,
      });
      await refresh();
    } catch (error) {
      showOperator("Local archive purge failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Purge local copy";
      }
    }
  }

  function renderEvents(data) {
    const events = Array.isArray(data.recent) ? data.recent.slice(0, 6) : [];
    setText("eventSummary", (data.total24h ?? events.length) + " in 24h");
    list("eventList", events, "no recent events", (event) => {
      const signal = event.payload && event.payload.signal ? event.payload.signal : null;
      const meta = [signal && signal.severity, signal && signal.category, event.source, age(event.ts)].filter(Boolean).join(" / ");
      const argv = event.payload && Array.isArray(event.payload.argv) ? event.payload.argv.join(" ") : "";
      const body = signal && signal.summary
        ? [signal.summary, signal.actionability, signal.needsAttention ? "needs attention" : ""].filter(Boolean).join(" / ")
        : argv;
      const tone = signal && signal.severity === "error"
        ? "rgba(224,113,103,0.5)"
        : signal && signal.severity === "warn"
          ? "rgba(217,180,92,0.5)"
          : "";
      return row(event.type || event.id, meta, body, tone);
    });
  }

  function renderDrafts(data) {
    const drafts = Array.isArray(data.drafts) ? data.drafts : [];
    setText("draftCount", (data.draftCount ?? drafts.length) + " drafts / " + (data.promotablePreviewCount ?? 0) + " previewable");
    list("draftList", drafts, "no draft tasks", (draft) => {
      const meta = [draft.status, draft.risk, draft.commandKind, age(draft.updatedAt)].filter(Boolean).join(" / ");
      const source = draft.source && draft.source.proposalId ? draft.source.proposalId : draft.surface;
      const body = [source, draft.intentPreview].filter(Boolean).join(" / ");
      const item = row(draft.title || draft.taskId, meta, body, draft.promotablePreview ? "" : "rgba(217,180,92,0.5)");
      const actions = make("div", "rowActions");
      const preview = make("button", null, "Preview queue");
      preview.type = "button";
      preview.dataset.action = "preview-draft";
      preview.dataset.taskId = draft.taskId;
      actions.appendChild(preview);
      const promote = make("button", null, "Promote");
      promote.type = "button";
      promote.dataset.action = "promote-draft";
      promote.dataset.taskId = draft.taskId;
      if (!draft.promotablePreview) promote.disabled = true;
      actions.appendChild(promote);
      item.appendChild(actions);
      return item;
    });
  }

  function renderExecutorControl(control) {
    const mode = control && control.paused ? "paused" : "active";
    const reason = control && control.reason ? control.reason : (mode === "paused" ? "intake is paused" : "intake is active");
    setText("executorControlMode", "Executor intake " + mode);
    setText("executorControlReason", reason + (control && control.updatedAt ? " / " + age(control.updatedAt) : ""));
    const pause = $("pauseExecutor");
    const resume = $("resumeExecutor");
    if (pause) pause.disabled = mode === "paused";
    if (resume) resume.disabled = mode !== "paused";
  }

  function renderExecutorQueue(data) {
    state.live.executorQueue = data;
    const counts = data && data.counts ? data.counts : {};
    const executor = data && data.executor ? data.executor : {};
    const control = data && data.control ? data.control : null;
    renderExecutorControl(control);
    const prefix = control && control.paused ? "paused / " : "";
    setText("queueSummary", prefix + (counts.eligiblePending ?? 0) + " eligible / " + (counts.pending ?? 0) + " pending / " + (counts.running ?? 0) + " running");
    const rows = [];
    if (data.nextEligible) {
      rows.push({ ...data.nextEligible, queueLane: "next eligible" });
    }
    (data.running || []).forEach((task) => rows.push({ ...task, queueLane: "running" }));
    (data.pending || []).filter((task) => !data.nextEligible || task.taskId !== data.nextEligible.taskId).slice(0, 5).forEach((task) => rows.push({ ...task, queueLane: "pending" }));
    (data.drafts || []).slice(0, 3).forEach((task) => rows.push({ ...task, queueLane: "draft" }));
    if (!rows.length && Array.isArray(data.recentFinished)) {
      data.recentFinished.slice(0, 4).forEach((task) => rows.push({ ...task, queueLane: "recent" }));
    }
    list("queueList", rows, "executor sees no pending or running tasks", (task) => {
      const meta = [task.queueLane, task.lane, task.status, task.risk, task.commandKind, age(task.updatedAt)].filter(Boolean).join(" / ");
      const blockers = Array.isArray(task.eligibilityBlockers) && task.eligibilityBlockers.length
        ? "blockers: " + task.eligibilityBlockers.join(", ")
        : task.executorEligible
          ? "executor eligible"
          : "";
      const heartbeat = [task.heartbeatPhase, task.heartbeatAt ? age(task.heartbeatAt) + " heartbeat" : ""].filter(Boolean).join(" / ");
      const timeout = task.timeoutPolicy
        ? "timeout " + duration(task.timeoutPolicy.timeoutMs) + " / " + task.timeoutPolicy.source + (task.timeoutPolicy.capped ? " / capped" : "")
        : "";
      const body = [blockers, heartbeat, timeout, task.intentPreview].filter(Boolean).join(" / ");
      const tone = task.executorEligible ? "rgba(110,193,140,0.45)" : task.status === "running" ? "rgba(117,167,216,0.5)" : "";
      const node = row(task.title || task.taskId, meta, body || executor.state || "", tone);
      const hints = task.actionHints || {};
      const actions = make("div", "rowActions");
      const inspect = make("button", null, "Inspect");
      inspect.type = "button";
      inspect.dataset.action = "inspect-task";
      inspect.dataset.taskId = task.taskId;
      actions.appendChild(inspect);
      if (hints.canCancel) {
        const cancel = make("button", null, "Cancel");
        cancel.type = "button";
        cancel.dataset.action = "cancel-task";
        cancel.dataset.taskId = task.taskId;
        actions.appendChild(cancel);
      }
      if (hints.canRetry) {
        const retry = make("button", null, "Retry");
        retry.type = "button";
        retry.dataset.action = "retry-task";
        retry.dataset.taskId = task.taskId;
        actions.appendChild(retry);
      }
      if (hints.canMarkStaleFailed) {
        const markFailed = make("button", null, "Mark failed");
        markFailed.type = "button";
        markFailed.dataset.action = "mark-stale-failed";
        markFailed.dataset.taskId = task.taskId;
        actions.appendChild(markFailed);
      }
      node.appendChild(actions);
      return node;
    });
    renderTenTen();
  }

  function renderAuthorityGates(data) {
    state.live.authorityGates = data;
    const counts = data && data.counts ? data.counts : {};
    const gates = Array.isArray(data && data.gates) ? data.gates : [];
    setText("authoritySummary", (counts.quarantined ?? 0) + " quarantined / " + (counts.blocked ?? 0) + " blocked / " + (counts.approved ?? 0) + " approved");
    setText("authorityQuarantined", String(counts.quarantined ?? 0));
    setText("authorityPolicyGated", String(counts["policy-gated"] ?? 0));
    list("authorityList", gates, "no authority gates", (gate) => {
      const meta = [gate.state, gate.riskClass, gate.authority, gate.surface].filter(Boolean).join(" / ");
      const body = [gate.operatorReason || gate.reason, gate.latestReceiptId ? "receipt " + shortId(gate.latestReceiptId) : ""].filter(Boolean).join(" / ");
      const tone = gate.state === "approved"
        ? "rgba(110,193,140,0.45)"
        : gate.state === "blocked"
          ? "rgba(224,113,103,0.5)"
          : gate.state === "quarantined"
            ? "rgba(217,180,92,0.5)"
            : "";
      const node = row(gate.label || gate.capabilityId, meta, body, tone);
      const hints = gate.actionHints || {};
      const actions = make("div", "rowActions");
      if (hints.canApprove) {
        const approve = make("button", null, "Approve");
        approve.type = "button";
        approve.dataset.action = "approve";
        approve.dataset.capabilityId = gate.capabilityId;
        actions.appendChild(approve);
      }
      if (hints.canQuarantine) {
        const quarantine = make("button", null, "Quarantine");
        quarantine.type = "button";
        quarantine.dataset.action = "quarantine";
        quarantine.dataset.capabilityId = gate.capabilityId;
        actions.appendChild(quarantine);
      }
      if (hints.canBlock) {
        const block = make("button", null, "Block");
        block.type = "button";
        block.dataset.action = "block";
        block.dataset.capabilityId = gate.capabilityId;
        actions.appendChild(block);
      }
      node.appendChild(actions);
      return node;
    });
    renderTenTen();
  }

  function renderSelfImprovementLab(data) {
    state.live.selfImprovementLab = data;
    const counts = data && data.counts ? data.counts : {};
    const readiness = data && data.readiness ? data.readiness : {};
    const proposals = Array.isArray(data && data.proposals) ? data.proposals : [];
    const draft = data && data.latestDraftProposal ? data.latestDraftProposal : null;
    const preview = data && data.draftPreview ? data.draftPreview : null;
    const readyLabel = readiness.state || "unknown";
    setText("selfLabSummary", readyLabel + " / " + (counts.approved ?? 0) + " approved / " + (counts.draft ?? 0) + " draft");
    setText("selfLabReadiness", readyLabel);
    setText("selfLabProposalCount", String(counts.total ?? proposals.length));
    const rows = [];
    if (draft) rows.push({ ...draft, lane: "draft" });
    proposals
      .filter((proposal) => !draft || proposal.proposalId !== draft.proposalId)
      .slice(0, 4)
      .forEach((proposal) => rows.push({ ...proposal, lane: "recent" }));
    if (!rows.length && preview) rows.push({ ...preview, lane: "preview" });
    list("selfLabList", rows, "no self-improvement proposals yet", (proposal) => {
      const meta = [proposal.lane, proposal.status, proposal.risk, proposal.authorityGateState].filter(Boolean).join(" / ");
      const blockers = Array.isArray(proposal.patchApplicationBlockers) && proposal.patchApplicationBlockers.length
        ? "blocked for patch: " + proposal.patchApplicationBlockers.join(", ")
        : "patch still requires separate approval";
      const targetSummary = (proposal.targetFiles || []).slice(0, 3).join(", ");
      const body = [proposal.objective, targetSummary, blockers].filter(Boolean).join(" / ");
      const tone = proposal.status === "approved"
        ? "rgba(110,193,140,0.45)"
        : proposal.status === "rejected"
          ? "rgba(224,113,103,0.5)"
          : proposal.status === "draft"
            ? "rgba(217,180,92,0.5)"
            : "";
      const node = row(proposal.title || proposal.proposalId, meta, body, tone);
      const actions = make("div", "rowActions");
      if (proposal.status === "draft") {
        const approve = make("button", null, "Approve");
        approve.type = "button";
        approve.dataset.action = "approve";
        approve.dataset.proposalId = proposal.proposalId;
        actions.appendChild(approve);
        const reject = make("button", null, "Reject");
        reject.type = "button";
        reject.dataset.action = "reject";
        reject.dataset.proposalId = proposal.proposalId;
        actions.appendChild(reject);
      }
      if (actions.childNodes.length) node.appendChild(actions);
      return node;
    });
    renderTenTen();
  }

  function renderCompaction(data) {
    state.live.compaction = data;
    const latest = data && data.latestDecision ? data.latestDecision : null;
    const draft = data && data.latestDraftDecision ? data.latestDraftDecision : null;
    const preview = data && data.draftPreview ? data.draftPreview : null;
    const unapplied = data ? (data.unappliedDeltaCount ?? 0) : 0;
    const stateLabel = latest ? latest.status : "no decision";
    setText("compactionSummary", unapplied + " unapplied / " + stateLabel);
    setText("compactionUnapplied", String(unapplied));
    setText("compactionApproval", draft ? "draft ready" : stateLabel);
    const approve = $("approveCompaction");
    if (approve) {
      approve.disabled = !draft || draft.status !== "draft";
      approve.dataset.decisionId = draft && draft.decisionId ? draft.decisionId : "";
    }
    const rows = [];
    if (draft) {
      rows.push({ ...draft, lane: "draft" });
    }
    if (latest && (!draft || latest.decisionId !== draft.decisionId)) {
      rows.push({ ...latest, lane: "latest" });
    }
    if (preview && (!draft || preview.decisionId !== draft.decisionId)) {
      rows.push({ ...preview, lane: "preview" });
    }
    list("compactionList", rows, "no compaction decision yet", (item) => {
      const meta = [item.lane, item.status, item.includedDeltaCount + " deltas", item.promotedClaimCount + " promoted"].filter(Boolean).join(" / ");
      const body = [
        item.deferredClaimCount + " deferred",
        item.openQuestionCount + " questions",
        item.resultingPriorId ? "prior " + shortId(item.resultingPriorId) : "",
      ].filter(Boolean).join(" / ");
      const tone = item.status === "applied"
        ? "rgba(110,193,140,0.45)"
        : item.status === "draft"
          ? "rgba(217,180,92,0.5)"
          : "";
      const node = row(item.decisionId || "compaction preview", meta, body, tone);
      const claims = Array.isArray(item.promotedClaimPreview) ? item.promotedClaimPreview.slice(0, 2) : [];
      claims.forEach((claim) => {
        const p = make("p", null, claim.text || claim.claimKey);
        node.appendChild(p);
      });
      return node;
    });
    renderTenTen();
  }

  function renderChuckAlive() {
    const live = state.live || {};
    const perichoresis = live.perichoresis || {};
    const prior = perichoresis.prior || {};
    const ledger = perichoresis.ledger || {};
    const queue = live.executorQueue || {};
    const queueCounts = queue.counts || {};
    const executor = queue.executor || perichoresis.executor || {};
    const control = queue.control || {};
    const doctor = live.doctor || {};
    const registry = live.registry || {};
    const compaction = live.compaction || {};
    const runningTasks = Array.isArray(queue.running) ? queue.running : [];
    const staleRunningMs = Number(queue.staleRunningMs || clientExecutorStaleRunningMs);
    const staleRunningCount = runningTasks.filter((task) => {
      const started = elapsedMs(task.startedAt);
      return started !== null && started > staleRunningMs;
    }).length;
    const pendingCount = Number(queueCounts.pending || 0);
    const runningCount = Number(queueCounts.running || 0);
    const eligibleCount = Number(queueCounts.eligiblePending || 0);
    const apiFresh = perichoresis.available !== false && isFresh(perichoresis.generatedAt, 60 * 1000);
    const hasPrior = Boolean(prior.priorId);
    const priorFresh = hasPrior && isFresh(prior.createdAt, 30 * 60 * 1000);
    const executorRunning = String(executor.state || "").toLowerCase() === "running";
    const doctorAvailable = doctor.available === true;
    const doctorAge = elapsedMs(doctor.generatedAt);
    const doctorFresh = doctorAvailable && doctorAge !== null && doctorAge <= 4 * 60 * 60 * 1000;
    const doctorVeryStale = doctorAvailable && doctorAge !== null && doctorAge > 12 * 60 * 60 * 1000;
    const executionReadyFamilies = Array.isArray(doctor.executionReadyFamilies)
      ? doctor.executionReadyFamilies.length
      : Array.isArray(registry.executionReadyFamilies)
        ? registry.executionReadyFamilies.length
        : 0;
    const dissentCount = Number(ledger.dissentCount || 0);
    const compactedClaimCount = Number(prior.compactedClaimCount || 0);
    const compactionApplied = prior.compactionCursor?.status === "applied" || Boolean(compaction.latestAppliedDecision);
    const signals = [
      {
        title: "API heartbeat",
        state: apiFresh ? "ok" : "err",
        critical: true,
        meta: apiFresh ? "fresh" : "missing or stale",
        body: "perichoresis endpoint updated " + age(perichoresis.generatedAt),
      },
      {
        title: "Universal prior",
        state: hasPrior ? (priorFresh ? "ok" : "warn") : "err",
        critical: true,
        meta: hasPrior ? shortId(prior.priorId) : "missing",
        body: hasPrior
          ? "latest prior is " + age(prior.createdAt) + " old with " + compactedClaimCount + " compacted claims"
          : "no prior id is available to the cockpit",
      },
      {
        title: "Executor service",
        state: executorRunning ? "ok" : "err",
        critical: true,
        meta: executor.state || "unknown",
        body: executor.pid ? "launchd pid " + executor.pid + " / runs " + (executor.runs ?? "--") : "executor service not proven running",
      },
      {
        title: "Queue lanes",
        state: staleRunningCount > 0 ? "err" : runningCount > (queue.globalRunningCap ?? clientExecutorGlobalRunningCap) ? "warn" : "ok",
        meta: pendingCount + " pending / " + runningCount + " running",
        body: staleRunningCount > 0
          ? staleRunningCount + " running task(s) exceed the recovery window"
          : "lane policy active: global cap " + (queue.globalRunningCap ?? clientExecutorGlobalRunningCap),
      },
      {
        title: "Model doctor",
        state: doctorFresh ? "ok" : doctorVeryStale || !doctorAvailable ? "err" : "warn",
        meta: doctorAvailable ? age(doctor.generatedAt) + " old" : "unavailable",
        body: doctorAvailable
          ? executionReadyFamilies + " execution-ready families reported"
          : (doctor.reason || "doctor data is not available"),
      },
      {
        title: "Dissent channel",
        state: dissentCount > 0 ? "ok" : "warn",
        meta: String(dissentCount),
        body: dissentCount > 0
          ? "dissent has at least one receipt"
          : "zero dissent is not mature proof; extraction still needs to show real negative signal",
      },
      {
        title: "Compaction memory",
        state: compactionApplied ? "ok" : "warn",
        meta: compactionApplied ? "applied" : "not applied",
        body: (ledger.posteriorDeltaCount ?? 0) + " deltas / " + (ledger.readMarkerCount ?? 0) + " read markers / " + (ledger.priorCount ?? 0) + " priors",
      },
    ];
    const criticalFailures = signals.filter((signal) => signal.critical && signal.state === "err").length;
    const errors = signals.filter((signal) => signal.state === "err").length;
    const warnings = signals.filter((signal) => signal.state === "warn").length;
    const stateLabel = criticalFailures > 0
      ? "blocked"
      : errors > 0 || warnings > 0
        ? "alive / degraded"
        : "alive / healthy";
    const reason = criticalFailures > 0
      ? "critical heartbeat, prior, or executor proof is missing"
      : errors > 0 || warnings > 0
        ? "receipts prove motion; safety and freshness need attention"
        : "heartbeat, prior, executor, queue, doctor, dissent, and compaction are all green";
    setText("aliveState", stateLabel);
    setText("aliveReason", reason);
    setText("alivePulse", apiFresh && priorFresh ? "fresh" : hasPrior ? "stale" : "missing");
    setText("alivePulseMeta", "api " + age(perichoresis.generatedAt) + " / prior " + age(prior.createdAt));
    setText("aliveQueue", pendingCount + " pending / " + runningCount + " running");
    setText("aliveQueueMeta", (control.paused ? "paused" : "active") + " / " + eligibleCount + " eligible / " + staleRunningCount + " stale");
    setText("aliveDoctor", doctorFresh ? "fresh" : doctorAvailable ? "stale" : "missing");
    setText("aliveDoctorMeta", doctorAvailable ? age(doctor.generatedAt) + " old / " + executionReadyFamilies + " execution-ready families" : (doctor.reason || "no doctor receipt"));
    setText("aliveSummary", stateLabel + " / " + (errors + warnings) + " warning(s)");
    list("aliveSignals", signals, "waiting for liveness receipts", (signal) =>
      row(signal.title, signal.meta, signal.body, signalTone(signal.state)),
    );
  }

  function renderTenTen() {
    renderChuckAlive();
    const live = state.live || {};
    const perichoresis = live.perichoresis || {};
    const prior = perichoresis.prior || {};
    const ledger = perichoresis.ledger || {};
    const registry = live.registry || {};
    const fleet = live.fleet || {};
    const queue = live.executorQueue || {};
    const compaction = live.compaction || {};
    const authorityGates = live.authorityGates || {};
    const selfLab = live.selfImprovementLab || {};
    const queueCounts = queue.counts || {};
    const authorityCounts = authorityGates.counts || {};
    const selfLabCounts = selfLab.counts || {};
    const control = queue.control || {};
    const latestDraft = compaction.latestDraftDecision || null;
    const latestApplied = compaction.latestAppliedDecision || null;
    const latestSelfLabDraft = selfLab.latestDraftProposal || null;
    const latestSelfLabApproved = selfLab.latestApprovedProposal || null;
    const doctor = live.doctor || {};
    const readFamilies = new Set((perichoresis.readMarkers || []).map((marker) => marker.family).filter(Boolean));
    const readyFamilies = Array.isArray(registry.executionReadyFamilies)
      ? registry.executionReadyFamilies.length
      : 0;
    const fleetFamilies = Number(fleet.independentEligibleFamilyCount || 0);
    const familySignal = Math.max(readyFamilies, fleetFamilies);
    const runningTasks = Array.isArray(queue.running) ? queue.running : [];
    const runningLaneCounts = new Map();
    runningTasks.forEach((task) => {
      const lane = task.lane || executorCommandLane(task.commandKind) || "unknown";
      runningLaneCounts.set(lane, (runningLaneCounts.get(lane) || 0) + 1);
    });
    const lanePolicy = queue.lanePolicy || clientExecutorLanePolicy;
    const laneOverCap = [...runningLaneCounts.entries()].some(([lane, count]) => count > (lanePolicy[lane]?.maxRunning ?? clientExecutorGlobalRunningCap));
    const staleRunningMs = Number(queue.staleRunningMs || clientExecutorStaleRunningMs);
    const staleRunningCount = runningTasks.filter((task) => {
      const started = elapsedMs(task.startedAt);
      return started !== null && started > staleRunningMs;
    }).length;
    const schedulerUnsafe = laneOverCap || staleRunningCount > 0 || (queueCounts.running ?? 0) > (queue.globalRunningCap ?? clientExecutorGlobalRunningCap);
    const doctorFresh = doctor.available === true && isFresh(doctor.generatedAt, 4 * 60 * 60 * 1000);
    const dissentPresent = (ledger.dissentCount ?? 0) > 0;
    const executorClean =
      (queueCounts.pending ?? 0) === 0 &&
      (queueCounts.running ?? 0) === 0 &&
      (queueCounts.eligiblePending ?? 0) === 0;
    const compactionReady = (compaction.unappliedDeltaCount ?? 0) === 0 || Boolean(latestDraft);
    const recoveryReady = queue.recoveryActionsAvailable === true;
    const authorityGateReady = authorityGates.available === true && (authorityCounts.total ?? 0) > 0;
    const authorityUnsafeOpen = (authorityCounts.quarantined ?? 0) === 0 && (authorityCounts.blocked ?? 0) === 0;
    const selfLabReady = selfLab.available === true;
    const selfLabGateApproved = selfLab.readiness && selfLab.readiness.authorityGate && selfLab.readiness.authorityGate.state === "approved";
    const selfLabHasProposal = Boolean(selfLab.latestProposal) || (selfLabCounts.total ?? 0) > 0;
    const coreScore = Math.min(
      7.4,
      3.8 +
        (prior.priorId ? 0.9 : 0) +
        ((prior.compactedClaimCount ?? 0) > 0 ? 0.8 : 0) +
        ((ledger.posteriorDeltaCount ?? 0) > 0 ? 0.5 : 0) +
        ((ledger.readMarkerCount ?? 0) > 0 ? 0.4 : 0) +
        (compaction.latestAppliedDecision ? 0.5 : 0) +
        (selfLabReady ? 0.2 : 0),
    );
    const autonomyScore = clampScore(
      2.4 +
        (!control.paused ? 0.5 : 0.25) +
        (executorClean ? 0.5 : 0) +
        (schedulerUnsafe ? -0.65 : 0.25) +
        ((queueCounts.recentFinished ?? 0) > 0 ? 0.4 : 0) +
        (recoveryReady ? 0.45 : 0) +
        (authorityGateReady ? 0.2 : 0) +
        (latestDraft ? 0.2 : 0) +
        (selfLabReady ? 0.25 : 0) +
        (selfLabHasProposal ? 0.35 : 0),
      1.8,
      6.4,
    );
    const perichoresisScore = clampScore(
      2.8 +
        (readFamilies.size >= 3 ? 0.9 : readFamilies.size * 0.25) +
        ((ledger.posteriorDeltaCount ?? 0) >= 3 ? 0.5 : 0) +
        (compactionReady ? 0.5 : 0) +
        (dissentPresent ? 0.3 : -0.25),
      1.8,
      6,
    );
    const frontDoorScore = Math.min(
      5.9,
      3.1 +
        (perichoresis.available !== false ? 0.4 : 0) +
        (queue.counts ? 0.35 : 0) +
        (compaction.available !== false ? 0.35 : 0) +
        (recoveryReady ? 0.2 : 0) +
        (authorityGateReady ? 0.2 : 0) +
        (latestDraft ? 0.2 : 0) +
        (selfLabReady ? 0.3 : 0) +
        (selfLabHasProposal ? 0.2 : 0),
    );
    const safetyScore = clampScore(
      4.6 +
        (executorClean ? 0.55 : 0) +
        (schedulerUnsafe ? -0.8 : 0.25) +
        (!control.paused ? 0.25 : 0.2) +
        (latestDraft && latestDraft.promotedClaimCount === 0 && latestDraft.deferredClaimCount > 0 ? 0.55 : 0) +
        (dissentPresent ? 0.25 : -0.25) +
        (doctorFresh ? 0.25 : -0.2) +
        (recoveryReady ? 0.45 : 0) +
        (authorityGateReady ? 0.5 : 0) +
        (!authorityUnsafeOpen ? 0.15 : 0) +
        (compaction.latestAppliedDecision ? 0.35 : 0) +
        (selfLabGateApproved ? 0.3 : 0),
      2.5,
      8.2,
    );
    const selfImprovementScore = Math.min(
      5.8,
      2.1 +
        (selfLabReady ? 0.65 : 0) +
        (selfLabGateApproved ? 0.75 : 0) +
        (executorClean ? 0.25 : 0) +
        (selfLabHasProposal ? 0.65 : 0) +
        (latestSelfLabDraft ? 0.35 : 0) +
        (latestSelfLabApproved ? 0.55 : 0),
    );
    const compactionBody = latestDraft
      ? "draft gate ready: " + latestDraft.promotedClaimCount + " promoted / " + latestDraft.deferredClaimCount + " deferred"
      : (compaction.unappliedDeltaCount ?? 0) === 0 && latestApplied
        ? "compaction current"
        : "compaction gate waiting";
    const items = [
      {
        title: "Core architecture",
        score: coreScore,
        meta: prior.priorId ? "universal prior online" : "prior missing",
        body: (prior.compactedClaimCount ?? 0) + " compacted claims / " + (ledger.posteriorDeltaCount ?? 0) + " deltas / " + (ledger.readMarkerCount ?? 0) + " reads",
      },
      {
        title: "Autonomy",
        score: autonomyScore,
        meta: control.paused ? "executor paused" : "executor active",
        body: (queueCounts.eligiblePending ?? 0) + " eligible / " + (queueCounts.pending ?? 0) + " pending / " + (queueCounts.running ?? 0) + " running; recovery + authority gates visible",
      },
      {
        title: "Perichoresis / shared family mind",
        score: perichoresisScore,
        meta: readFamilies.size + " families in latest read loop",
        body: compactionBody + " / dissent " + (ledger.dissentCount ?? 0),
      },
      {
        title: "OpenClaw as front door",
        score: frontDoorScore,
        meta: "cockpit is live",
        body: "dashboard covers prior, queue, compaction, authority gates, deltas, reads; phone/desktop sovereign app still not complete",
      },
      {
        title: "Safety / governance",
        score: safetyScore,
        meta: executorClean ? "queue clean" : "queue has work",
        body: (authorityCounts.quarantined ?? 0) + " quarantined / " + (authorityCounts["policy-gated"] ?? 0) + " policy-gated / " + (authorityCounts.blocked ?? 0) + " blocked; approval tokens + receipts online",
      },
      {
        title: "Self-improvement loop",
        score: selfImprovementScore,
        meta: selfLabReady ? (selfLab.readiness?.state || "lab online") : "lab missing",
        body: (selfLabCounts.total ?? 0) + " proposals / " + (selfLabCounts.approved ?? 0) + " approved; authority gate " + (selfLab.readiness?.authorityGate?.state || "unknown"),
      },
    ];
    const weighted = items.reduce((sum, item) => sum + item.score, 0) / items.length;
    const score = Math.round(weighted * 10) / 10;
    const nextGate = latestDraft
      ? "approve/reject draft"
      : schedulerUnsafe
        ? "restore scheduler safety"
      : !executorClean
        ? "clear executor queue"
        : !authorityGateReady
          ? "load authority gates"
          : !selfLabReady
            ? "load self-improvement lab"
            : latestSelfLabDraft
              ? "approve/reject self-build proposal"
              : !selfLabHasProposal
                ? "draft self-build proposal"
                : familySignal < 3
                  ? "restore family readiness"
                  : "next doctrine sprint";
    const band = score >= 9.5 ? "10/10-ready" : score >= 7 ? "strong / climbing" : score >= 5 ? "mid-build" : "early";
    const confidence = schedulerUnsafe || !doctorFresh || !dissentPresent ? "heuristic / degraded" : "receipt-backed";
    setText("tenTenScore", score.toFixed(1) + "/10");
    setText("tenTenGate", nextGate);
    setText("tenTenSummary", band + " / " + confidence + " / " + nextGate);
    list("tenTenList", items, "waiting for live 10/10 receipts", (item) => {
      const value = item.score.toFixed(1) + "/10";
      const tone = item.score >= 0.9
        ? "rgba(110,193,140,0.45)"
        : item.score >= 0.7
          ? "rgba(217,180,92,0.5)"
          : "rgba(224,113,103,0.45)";
      const scoreTone = item.score >= 7
        ? "rgba(110,193,140,0.45)"
        : item.score >= 5
          ? "rgba(217,180,92,0.5)"
          : "rgba(224,113,103,0.45)";
      return row(item.title, value + " / " + item.meta, item.body, scoreTone || tone);
    });
  }

  function showErrors(errors) {
    const node = $("errorLine");
    if (!node) return;
    if (!errors.length) {
      node.textContent = "";
      node.className = "small";
      return;
    }
    node.className = "errorLine";
    node.textContent = errors.join(" / ");
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    state.errors = [];
    const button = $("refresh");
    if (button) button.disabled = true;
    setText("clock", "refreshing " + new Date().toLocaleTimeString());
    const jobs = [
      ["perichoresis", endpoints.perichoresis, 5000, renderPerichoresis],
      ["doctor", endpoints.doctor, 5000, renderDoctor],
      ["registry", endpoints.registry, 5000, renderRegistry],
      ["fleet", endpoints.fleet, 5000, renderFleet],
      ["macHealth", endpoints.macHealth, 5000, renderMacHealth],
      ["macSelfHealStatus", endpoints.macSelfHealStatus, 5000, renderMacSelfHealStatus],
      ["events", endpoints.events, 5000, renderEvents],
      ["drafts", endpoints.drafts, 5000, renderDrafts],
      ["executorQueue", endpoints.executorQueue, 5000, renderExecutorQueue],
      ["authorityGates", endpoints.authorityGates, 5000, renderAuthorityGates],
      ["selfImprovementLab", endpoints.selfImprovementLab, 5000, renderSelfImprovementLab],
      ["compaction", endpoints.compaction, 12000, renderCompaction],
    ];
    const results = await Promise.allSettled(jobs.map((job) => fetchJson(job[1], job[2]).then((data) => job[3](data))));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        state.errors.push(jobs[index][0] + ": " + (result.reason && result.reason.message ? result.reason.message : result.reason));
      }
    });
    showErrors(state.errors);
    setText("clock", "updated " + new Date().toLocaleTimeString());
    if (button) button.disabled = false;
    state.loading = false;
  }

  async function draftProposal(proposalId, button) {
    if (!proposalId) return;
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Drafting...";
    }
    showOperator("drafting proposal", { proposalId });
    try {
      const result = await postJson(endpoints.proposalDraft, { proposalId }, 8000);
      showOperator("draft created", {
        taskId: result.task && result.task.id,
        status: result.task && result.task.status,
        path: result.path,
        reused: result.reused === true,
        executorNote: "Draft status is not executor-eligible.",
      });
      await refresh();
    } catch (error) {
      showOperator("draft failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Draft task";
      }
    }
  }

  async function previewDraft(taskId, button) {
    if (!taskId) return;
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Previewing...";
    }
    showOperator("previewing draft", { taskId });
    try {
      const result = await postJson(endpoints.draftPreview, { taskId }, 8000);
      showOperator("queue preview", {
        taskId: result.draft && result.draft.taskId,
        from: result.draft && result.draft.status,
        previewStatus: result.pendingPreview && result.pendingPreview.status,
        commandKind: result.draft && result.draft.commandKind,
        promotablePreview: result.draft && result.draft.promotablePreview,
        promotionBlockers: result.draft && result.draft.promotionBlockers,
        executorTriggered: result.executorTriggered,
        executorNote: result.executorNote,
      });
    } catch (error) {
      showOperator("preview failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Preview queue";
      }
    }
  }

  async function promoteDraft(taskId, button) {
    if (!taskId) return;
    const warning = [
      "Promote this draft to pending?",
      "",
      "This writes to the local docket. The launchd docket executor may pick it up on its next tick and dispatch the task to model surfaces.",
      "",
      "Continue only if you want this draft to become executable."
    ].join("\\n");
    if (!window.confirm(warning)) {
      showOperator("promotion cancelled", { taskId, executorTriggered: false });
      return;
    }
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Promoting...";
    }
    showOperator("promoting draft", { taskId });
    try {
      const result = await postJson(endpoints.draftPromote, {
        taskId,
        confirm: "PROMOTE_DRAFT_TO_PENDING",
        approvedBy: "operator/cockpit",
      }, 8000);
      showOperator("draft promoted", {
        taskId: result.task && (result.task.id || result.task.taskId),
        status: result.task && result.task.status,
        path: result.path,
        executorTriggered: result.executorTriggered,
        executorNote: result.executorNote,
      });
      await refresh();
    } catch (error) {
      showOperator("promotion failed", error && error.message ? error.message : String(error));
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Promote";
      }
    }
  }

  async function setExecutorControl(action, button) {
    const normalized = String(action || "").toLowerCase();
    if (!["pause", "resume"].includes(normalized)) return;
    if (normalized === "resume") {
      const warning = [
        "Resume executor intake?",
        "",
        "Any pending low-risk allowlisted task can be claimed by the launchd executor on its next tick.",
        "",
        "Continue only if the pending queue is ready to run."
      ].join("\\n");
      if (!window.confirm(warning)) {
        showOperator("resume cancelled", { executorControl: "paused" });
        return;
      }
    }
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = normalized === "pause" ? "Pausing..." : "Resuming...";
    }
    showOperator(normalized === "pause" ? "pausing executor" : "resuming executor", { action: normalized });
    try {
      const body = {
        action: normalized,
        updatedBy: "operator/cockpit",
        reason: normalized === "pause"
          ? "operator paused executor intake from cockpit"
          : "operator resumed executor intake from cockpit",
      };
      if (normalized === "resume") body.confirm = "RESUME_EXECUTOR";
      const result = await postJson(endpoints.executorControl, body, 8000);
      showOperator(normalized === "pause" ? "executor paused" : "executor resumed", result.control || result);
      await refresh();
    } catch (error) {
      showOperator("executor control failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || (normalized === "pause" ? "Pause intake" : "Resume intake");
      }
    }
  }

  async function inspectExecutor(button) {
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Inspecting...";
    }
    showOperator("inspecting executor", "Reading queue, executor logs, and recent docket events...");
    try {
      const result = await fetchJson(endpoints.executorInspect, 8000);
      showOperator("executor inspection", {
        control: result.control,
        executor: result.executor,
        counts: result.counts,
        staleRunning: result.staleRunning,
        recentEvents: result.recentEvents,
        logs: {
          stdout: result.logs && result.logs.stdout ? {
            available: result.logs.stdout.available,
            updatedAt: result.logs.stdout.updatedAt,
            bytes: result.logs.stdout.bytes,
            tail: result.logs.stdout.text,
          } : null,
          stderr: result.logs && result.logs.stderr ? {
            available: result.logs.stderr.available,
            updatedAt: result.logs.stderr.updatedAt,
            bytes: result.logs.stderr.bytes,
            tail: result.logs.stderr.text,
          } : null,
        },
      });
    } catch (error) {
      showOperator("executor inspection failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Inspect";
      }
    }
  }

  async function inspectTask(taskId, button) {
    if (!taskId) return;
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Inspecting...";
    }
    try {
      const result = await fetchJson(endpoints.executorInspect + "?taskId=" + encodeURIComponent(taskId), 8000);
      showOperator("task inspection", result.task || { taskId, found: false });
    } catch (error) {
      showOperator("task inspection failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Inspect";
      }
    }
  }

  async function docketTaskAction(taskId, action, button) {
    if (!taskId || !action) return;
    const normalized = String(action).toLowerCase();
    const config = {
      "cancel-task": {
        apiAction: "cancel",
        token: "CANCEL_DOCKET_TASK",
        label: "Cancel",
        warning: "Cancel this draft/pending task? This preserves the task file and writes a cancelled heartbeat.",
      },
      "retry-task": {
        apiAction: "retry",
        token: "RETRY_DOCKET_TASK",
        label: "Retry",
        warning: "Create a new pending retry for this terminal task? The original task remains in the ledger.",
      },
      "mark-stale-failed": {
        apiAction: "mark-stale-failed",
        token: "MARK_STALE_TASK_FAILED",
        label: "Mark failed",
        warning: "Mark this stale running task failed? Use this only when the executor has exceeded the recovery window.",
      },
    }[normalized];
    if (!config) return;
    if (!window.confirm(config.warning + "\\n\\nTask: " + taskId)) {
      showOperator(config.label.toLowerCase() + " cancelled", { taskId, action: config.apiAction });
      return;
    }
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = config.label + "...";
    }
    showOperator(config.label.toLowerCase() + " requested", { taskId, action: config.apiAction });
    try {
      const result = await postJson(endpoints.docketTaskAction, {
        taskId,
        action: config.apiAction,
        confirm: config.token,
        operator: "operator/cockpit",
      }, 8000);
      showOperator(config.label.toLowerCase() + " complete", {
        taskId: result.taskId,
        retryTaskId: result.retryTaskId,
        status: result.task && result.task.status,
        path: result.path,
      });
      await refresh();
    } catch (error) {
      showOperator(config.label.toLowerCase() + " failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || config.label;
      }
    }
  }

  async function authorityGateAction(capabilityId, action, button) {
    if (!capabilityId || !action) return;
    const normalized = String(action).toLowerCase();
    const config = {
      approve: {
        token: "APPROVE_SKILL_AUTHORITY",
        label: "Approve",
        warning: "Approve this authority lane? This writes a local policy receipt only. It does not install software, grant OS permissions, or bypass Joseph confirmations.",
      },
      quarantine: {
        token: "QUARANTINE_SKILL_AUTHORITY",
        label: "Quarantine",
        warning: "Move this authority lane back to quarantine? Existing receipts are preserved.",
      },
      block: {
        token: "BLOCK_SKILL_AUTHORITY",
        label: "Block",
        warning: "Block this authority lane? This prevents Chuck from treating it as available authority until a later explicit approval changes it.",
      },
    }[normalized];
    if (!config) return;
    if (!window.confirm(config.warning + "\\n\\nCapability: " + capabilityId)) {
      showOperator(config.label.toLowerCase() + " cancelled", { capabilityId, action: normalized });
      return;
    }
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = config.label + "...";
    }
    showOperator(config.label.toLowerCase() + " authority gate", { capabilityId, action: normalized });
    try {
      const result = await postJson(endpoints.authorityGateAction, {
        capabilityId,
        action: normalized,
        confirm: config.token,
        operator: "operator/cockpit",
      }, 8000);
      showOperator("authority gate updated", {
        capabilityId: result.capabilityId,
        fromState: result.fromState,
        toState: result.toState,
        receiptId: result.receipt && result.receipt.receiptId,
        nonEffects: result.receipt && result.receipt.nonEffects,
      });
      await refresh();
    } catch (error) {
      showOperator("authority gate failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || config.label;
      }
    }
  }

  async function draftSelfImprovement(button) {
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Drafting...";
    }
    showOperator("drafting self-improvement proposal", {
      writes: "proposal artifact only",
      modelDispatch: false,
      patchApplication: false,
    });
    try {
      const result = await postJson(endpoints.selfImprovementProposal, {
        createdBy: "operator/cockpit",
      }, 8000);
      const proposal = result.proposal || {};
      showOperator("self-improvement proposal drafted", {
        proposalId: proposal.proposalId,
        status: proposal.status,
        laneId: proposal.laneId,
        path: result.path,
        targetFiles: proposal.targetFiles,
        patchApplicationBlockers: proposal.authorityDiff && proposal.authorityDiff.patchApplicationBlockers,
        nonEffects: proposal.authorityDiff && proposal.authorityDiff.nonEffects,
      });
      await refresh();
    } catch (error) {
      showOperator("self-improvement draft failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Draft proposal";
      }
    }
  }

  async function selfImprovementAction(proposalId, action, button) {
    if (!proposalId || !action) return;
    const normalized = String(action).toLowerCase();
    const config = {
      approve: {
        token: "APPROVE_SELF_IMPROVEMENT_PROPOSAL",
        label: "Approve",
        warning: "Approve this self-improvement proposal? This writes an approval receipt only. It does not run a model, create a patch, apply source edits, promote a docket task, or resume executor intake.",
      },
      reject: {
        token: "REJECT_SELF_IMPROVEMENT_PROPOSAL",
        label: "Reject",
        warning: "Reject this self-improvement proposal? This preserves the proposal and writes a rejection receipt.",
      },
    }[normalized];
    if (!config) return;
    if (!window.confirm(config.warning + "\\n\\nProposal: " + proposalId)) {
      showOperator(normalized + " cancelled", { proposalId, action: normalized });
      return;
    }
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = config.label + "...";
    }
    showOperator(config.label.toLowerCase() + " self-improvement proposal", { proposalId });
    try {
      const result = await postJson(endpoints.selfImprovementAction, {
        proposalId,
        action: normalized,
        confirm: config.token,
        operator: "operator/cockpit",
      }, 8000);
      showOperator("self-improvement proposal " + result.status, {
        proposalId: result.proposalId,
        status: result.status,
        receiptId: result.receipt && result.receipt.receiptId,
        nonEffects: result.receipt && result.receipt.nonEffects,
      });
      await refresh();
    } catch (error) {
      showOperator("self-improvement action failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || config.label;
      }
    }
  }

  async function draftCompaction(button) {
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Drafting...";
    }
    showOperator("drafting compaction", {
      writes: "draft decision only",
      priorMutation: false,
    });
    try {
      const result = await postJson(endpoints.compactionPreview, { write: true }, 12000);
      showOperator("compaction draft ready", {
        decisionId: result.decision && result.decision.decisionId,
        path: result.path,
        includedDeltas: result.decision && result.decision.includedDeltaIds && result.decision.includedDeltaIds.length,
        promotedClaims: result.decision && result.decision.promotedClaims && result.decision.promotedClaims.length,
        deferredClaims: result.decision && result.decision.deferredClaims && result.decision.deferredClaims.length,
        priorMutation: false,
      });
      await refresh();
    } catch (error) {
      showOperator("compaction draft failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Draft compaction";
      }
    }
  }

  async function approveCompaction(button) {
    const decisionId = button ? button.dataset.decisionId : "";
    if (!decisionId) return;
    const warning = [
      "Approve prior compaction?",
      "",
      "This applies the draft decision to the compact universal prior. It does not resume executor intake or run docket tasks.",
      "",
      "Continue only if Joseph approves this prior mutation."
    ].join("\\n");
    if (!window.confirm(warning)) {
      showOperator("compaction approval cancelled", { decisionId, priorMutation: false });
      return;
    }
    const oldText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Approving...";
    }
    showOperator("approving compaction", { decisionId });
    try {
      const result = await postJson(endpoints.compactionApprove, {
        decisionId,
        confirm: "APPROVE_PRIOR_COMPACTION",
        approvedBy: "operator/cockpit",
      }, 60000);
      showOperator("compaction applied", {
        decisionId: result.decisionId,
        resultingPriorId: result.resultingPriorId,
        priorReceipt: result.priorReceipt,
      });
      await refresh();
    } catch (error) {
      showOperator("compaction approval failed", error && error.message ? error.message : String(error));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Approve compaction";
      }
    }
  }

  async function runOperatorCommand(kind) {
    const config = {
      doctor: { url: endpoints.doctorCommand, method: "POST", timeoutMs: 190000, label: "doctor" },
      atlas: { url: endpoints.atlasCommand, method: "GET", timeoutMs: 30000, label: "surface atlas" },
      docket: { url: endpoints.docketCommand, method: "GET", timeoutMs: 30000, label: "docket" },
      capability: { url: endpoints.capabilityCommand, method: "GET", timeoutMs: 190000, label: "capability ledger" },
    }[kind];
    if (!config) return;
    showOperator("running " + config.label, "Waiting for " + config.label + "...");
    try {
      const data = config.method === "POST"
        ? await postJson(config.url, {}, config.timeoutMs)
        : await fetchJson(config.url, config.timeoutMs);
      showOperator(config.label + " complete", compactCommandResult(kind, data));
      await refresh();
    } catch (error) {
      showOperator(config.label + " failed", error && error.message ? error.message : String(error));
    }
  }

  $("proposalList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='draft-proposal']");
    if (!button) return;
    draftProposal(button.dataset.proposalId, button);
  });
  $("draftList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "preview-draft") {
      previewDraft(button.dataset.taskId, button);
    } else if (button.dataset.action === "promote-draft") {
      promoteDraft(button.dataset.taskId, button);
    }
  });
  $("queueList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "inspect-task") {
      inspectTask(button.dataset.taskId, button);
    } else {
      docketTaskAction(button.dataset.taskId, button.dataset.action, button);
    }
  });
  $("authorityList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    authorityGateAction(button.dataset.capabilityId, button.dataset.action, button);
  });
  $("selfLabList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    selfImprovementAction(button.dataset.proposalId, button.dataset.action, button);
  });
  $("operator").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-command]");
    if (!button) return;
    runOperatorCommand(button.dataset.command);
  });
  $("inspectExecutor").addEventListener("click", (event) => inspectExecutor(event.currentTarget));
  $("pauseExecutor").addEventListener("click", (event) => setExecutorControl("pause", event.currentTarget));
  $("resumeExecutor").addEventListener("click", (event) => setExecutorControl("resume", event.currentTarget));
  $("draftSelfLab").addEventListener("click", (event) => draftSelfImprovement(event.currentTarget));
  $("draftCompaction").addEventListener("click", (event) => draftCompaction(event.currentTarget));
  $("approveCompaction").addEventListener("click", (event) => approveCompaction(event.currentTarget));
  $("planMacHeal").addEventListener("click", (event) => planMacSelfHeal(event.currentTarget));
  $("runMacHeal").addEventListener("click", (event) => runMacSelfHeal(event.currentTarget));
  $("runMacCloudOffload").addEventListener("click", (event) => runMacCloudOffload(event.currentTarget));
  $("purgeMacLocalArchive").addEventListener("click", (event) => purgeMacLocalArchive(event.currentTarget));
  $("refresh").addEventListener("click", refresh);
  refresh();
  setInterval(refresh, 15000);
})();
</script>
</body>
</html>`;

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
  .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  @media (max-width: 900px) { .grid.two, .grid.three { grid-template-columns: 1fr; } }
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
  .receipt .status.info { color: var(--info); }
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
  <span class="title">OPENCLAW · CHUCK COCKPIT</span>
  <span class="pill"><span id="indicator" class="indicator-dot"></span><b id="hdr-time">—</b></span>
  <span class="pill">prior: <b id="hdr-prior">—</b></span>
  <span class="pill">deltas: <b id="hdr-deltas">—</b></span>
  <span class="pill">executor: <b id="hdr-executor">—</b></span>
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
<section><h2 class="section">Perichoresis Cockpit</h2><div id="perichoresis"><div class="empty">loading…</div></div></section>
	<section><h2 class="section">Fleet Readiness Board</h2><div id="capability-ledger"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Surface Transport Audit</h2><div id="transport-audit"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Latest Fleet Run</h2><div id="latest-fleet-run"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Live Build Timeline</h2><div id="live-build"><div class="empty">loading…</div></div></section>
<section><h2 class="section">Parallel Work Ledger</h2><div id="work-ledger"><div class="empty">loading…</div></div></section>
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
  const shortId = (value) => {
    const text = String(value || "");
    if (!text) return "—";
    if (text.length <= 28) return text;
    return text.slice(0, 12) + "…" + text.slice(-10);
  };
  const statusTone = (value) => {
    const text = String(value || "").toLowerCase();
    if (/fail|error|blocked|missing|timeout|contested|rejected/.test(text)) return "err";
    if (/pending|proposal|candidate|gate|running|claimed|open|deepen|warn/.test(text)) return "warn";
    if (/completed|accepted|ready|ok|supported|load-bearing|none/.test(text)) return "ok";
    return "info";
  };
  const compactList = (items, emptyText, tag) => {
    const rows = (items || []).slice(0, 8).map((item) =>
      '<li style="display:block;"><div style="display:flex;justify-content:space-between;gap:10px;">' +
      '<span class="slug">' + escHtml(item) + '</span><span class="w">' + escHtml(tag || "") + '</span></div></li>'
    ).join("");
    return '<ul class="princ">' + (rows || '<li><span class="slug">' + escHtml(emptyText) + '</span><span class="w">ok</span></li>') + '</ul>';
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

  async function fetchJsonWithTimeout(url, { timeoutMs = 6000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchJsonOrThrow(url, { cache: "no-store", signal: controller.signal });
    } catch (err) {
      if (err?.name === "AbortError") {
        throw new Error("timeout after " + timeoutMs + "ms");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function renderPanelFailure(id, label, error) {
    const root = $(id);
    if (!root) return;
    root.innerHTML =
      '<div class="empty">' +
      escHtml(label + " unavailable: " + (error?.message || error)) +
      '</div>';
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
      metric("full-capacity", (ledger.fullCapacityFamilies || []).join(", ") || "none"),
      metric("capacity score", ledger.capacityScore == null ? "—" : ledger.capacityScore + "%"),
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
      pollDashboard();
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
      pollDashboard();
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
      pollDashboard();
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
      pollDashboard();
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
      pollDashboard();
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
      await pollDashboard();
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
      pollDashboard();
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
      pollDashboard();
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
      pollDashboard();
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
      pollDashboard();
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

  function renderWorkLedger(ledger) {
    const root = $("work-ledger");
    if (!root) { return; }
    const git = ledger?.git || {};
    if (!ledger?.available) {
      root.innerHTML = '<div class="empty">' + escHtml(ledger?.reason ?? "no parallel work ledger yet") + '</div>' +
        '<div class="run-summary" style="margin-top:10px;">' + [
          metric("branch", git.branch || "unknown"),
          metric("dirty", git.dirtyCount ?? 0),
        ].join("") + '</div>';
      return;
    }
    const summary = [
      metric("lanes", (ledger.lanes || []).length),
      metric("events", (ledger.events || []).length),
      metric("branch", git.branch || "unknown"),
      metric("dirty", git.dirtyCount ?? 0),
      metric("latest", ledger.latestEvent ? fmtAgo(ledger.latestEvent.createdAt) : "none"),
    ].join("");
    const lanes = (ledger.lanes || []).slice(0, 8).map((lane) => {
      const files = (lane.files || []).slice(0, 5).join(", ") || "no files listed";
      return '<li style="display:block;"><div style="display:flex;justify-content:space-between;gap:10px;">' +
        '<span class="slug">' + escHtml((lane.lane || "default") + " · " + (lane.agent || "unknown")) + '</span><span class="w">' +
        escHtml(lane.status || "unknown") + '</span></div>' +
        '<div style="color:var(--fg-dim);margin-top:3px;">' + escHtml(lane.summary || "") + '</div>' +
        '<div style="color:var(--fg-dim);margin-top:3px;">files: ' + escHtml(files) + '</div>' +
        '</li>';
    }).join("");
    const dirty = (git.files || []).slice(0, 12).map((file) =>
      '<li><span class="slug">' + escHtml(file.path) + '</span><span class="w">' + escHtml(file.code) + '</span></li>'
    ).join("");
    root.innerHTML = '<div class="run-summary">' + summary + '</div>' +
      '<div class="grid two">' +
      '<div class="card"><div class="col-title">Lanes</div><ul class="princ">' + (lanes || '<li><span class="slug">no lanes announced</span><span class="w">empty</span></li>') + '</ul></div>' +
      '<div class="card"><div class="col-title">Dirty Files</div><ul class="princ">' + (dirty || '<li><span class="slug">worktree clean</span><span class="w">ok</span></li>') + '</ul></div>' +
      '</div>';
  }

  function renderLiveBuild(live) {
    const root = $("live-build");
    if (!root) { return; }
    if (!live?.available) {
      root.innerHTML = '<div class="empty">' + escHtml(live?.reason ?? "no live build events yet") + '</div>';
      return;
    }
    const events = live.events || [];
    const active = live.activeRuns || [];
    const summary = [
      metric("active", active.length),
      metric("events", events.length),
      metric("latest", live.latestEvent ? fmtAgo(live.latestEvent.createdAt) : "none"),
      metric("latest status", live.latestEvent?.status || "none"),
    ].join("");
    const rows = events.slice(0, 14).map((event) => {
      const tone = event.status === "passed" ? "ok" : event.status === "started" || event.status === "running" ? "warn" : "err";
      const details = [
        event.kind,
        event.exitCode == null ? null : "exit=" + event.exitCode,
        event.timedOut ? "timeout" : null,
        event.stdoutBytes == null ? null : "stdout=" + event.stdoutBytes + "B",
        event.stderrBytes == null ? null : "stderr=" + event.stderrBytes + "B",
      ].filter(Boolean).join(" · ");
      return '<li style="display:block;"><div style="display:flex;justify-content:space-between;gap:10px;">' +
        '<span class="slug">' + escHtml(event.summary || event.runId || "live event") + '</span><span class="w" style="color:var(--' + tone + ');">' +
        escHtml(event.status || "unknown") + '</span></div>' +
        '<div style="color:var(--fg-dim);margin-top:3px;">' + escHtml(details || event.runId || "") + '</div>' +
        '<div style="color:var(--fg-faint);margin-top:3px;">' + escHtml(fmtAgo(event.createdAt)) + '</div>' +
        '</li>';
    }).join("");
    root.innerHTML = '<div class="run-summary">' + summary + '</div>' +
      '<div class="card"><ul class="princ">' +
      (rows || '<li><span class="slug">no events yet</span><span class="w">idle</span></li>') +
      '</ul></div>';
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
      const runtime = entry.runtimeState ? " · runtime: " + entry.runtimeState : "";
      return '<div class="receipt" data-family="' + escHtml(entry.family) + '"><div class="top"><span class="family">' +
        escHtml(entry.family + " · " + entry.surface) + '</span><span class="status ' + cls + '">' + escHtml(entry.readiness) +
        '</span></div><div style="color:var(--fg-dim);">' + escHtml(proof) + '</div>' +
        '<div style="color:var(--fg-dim);margin-top:3px;">count-family: ' + escHtml(entry.countsAsIndependentFamily ? "yes" : "no") +
        ' · confidence: ' + escHtml(entry.confidence || "unknown") +
        ' · age: ' + escHtml(fmtAgo(entry.lastProofAt)) + escHtml(runtime) + '</div>' +
        (caveats ? '<div style="color:var(--warn);margin-top:3px;">' + escHtml(caveats) + '</div>' : '') +
        '<div style="color:var(--fg-faint);font:11px var(--mono);margin-top:3px;">next: ' + escHtml(entry.nextRepairAction || "") + '</div>' +
        '</div>';
    }).join("");
    root.innerHTML = '<div class="run-summary">' + summaryHtml + '</div>' +
      '<div class="receipt-grid">' + (cards || '<div class="empty">no capability entries</div>') + '</div>' +
      '<div style="color:var(--fg-faint);font:11px var(--mono);margin-top:8px;">The Kernel relies on load-bearing surfaces only. Late OCR/recovery evidence remains visible but degraded until normal proof succeeds.</div>';
  }

  function renderTransportAudit(audit) {
    const root = $("transport-audit");
    if (!root) { return; }
    if (!audit?.available) {
      root.innerHTML = '<div class="empty">' + escHtml(audit?.reason ?? "transport audit unavailable") + '</div>';
      return;
    }
    const summary = audit.summary || {};
    const entries = audit.entries || [];
    const summaryHtml = [
      metric("transport-load-bearing", summary.loadBearing || 0),
      metric("partial", summary.partial || 0),
      metric("missing", summary.missing || 0),
      metric("surfaces", summary.totalSurfaces || entries.length || 0),
      metric("refreshed", fmtAgo(audit.refreshedAt)),
    ].join("");
    const order = { missing: 0, partial: 1, "load-bearing": 2 };
    const cards = [...entries]
      .sort((a, b) => {
        const ai = order[a.proofGrade] ?? 9;
        const bi = order[b.proofGrade] ?? 9;
        if (ai !== bi) return ai - bi;
        return String(a.surface).localeCompare(String(b.surface));
      })
      .slice(0, 24)
      .map((entry) => {
        const cls = entry.proofGrade === "load-bearing" ? "ok" : entry.proofGrade === "missing" ? "err" : "warn";
        const gaps = (entry.gaps || []).join(", ") || "none";
        const proven = (entry.provenProofs || []).join(", ") || "none";
        return '<div class="receipt" data-family="' + escHtml(entry.family) + '"><div class="top"><span class="family">' +
          escHtml(entry.family + " · " + entry.surface) + '</span><span class="status ' + cls + '">' + escHtml(entry.proofGrade) +
          '</span></div><div style="color:var(--fg-dim);">primary: ' + escHtml(entry.primaryTransport || "unknown") +
          ' · readiness: ' + escHtml(entry.readiness || "unknown") + '</div>' +
          '<div style="color:var(--fg-dim);margin-top:3px;">proven: ' + escHtml(proven) + '</div>' +
          '<div style="color:' + (gaps === "none" ? "var(--fg-dim)" : "var(--warn)") + ';margin-top:3px;">gaps: ' + escHtml(gaps) + '</div>' +
          '<div style="color:var(--fg-faint);font:11px var(--mono);margin-top:3px;">next: ' + escHtml(entry.nextAction || "") + '</div>' +
          '</div>';
      }).join("");
    root.innerHTML = '<div class="run-summary">' + summaryHtml + '</div>' +
      '<div class="receipt-grid">' + (cards || '<div class="empty">no transport audit entries</div>') + '</div>' +
      '<div style="color:var(--fg-faint);font:11px var(--mono);margin-top:8px;">Transport load-bearing means the surface has the specific controls/proofs the driver needs, not merely that the family can answer.</div>';
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

  function renderPerichoresis(p) {
    const root = $("perichoresis");
    if (!root) { return; }
    if (!p?.available) {
      root.innerHTML = '<div class="empty">' + escHtml(p?.reason ?? "perichoresis state unavailable") + '</div>';
      return;
    }
    const prior = p.prior || {};
    const ledger = p.ledger || {};
    const executor = p.executor || {};
    const executorState = executor.present
      ? (executor.state || "present") + (executor.pid ? " · pid " + executor.pid : "")
      : "missing";
    const modelReady = prior.modelReadiness
      ? ((prior.modelReadiness.executionReadyFamilies || prior.modelReadiness.readyFamilies || []).length + "/" +
        ((prior.modelReadiness.configuredFamilies || []).length || "?" ) + " families")
      : "—";
    const summary = [
      metric("current prior", prior.priorId || "none"),
      metric("source hash", prior.sourceHash ? shortId(prior.sourceHash) : "none"),
      metric("prior age", fmtAgo(prior.createdAt)),
      metric("executor", executorState),
      metric("models", modelReady),
      metric("active tasks", (p.activeTasks || []).length),
      metric("deltas", ledger.posteriorDeltaCount ?? 0),
      metric("read markers", ledger.readMarkerCount ?? 0),
      metric("dissent", ledger.dissentCount ?? 0),
    ].join("");
    const priorPanel = '<div class="card"><div class="col-title">Universal Prior</div>' +
      '<div style="font:12px var(--mono);color:var(--fg);margin-bottom:6px;">' + escHtml(prior.doctrine?.claim || "") + '</div>' +
      '<div style="font:12px var(--mono);color:var(--fg-dim);">' + escHtml(prior.focus || "no current focus") + '</div>' +
      '<div class="grid two" style="margin-top:10px;">' +
      '<div><div class="col-title">Open Questions</div>' + compactList(prior.openQuestions, "no open questions", "question") + '</div>' +
      '<div><div class="col-title">Next Actions</div>' + compactList(prior.recommendedNextActions, "no recommended actions", "next") + '</div>' +
      '</div></div>';
    const proposals = (p.proposals || []).map((proposal) =>
      '<div class="receipt" data-family="' + escHtml(proposal.family) + '"><div class="top"><span class="family">' +
      escHtml(proposal.family + " · " + proposal.surface) + '</span><span class="status ' + statusTone(proposal.status) + '">' +
      escHtml(proposal.status) + '</span></div><div style="color:var(--fg);">' + escHtml(proposal.title || proposal.deltaId) + '</div>' +
      '<div style="color:var(--fg-dim);margin-top:4px;">' + escHtml(shortId(proposal.deltaId) + " · " + (proposal.confidence || "unknown")) + '</div></div>'
    ).join("");
    const taskRows = (p.activeTasks || []).slice(0, 8).map((task) =>
      '<li style="display:block;"><div style="display:flex;justify-content:space-between;gap:10px;">' +
      '<span class="slug">' + escHtml(task.title || task.taskId) + '</span><span class="w" style="color:var(--' + statusTone(task.status) + ');">' +
      escHtml(task.status || "unknown") + '</span></div>' +
      '<div style="color:var(--fg-dim);margin-top:3px;">' + escHtml((task.commandKind || "task") + " · " + (task.risk || "risk?") + " · " + fmtAgo(task.updatedAt)) + '</div></li>'
    ).join("");
    const deltaCards = (p.posteriorDeltas || []).slice(0, 8).map((delta) => {
      const claims = (delta.claimsPreview || []).slice(0, 2).map((claim) =>
        '<li style="display:block;"><span class="slug">' + escHtml(claim.text || "") + '</span></li>'
      ).join("");
      const next = (delta.recommendedNextActions || []).slice(0, 1).map((item) =>
        '<div style="color:var(--warn);margin-top:4px;">next: ' + escHtml(item) + '</div>'
      ).join("");
      const status = delta.authorityImpact || delta.confidence || "delta";
      return '<div class="receipt" data-family="' + escHtml(delta.family) + '"><div class="top"><span class="family">' +
        escHtml(delta.family + " · " + delta.surface) + '</span><span class="status ' + statusTone(status) + '">' +
        escHtml(status) + '</span></div><div style="color:var(--fg-dim);">' +
        escHtml(shortId(delta.deltaId) + " · prior " + shortId(delta.priorId)) + '</div>' +
        '<div style="color:var(--fg-dim);margin-top:3px;">claims ' + escHtml(delta.claimCount) +
        ' · evidence ' + escHtml(delta.evidenceCount) + ' · questions ' + escHtml(delta.openQuestionCount) +
        ' · ' + escHtml(fmtAgo(delta.createdAt)) + '</div>' +
        (claims ? '<ul class="princ" style="margin-top:6px;">' + claims + '</ul>' : '') + next + '</div>';
    }).join("");
    const readRows = (p.readMarkers || []).slice(0, 8).map((marker) =>
      '<li style="display:block;"><div style="display:flex;justify-content:space-between;gap:10px;">' +
      '<span class="slug">' + escHtml(marker.family + " · " + marker.surface) + '</span><span class="w" style="color:var(--' + statusTone(marker.result) + ');">' +
      escHtml(marker.result || "seen") + '</span></div><div style="color:var(--fg-dim);margin-top:3px;">' +
      escHtml(shortId(marker.priorId) + " · " + (marker.scope || "scope?") + " · " + fmtAgo(marker.seenAt)) + '</div></li>'
    ).join("");
    const dissentCards = (p.dissent || []).slice(0, 8).map((item) =>
      '<div class="receipt" data-family="' + escHtml(item.family) + '"><div class="top"><span class="family">' +
      escHtml(item.family + " · " + item.surface) + '</span><span class="status ' + statusTone(item.status) + '">' +
      escHtml(item.status || "open") + '</span></div><div style="color:var(--fg);">' + escHtml(item.reason || item.claimId || "") +
      '</div><div style="color:var(--fg-dim);margin-top:4px;">' + escHtml(shortId(item.dissentId) + " · evidence " + item.evidenceCount) + '</div></div>'
    ).join("");
    root.innerHTML = '<div class="run-summary">' + summary + '</div>' +
      '<div class="grid two">' + priorPanel +
      '<div class="card"><div class="col-title">Proposal Lane</div><div class="receipt-grid">' +
      (proposals || '<div class="empty">no delta promotion candidates</div>') + '</div>' +
      '<div class="col-title" style="margin-top:12px;">Active Docket</div><ul class="princ">' +
      (taskRows || '<li><span class="slug">no active tasks</span><span class="w">idle</span></li>') + '</ul></div></div>' +
      '<div class="grid two" style="margin-top:12px;">' +
      '<div class="card"><div class="col-title">Latest Posterior Deltas</div><div class="receipt-grid">' +
      (deltaCards || '<div class="empty">no posterior deltas yet</div>') + '</div></div>' +
      '<div class="card"><div class="col-title">Read Markers</div><ul class="princ">' +
      (readRows || '<li><span class="slug">no read markers yet</span><span class="w">empty</span></li>') + '</ul>' +
      '<div class="col-title" style="margin-top:12px;">Open Dissent</div><div class="receipt-grid">' +
      (dissentCards || '<div class="empty">no dissent records</div>') + '</div></div></div>';
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
    $("hdr-prior").textContent = snap.perichoresis?.prior?.priorId
      ? shortId(snap.perichoresis.prior.priorId)
      : "—";
    $("hdr-deltas").textContent = snap.perichoresis?.ledger
      ? (snap.perichoresis.ledger.posteriorDeltaCount ?? 0) + " / " + (snap.perichoresis.ledger.readMarkerCount ?? 0) + " reads"
      : "—";
    $("hdr-executor").textContent = snap.perichoresis?.executor?.present
      ? (snap.perichoresis.executor.state || "present")
      : "—";
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

  const dashboardState = {
    time: new Date().toISOString(),
    perichoresis: null,
    fleet: null,
    processes: null,
    scorer: null,
    curator: null,
    router: null,
    builder: null,
    workLedger: null,
    liveBuild: null,
    capabilityLedger: null,
    transportAudit: null,
    latestFleetRun: null,
    surfaceControl: null,
    surfaceAtlas: null,
    repoHygiene: null,
    repoHygieneCheckpoint: null,
    githubHygieneCheckpoint: null,
    upstreamSyncCheckpoint: null,
    modelDoctor: null,
    familyRegistry: null,
    panels: null,
    recentEvents: null,
  };

  const panelLoaders = [
    {
      key: "perichoresis",
      url: "/api/chuck-v3/perichoresis",
      id: "perichoresis",
      label: "perichoresis",
      timeoutMs: 3500,
      render: (data) => renderPerichoresis(data),
    },
    {
      key: "capabilityLedger",
      url: "/api/chuck-v2/capability-ledger/status",
      id: "capability-ledger",
      label: "fleet readiness",
      timeoutMs: 9000,
      render: (data) => renderCapabilityLedger(data),
    },
    {
      key: "transportAudit",
      url: "/api/chuck-v2/transport-audit/status",
      id: "transport-audit",
      label: "transport audit",
      timeoutMs: 9000,
      render: (data) => renderTransportAudit(data),
    },
    {
      key: "latestFleetRun",
      url: "/api/chuck-v2/latest-fleet-run",
      id: "latest-fleet-run",
      label: "latest fleet run",
      timeoutMs: 3500,
      render: (data) => renderLatestFleetRun(data),
    },
    {
      key: "liveBuild",
      url: "/api/chuck-v2/live-build",
      id: "live-build",
      label: "live build",
      timeoutMs: 3000,
      render: (data) => renderLiveBuild(data),
    },
    {
      key: "workLedger",
      url: "/api/chuck-v2/work-ledger",
      id: "work-ledger",
      label: "work ledger",
      timeoutMs: 4000,
      render: (data) => renderWorkLedger(data),
    },
    {
      key: "surfaceControl",
      url: "/api/chuck-v2/surface-control",
      id: "surface-control",
      label: "surface return",
      timeoutMs: 3000,
      render: (data) => renderSurfaceControl(data),
    },
    {
      key: "surfaceAtlas",
      url: "/api/chuck-v2/surface-atlas/status",
      id: "surface-atlas",
      label: "surface atlas",
      timeoutMs: 9000,
      render: (data) => renderSurfaceAtlas(data),
    },
    {
      key: "repoHygiene",
      url: "/api/repo-hygiene",
      id: "repo-hygiene",
      label: "repo hygiene",
      timeoutMs: 4000,
      render: (data) => renderRepoHygiene(data, dashboardState.repoHygieneCheckpoint),
    },
    {
      key: "repoHygieneCheckpoint",
      url: "/api/repo-hygiene/latest-checkpoint",
      id: "repo-hygiene",
      label: "repo checkpoint",
      timeoutMs: 3000,
      render: (data) => renderRepoHygiene(dashboardState.repoHygiene, data),
    },
    {
      key: "githubHygieneCheckpoint",
      url: "/api/github-hygiene/latest-checkpoint",
      id: "github-hygiene",
      label: "GitHub hygiene",
      timeoutMs: 3000,
      render: (data) => renderGitHubHygiene(data),
    },
    {
      key: "upstreamSyncCheckpoint",
      url: "/api/upstream-sync/latest-checkpoint",
      id: "upstream-sync",
      label: "upstream sync",
      timeoutMs: 3000,
      render: (data) => renderUpstreamSync(data),
    },
    {
      key: "builder",
      url: "/api/chuck-v2/build/status",
      id: "builder",
      label: "builder",
      timeoutMs: 3000,
      render: (data) => renderBuilder(data),
    },
    {
      key: "modelDoctor",
      url: "/api/chuck-v2/doctor/status",
      id: "model-doctor",
      label: "model doctor",
      timeoutMs: 3000,
      render: (data) => renderModelDoctor(data),
    },
    {
      key: "familyRegistry",
      url: "/api/chuck-v2/family-registry",
      id: "family-registry",
      label: "family registry",
      timeoutMs: 3000,
      render: (data) => renderFamilyRegistry(data),
    },
    {
      key: "fleet",
      url: "/api/fleet",
      id: "fleet",
      label: "fleet",
      timeoutMs: 8000,
      render: (data) => renderFleet(data, dashboardState.familyRegistry),
    },
    {
      key: "processes",
      url: "/api/processes",
      id: "procs",
      label: "processes",
      timeoutMs: 3000,
      render: (data) => renderProcs(data),
    },
    {
      key: "scorer",
      url: "/api/scorer",
      id: "scorer",
      label: "principle scorer",
      timeoutMs: 3000,
      render: (data) => renderScorer(data),
    },
    {
      key: "curator",
      url: "/api/curator",
      id: "curator",
      label: "curator",
      timeoutMs: 3000,
      render: (data) => renderCurator(data),
    },
    {
      key: "router",
      url: "/api/router",
      id: "router",
      label: "router",
      timeoutMs: 3000,
      render: (data) => renderRouter(data),
    },
    {
      key: "panels",
      url: "/api/panels",
      id: "panels",
      label: "panels",
      timeoutMs: 8000,
      render: (data) => renderPanels(data),
    },
    {
      key: "recentEvents",
      url: "/api/recent-events",
      id: "event-stream",
      label: "events",
      timeoutMs: 3000,
      render: (data) => {
        if (!eventStreamSeeded) {
          seedEventStream(data?.recent ?? []);
          eventStreamSeeded = true;
        }
      },
    },
  ];

  let refreshInFlight = false;
  function refreshHeader() {
    dashboardState.time = new Date().toISOString();
    renderHeader(dashboardState);
  }

  async function refreshPanel(loader) {
    try {
      const data = await fetchJsonWithTimeout(loader.url, { timeoutMs: loader.timeoutMs });
      dashboardState[loader.key] = data;
      loader.render(data);
      refreshHeader();
    } catch (err) {
      dashboardState[loader.key] = {
        available: false,
        reason: err?.message || String(err),
      };
      renderPanelFailure(loader.id, loader.label, err);
      refreshHeader();
    }
  }

  async function pollDashboard() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    $("hdr-refresh").textContent = "refreshing…";
    refreshHeader();
    try {
      await Promise.allSettled(panelLoaders.map((loader) => refreshPanel(loader)));
      $("hdr-refresh").textContent = new Date().toLocaleTimeString();
    } finally {
      refreshInFlight = false;
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

  pollDashboard();
  setInterval(pollDashboard, 15000);
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
