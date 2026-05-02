#!/usr/bin/env node
// =============================================================================
// TRANSITIONAL DUPLICATE — Unit 6c of the openclaw-first migration (2026-05-01).
// =============================================================================
// The CANONICAL implementation of the read-only typed surface lives at:
//   extensions/skill-docket-executor/src/* (re-exported via
//   @openclaw/skill-docket-executor api.ts)
//
// This .mjs preserves the long-running daemon (claim/runTask/spawnBounded/
// zombie-sweep/heartbeat/posterior-delta/prior-refresh) that the LaunchAgent
// ~/Library/LaunchAgents/com.openclaw.chuck-docket-executor.plist invokes
// every 60s. The TS plugin v0.1 ships only the read-only typed surface
// (COMMANDS registry, lane policies, mac gate, eligibility, executor
// control, env builder, summarizeStatus); v0.2 will fold the daemon in
// when openclaw cron supports long-running plugin daemons.
//
// EDITS that touch the typed surface (COMMANDS, LANE_TIMEOUT_POLICY,
// EXECUTOR_LANE_POLICY, MAC_GATE_THRESHOLDS, MAC_GATE_EXEMPT_COMMAND_KINDS,
// eligibilityBlockers, timeoutPolicyForTask, readExecutorControl,
// buildExecutorEnv) go in BOTH places (here AND
// extensions/skill-docket-executor/src/*.ts) until v0.2.
//
// EDITS that touch the daemon (tick, claimTask, runTask, spawnBounded,
// sweepZombieTasks, heartbeats, attachPosteriorDeltas, attachPriorCapsule,
// refreshPriorCapsule, writePosteriorDeltas, lock acquire/release) stay
// here only — they have no canonical counterpart yet.
//
// The .mjs retires when openclaw cron grows long-running plugin-daemon
// support. At that point the entire chuck-comms-cascade /
// chuck-reach-ledger / chuck-sms-bridge / chuck-format-update /
// chuck-task-validator / chuck-cascade-watcher .mjs duplicate chain
// finally collapses too.
// =============================================================================
//
// Bounded Chuck v3 docket executor.
//
// Canonical queue:
//   ~/.openclaw/workspace/state/chuck-v3/docket/*.json
//
// This intentionally executes only explicit low-risk commandKind values. It
// never derives commands from task titles or free-form text.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { open, mkdir, readdir, readFile, rm, rename, stat, writeFile } from "node:fs/promises";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkCodexBudget } from "./apex-codex-budget.mjs";
import { notify as commsNotify } from "./chuck-comms-cascade.mjs";
import { validateTaskDeliverable } from "./chuck-task-validator.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = resolve(SCRIPTS_DIR, "..", "..", "..");
const DOCKET_DIR = join(homedir(), ".openclaw", "workspace", "state", "chuck-v3", "docket");
const LATEST_PRIOR = join(
  homedir(),
  ".openclaw",
  "workspace",
  "state",
  "chuck-v3",
  "priors",
  "latest.json",
);
const EXECUTOR_CONTROL_PATH = join(
  homedir(),
  ".openclaw",
  "workspace",
  "state",
  "chuck-v3",
  "executor-control.json",
);
const SOURCE = "chuck-docket-executor";
// Timeout ceilings are lane-aware. Build lanes need real room; diagnostics
// should stay crisp. Keep a ceiling rather than removing timeouts entirely so
// a wedged child cannot quietly consume the machine forever.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const LANE_TIMEOUT_POLICY = new Map([
  ["diagnostic", { defaultMs: 5 * 60 * 1000, longMs: 5 * 60 * 1000, maxMs: 15 * 60 * 1000 }],
  ["memory", { defaultMs: 10 * 60 * 1000, longMs: 20 * 60 * 1000, maxMs: 30 * 60 * 1000 }],
  ["maintenance", { defaultMs: 20 * 60 * 1000, longMs: 45 * 60 * 1000, maxMs: 60 * 60 * 1000 }],
  ["scout", { defaultMs: 45 * 60 * 1000, longMs: 90 * 60 * 1000, maxMs: 2 * 60 * 60 * 1000 }],
  ["build", { defaultMs: 45 * 60 * 1000, longMs: 2 * 60 * 60 * 1000, maxMs: 2 * 60 * 60 * 1000 }],
]);
const LOCK_STALE_MS =
  Math.max(DEFAULT_TIMEOUT_MS, ...[...LANE_TIMEOUT_POLICY.values()].map((policy) => policy.maxMs)) *
  2;
const DEFAULT_LOOP_INTERVAL_MS = 60 * 1000;
const TAIL_LIMIT_CHARS = 16 * 1024;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const MAC_GATE_CACHE_MS = 5000;
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
  diskMinFreeBytes: 25 * GIB,
  swapWarnUsedBytes: 10 * GIB,
};
let macGateCache = null;

