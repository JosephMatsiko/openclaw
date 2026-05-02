#!/usr/bin/env node
// =============================================================================
// TRANSITIONAL DUPLICATE — Unit 8 of the openclaw-first migration (2026-05-01).
// =============================================================================
// The CANONICAL implementation of the typed surface lives at:
//   extensions/skill-gateway-watchdog/src/* (re-exported via
//   @openclaw/skill-gateway-watchdog api.ts)
//
// This .mjs preserves the long-running daemon (60s poll loop + signal
// handling) that the LaunchAgent at
// ~/Library/LaunchAgents/com.openclaw.chuck-gateway-watchdog.plist invokes.
// The TS plugin v0.1 ships the read-only typed surface (probe / tick /
// status / restartGateway primitives); v0.2 will fold the daemon in
// when openclaw cron supports long-running plugin daemons.
//
// EDITS to the typed surface (probe primitives, tick logic, state IO,
// thresholds) go in BOTH places (here AND
// extensions/skill-gateway-watchdog/src/*.ts) until v0.2.
//
// EDITS to the daemon (poll loop, signal handlers) stay here only.
// =============================================================================
//
// chuck-gateway-watchdog — durable substrate-ceiling fix at the operational layer.
//
// The kernel rewrite (src/agents/ollama-runtime/) ships the runtime adapter
// and is bundled into dist/, but the dispatch site at attempt-execution.ts:374
// is NOT reached for `openclaw agent` CLI runs (the CLI takes a different
// agent-command.ts path that bypasses the attempt-execution dispatch). The
// underlying gateway pinning (claude-cli subprocess blocks event loop ~2 min
// per session-lane run) remains until that path is fully traced + patched.
//
// Until then, this watchdog is the durable solution at the operations layer:
// it polls gateway event-loop health, and when the gateway is pinned past a
// threshold, auto-restarts via launchctl. Joseph's daily flow stays usable
// because pin events become 30-second auto-recoveries instead of multi-minute
// hangs.
//
// Defaults are evidence-derived (per "nothing arbitrary"):
//   POLL_INTERVAL_MS 60s — telegram polling stalls after ~150s blocked, so
//     we want to detect + act before users notice.
//   PIN_DETECTION_WINDOW_MS 4 min — the worst observed pin (gateway PID 7803
//     2026-04-30) was 6.7 min sustained. 4 min is "definitely a pin," not just
//     a long agent run.
//   COOLDOWN_AFTER_RESTART_MS 5 min — give the new gateway PID time to cold-
//     start (build-info, plugins load, channel sidecars connect) before the
//     next health check.
//   RESTART_BACKOFF_BASE_MS 2 min — anti-flap if restart doesn't fix the
//     issue (e.g. config bug). Doubles each successive failure to a max of
//     1 hour.
//   MAX_RESTARTS_PER_DAY 12 — sanity cap. If we hit this, something is broken
//     beyond auto-recovery and Joseph needs to intervene.
//
// CLI:
//   node chuck-gateway-watchdog.mjs run         — daemon loop
//   node chuck-gateway-watchdog.mjs status      — print current state + history
//   node chuck-gateway-watchdog.mjs probe       — one-shot health check (no restart)
//   node chuck-gateway-watchdog.mjs --dry-run   — daemon mode without restart action

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const WORKSPACE_STATE = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V3 = join(WORKSPACE_STATE, "chuck-v3");
const WATCHDOG_DIR = join(CHUCK_V3, "gateway-watchdog");
const STATE_PATH = join(WATCHDOG_DIR, "state.json");
const EVENTS_PATH = join(WORKSPACE_STATE, "apex-events.jsonl");
const ERR_LOG_PATH = join(HOME, ".openclaw", "logs", "gateway.err.log");

const SOURCE = "chuck-gateway-watchdog";
const POLL_INTERVAL_MS = 60_000;
const PIN_DETECTION_WINDOW_MS = 4 * 60 * 1000;
const COOLDOWN_AFTER_RESTART_MS = 5 * 60 * 1000;
const RESTART_BACKOFF_BASE_MS = 2 * 60 * 1000;
const RESTART_BACKOFF_MAX_MS = 60 * 60 * 1000;
const MAX_RESTARTS_PER_DAY = 12;
const HISTORY_LIMIT = 200;

const GATEWAY_LAUNCHD_TARGET = "gui/501/ai.openclaw.gateway";

function nowIso() {
  return new Date().toISOString();
}
function nowMs() {
  return Date.now();
}

function ensureDirs() {
  if (!existsSync(WATCHDOG_DIR)) mkdirSync(WATCHDOG_DIR, { recursive: true });
}

