#!/usr/bin/env node
// =============================================================================
// TRANSITIONAL DUPLICATE — Unit 9 of the openclaw-first migration (2026-05-01).
// =============================================================================
// The CANONICAL implementation lives at:
//   extensions/skill-self-improvement-scanner/src/* (re-exported via
//   @openclaw/skill-self-improvement-scanner api.ts)
//
// This .mjs preserves identical 6-detector / fingerprint-dedupe / anti-flood
// semantics so the LaunchAgent at
// ~/Library/LaunchAgents/com.openclaw.chuck-self-improvement-scanner.plist
// keeps firing every 6h unchanged. Vanilla Node can't import the TS plugin's
// api.ts at runtime, so duplicating the logic is the working seam. Both
// copies write to the same docket directory + last-scan.json.
//
// EDITS: bug fixes go in BOTH places (here AND
// extensions/skill-self-improvement-scanner/src/*.ts) until v0.2.
//
// The .mjs retires when openclaw cron grows long-running plugin-daemon
// support and absorbs the LaunchAgent.
// =============================================================================
//
// chuck-self-improvement-scanner — recursive autonomy primitive.
//
// Periodically scans Chuck's state for gaps and drops docket tasks to fix
// them. Mirrors apex-better's "universal exponential" pattern: every gap
// category gets a probe + remediation candidate; idempotency-keyed so the
// same gap isn't re-dropped on every scan.
//
// Six gap categories:
//   1. dockethealth — >5 failed tasks in 24h
//   2. stuckpending — pending task older than 6h
//   3. mcpgap       — apex-* MCP script not registered in all 3 configs
//   4. plistgap     — chuck-*-{executor,self-heal,digest,scanner}.mjs without launchd plist
//   5. skillgap     — executor commandKind without matching ~/.claude/skills/<kind>-* skill
//   6. busdiversity — fewer than 10 distinct event types in last 200 bus events
//
// Idempotency: state/chuck-v3/self-improvement/last-scan.json records open
// task ids per category. Before dropping a new task we check the docket
// for an existing pending/running task with matching source.fingerprint;
// if present, skip — the prior task is still working it.
//
// Anti-flood: at most 5 tasks per scan (regardless of how many gaps found).
//
// CLI:
//   node chuck-self-improvement-scanner.mjs scan
//   node chuck-self-improvement-scanner.mjs scan --dry-run
//   node chuck-self-improvement-scanner.mjs status

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const HOME = homedir();
const SCRIPTS_DIR = join(HOME, "Projects", "openclaw", "extensions", "memory-graph", "scripts");
const DOCKET_DIR = join(HOME, ".openclaw", "workspace", "state", "chuck-v3", "docket");
const SELF_IMPROV_DIR = join(
  HOME,
  ".openclaw",
  "workspace",
  "state",
  "chuck-v3",
  "self-improvement",
);
const LAST_SCAN_PATH = join(SELF_IMPROV_DIR, "last-scan.json");
const EVENTS_PATH = join(HOME, ".openclaw", "workspace", "state", "apex-events.jsonl");
const LAUNCHAGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const SKILLS_DIR = join(HOME, ".claude", "skills");
const CODEX_CONFIG = join(HOME, ".codex", "config.toml");
const OPENCLAW_CONFIG = join(HOME, ".openclaw", "openclaw.json");
const CLAUDE_CONFIG = join(HOME, ".claude.json");

const HOUR_MS = 60 * 60 * 1000;
const MAX_DROPS_PER_SCAN = 5;

const SCANNER_KIND = "chuck-self-improvement-scanner";

// Daemon-shape entrypoints that expect a launchd plist.
const PLIST_PATTERNS = [
  /^chuck-.*-executor\.mjs$/,
  /^chuck-.*-self-heal\.mjs$/,
  /^chuck-.*-digest\.mjs$/,
  /^chuck-.*-scanner\.mjs$/,
];

// Executor commandKinds (mirrors COMMANDS map in chuck-docket-executor.mjs).
// Hardcoded rather than imported because the executor doesn't export this.
const EXECUTOR_COMMAND_KINDS = [
  "bootstrap",
  "doctor",
  "capability-ledger",
  "docket-list",
  "prior-capsule",
  "live-scout",
  "codex-build",
  "claude-cli-build",
  "mac-self-heal",
];