// Build the env for child-process spawns. Critical: when chuck-docket-executor
// runs under launchd, process.env.PATH is launchd's minimal one and doesn't
// include /opt/homebrew/bin, ~/.openclaw/bin, or the nvm-installed Node bin
// dir. Without this enhancement, spawn("codex", ...) returns ENOENT even
// though the binary exists. Caused multiple "spawn codex ENOENT" deltas
// 2026-04-29 (multi-family agreement, see compaction-20260429T203243847Z).
// Fix here unblocks Chuck-builds-Chuck for code work via the codex lane.
function buildExecutorEnv() {
  const home = process.env.HOME ?? homedir();
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

const COMMANDS = new Map([
  [
    "bootstrap",
    {
      lane: "diagnostic",
      build: () => ({
        executable: process.execPath,
        args: ["extensions/memory-graph/scripts/apex-session-bootstrap.mjs", "--json"],
      }),
    },
  ],
  [
    "doctor",
    {
      lane: "diagnostic",
      build: () => ({
        executable: process.execPath,
        args: [
          "--import",
          "tsx",
          "extensions/memory-graph/scripts/chuck-v2-run.ts",
          "--doctor",
          "--json",
          "--no-persist",
        ],
      }),
    },
  ],
  [
    "capability-ledger",
    {
      lane: "diagnostic",
      build: () => ({
        executable: process.execPath,
        args: [
          "--import",
          "tsx",
          "extensions/memory-graph/scripts/chuck-v2-run.ts",
          "--capability-ledger",
          "--json",
        ],
      }),
    },
  ],
  [
    "docket-list",
    {
      lane: "diagnostic",
      build: () => ({
        executable: process.execPath,
        args: [
          "--import",
          "tsx",
          "extensions/memory-graph/scripts/chuck-v2-run.ts",
          "--docket",
          "--json",
        ],
      }),
    },
  ],
  [
    "prior-capsule",
    {
      lane: "memory",
      build: (task) => ({
        executable: process.execPath,
        args: [
          "extensions/memory-graph/scripts/chuck-prior-capsule.mjs",
          "--write",
          "--markdown",
          "--json",
          ...(task?.sourceTaskPath ? ["--source-task", task.sourceTaskPath] : []),
        ],
      }),
    },
  ],
  [
    "live-scout",
    {
      lane: "scout",
      build: (task) => ({
        executable: process.execPath,
        args: [
          "--import",
          "tsx",
          "extensions/memory-graph/scripts/chuck-v2-run.ts",
          "--live-scout",
          "--json",
          "--no-auto-deepen",
          ...includeProvisionalArgs(task),
          ...onlySurfaceArgs(task),
          taskIntentWithPrior(task),
        ],
      }),
    },
  ],
  [
    // codex-build — Chuck-builds-Chuck dispatch lane. Routes a docket task's
    // intent to codex CLI in workspace-write sandbox. Codex receives the
    // intent as its initial prompt, runs in REPO_ROOT (set by spawnBounded
    // cwd), can write within workspace but cannot escape repo. Stdout is
    // captured to the task's stdoutTail. The task intent SHOULD be a tight,
    // bounded build instruction (file paths, what to do, success criteria).
    // Loose intents will produce loose builds — write tight tasks.
    //
    // Sandbox: workspace-write (codex can read/write inside cwd; network is
    // restricted by codex's default policy). Safer than --dangerously-bypass.
    // Skip-git-repo-check tolerates the repo being on a feature branch with
    // uncommitted changes (true today: phase-1/sandbox-broker has untracked
    // codex chuck-* work).
    //
    // Codex auth is handled by the codex CLI itself via ChatGPT login at
    // ~/.codex/. The buildExecutorEnv() PATH augment ensures the codex
    // binary at ~/.openclaw/bin/codex (or /opt/homebrew/bin/codex) resolves
    // even under launchd's minimal PATH.
    "codex-build",
    {
      lane: "build",
      build: (task) => ({
        executable: `${homedir()}/.openclaw/bin/codex`,
        args: [
          "exec",
          "--sandbox",
          "workspace-write",
          "--skip-git-repo-check",
          "-C",
          REPO_ROOT,
          task?.intent ?? "no intent provided",
        ],
      }),
    },
  ],
  [
    // claude-cli-build — Chuck-builds-Chuck FAILOVER lane (per orchestrator
    // policy v1: claude-cli is failover for code/state/repo work when codex is
    // unavailable). Routes the docket task's intent to claude -p (Opus 4.7,
    // Max-CLI substrate) with full permission bypass + bypassPermissions mode
    // so claude can write/edit files in the cwd without per-action approval
    // prompts (since this is non-interactive batch execution).
    //
    // Use this commandKind when codex is OS-down or rate-limited and the
    // build is time-sensitive. Codex remains primary per the policy; this is
    // explicit second-string fallback. Codex returning healthy means future
    // tasks should still prefer codex-build for its repo-grounding strength.
    //
    // Sandbox: claude -p --permission-mode bypassPermissions allows tool use
    // without prompts; cwd is REPO_ROOT (set by spawnBounded) so writes are
    // bounded to the repo. claude does not have a sandbox flag equivalent to
    // codex --sandbox workspace-write, so the cwd boundary is the only fence.
    "claude-cli-build",
    {
      lane: "build",
      build: (task) => ({
        executable: "claude",
        args: [
          "-p",
          "--model",
          "opus",
          "--permission-mode",
          "bypassPermissions",
          task?.intent ?? "no intent provided",
        ],
      }),
    },
  ],
  [
    "mac-self-heal",
    {
      lane: "maintenance",
      build: (task) => ({
        executable: process.execPath,
        args: [
          "extensions/memory-graph/scripts/chuck-mac-self-heal.mjs",
          "apply",
          "--json",
          "--max-actions",
          String(parseOptionalPositiveInt(task?.maxActions) ?? 24),
          ...(typeof task?.cloudTarget === "string" && task.cloudTarget.trim()
            ? ["--cloud-target", task.cloudTarget.trim()]
            : []),
        ],
      }),
    },
  ],
]);

// 2026-04-29: opened up per Joseph's "open it up fully" — codex is locked till
// May 5 (and per Joseph "until further notice" claude-cli stays primary), so
// build lane gets paralleled. Claude Max sub has materially higher headroom
// than codex's per-account weekly cap; multi-task concurrency is now safe.
const EXECUTOR_GLOBAL_RUNNING_CAP = 6;
const EXECUTOR_LANE_POLICY = new Map([
  ["diagnostic", { maxRunning: 2, description: "read-only cockpit/doctor checks" }],
  ["scout", { maxRunning: 2, description: "model-family scout dispatch" }],
  [
    "build",
    {
      maxRunning: 2,
      description: "repo/state writing build lane (claude-cli primary, paralleled)",
    },
  ],
  ["memory", { maxRunning: 2, description: "prior/posterior maintenance" }],
  ["maintenance", { maxRunning: 2, description: "Mac self-heal and local stewardship" }],
]);

function parseArgs(argv) {
  const options = {
    dryRun: false,
    loop: false,
    intervalMs: DEFAULT_LOOP_INTERVAL_MS,
    timeoutMs: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--loop") {
      options.loop = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--interval-ms") {
      options.intervalMs = parsePositiveInt(argv[++i], "--interval-ms");
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(argv[++i], "--timeout-ms");
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
  node extensions/memory-graph/scripts/chuck-docket-executor.mjs [--dry-run] [--loop]

Options:
  --dry-run              Print eligible low-risk pending tasks without mutating.
  --loop                 Keep ticking with a 60s interval by default.
  --interval-ms <ms>     Override loop interval.
  --timeout-ms <ms>      Override child timeout. Default: 300000.
  --json                 Print machine-readable summaries.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.loop) {
    for (;;) {
      await tick(options);
      await sleep(options.intervalMs);
    }
  }
  const result = await tick(options);
  if (!options.json && !options.dryRun && result.paused) {
    console.log(`Executor intake paused: ${result.control?.reason || "no reason recorded"}`);
    return;
  }
  if (!options.json && !options.dryRun && !result.claimed) {
    console.log("No eligible low-risk pending Chuck v3 docket task found.");
  }
}

async function tick(options) {
  const control = await readExecutorControl();
  if (executorIntakePaused(control)) {
    if (options.dryRun) {
      printDryRun([], options, control);
    }
    return { claimed: false, eligible: 0, paused: true, control };
  }
  // Zombie sweep: tasks marked status=running whose lock-holder PID is dead
  // (or whose lock is missing entirely) get auto-recovered to status=failed.
  // Without this the queue silently gridlocks the moment a child crashes
  // before the executor can write a heartbeat — we hit this 2026-04-29 with
  // morning-digest + imagen-toolkit + cockpit-proposal all sitting "running"
  // for 2-3h with dead PIDs holding locks.
  if (!options.dryRun) {
    const recovered = await sweepZombieTasks();
    if (recovered.length) {
      console.log(
        `[zombie-sweep] recovered ${recovered.length} task(s): ${recovered.map((r) => r.taskId).join(", ")}`,
      );
    }
  }
  const entries = await loadEligibleTasks();
  if (options.dryRun) {
    printDryRun(entries, options, control);
    return { claimed: false, eligible: entries.length };
  }
  const next = entries[0];
  if (!next) {
    return { claimed: false, eligible: 0 };
  }
  const claimed = await claimTask(next);
  if (!claimed) {
    return { claimed: false, eligible: entries.length };
  }
  const claimedTimeoutPolicy = timeoutPolicyForTask(claimed.task, options);
  await emitBusEvent("claimed", claimed.task, {
    path: claimed.path,
    timeoutPolicy: claimedTimeoutPolicy,
    notificationCandidate: true,
    signal: signalEnvelope({
      category: "executor.task.claimed",
      severity: "info",
      subject: taskLabel(claimed.task),
      summary: `Claimed ${taskLabel(claimed.task)} on ${claimedTimeoutPolicy.lane} lane`,
      actionability: "observe",
      evidence: { path: claimed.path, timeoutPolicy: claimedTimeoutPolicy },
    }),
  });
  if (claimedTimeoutPolicy.capped) {
    await emitBusEvent("timeout-capped", claimed.task, {
      path: claimed.path,
      timeoutPolicy: claimedTimeoutPolicy,
      notificationCandidate: true,
      signal: signalEnvelope({
        category: "executor.timeout.capped",
        severity: "warn",
        subject: taskLabel(claimed.task),
        summary: `Requested timeout ${claimedTimeoutPolicy.requestedMs}ms was capped at ${claimedTimeoutPolicy.timeoutMs}ms`,
        actionability: "review-timeout-policy",
        needsAttention: true,
        evidence: { path: claimed.path, timeoutPolicy: claimedTimeoutPolicy },
      }),
    });
  }
  console.log(`Claimed ${taskLabel(claimed.task)} (${claimed.task.commandKind})`);
  try {
    const outcome = await runTask(claimed.task, options);
    await completeTask(claimed.path, outcome);
    const posteriorDeltas = await writePosteriorDeltas(claimed.path, outcome.task, options);
    if (posteriorDeltas) {
      outcome.task.posteriorDeltas = posteriorDeltas;
      await attachPosteriorDeltas(claimed.path, outcome.task.executorRunId, posteriorDeltas);
    }
    const priorRefresh = await refreshPriorCapsule(claimed.path, options);
    if (priorRefresh) {
      outcome.task.priorCapsule = priorRefresh;
      await attachPriorCapsule(claimed.path, outcome.task.executorRunId, priorRefresh);
    }
    await emitBusEvent(outcome.status, outcome.task, {
      path: claimed.path,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      posteriorDeltaCount: posteriorDeltas?.deltaCount ?? null,
      priorId: priorRefresh?.priorId ?? null,
      priorPath: priorRefresh?.path ?? null,
      timeoutPolicy: outcome.task.command?.timeoutPolicy ?? null,
      validation: outcome.validation ?? null,
      notificationCandidate: true,
      signal: signalEnvelope({
        category: `executor.task.${outcome.status}`,
        severity: outcome.status === "completed" ? "info" : "error",
        subject: taskLabel(outcome.task),
        summary: `${outcome.status === "completed" ? "Completed" : outcome.status === "failed-validation" ? "Failed-validation" : "Failed"} ${taskLabel(outcome.task)}`,
        actionability: outcome.status === "completed" ? "archive" : "inspect",
        needsAttention: outcome.status !== "completed",
        evidence: {
          path: claimed.path,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          timedOut: outcome.timedOut,
          timeoutPolicy: outcome.task.command?.timeoutPolicy ?? null,
          validation: outcome.validation ?? null,
        },
      }),
    });
    if (outcome.status === "failed-validation") {
      await emitBusEvent("validation_failed", outcome.task, {
        path: claimed.path,
        exitCode: outcome.exitCode,
        reason: outcome.validation?.reason ?? null,
        category: outcome.validation?.category ?? null,
        evidence: outcome.validation?.evidence ?? null,
        notificationCandidate: true,
      }).catch(() => {});
    }
    // 2026-04-29: auto-fire comms-cascade for failed and failed-validation
    // task outcomes. Cascade enforces tier-aware delivery (apex-apple-bridge
    // → telegram → imessage → digest), respects quiet-hours, records to
    // notification ledger. failed-validation gets warn severity (the task
    // LIED about success — interesting but not a system emergency); plain
    // failed gets warn too. Anti-spam dedup is handled inside the cascade
    // module so identical failures within 30s don't re-notify.
    if (outcome.status === "failed" || outcome.status === "failed-validation") {
      const taskTitle = outcome.task?.title || outcome.task?.id || "(no title)";
      const subject =
        outcome.status === "failed-validation"
          ? `Task validation failed: ${taskTitle}`
          : `Task failed: ${taskTitle}`;
      const bodyLines = [
        `commandKind: ${outcome.task?.command?.commandKind ?? "?"}`,
        `exit: ${outcome.exitCode ?? "null"}  signal: ${outcome.signal ?? "null"}  timedOut: ${outcome.timedOut}`,
      ];
      if (outcome.validation?.reason) bodyLines.push(`validation: ${outcome.validation.reason}`);
      if (outcome.task?.command?.failoverFrom) {
        bodyLines.push(
          `(failed-over from ${outcome.task.command.failoverFrom}: ${outcome.task.command.failoverReason ?? "no reason"})`,
        );
      }
      bodyLines.push(`task path: ${claimed.path}`);
      commsNotify({
        subject,
        body: bodyLines.join("\n"),
        severity: "warn",
        tier: "immediate-low-friction",
        origin: { kind: "chuck-docket-executor.task-failure", ref: outcome.task?.id ?? null },
      }).catch((e) => console.error(`[cascade] failed to fire notify: ${e?.message ?? e}`));
    }
    console.log(
      `${outcome.status === "completed" ? "Completed" : "Failed"} ${taskLabel(outcome.task)} exit=${outcome.exitCode ?? "null"} signal=${outcome.signal ?? "null"} timeout=${outcome.timedOut}`,
    );
    if (priorRefresh) {
      console.log(`Refreshed prior ${priorRefresh.priorId}`);
    }
    if (posteriorDeltas) {
      console.log(`Wrote ${posteriorDeltas.deltaCount} posterior delta(s)`);
    }
    return { claimed: true, eligible: entries.length, status: outcome.status };
  } finally {
    await releaseLock(claimed.lockPath);
  }
}

async function readExecutorControl() {
  try {
    const control = JSON.parse(await readFile(EXECUTOR_CONTROL_PATH, "utf8"));
    const mode = control?.mode === "paused" ? "paused" : "active";
    return {
      mode,
      paused: mode === "paused",
      reason: typeof control?.reason === "string" ? control.reason : "",
      updatedAt: control?.updatedAt ?? null,
      updatedBy: control?.updatedBy ?? null,
      path: EXECUTOR_CONTROL_PATH,
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        mode: "active",
        paused: false,
        reason: "default active; no control file",
        updatedAt: null,
        updatedBy: null,
        path: EXECUTOR_CONTROL_PATH,
      };
    }
    return {
      mode: "paused",
      paused: true,
      reason: `fail-closed: executor control unreadable (${err.message})`,
      updatedAt: null,
      updatedBy: SOURCE,
      path: EXECUTOR_CONTROL_PATH,
      failClosed: true,
    };
  }
}

