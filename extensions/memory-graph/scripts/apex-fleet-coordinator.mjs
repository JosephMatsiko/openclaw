#!/usr/bin/env node
// Apex Fleet Coordinator — health-driven worker role assignment.
//
// Runs `probeAll()` from worker-probe, writes fleet health to
// ~/.openclaw/workspace/state/worker-health.json, and assigns roles to
// the healthiest worker per slot.
//
// Role assignments (priority order per role):
//   research-primary   : claude > gemini > research-gemini-chat (Chrome Pro)
//   research-secondary : gemini > claude > ollama
//   embedding          : ollama > (none; embedding becomes unavailable)
//   search             : searxng > duckduckgo (always available via apex-search)
//   quickchat          : claude (sonnet) > gemini (flash) > ollama
//
// On state transitions (a role changes active-worker), emits
// `apex-fleet-coordinator` `role-changed` events. If all workers for a
// critical role are DOWN, emits `role-degraded` and optionally escalates
// via Telegram.
//
// Writes state:
//   ~/.openclaw/workspace/state/worker-health.json — full probe snapshot
//   ~/.openclaw/workspace/state/fleet-roles.json   — role→worker map
//
// Usage:
//   node apex-fleet-coordinator.mjs                   # run + reassign + emit
//   node apex-fleet-coordinator.mjs --dry-run         # probe + plan only
//   node apex-fleet-coordinator.mjs --escalate=off    # never telegram-escalate

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emit } from "./apex-event-bus.mjs";
import { probeAll } from "./worker-probe.mjs";

const HOME = homedir();
const STATE_DIR = join(HOME, ".openclaw", "workspace", "state");
const HEALTH_PATH = join(STATE_DIR, "worker-health.json");
const ROLES_PATH = join(STATE_DIR, "fleet-roles.json");
const TELEGRAM_ALLOW_FROM = join(
  HOME,
  ".openclaw",
  "credentials",
  "telegram-default-allowFrom.json",
);
const OPENCLAW_CLI = join(HOME, "Projects", "openclaw", "openclaw.mjs");
const NODE_BIN = process.execPath;

// Role priority — first healthy worker wins.
// Chrome-driven Plus/Pro subscription workers (chatgpt, perplexity) are
// sovereign-viable (real Chrome via apex-chrome-lib, no PAYG) but
// slower per-turn than CLI workers. Ranked below CLI workers, above
// ollama for research roles. apex-route's handleAsk runs ALL healthy
// workers in parallel via apex-dispatch — this policy just picks
// single-worker fallback order for role slots.
const ROLE_POLICY = {
  "research-primary": [
    "claude",
    "gemini",
    "chatgpt",
    "perplexity",
    "claude-ai",
    "aistudio",
    "grok",
  ],
  "research-secondary": [
    "gemini",
    "chatgpt",
    "perplexity",
    "claude-ai",
    "aistudio",
    "grok",
    "claude",
    "ollama",
  ],
  embedding: ["ollama"],
  search: ["searxng", "duckduckgo-builtin"],
  quickchat: [
    "claude",
    "gemini",
    "chatgpt",
    "perplexity",
    "grok",
    "claude-ai",
    "aistudio",
    "ollama",
  ],
  // Code-lane — Claude Code is the home-field master; Codex + Gemini
  // give additional cloud-sandboxed + grounded perspectives. Codex
  // is sovereignty-gated per research-chatgpt-codex.mjs.
  "code-review": ["claude", "codex", "gemini"],
};

// Critical roles — degradation triggers escalation.
const CRITICAL_ROLES = new Set(["research-primary", "quickchat"]);

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function readJson(path, fallback) {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, obj) {
  ensureStateDir();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, path);
}

function pickAssignment(health) {
  const out = {};
  const degraded = [];
  for (const [role, candidates] of Object.entries(ROLE_POLICY)) {
    let chosen = null;
    for (const c of candidates) {
      if (c === "duckduckgo-builtin") {
        chosen = c;
        break;
      }
      if (health?.[c]?.healthy) {
        chosen = c;
        break;
      }
    }
    out[role] = chosen;
    if (!chosen) {
      degraded.push(role);
    }
  }
  return { assignments: out, degraded };
}