function emitEvent(type, payload) {
  const ev = {
    id: `e-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
    ts: nowIso(),
    actor: "chuck",
    source: SOURCE,
    type,
    payload,
  };
  try {
    appendFileSync(EVENTS_PATH, JSON.stringify(ev) + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function loadState() {
  return readJson(STATE_PATH, {
    startedAt: null,
    lastProbe: null,
    history: [],
    restartCount: 0,
    restartCountToday: 0,
    todayKey: new Date().toISOString().slice(0, 10),
    nextRestartAllowedMs: 0,
    consecutiveRestartFailures: 0,
  });
}

function saveState(state) {
  state.history = (state.history || []).slice(-HISTORY_LIMIT);
  ensureDirs();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// Find the gateway PID via pgrep. Returns null if not running.
function findGatewayPid() {
  const res = spawnSync("/usr/bin/pgrep", ["-f", "openclaw.*dist/index.js gateway"], {
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  const pids = res.stdout
    .trim()
    .split("\n")
    .map((s) => parseInt(s, 10))
    .filter(Boolean);
  return pids[0] || null;
}

// Read the gateway's recent event-loop liveness warnings from its err log.
// Returns the count + most-recent block duration in the last `windowMs`.
function recentEventLoopBlocks(windowMs) {
  if (!existsSync(ERR_LOG_PATH)) return { count: 0, maxBlockMs: 0, lastTs: null };
  let buf;
  try {
    const all = readFileSync(ERR_LOG_PATH, "utf8");
    buf = all.length > 2_000_000 ? all.slice(-2_000_000) : all;
  } catch {
    return { count: 0, maxBlockMs: 0, lastTs: null };
  }
  const lines = buf.split("\n");
  const cutoff = nowMs() - windowMs;
  let count = 0;
  let maxBlockMs = 0;
  let lastTs = null;
  // Patterns emitted by gateway diagnostic when event-loop is blocked.
  // e.g. "eventLoopDelayMaxMs=128513.5" "eventLoopUtilization=1"
  const blockRe = /eventLoopDelayMaxMs=([\d.]+)/;
  const tsRe = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-\d{2}:\d{2})/;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes("liveness warning")) continue;
    const tsm = line.match(tsRe);
    if (!tsm) continue;
    const ts = Date.parse(tsm[1]);
    if (!ts) continue;
    if (ts < cutoff) break;
    const m = line.match(blockRe);
    if (!m) continue;
    const ms = parseFloat(m[1]);
    if (Number.isFinite(ms)) {
      count += 1;
      if (ms > maxBlockMs) {
        maxBlockMs = ms;
        lastTs = tsm[1];
      }
    }
  }
  return { count, maxBlockMs, lastTs };
}

// Read gateway process %CPU from ps. Returns null if not found.
function readGatewayCpu(pid) {
  if (!pid) return null;
  const res = spawnSync("/bin/ps", ["-p", String(pid), "-o", "%cpu="], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const v = parseFloat(res.stdout.trim());
  return Number.isFinite(v) ? v : null;
}

// Probe: returns { pid, cpu, eventLoopBlocks: {count, maxBlockMs, lastTs}, healthy, reason }
function probe() {
  const pid = findGatewayPid();
  if (!pid) {
    return {
      pid: null,
      cpu: null,
      eventLoopBlocks: { count: 0, maxBlockMs: 0, lastTs: null },
      healthy: false,
      reason: "gateway process not found",
    };
  }
  const cpu = readGatewayCpu(pid);
  const blocks = recentEventLoopBlocks(PIN_DETECTION_WINDOW_MS);
  // Healthy = no event-loop blocks > 60s in the last 4 min, AND cpu < 80%.
  // 60s threshold is the "annoying but acceptable" line — anything longer is
  // a real pin.
  const recentLongBlock = blocks.maxBlockMs > 60_000;
  const sustainedHighCpu = (cpu ?? 0) > 80;
  const healthy = !recentLongBlock && !sustainedHighCpu;
  const reasonParts = [];
  if (recentLongBlock)
    reasonParts.push(
      `event-loop blocked ${Math.round(blocks.maxBlockMs / 1000)}s (last ${blocks.lastTs})`,
    );
  if (sustainedHighCpu) reasonParts.push(`cpu ${cpu}%`);
  return {
    pid,
    cpu,
    eventLoopBlocks: blocks,
    healthy,
    reason: reasonParts.join(", ") || "ok",
  };
}

function restartGateway() {
  const start = nowMs();
  const res = spawnSync("/bin/launchctl", ["kickstart", "-k", GATEWAY_LAUNCHD_TARGET], {
    encoding: "utf8",
  });
  const durationMs = nowMs() - start;
  return {
    ok: res.status === 0,
    durationMs,
    error: res.status !== 0 ? res.stderr || `exit ${res.status}` : null,
  };
}

function rollDayBucket(state) {
  const todayKey = new Date().toISOString().slice(0, 10);
  if (state.todayKey !== todayKey) {
    state.todayKey = todayKey;
    state.restartCountToday = 0;
  }
}

async function tick(opts = {}) {
  ensureDirs();
  const state = loadState();
  if (!state.startedAt) state.startedAt = nowIso();
  rollDayBucket(state);

  const p = probe();
  const ts = nowIso();
  state.lastProbe = { ts, ...p };
  state.history.push({ ts, ...p, action: null });

  // Bail conditions: healthy, in cooldown, hit daily cap.
  if (p.healthy) {
    saveState(state);
    return { action: "healthy", probe: p };
  }
  if (nowMs() < state.nextRestartAllowedMs) {
    state.history[state.history.length - 1].action = "deferred-cooldown";
    saveState(state);
    return {
      action: "deferred-cooldown",
      probe: p,
      nextAllowedAt: new Date(state.nextRestartAllowedMs).toISOString(),
    };
  }
  if (state.restartCountToday >= MAX_RESTARTS_PER_DAY) {
    state.history[state.history.length - 1].action = "daily-cap-hit";
    emitEvent("chuck.gateway.watchdog.cap_hit", {
      restartCountToday: state.restartCountToday,
      max: MAX_RESTARTS_PER_DAY,
      reason: p.reason,
    });
    saveState(state);
    return { action: "daily-cap-hit", probe: p };
  }

  // Restart.
  emitEvent("chuck.gateway.watchdog.restart_initiated", {
    pid: p.pid,
    cpu: p.cpu,
    blockSummary: p.eventLoopBlocks,
    reason: p.reason,
    restartCountToday: state.restartCountToday,
  });
  let restart;
  if (opts.dryRun) {
    restart = { ok: true, durationMs: 0, dryRun: true };
  } else {
    restart = restartGateway();
  }
  state.history[state.history.length - 1].action = restart.ok ? "restarted" : "restart-failed";
  state.history[state.history.length - 1].restart = restart;
  if (restart.ok) {
    state.restartCount += 1;
    state.restartCountToday += 1;
    state.consecutiveRestartFailures = 0;
    state.nextRestartAllowedMs = nowMs() + COOLDOWN_AFTER_RESTART_MS;
    emitEvent("chuck.gateway.watchdog.restart_completed", {
      durationMs: restart.durationMs,
      restartCount: state.restartCount,
      restartCountToday: state.restartCountToday,
    });
  } else {
    state.consecutiveRestartFailures += 1;
    const backoff = Math.min(
      RESTART_BACKOFF_BASE_MS * Math.pow(2, state.consecutiveRestartFailures - 1),
      RESTART_BACKOFF_MAX_MS,
    );
    state.nextRestartAllowedMs = nowMs() + backoff;
    emitEvent("chuck.gateway.watchdog.restart_failed", {
      error: restart.error,
      consecutiveFailures: state.consecutiveRestartFailures,
      backoffMs: backoff,
    });
  }
  saveState(state);
  return { action: state.history[state.history.length - 1].action, probe: p, restart };
}

async function runDaemon(opts = {}) {
  emitEvent("chuck.gateway.watchdog.daemon_started", {
    pollIntervalMs: POLL_INTERVAL_MS,
    pinDetectionWindowMs: PIN_DETECTION_WINDOW_MS,
    cooldownAfterRestartMs: COOLDOWN_AFTER_RESTART_MS,
    maxRestartsPerDay: MAX_RESTARTS_PER_DAY,
    dryRun: opts.dryRun === true,
  });
  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });
  while (!stopping) {
    try {
      await tick(opts);
    } catch (err) {
      console.error(`[gateway-watchdog] tick error: ${err?.stack || err}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  emitEvent("chuck.gateway.watchdog.daemon_stopped", {});
}

function runStatus() {
  const state = loadState();
  rollDayBucket(state);
  const p = probe();
  return {
    daemonStartedAt: state.startedAt,
    lastProbe: state.lastProbe,
    currentProbe: p,
    restartCount: state.restartCount,
    restartCountToday: state.restartCountToday,
    consecutiveRestartFailures: state.consecutiveRestartFailures,
    nextRestartAllowedAt: state.nextRestartAllowedMs
      ? new Date(state.nextRestartAllowedMs).toISOString()
      : null,
    historyTail: (state.history || []).slice(-10).reverse(),
    config: {
      pollIntervalMs: POLL_INTERVAL_MS,
      pinDetectionWindowMs: PIN_DETECTION_WINDOW_MS,
      cooldownAfterRestartMs: COOLDOWN_AFTER_RESTART_MS,
      maxRestartsPerDay: MAX_RESTARTS_PER_DAY,
    },
  };
}

async function main() {
  const cmd = process.argv[2] || "run";
  const opts = { dryRun: process.argv.includes("--dry-run") };
  if (cmd === "run") {
    await runDaemon(opts);
  } else if (cmd === "probe") {
    console.log(JSON.stringify(probe(), null, 2));
  } else if (cmd === "status") {
    console.log(JSON.stringify(runStatus(), null, 2));
  } else if (cmd === "tick") {
    const r = await tick(opts);
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.error("usage: chuck-gateway-watchdog {run | probe | status | tick} [--dry-run]");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