function executorIntakePaused(control) {
  return control?.paused === true || control?.mode === "paused";
}

async function loadDocketTaskEntries() {
  let names;
  try {
    names = await readdir(DOCKET_DIR);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return [];
    }
    warn(`failed to read docket directory: ${err.message}`);
    return [];
  }
  const entries = [];
  for (const name of names.toSorted()) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const path = join(DOCKET_DIR, name);
    const loaded = await readTaskFile(path);
    if (!loaded.ok) {
      warn(`${name}: ${loaded.reason}`);
      continue;
    }
    const fileStat = await statSafe(path);
    if (!fileStat) {
      continue;
    }
    entries.push({ path, task: loaded.task, mtimeMs: fileStat.mtimeMs });
  }
  return entries;
}

async function loadEligibleTasks() {
  const entries = await loadDocketTaskEntries();
  return entries
    .filter((entry) => isEligible(entry.task, { activeEntries: entries }))
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs);
}

async function readTaskFile(path) {
  try {
    const text = await readFile(path, "utf8");
    const task = JSON.parse(text);
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      return { ok: false, reason: "task JSON is not an object" };
    }
    return { ok: true, task };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { ok: false, reason: "task file disappeared" };
    }
    if (err instanceof SyntaxError) {
      return { ok: false, reason: "malformed JSON" };
    }
    return { ok: false, reason: `read failed: ${err.message}` };
  }
}