function resolveTarget() {
  if (!existsSync(TELEGRAM_ALLOW_FROM)) {
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(TELEGRAM_ALLOW_FROM, "utf8"));
    const first = Array.isArray(data?.allowFrom) ? data.allowFrom[0] : null;
    return typeof first === "string" ? first.trim() : null;
  } catch {
    return null;
  }
}

async function sendEscalation(body, { target }) {
  return new Promise((resolve) => {
    const child = spawn(
      NODE_BIN,
      [
        OPENCLAW_CLI,
        "message",
        "send",
        "--channel",
        "telegram",
        "--target",
        target,
        "--message",
        body,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("close", (code) => resolve({ ok: code === 0, code, stderr }));
    child.on("error", (err) =>
      resolve({ ok: false, code: -1, stderr: err?.message ?? String(err) }),
    );
  });
}

export async function runCoordinator({ dryRun = false, escalate = true } = {}) {
  const health = await probeAll({ forceRefresh: true });
  const { assignments, degraded } = pickAssignment(health);
  const prior = readJson(ROLES_PATH, { assignments: {}, updatedAt: null });

  const changes = [];
  for (const [role, worker] of Object.entries(assignments)) {
    const priorWorker = prior.assignments?.[role] ?? null;
    if (worker !== priorWorker) {
      changes.push({ role, from: priorWorker, to: worker });
    }
  }

  const snapshot = {
    assignments,
    degraded,
    updatedAt: new Date().toISOString(),
    healthBrief: Object.fromEntries(
      Object.entries(health).map(([k, v]) => [
        k,
        { healthy: v.healthy, latencyMs: v.latencyMs, details: v.details },
      ]),
    ),
  };

  if (dryRun) {
    return { changes, snapshot, health, escalated: false };
  }

  writeJsonAtomic(HEALTH_PATH, { updatedAt: snapshot.updatedAt, workers: health });
  writeJsonAtomic(ROLES_PATH, snapshot);

  for (const c of changes) {
    await emit({
      source: "apex-fleet-coordinator",
      type: "role-changed",
      payload: c,
    });
  }

  let escalated = false;
  const criticalDegraded = degraded.filter((r) => CRITICAL_ROLES.has(r));
  if (criticalDegraded.length > 0) {
    await emit({
      source: "apex-fleet-coordinator",
      type: "role-degraded",
      payload: { degraded: criticalDegraded, health },
    });
    if (escalate) {
      const target = resolveTarget();
      if (target) {
        const body = [
          "*Apex fleet — role degradation*",
          "",
          `Critical roles with no healthy worker: ${criticalDegraded.join(", ")}`,
          "",
          ...Object.entries(health).map(
            ([k, v]) => `· ${k}: ${v.healthy ? "READY" : "DOWN"} — ${v.details}`,
          ),
        ].join("\n");
        const r = await sendEscalation(body, { target });
        escalated = r.ok;
      }
    }
  }

  return { changes, snapshot, health, escalated };
}

// ---- CLI ---------------------------------------------------------------

async function mainCli() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const escalate = !argv.some((a) => a === "--escalate=off");
  const res = await runCoordinator({ dryRun, escalate });
  console.log(
    `[apex-fleet-coordinator] changes=${res.changes.length} degraded=${res.snapshot.degraded.join(",") || "—"} escalated=${res.escalated}`,
  );
  for (const c of res.changes) {
    console.log(
      `  · ${c.role}: ${typeof c.from === "string" ? c.from : "(none)"} → ${typeof c.to === "string" ? c.to : "(none)"}`,
    );
  }
  for (const [role, w] of Object.entries(res.snapshot.assignments)) {
    console.log(`  role ${role} → ${typeof w === "string" ? w : "(no worker)"}`);
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  mainCli().catch((err) => {
    console.error(
      `[apex-fleet-coordinator] fatal: ${err instanceof Error ? err.stack : String(err)}`,
    );
    process.exitCode = 1;
  });
}