// ─── FS helpers ──────────────────────────────────────────────────────────
function ensureDirs() {
  if (!existsSync(SELF_IMPROV_DIR)) {
    mkdirSync(SELF_IMPROV_DIR, { recursive: true });
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

function fingerprint(category, payload) {
  return createHash("sha1").update(`${category}::${payload}`).digest("hex").slice(0, 12);
}

// ─── Docket loading ──────────────────────────────────────────────────────
function loadDocket() {
  if (!existsSync(DOCKET_DIR)) return [];
  const out = [];
  for (const name of readdirSync(DOCKET_DIR)) {
    if (!name.endsWith(".json")) continue;
    const t = readJson(join(DOCKET_DIR, name), null);
    if (t) out.push(t);
  }
  return out;
}

function existingFingerprints(tasks, category) {
  const set = new Set();
  for (const t of tasks) {
    if (t?.source?.kind !== SCANNER_KIND) continue;
    if (t?.source?.category !== category) continue;
    if (!["pending", "running"].includes(t?.status)) continue;
    if (t?.source?.fingerprint) set.add(t.source.fingerprint);
  }
  return set;
}

// ─── Gap detectors ───────────────────────────────────────────────────────
function detectDocketHealth(tasks) {
  const cutoff = Date.now() - 24 * HOUR_MS;
  const recent = tasks.filter(
    (t) => t?.status === "failed" && t?.finishedAt && Date.parse(t.finishedAt) >= cutoff,
  );
  if (recent.length <= 5) return null;
  const list = recent
    .slice(0, 10)
    .map((t) => `${t.id} ('${t.title || "untitled"}'; exit=${t.exitCode ?? "?"})`);
  return {
    category: "dockethealth",
    fingerprint: fingerprint(
      "dockethealth",
      recent
        .map((t) => t.id)
        .sort()
        .join(","),
    ),
    title: `Investigate cluster of ${recent.length} recent docket failures`,
    intent: `Investigate the cluster of ${recent.length} recent failures in the last 24h: ${list.join("; ")}. Pull rollouts/heartbeats, identify common failure mode (executor blocker, lane cap, builder bug, model quota, MCP outage), propose fix or quarantine.`,
  };
}

function detectStuckPending(tasks, openFps) {
  const cutoff = Date.now() - 6 * HOUR_MS;
  const out = [];
  for (const t of tasks) {
    if (t?.status !== "pending") continue;
    if ((t?.createdAt ? Date.parse(t.createdAt) : Date.now()) > cutoff) continue;
    const fp = fingerprint("stuckpending", t.id);
    if (openFps.has(fp)) continue;
    out.push({
      category: "stuckpending",
      fingerprint: fp,
      title: `Diagnose stuck pending task: ${t.id}`,
      intent: `Diagnose why pending task ${t.id} ('${t.title || "untitled"}') hasn't been claimed in 6h+; check whether commandKind '${t.commandKind || "?"}' has a builder in chuck-docket-executor.mjs COMMANDS map, lane caps for surface '${t.surface || "?"}', executor-control pause state, or eligibility filters (risk, MAC_GATE).`,
    });
  }
  return out;
}

function detectMcpGap(openFps) {
  if (!existsSync(SCRIPTS_DIR)) return [];
  const allFiles = readdirSync(SCRIPTS_DIR).filter((n) => n.endsWith(".mjs"));
  const allMcp = allFiles.filter((n) => {
    if (!n.startsWith("apex-") && !n.endsWith("-toolkit.mjs")) return false;
    try {
      return /StdioServerTransport|McpServer\(/.test(
        readFileSync(join(SCRIPTS_DIR, n), "utf8").slice(0, 2000),
      );
    } catch {
      return false;
    }
  });

  const codexNames = new Set();
  try {
    for (const m of readFileSync(CODEX_CONFIG, "utf8").matchAll(
      /^\[mcp_servers\.([a-z][a-z0-9-]*)\]/gm,
    )) {
      codexNames.add(m[1]);
    }
  } catch {
    /* ignore */
  }
  const openclawCfg = readJson(OPENCLAW_CONFIG, {});
  const openclawNames = new Set(
    Object.keys(openclawCfg?.mcp?.servers || openclawCfg?.mcpServers || {}),
  );
  const claudeNames = new Set(Object.keys(readJson(CLAUDE_CONFIG, {})?.mcpServers || {}));

  const out = [];
  for (const script of allMcp) {
    const name = script.replace(/\.mjs$/, "");
    const missing = [];
    if (!codexNames.has(name)) missing.push("~/.codex/config.toml");
    if (!openclawNames.has(name)) missing.push("~/.openclaw/openclaw.json");
    if (!claudeNames.has(name)) missing.push("~/.claude.json");
    if (missing.length === 0) continue;
    const fp = fingerprint("mcpgap", `${name}::${missing.sort().join(",")}`);
    if (openFps.has(fp)) continue;
    out.push({
      category: "mcpgap",
      fingerprint: fp,
      title: `Register MCP '${name}' in ${missing.length} missing config(s)`,
      intent: `Register MCP server '${name}' (${join(SCRIPTS_DIR, script)}) in: ${missing.join(", ")}. Use existing memory-graph entry as template: codex TOML [mcp_servers.<name>] with command="node" args=[abs path]; openclaw + claude use JSON mcpServers/<name>. Restart loaded CLIs after.`,
      // Explicit deliverable: the config files being modified (NOT the source
      // .mjs script, which already exists and isn't touched). The validator
      // checks mtime > startedAt on these to confirm the registration landed.
      deliverable: { paths: [...missing] },
    });
  }
  return out;
}

function detectPlistGap(openFps) {
  if (!existsSync(SCRIPTS_DIR)) return [];
  const candidates = readdirSync(SCRIPTS_DIR).filter((n) =>
    PLIST_PATTERNS.some((re) => re.test(n)),
  );
  const out = [];
  for (const script of candidates) {
    const name = script.replace(/\.mjs$/, "");
    const plistPath = join(LAUNCHAGENTS_DIR, `com.openclaw.${name}.plist`);
    if (existsSync(plistPath)) continue;
    const fp = fingerprint("plistgap", name);
    if (openFps.has(fp)) continue;
    out.push({
      category: "plistgap",
      fingerprint: fp,
      title: `Build launchd plist for ${name}`,
      intent: `Build launchd plist at ${plistPath} for ${join(SCRIPTS_DIR, script)}. Default schedule: StartInterval=21600 (every 6h), RunAtLoad=true, KeepAlive=false, ProcessType=Background. Mirror com.openclaw.chuck-mac-self-heal.plist (logs at ~/.openclaw/logs/${name}.{out,err}.log; PATH includes nvm node bin). Load with 'launchctl load -w <path>'.`,
    });
  }
  return out;
}

function detectSkillGap(openFps) {
  if (!existsSync(SKILLS_DIR)) return [];
  const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const out = [];
  for (const kind of EXECUTOR_COMMAND_KINDS) {
    if (skillDirs.some((d) => new RegExp(`(^|-)${kind}(-|$)`).test(d))) continue;
    const fp = fingerprint("skillgap", kind);
    if (openFps.has(fp)) continue;
    out.push({
      category: "skillgap",
      fingerprint: fp,
      title: `Author skill for commandKind '${kind}' (low priority)`,
      intent: `Executor COMMANDS map defines '${kind}' but no skill in ~/.claude/skills/ matches. Consider authoring /${kind}-failover or /${kind}-explain so a Chuck operator can invoke this commandKind interactively. Low priority — skip if rarely used outside automated paths.`,
    });
  }
  return out;
}

function detectBusDiversity(openFps) {
  if (!existsSync(EVENTS_PATH)) return null;
  let lines = [];
  try {
    lines = readFileSync(EVENTS_PATH, "utf8").trim().split("\n").slice(-200);
  } catch {
    return null;
  }
  const types = new Set();
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (typeof e?.type === "string" && e.type.length > 0) types.add(e.type);
    } catch {
      /* skip */
    }
  }
  if (types.size >= 10) return null;
  const fp = fingerprint("busdiversity", `count:${types.size}`);
  if (openFps.has(fp)) return null;
  return {
    category: "busdiversity",
    fingerprint: fp,
    title: `Audit bus instrumentation: only ${types.size} distinct event types in last 200`,
    intent: `Apex bus shows only ${types.size} distinct event types in last 200 events (threshold 10). Audit silent subsystems — candidates: chuck-dashboard interactions, chuck-telegram-poller inbound, chuck-prior-capsule writes, chuck-posterior-delta, capability self-heals, MCP lifecycle. Propose 1-line emit() at meaningful seams. Currently-seen: ${[...types].slice(0, 8).join(", ")}.`,
  };
}

// ─── Task creation ───────────────────────────────────────────────────────
function buildTask(gap, nowMs) {
  const id = `task-selfimprov-${nowMs}`;
  const nowIso = new Date(nowMs).toISOString();
  const task = {
    id,
    title: gap.title,
    status: "pending",
    risk: "low",
    commandKind: "claude-cli-build",
    surface: "chuck-cockpit",
    intent: gap.intent,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: SCANNER_KIND,
    source: {
      kind: SCANNER_KIND,
      category: gap.category,
      fingerprint: gap.fingerprint,
    },
    heartbeats: [
      {
        at: nowIso,
        phase: "pending",
        message: `Auto-promoted by ${SCANNER_KIND}: ${gap.title}`,
      },
    ],
  };
  // Detector-supplied explicit deliverable wins over validator's intent-text
  // inference. mcpgap sets this to the config files being modified — without
  // it, the validator guesses the source .mjs script and false-fails.
  if (gap.deliverable && typeof gap.deliverable === "object") {
    task.deliverable = gap.deliverable;
  }
  return task;
}

function writeTask(task) {
  if (!existsSync(DOCKET_DIR)) mkdirSync(DOCKET_DIR, { recursive: true });
  const path = join(DOCKET_DIR, `${task.id}.json`);
  writeFileSync(path, JSON.stringify(task, null, 2) + "\n", "utf8");
  return path;
}

// ─── Main scan ───────────────────────────────────────────────────────────
async function runScan({ dryRun = false } = {}) {
  ensureDirs();
  const tasks = loadDocket();

  // Aggregate gaps from all six detectors. Each gets its own openFps set.
  const fpsByCat = {};
  for (const c of [
    "dockethealth",
    "stuckpending",
    "mcpgap",
    "plistgap",
    "skillgap",
    "busdiversity",
  ]) {
    fpsByCat[c] = existingFingerprints(tasks, c);
  }

  const gaps = [];
  const dh = detectDocketHealth(tasks);
  if (dh && !fpsByCat.dockethealth.has(dh.fingerprint)) gaps.push(dh);
  gaps.push(...detectStuckPending(tasks, fpsByCat.stuckpending));
  gaps.push(...detectMcpGap(fpsByCat.mcpgap));
  gaps.push(...detectPlistGap(fpsByCat.plistgap));
  gaps.push(...detectSkillGap(fpsByCat.skillgap));
  const bd = detectBusDiversity(fpsByCat.busdiversity);
  if (bd) gaps.push(bd);

  // Anti-flood: drop at most MAX_DROPS_PER_SCAN per run.
  const toEmit = gaps.slice(0, MAX_DROPS_PER_SCAN);

  const dropped = [];
  const skipped = gaps.length - toEmit.length;
  let nowMs = Date.now();
  for (const gap of toEmit) {
    // Bump unique ms to avoid id collision when two gaps share the same ms.
    nowMs += 1;
    const task = buildTask(gap, nowMs);
    if (dryRun) {
      dropped.push({ id: task.id, category: gap.category, title: gap.title, dryRun: true });
    } else {
      const path = writeTask(task);
      dropped.push({ id: task.id, category: gap.category, title: gap.title, path });
    }
  }

  // Update last-scan.json.
  if (!dryRun) {
    const refreshedTasks = loadDocket();
    const openByCat = {};
    for (const c of Object.keys(fpsByCat)) {
      openByCat[c] = refreshedTasks
        .filter(
          (t) =>
            t?.source?.kind === SCANNER_KIND &&
            t?.source?.category === c &&
            ["pending", "running"].includes(t?.status),
        )
        .map((t) => t.id);
    }
    writeFileSync(
      LAST_SCAN_PATH,
      JSON.stringify(
        {
          lastScanAt: new Date().toISOString(),
          openTaskIdsByCategory: openByCat,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }

  return {
    dryRun,
    gapsFound: gaps.length,
    dropped,
    floodSkipped: skipped,
  };
}

function runStatus() {
  const last = readJson(LAST_SCAN_PATH, null);
  const tasks = loadDocket();
  const openByCat = {};
  for (const c of [
    "dockethealth",
    "stuckpending",
    "mcpgap",
    "plistgap",
    "skillgap",
    "busdiversity",
  ]) {
    openByCat[c] = tasks
      .filter(
        (t) =>
          t?.source?.kind === SCANNER_KIND &&
          t?.source?.category === c &&
          ["pending", "running"].includes(t?.status),
      )
      .map((t) => ({ id: t.id, status: t.status, title: t.title }));
  }
  return {
    lastScanAt: last?.lastScanAt ?? null,
    openTaskIdsByCategory: openByCat,
    counts: Object.fromEntries(Object.entries(openByCat).map(([k, v]) => [k, v.length])),
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "scan";
  const dryRun = argv.includes("--dry-run");

  if (cmd === "scan") {
    const summary = await runScan({ dryRun });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (cmd === "status") {
    console.log(JSON.stringify(runStatus(), null, 2));
    return;
  }
  console.error(`unknown command: ${cmd}`);
  console.error(`usage: chuck-self-improvement-scanner.mjs {scan [--dry-run] | status}`);
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