function taskStatus(task) {
  return String(task?.status ?? "").toLowerCase();
}

function commandLane(commandKind) {
  return COMMANDS.get(commandKind)?.lane ?? null;
}

function readDiskStatus() {
  try {
    const statValue = statfsSync(homedir());
    const totalBytes = Number(statValue.blocks) * Number(statValue.bsize);
    const freeBytes = Number(statValue.bavail) * Number(statValue.bsize);
    return {
      available: true,
      path: homedir(),
      totalBytes,
      freeBytes,
      freePercent: totalBytes > 0 ? freeBytes / totalBytes : null,
    };
  } catch (err) {
    return { available: false, path: homedir(), reason: err.message };
  }
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
  const totalBytes = Number(match[1]) * MIB;
  const usedBytes = Number(match[2]) * MIB;
  const freeBytes = Number(match[3]) * MIB;
  return {
    available: true,
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: totalBytes > 0 ? usedBytes / totalBytes : null,
    raw: text.trim(),
  };
}

function macHealthGateStatus() {
  if (macGateCache && Date.now() - macGateCache.cachedAtMs < MAC_GATE_CACHE_MS) {
    return macGateCache.value;
  }
  const cpuCount = cpus().length || 1;
  const loads = loadavg();
  const totalMemoryBytes = totalmem();
  const freeMemoryBytes = freemem();
  const disk = readDiskStatus();
  const swap = readSwapStatus();
  const blockers = [];
  const signals = [];
  const loadRatio = loads[0] / cpuCount;
  const memoryFreePercent = totalMemoryBytes > 0 ? freeMemoryBytes / totalMemoryBytes : null;
  if (!disk.available) {
    blockers.push("mac health gate cannot read disk status");
    signals.push({
      category: "mac.disk",
      severity: "error",
      summary: disk.reason || "disk unavailable",
    });
  } else {
    const lowDisk =
      (disk.freePercent ?? 1) < MAC_GATE_THRESHOLDS.diskWarnFreePercent ||
      disk.freeBytes < MAC_GATE_THRESHOLDS.diskMinFreeBytes;
    if (lowDisk) {
      blockers.push(
        `mac disk gate: ${formatBytes(disk.freeBytes)} free below ${formatBytes(MAC_GATE_THRESHOLDS.diskMinFreeBytes)} or ${Math.round(MAC_GATE_THRESHOLDS.diskWarnFreePercent * 100)}%`,
      );
    }
    signals.push({
      category: "mac.disk",
      severity: lowDisk ? "warn" : "info",
      summary: `${formatBytes(disk.freeBytes)} free`,
      value: disk.freePercent,
    });
  }
  if (swap.available) {
    const highSwap = swap.usedBytes > MAC_GATE_THRESHOLDS.swapWarnUsedBytes;
    if (highSwap) {
      blockers.push(
        `mac swap gate: ${formatBytes(swap.usedBytes)} used above ${formatBytes(MAC_GATE_THRESHOLDS.swapWarnUsedBytes)}`,
      );
    }
    signals.push({
      category: "mac.swap",
      severity: highSwap ? "warn" : "info",
      summary: `${formatBytes(swap.usedBytes)} used`,
      value: swap.usedPercent,
    });
  }
  signals.push({
    category: "mac.load",
    severity: loadRatio > 2 ? "warn" : "info",
    summary: `load ${loads[0].toFixed(2)} / ${cpuCount} cores`,
    value: loadRatio,
  });
  signals.push({
    category: "mac.memory",
    severity: memoryFreePercent !== null && memoryFreePercent < 0.05 ? "warn" : "info",
    summary: `free memory ${Math.round((memoryFreePercent ?? 0) * 100)}%`,
    value: memoryFreePercent,
  });
  const value = {
    generatedAt: new Date().toISOString(),
    state: blockers.length > 0 ? "blocked" : "clear",
    blockers,
    thresholds: MAC_GATE_THRESHOLDS,
    load: { one: loads[0], five: loads[1], fifteen: loads[2], cpuCount, loadRatio },
    memory: {
      totalBytes: totalMemoryBytes,
      freeBytes: freeMemoryBytes,
      freePercent: memoryFreePercent,
    },
    disk,
    swap,
    signals,
  };
  macGateCache = { cachedAtMs: Date.now(), value };
  return value;
}

function macHealthGateBlockers(task) {
  const commandKind = String(task?.commandKind ?? "");
  if (MAC_GATE_EXEMPT_COMMAND_KINDS.has(commandKind)) {
    return [];
  }
  return macHealthGateStatus().blockers;
}

function runningEntries(entries) {
  return entries.filter((entry) => taskStatus(entry.task) === "running");
}

function eligibilityBlockers(task, { activeEntries = [] } = {}) {
  const blockers = [];
  const commandKind = typeof task?.commandKind === "string" ? task.commandKind : "";
  const lane = commandLane(commandKind);
  if (taskStatus(task) !== "pending") {
    blockers.push("status is not pending");
  }
  if (task?.risk !== "low") {
    blockers.push("risk is not low");
  }
  if (!COMMANDS.has(commandKind)) {
    blockers.push("commandKind is not executor-allowlisted");
  }
  if (COMMANDS.has(commandKind) && !commandHasRequiredFields(task)) {
    blockers.push(`${commandKind} is missing required fields`);
  }
  if (COMMANDS.has(commandKind)) {
    blockers.push(...macHealthGateBlockers(task));
  }
  if (lane && activeEntries.length > 0) {
    const activeRunning = runningEntries(activeEntries);
    const lanePolicy = EXECUTOR_LANE_POLICY.get(lane);
    const laneRunning = activeRunning.filter(
      (entry) => commandLane(entry.task?.commandKind) === lane,
    );
    if (activeRunning.length >= EXECUTOR_GLOBAL_RUNNING_CAP) {
      blockers.push(`global running cap ${EXECUTOR_GLOBAL_RUNNING_CAP} reached`);
    }
    if (lanePolicy && laneRunning.length >= lanePolicy.maxRunning) {
      blockers.push(`lane ${lane} running cap ${lanePolicy.maxRunning} reached`);
    }
  }
  return blockers;
}

function isEligible(task, context = {}) {
  return eligibilityBlockers(task, context).length === 0;
}

async function claimTask(entry) {
  const lockPath = `${entry.path}.lock`;
  const lock = await acquireLock(lockPath);
  if (!lock) {
    return null;
  }
  let claimed = null;
  try {
    const control = await readExecutorControl();
    if (executorIntakePaused(control)) {
      return null;
    }
    const beforeStat = await statSafe(entry.path);
    if (!beforeStat || beforeStat.mtimeMs !== entry.mtimeMs) {
      return null;
    }
    const fresh = await readTaskFile(entry.path);
    const activeEntries = await loadDocketTaskEntries();
    if (!fresh.ok || !isEligible(fresh.task, { activeEntries })) {
      return null;
    }
    const now = new Date().toISOString();
    const claimedTask = {
      ...fresh.task,
      status: "running",
      startedAt: fresh.task.startedAt ?? now,
      updatedAt: now,
      executorRunId: fresh.task.executorRunId ?? randomUUID(),
      heartbeats: [
        ...safeArray(fresh.task.heartbeats),
        {
          at: now,
          phase: "claimed",
          executor: SOURCE,
          commandKind: fresh.task.commandKind,
          lane: commandLane(fresh.task.commandKind),
          macHealthGate: macHealthGateStatus(),
        },
      ],
    };
    await writeJsonAtomic(entry.path, claimedTask);
    const after = await readTaskFile(entry.path);
    if (
      !after.ok ||
      after.task.executorRunId !== claimedTask.executorRunId ||
      after.task.status !== "running"
    ) {
      return null;
    }
    claimed = { path: entry.path, lockPath, task: after.task };
    return claimed;
  } finally {
    if (!claimed) {
      await releaseLock(lockPath);
    }
  }
}

async function runTask(task, options) {
  const taskForRun = taskWithPriorBeforeRun(task);
  // Lockout-aware failover: if a codex-build task fires while codex is in
  // lockout (set via apex-codex-budget lockout --until <iso>), transparently
  // route through claude-cli-build (Opus 4.7 via Claude Max) instead. The
  // requested commandKind + reason are preserved in the rollout for audit;
  // the effective commandKind is what actually ran. Per orchestrator policy v1.
  let effectiveCommandKind = task.commandKind;
  let failoverFromCommandKind = null;
  let failoverReason = null;
  if (task.commandKind === "codex-build") {
    try {
      const budget = checkCodexBudget();
      if (budget.lockoutActive) {
        effectiveCommandKind = "claude-cli-build";
        failoverFromCommandKind = "codex-build";
        failoverReason = `codex locked out until ${budget.lockoutUntil}: ${budget.lockoutReason || "no reason recorded"}`;
        console.log(
          `[failover] ${task.id ?? "(no id)"}: codex-build → claude-cli-build (${failoverReason})`,
        );
      }
    } catch (e) {
      // Budget probe failure is non-fatal — proceed with originally-requested
      // commandKind. If codex IS in fact rate-limited at OpenAI side, the
      // codex CLI will surface its own usage-limit error via stderrTail.
      console.error(`[failover-probe-error] ${task.id ?? "(no id)"}: ${e.message ?? e}`);
    }
  }
  const command = COMMANDS.get(effectiveCommandKind).build(taskForRun);
  const timeoutPolicy = timeoutPolicyForTask(
    { ...task, commandKind: effectiveCommandKind },
    options,
  );
  const started = Date.now();
  const result = await spawnBounded(command.executable, command.args, timeoutPolicy.timeoutMs);
  const now = new Date().toISOString();
  let status = result.exitCode === 0 && !result.signal && !result.timedOut ? "completed" : "failed";
  // Closed-loop validation: exit=0 alone is a leaky proxy for "task did the
  // thing." chuck-task-validator inspects intent text + filesystem to confirm
  // the deliverable actually shipped. Flips status to failed-validation when
  // the deliverable is missing/empty/stale/syntax-broken. Validator errors
  // never false-fail (they fall through to trust-exit-code).
  let validation = null;
  if (status === "completed") {
    try {
      validation = await validateTaskDeliverable({
        ...taskForRun,
        commandKind: effectiveCommandKind,
        status,
        executorRunId: taskForRun.executorRunId,
        startedAt: new Date(started).toISOString(),
        finishedAt: now,
        command: {
          commandKind: effectiveCommandKind,
          executable: command.executable,
          args: command.args,
        },
        stdoutTail: result.stdout,
        stderrTail: result.stderr,
      });
      if (!validation.valid) {
        status = "failed-validation";
        console.log(
          `[validator] ${task.id ?? "(no id)"}: completed exit 0 but validation failed — ${validation.reason}`,
        );
      }
    } catch (e) {
      console.error(`[validator-error] ${task.id ?? "(no id)"}: ${e?.message ?? e}`);
      validation = {
        valid: true,
        reason: `validator threw: ${e?.message ?? e}; trusting exit code`,
        category: "validator-error",
      };
    }
  }
  return {
    task: {
      ...taskForRun,
      status,
      finishedAt: now,
      updatedAt: now,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: Date.now() - started,
      command: {
        commandKind: effectiveCommandKind,
        requestedCommandKind: task.commandKind,
        failoverFrom: failoverFromCommandKind,
        failoverReason,
        lane: commandLane(effectiveCommandKind),
        executable: command.executable,
        args: command.args,
        cwd: REPO_ROOT,
        timeoutMs: timeoutPolicy.timeoutMs,
        timeoutPolicy,
      },
      validation: validation ?? {
        valid: true,
        reason: `task did not reach validation (status=${status})`,
        category: "skipped",
      },
      stdoutTail: tail(result.stdout, TAIL_LIMIT_CHARS),
      stderrTail: tail(result.stderr, TAIL_LIMIT_CHARS),
      heartbeats: [
        ...safeArray(task.heartbeats),
        {
          at: now,
          phase: status,
          executor: SOURCE,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          durationMs: Date.now() - started,
          timeoutPolicy,
          validation: validation
            ? { valid: validation.valid, reason: validation.reason, category: validation.category }
            : null,
        },
      ],
    },
    status,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    validation,
  };
}

function timeoutPolicyForTask(task, options = {}) {
  const lane = commandLane(task?.commandKind) ?? "unknown";
  const policy = LANE_TIMEOUT_POLICY.get(lane) ?? {
    defaultMs: DEFAULT_TIMEOUT_MS,
    longMs: DEFAULT_TIMEOUT_MS,
    maxMs: DEFAULT_TIMEOUT_MS,
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
  if (Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0) {
    source = "cli-override";
    requestedMs = options.timeoutMs;
  } else if (taskRequestedMs !== null) {
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

function parseOptionalPositiveInt(value) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function signalEnvelope({
  category,
  severity = "info",
  subject = "",
  summary = "",
  actionability = "observe",
  needsAttention = false,
  evidence = {},
} = {}) {
  return {
    schemaVersion: 1,
    category: category || "executor.signal",
    severity,
    subject,
    summary,
    actionability,
    needsAttention: needsAttention === true,
    evidence,
  };
}

function taskWithPriorBeforeRun(task) {
  const latestPrior = readLatestPriorReceipt();
  if (!latestPrior) {
    return task;
  }
  return {
    ...task,
    priorCapsuleBefore: {
      ...latestPrior,
      injectedIntoPrompt: task.commandKind === "live-scout",
      scope: task.commandKind === "live-scout" ? "summary" : "none",
    },
  };
}

function spawnBounded(executable, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    const effectiveTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(executable, args, {
      cwd: REPO_ROOT,
      env: buildExecutorEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* child already exited */
      }
    }, effectiveTimeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = tail(stdout + chunk, TAIL_LIMIT_CHARS);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = tail(stderr + chunk, TAIL_LIMIT_CHARS);
    });
    child.on("error", (err) => {
      stderr = tail(`${stderr}\nspawn error: ${err.message}`, TAIL_LIMIT_CHARS);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

async function completeTask(path, outcome) {
  const fresh = await readTaskFile(path);
  const base =
    fresh.ok &&
    fresh.task.status === "running" &&
    fresh.task.executorRunId === outcome.task.executorRunId
      ? fresh.task
      : outcome.task;
  await writeJsonAtomic(path, {
    ...base,
    ...outcome.task,
    heartbeats: outcome.task.heartbeats,
  });
}

async function refreshPriorCapsule(sourceTaskPath, options) {
  const command = COMMANDS.get("prior-capsule").build({ sourceTaskPath });
  const result = await spawnBounded(
    command.executable,
    command.args,
    timeoutPolicyForTask({ commandKind: "prior-capsule" }, options).timeoutMs,
  );
  if (result.exitCode !== 0 || result.signal || result.timedOut) {
    warn(
      `prior capsule refresh failed exit=${result.exitCode ?? "null"} signal=${result.signal ?? "null"} timeout=${result.timedOut}: ${tail(result.stderr || result.stdout, 1000)}`,
    );
    return null;
  }
  try {
    const receipt = JSON.parse(result.stdout);
    return {
      priorId: receipt.priorId ?? null,
      sourceHash: receipt.sourceHash ?? null,
      path: receipt.path ?? null,
      markdownPath: receipt.markdownPath ?? null,
      latestPath: receipt.latestPath ?? null,
      refreshedAt: receipt.createdAt ?? new Date().toISOString(),
    };
  } catch (err) {
    warn(`prior capsule refresh returned malformed JSON: ${err.message}`);
    return null;
  }
}

async function writePosteriorDeltas(sourceTaskPath, task, options) {
  const executionPaths = extractRunnerExecutionPaths(
    `${task.stdoutTail ?? ""}\n${task.stderrTail ?? ""}`,
  );
  if (executionPaths.length === 0) {
    return null;
  }
  const receipts = [];
  for (const executionPath of executionPaths) {
    if (!existsSync(executionPath)) {
      warn(`posterior delta skipped missing runner execution: ${executionPath}`);
      continue;
    }
    const command = {
      executable: process.execPath,
      args: [
        "extensions/memory-graph/scripts/chuck-posterior-delta.mjs",
        "from-runner-execution",
        "--runner-execution",
        executionPath,
        "--task",
        sourceTaskPath,
        "--prior",
        "latest",
        "--write",
        "--json",
      ],
    };
    const result = await spawnBounded(
      command.executable,
      command.args,
      timeoutPolicyForTask({ commandKind: "prior-capsule" }, options).timeoutMs,
    );
    if (result.exitCode !== 0 || result.signal || result.timedOut) {
      warn(
        `posterior delta write failed exit=${result.exitCode ?? "null"} signal=${result.signal ?? "null"} timeout=${result.timedOut}: ${tail(result.stderr || result.stdout, 1000)}`,
      );
      continue;
    }
    try {
      receipts.push(JSON.parse(result.stdout));
    } catch (err) {
      warn(`posterior delta writer returned malformed JSON: ${err.message}`);
    }
  }
  if (receipts.length === 0) {
    return null;
  }
  return {
    wroteAt: new Date().toISOString(),
    executionPaths,
    deltaCount: receipts.reduce((sum, receipt) => sum + Number(receipt.deltaCount ?? 0), 0),
    readMarkerCount: receipts.reduce(
      (sum, receipt) => sum + Number(receipt.readMarkerCount ?? 0),
      0,
    ),
    receipts: receipts.map((receipt) => ({
      executionPath: receipt.executionPath ?? null,
      runId: receipt.runId ?? null,
      priorId: receipt.priorId ?? null,
      deltaCount: receipt.deltaCount ?? 0,
      readMarkerCount: receipt.readMarkerCount ?? 0,
      deltas: Array.isArray(receipt.deltas) ? receipt.deltas : [],
      readMarkers: Array.isArray(receipt.readMarkers) ? receipt.readMarkers : [],
    })),
  };
}

async function attachPosteriorDeltas(path, executorRunId, posteriorDeltas) {
  const fresh = await readTaskFile(path);
  if (!fresh.ok || fresh.task.executorRunId !== executorRunId) {
    return;
  }
  const now = new Date().toISOString();
  await writeJsonAtomic(path, {
    ...fresh.task,
    posteriorDeltas,
    updatedAt: now,
    heartbeats: [
      ...safeArray(fresh.task.heartbeats),
      {
        at: now,
        phase: "posterior-deltas-written",
        executor: SOURCE,
        deltaCount: posteriorDeltas.deltaCount,
        readMarkerCount: posteriorDeltas.readMarkerCount,
      },
    ],
  });
}

async function attachPriorCapsule(path, executorRunId, priorRefresh) {
  const fresh = await readTaskFile(path);
  if (!fresh.ok || fresh.task.executorRunId !== executorRunId) {
    return;
  }
  const now = new Date().toISOString();
  await writeJsonAtomic(path, {
    ...fresh.task,
    priorCapsule: priorRefresh,
    updatedAt: now,
    heartbeats: [
      ...safeArray(fresh.task.heartbeats),
      {
        at: now,
        phase: "prior-refreshed",
        executor: SOURCE,
        priorId: priorRefresh.priorId,
        path: priorRefresh.path,
      },
    ],
  });
}

async function acquireLock(path) {
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
    await handle.close();
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") {
      // PID-based stale check first (fast + precise — beats the slow mtime
      // window). If the recorded holder PID is dead, the lock is stale
      // regardless of how recently it was created.
      const parsed = await readLockPid(path);
      if (parsed && !isPidAlive(parsed.pid)) {
        warn(`stale lock ${path}: pid ${parsed.pid} (since ${parsed.ts}) is dead — releasing`);
        await releaseLock(path);
        return acquireLock(path);
      }
      // Fall back to mtime-based stale check (covers locks with malformed
      // content or lock files written by an older executor format).
      const lockStat = await statSafe(path);
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await releaseLock(path);
        return acquireLock(path);
      }
      return false;
    }
    warn(`failed to create lock ${path}: ${err.message}`);
    return false;
  }
}

// Lock holder liveness check. Signal 0 doesn't deliver anything but raises
// ESRCH (no such process) if the pid is gone. EPERM means the pid IS alive
// but we don't have permission to signal it — still alive from our POV.
function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

// Lock file format is `${pid} ${iso8601}\n`. Returns {pid, ts} or null.
async function readLockPid(path) {
  try {
    const content = await readFile(path, "utf8");
    const m = content.match(/^(\d+)\s+(\S+)/);
    if (!m) return null;
    return { pid: Number(m[1]), ts: m[2] };
  } catch {
    return null;
  }
}

// Find tasks marked status=running whose lock-holder PID is dead (or whose
// lock is missing entirely) and auto-recover them to status=failed. Returns
// an array of {taskId, reason} for log/observability. Called once per tick
// before claim attempts so the queue self-heals from crashed children.
async function sweepZombieTasks() {
  const recovered = [];
  let entries;
  try {
    entries = await readdir(DOCKET_DIR);
  } catch {
    return recovered;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".lock")) continue;
    const taskPath = join(DOCKET_DIR, entry);
    const lockPath = `${taskPath}.lock`;
    let task;
    try {
      task = JSON.parse(await readFile(taskPath, "utf8"));
    } catch {
      continue;
    }
    if (task?.status !== "running") continue;
    const parsed = await readLockPid(lockPath);
    let reason = null;
    if (!parsed) {
      reason = "no lock file but task status=running";
    } else if (!isPidAlive(parsed.pid)) {
      reason = `lock-holder PID ${parsed.pid} (since ${parsed.ts}) is dead`;
    }
    if (!reason) continue;
    const now = new Date().toISOString();
    task.status = "failed";
    task.finishedAt = now;
    task.updatedAt = now;
    task.exitCode = null;
    task.signal = null;
    task.timedOut = false;
    task.stdoutTail = task.stdoutTail || "";
    task.stderrTail = `ZOMBIE RECOVERY (executor sweep ${now}): ${reason}. Auto-recovered. Re-promote as a fresh task to retry.`;
    const hb = Array.isArray(task.heartbeats) ? task.heartbeats.slice() : [];
    hb.push({ at: now, phase: "failed", message: `Zombie sweep — ${reason}` });
    task.heartbeats = hb;
    try {
      await writeJsonAtomic(taskPath, task);
      await releaseLock(lockPath);
      recovered.push({ taskId: task.id, reason });
      try {
        await emitBusEvent("zombie_recovered", task, { reason, sweptAt: now });
      } catch {}
    } catch (err) {
      warn(`zombie sweep failed to recover ${task.id}: ${err?.message ?? err}`);
    }
  }
  return recovered;
}

async function releaseLock(path) {
  await rm(path, { force: true }).catch(() => {});
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function statSafe(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function emitBusEvent(type, task, payload) {
  try {
    const busUrl = pathToFileURL(join(SCRIPTS_DIR, "apex-event-bus.mjs")).href;
    const bus = await import(busUrl);
    if (typeof bus.emit === "function") {
      await bus.emit({
        source: SOURCE,
        type: `chuck.docket.${type}`,
        payload: {
          taskId: task.id ?? task.taskId ?? null,
          title: task.title ?? null,
          commandKind: task.commandKind ?? null,
          ...payload,
        },
      });
    }
  } catch (err) {
    warn(`event bus emit failed: ${err.message}`);
  }
}

function printDryRun(entries, options, control = null) {
  const rows = entries.map(({ path, task }) => ({
    path,
    id: task.id ?? task.taskId ?? null,
    title: task.title ?? null,
    status: task.status,
    risk: task.risk,
    commandKind: task.commandKind,
    lane: commandLane(task.commandKind),
    timeoutPolicy: timeoutPolicyForTask(task, options),
  }));
  if (options.json) {
    console.log(JSON.stringify({ docketDir: DOCKET_DIR, control, eligible: rows }, null, 2));
    return;
  }
  if (executorIntakePaused(control)) {
    console.log(`Executor intake paused: ${control?.reason || "no reason recorded"}`);
    return;
  }
  if (rows.length === 0) {
    console.log(`No eligible low-risk pending tasks in ${DOCKET_DIR}`);
    return;
  }
  for (const row of rows) {
    console.log(`${row.commandKind.padEnd(18)} ${row.id ?? "(no id)"} ${row.title ?? row.path}`);
  }
}

function commandHasRequiredFields(task) {
  if (task.commandKind !== "live-scout") {
    return true;
  }
  return taskIntent(task).length > 0;
}

function includeProvisionalArgs(task) {
  return task.includeProvisional === true ? ["--include-provisional"] : [];
}

function onlySurfaceArgs(task) {
  if (!Array.isArray(task.onlySurfaces)) {
    return [];
  }
  const surfaces = task.onlySurfaces.map((surface) => String(surface ?? "").trim()).filter(Boolean);
  return surfaces.length > 0 ? ["--only-surface", surfaces.join(",")] : [];
}

function taskIntent(task) {
  return String(task.intent ?? task.prompt ?? "").trim();
}

function taskIntentWithPrior(task) {
  const intent = taskIntent(task);
  const prior = task.priorCapsuleBefore;
  if (!prior?.priorId) {
    return intent;
  }
  const lines = [
    "SHARED PRIOR CAPSULE (compact executor injection; same for every family surface in this task):",
    `priorId: ${prior.priorId}`,
    `sourceHash: ${prior.sourceHash ?? "unknown"}`,
  ];
  if (prior.focus) {
    lines.push(`focus: ${prior.focus}`);
  }
  if (Array.isArray(prior.openQuestions) && prior.openQuestions.length) {
    lines.push("openQuestions:");
    for (const question of prior.openQuestions.slice(0, 5)) {
      lines.push(`- ${question}`);
    }
  }
  if (Array.isArray(prior.recommendedNextActions) && prior.recommendedNextActions.length) {
    lines.push("recommendedNextActions:");
    for (const action of prior.recommendedNextActions.slice(0, 5)) {
      lines.push(`- ${action}`);
    }
  }
  lines.push(
    "Instruction: start from this prior, form your own family posterior, and explicitly flag any disagreement with the prior.",
  );
  lines.push("");
  lines.push("TASK:");
  lines.push(intent);
  return lines.join("\n");
}

function readLatestPriorReceipt() {
  if (!existsSync(LATEST_PRIOR)) {
    return null;
  }
  try {
    const prior = JSON.parse(readFileSync(LATEST_PRIOR, "utf8"));
    return {
      priorId: prior.priorId ?? null,
      sourceHash: prior.sourceHash ?? null,
      path: LATEST_PRIOR,
      createdAt: prior.createdAt ?? null,
      focus: prior.operatorIntent?.focus ?? null,
      activeTaskCount: Array.isArray(prior.activeTasks) ? prior.activeTasks.length : null,
      recentDocketCount: Array.isArray(prior.recentDocket) ? prior.recentDocket.length : null,
      openQuestions: Array.isArray(prior.openQuestions) ? prior.openQuestions.slice(0, 5) : [],
      recommendedNextActions: Array.isArray(prior.recommendedNextActions)
        ? prior.recommendedNextActions.slice(0, 5)
        : [],
      ledgerState: prior.ledgerState ?? null,
    };
  } catch (err) {
    warn(`failed to read latest prior: ${err.message}`);
    return null;
  }
}

function extractRunnerExecutionPaths(text) {
  const paths = new Set();
  const stringPattern = /"executionPath"\s*:\s*"([^"]+runner-executions[^"]+\.json)"/g;
  for (const match of text.matchAll(stringPattern)) {
    paths.add(match[1]);
  }
  const linePattern = /runnerExecutionPath:\s*(.+runner-executions.+\.json)/g;
  for (const match of text.matchAll(linePattern)) {
    paths.add(match[1].trim());
  }
  return [...paths];
}

function tail(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return text;
  }
  return text.slice(text.length - limit);
}

function formatBytes(bytes) {
  const value = Number(bytes ?? 0);
  if (value >= GIB) {
    return `${(value / GIB).toFixed(1)} GiB`;
  }
  if (value >= MIB) {
    return `${(value / MIB).toFixed(1)} MiB`;
  }
  return `${Math.round(value)} B`;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function taskLabel(task) {
  return task.id ?? task.taskId ?? task.title ?? "(untitled task)";
}

function warn(message) {
  process.stderr.write(`[${SOURCE}] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

process.on("SIGINT", () => {
  process.exit(130);
});

main().catch((err) => {
  warn(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
