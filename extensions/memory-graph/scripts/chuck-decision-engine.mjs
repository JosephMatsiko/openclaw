#!/usr/bin/env node
// chuck-decision-engine — autonomy primitive: detect → decide → propose.
//
// Where chuck-self-improvement-scanner is gap-detect (just identifies missing
// wiring), this is a true policy-decide loop. It scans Chuck's actual
// operating state, generates structured proposals (situation + options +
// recommendation + rationale + risk class + rollback path), and either
// auto-applies low-risk docket-promotions immediately or stages a proposal
// file + Telegram-notifies Joseph for medium/high-risk.
//
// Six decision detectors:
//   a. failed-task-cluster — >=3 failed tasks in 6h sharing commandKind
//   b. zombie-cluster      — >=3 chuck.zombie_recovered events in 24h
//   c. channel-drift       — enabled channel silent 7d+
//   d. scanner-tune        — scanner-promoted tasks failing >50% (n>=5)
//   e. orphan-mcp          — apex-* MCP script registered in 0/3 CLI registries
//   f. stale-mac-heal      — mac-self-heal latest.json > 12h old
//
// Risk → action:
//   low   → auto-apply only if action is "drop a docket task". Config edits
//           (even low-risk) stage as proposal for Joseph.
//   med   → stage proposal + Telegram notify
//   high  → stage proposal + Telegram notify
//
// Idempotency: state/chuck-v3/decisions/last-scan.json keyed by
// pattern-fingerprint + timestamp; skip same fingerprint emitted in last 12h.
// Anti-flood: max 3 proposals per scan.
//
// CLI:
//   node chuck-decision-engine.mjs scan [--dry-run]
//   node chuck-decision-engine.mjs status
//   node chuck-decision-engine.mjs apply <decision-id>
//   node chuck-decision-engine.mjs reject <decision-id> [--reason "..."]

import { execSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const SCRIPTS_DIR = join(HOME, "Projects", "openclaw", "extensions", "memory-graph", "scripts");
const WORKSPACE_STATE = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V3 = join(WORKSPACE_STATE, "chuck-v3");
const DOCKET_DIR = join(CHUCK_V3, "docket");
const DECISIONS_DIR = join(CHUCK_V3, "decisions");
const LAST_SCAN_PATH = join(DECISIONS_DIR, "last-scan.json");
const EVENTS_PATH = join(WORKSPACE_STATE, "apex-events.jsonl");
const MAC_HEAL_LATEST = join(CHUCK_V3, "mac-self-heal", "latest.json");
const MAC_HEAL_RECEIPTS = join(CHUCK_V3, "mac-self-heal", "receipts");
const HEALTH_SNAPSHOT = join(CHUCK_V3, "health-snapshot.json");
const OPENCLAW_CONFIG = join(HOME, ".openclaw", "openclaw.json");
const CODEX_CONFIG = join(HOME, ".codex", "config.toml");
const CLAUDE_CONFIG = join(HOME, ".claude.json");

const ENGINE_KIND = "chuck-decision-engine";
const TELEGRAM_CHAT_ID = "8630163522";

const HOUR_MS = 60 * 60 * 1000;
const MAX_PROPOSALS_PER_SCAN = 3;
const FINGERPRINT_DEDUP_WINDOW_MS = 12 * HOUR_MS;

// ─── FS / util helpers ───────────────────────────────────────────────────
function ensureDirs() {
  for (const d of [DECISIONS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
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

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function fp(category, payload) {
  return createHash("sha1").update(`${category}::${payload}`).digest("hex").slice(0, 12);
}

function decisionId() {
  return `decision-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

// Tail last N lines without slurping the whole file. Falls back to slurp on error.
function tailLines(path, maxLines) {
  if (!existsSync(path)) return [];
  try {
    const buf = readFileSync(path, "utf8");
    const lines = buf.split("\n");
    return lines.slice(-maxLines - 1).filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function emitEvent(type, payload) {
  const ev = {
    id: `e-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
    ts: new Date().toISOString(),
    actor: "chuck",
    source: ENGINE_KIND,
    type,
    payload,
  };
  try {
    appendFileSync(EVENTS_PATH, JSON.stringify(ev) + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

// ─── Loaders ─────────────────────────────────────────────────────────────
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

function loadEvents(maxLines = 500) {
  return tailLines(EVENTS_PATH, maxLines)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadRecentReceipts(n = 20) {
  if (!existsSync(MAC_HEAL_RECEIPTS)) return [];
  const files = readdirSync(MAC_HEAL_RECEIPTS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .slice(-n);
  return files.map((f) => readJson(join(MAC_HEAL_RECEIPTS, f), null)).filter(Boolean);
}

// ─── Detectors (each returns proposal-shaped object or null) ─────────────
function detectFailedTaskCluster(tasks) {
  const cutoff = Date.now() - 6 * HOUR_MS;
  const recent = tasks.filter(
    (t) =>
      t?.status === "failed" && t?.commandKind && t?.updatedAt && Date.parse(t.updatedAt) >= cutoff,
  );
  if (recent.length < 3) return null;
  const byKind = new Map();
  for (const t of recent) byKind.set(t.commandKind, (byKind.get(t.commandKind) || 0) + 1);
  let bestKind = null,
    bestCount = 0;
  for (const [k, c] of byKind)
    if (c > bestCount) {
      bestKind = k;
      bestCount = c;
    }
  if (bestCount < 3) return null;
  const ids = recent
    .filter((t) => t.commandKind === bestKind)
    .map((t) => t.id)
    .slice(0, 8);
  return {
    category: "failed-task-cluster",
    fingerprint: fp("failed-task-cluster", `${bestKind}:${bestCount}`),
    situation: `Lane '${bestKind}' shows ${bestCount} failed tasks in last 6h`,
    options: [
      {
        label: "investigate",
        action: "Read task heartbeats + executor logs to identify root cause",
      },
      {
        label: "quarantine",
        action: `Add commandKind '${bestKind}' to executor pause list until cause identified`,
      },
    ],
    recommendation: "investigate",
    rationale: `${bestCount} failures clustered on same commandKind in 6h suggests a systemic issue (builder bug, model quota, MCP outage). Investigation surfaces the root cause; quarantine masks it.`,
    riskClass: "medium",
    evidence: { commandKind: bestKind, count: bestCount, taskIds: ids, windowHours: 6 },
    rollback: `If quarantine is chosen, remove '${bestKind}' from executor pause list to resume promotion.`,
  };
}

function detectZombieClusterEvents(events) {
  const cutoff = Date.now() - 24 * HOUR_MS;
  const zombies = events.filter((e) => {
    if (!e?.ts || Date.parse(e.ts) < cutoff) return false;
    return e?.type === "chuck.zombie_recovered" || e?.type === "zombie_recovered";
  });
  if (zombies.length < 3) return null;
  const lanes = new Map();
  for (const z of zombies) {
    const lane = z?.payload?.lane || z?.payload?.commandKind || z?.source || "unknown";
    lanes.set(lane, (lanes.get(lane) || 0) + 1);
  }
  let dominantLane = null,
    dominantCount = 0;
  for (const [l, c] of lanes)
    if (c > dominantCount) {
      dominantLane = l;
      dominantCount = c;
    }
  return {
    category: "zombie-cluster",
    fingerprint: fp("zombie-cluster", `${dominantLane}:${zombies.length}`),
    situation: `Executor recovered ${zombies.length} zombie processes in last 24h (dominant lane: ${dominantLane}, ${dominantCount} occurrences)`,
    options: [
      {
        label: "tighten-timeout",
        action: `Reduce LANE_TIMEOUT_POLICY for lane '${dominantLane}' so child processes get killed cleanly before zombie state`,
      },
      {
        label: "investigate-exit-pattern",
        action:
          "Read recent task logs for the affected lane to find the child-process exit signal pattern",
      },
    ],
    recommendation: "investigate-exit-pattern",
    rationale: `${zombies.length} zombie recoveries means children are exiting in ways the executor doesn't reap cleanly. Investigating exit pattern first preserves diagnostic signal; tightening timeout is the corrective lever once the pattern is known.`,
    riskClass: "medium",
    evidence: { totalZombies: zombies.length, dominantLane, dominantCount, windowHours: 24 },
    rollback: `If timeout tightening is applied, restore prior LANE_TIMEOUT_POLICY value (typically 30 min) to revert.`,
  };
}

function detectChannelDrift(events) {
  const cfg = readJson(OPENCLAW_CONFIG, {});
  const channels = cfg?.channels || {};
  const cutoff = Date.now() - 7 * 24 * HOUR_MS;
  const drifted = [];
  for (const [name, c] of Object.entries(channels)) {
    if (!c?.enabled) continue;
    const seen = events.some((e) => {
      if (!e?.ts || Date.parse(e.ts) < cutoff) return false;
      const t = e?.type || "";
      const s = e?.source || "";
      const p = JSON.stringify(e?.payload || {});
      return (
        t.startsWith(`chat.`) ||
        t.startsWith(`channel.`) ||
        s.includes(name) ||
        p.includes(`"channel":"${name}"`) ||
        p.includes(`"channel": "${name}"`)
      );
    });
    if (!seen) drifted.push(name);
  }
  if (drifted.length === 0) return null;
  const candidate = drifted[0]; // one at a time to keep proposals small
  return {
    category: "channel-drift",
    fingerprint: fp("channel-drift", candidate),
    situation: `Channel '${candidate}' is enabled in openclaw.json but has zero events in apex-events.jsonl over last 7 days`,
    options: [
      {
        label: "retire",
        action: `Set channels.${candidate}.enabled = false in openclaw.json (reversible)`,
      },
      {
        label: "investigate-routing",
        action: `Probe channel '${candidate}' send/receive path to confirm whether it's routing correctly but silent vs. actually broken`,
      },
    ],
    recommendation: "investigate-routing",
    rationale: `Silence is ambiguous — could mean Joseph never uses the channel (retire fits) or routing is broken (retire would mask it). Investigation resolves the ambiguity. Other drifted enabled channels: ${drifted.slice(1).join(", ") || "none"}.`,
    riskClass: "low",
    evidence: { channel: candidate, otherDrifted: drifted.slice(1), windowDays: 7 },
    rollback: `If retire is applied: set channels.${candidate}.enabled = true in openclaw.json.`,
  };
}

function detectScannerFailureRate(tasks) {
  const cutoff = Date.now() - 7 * 24 * HOUR_MS;
  const scannerTasks = tasks.filter(
    (t) =>
      t?.source?.kind === "chuck-self-improvement-scanner" &&
      t?.updatedAt &&
      Date.parse(t.updatedAt) >= cutoff,
  );
  if (scannerTasks.length < 5) return null;
  const failed = scannerTasks.filter((t) => t.status === "failed").length;
  const rate = failed / scannerTasks.length;
  if (rate <= 0.5) return null;
  return {
    category: "scanner-tune",
    fingerprint: fp("scanner-tune", `${scannerTasks.length}:${failed}`),
    situation: `Self-improvement-scanner promoted ${scannerTasks.length} tasks in 7d; ${failed} failed (${(rate * 100).toFixed(0)}%)`,
    options: [
      {
        label: "tighten-fingerprint",
        action: "Tune scanner fingerprint dedup so repeat-failure tasks aren't re-promoted",
      },
      {
        label: "raise-risk",
        action:
          "Reclassify scanner tasks from low → medium risk so they require Joseph review before claim",
      },
      {
        label: "audit-detectors",
        action:
          "Audit which detector category produces the most failures and refine its intent text",
      },
    ],
    recommendation: "audit-detectors",
    rationale: `>50% failure rate means scanner is generating malformed or impossible tasks. Auditing per-detector failure breakdown is the diagnostic step; raising-risk is throttling without fix; tightening-fingerprint hides repeat-failures without fixing root cause.`,
    riskClass: "low",
    evidence: {
      totalPromoted: scannerTasks.length,
      failed,
      rate: Number(rate.toFixed(3)),
      windowDays: 7,
    },
    rollback: `Revert any detector intent text edits via git; risk-class change is a single line in chuck-self-improvement-scanner.mjs buildTask().`,
  };
}

function detectOrphanMcpScripts() {
  if (!existsSync(SCRIPTS_DIR)) return null;
  const files = readdirSync(SCRIPTS_DIR).filter(
    (n) => n.endsWith(".mjs") && (n.startsWith("apex-") || n.endsWith("-toolkit.mjs")),
  );
  // MCP-server-shaped: contains StdioServerTransport or McpServer( in first ~2KB
  const mcpFiles = files.filter((n) => {
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
    const tomlText = readFileSync(CODEX_CONFIG, "utf8");
    for (const m of tomlText.matchAll(/^\[mcp_servers\.([a-z][a-z0-9-]*)\]/gm))
      codexNames.add(m[1]);
  } catch {
    /* ignore */
  }
  const openclawCfg = readJson(OPENCLAW_CONFIG, {});
  const openclawNames = new Set(
    Object.keys(openclawCfg?.mcp?.servers || openclawCfg?.mcpServers || {}),
  );
  const claudeNames = new Set(Object.keys(readJson(CLAUDE_CONFIG, {})?.mcpServers || {}));

  const orphans = [];
  for (const f of mcpFiles) {
    const name = f.replace(/\.mjs$/, "");
    const registered =
      (codexNames.has(name) ? 1 : 0) +
      (openclawNames.has(name) ? 1 : 0) +
      (claudeNames.has(name) ? 1 : 0);
    if (registered === 0) orphans.push(name);
  }
  if (orphans.length === 0) return null;
  const candidate = orphans[0];
  return {
    category: "orphan-mcp",
    fingerprint: fp("orphan-mcp", candidate),
    situation: `MCP-shaped script '${candidate}' exists in scripts/ but is registered in 0/3 CLI registries (codex, openclaw, claude)`,
    options: [
      {
        label: "wire-all-three",
        action: `Add '${candidate}' entry to ~/.codex/config.toml + ~/.openclaw/openclaw.json mcp.servers + ~/.claude.json mcpServers, then restart loaded CLIs`,
      },
      {
        label: "leave-as-library",
        action: `If '${candidate}' is intended as an internal library only, leave it but rename to drop the apex-/-toolkit prefix to avoid future false-positives`,
      },
    ],
    recommendation: "wire-all-three",
    rationale: `Script declares MCP-server shape (StdioServerTransport or McpServer) but no consumer can reach it. Either it should be wired everywhere (capability voice) or its naming is misleading. Wiring is the higher-value path. Other orphans this scan: ${orphans.slice(1).join(", ") || "none"}.`,
    riskClass: "low",
    evidence: { script: candidate, otherOrphans: orphans.slice(1), registeredIn: 0 },
    rollback: `Remove the entries from each of the three configs; CLI restart unwires it.`,
  };
}

function detectStaleMacHeal() {
  const latest = readJson(MAC_HEAL_LATEST, null);
  if (!latest?.updatedAt) {
    return {
      category: "stale-mac-heal",
      fingerprint: fp("stale-mac-heal", "missing"),
      situation: `mac-self-heal/latest.json missing or unreadable`,
      options: [
        {
          label: "verify-launchd",
          action: "Check launchctl list | grep mac-self-heal and run a forced sweep manually",
        },
        {
          label: "rebuild-state",
          action: "Run `chuck-mac-self-heal apply --json` once to seed latest.json",
        },
      ],
      recommendation: "verify-launchd",
      rationale: `Missing latest.json means the daemon may have never run or state is corrupt. Verify the launchd job before assuming the daemon code is broken.`,
      riskClass: "low",
      evidence: { latestPath: MAC_HEAL_LATEST, exists: existsSync(MAC_HEAL_LATEST) },
      rollback: `n/a — verification only.`,
    };
  }
  const ageMs = Date.now() - Date.parse(latest.updatedAt);
  if (ageMs <= 12 * HOUR_MS) return null;
  const ageHours = (ageMs / HOUR_MS).toFixed(1);
  return {
    category: "stale-mac-heal",
    fingerprint: fp("stale-mac-heal", `age:${Math.floor(ageMs / HOUR_MS)}h`),
    situation: `mac-self-heal hasn't run in ${ageHours}h (latest update: ${latest.updatedAt})`,
    options: [
      {
        label: "verify-launchd",
        action:
          "Check `launchctl list | grep mac-self-heal` and inspect logs at ~/.openclaw/logs/chuck-mac-self-heal.{out,err}.log",
      },
      {
        label: "force-sweep",
        action:
          "Run `chuck-mac-self-heal apply --json --max-actions 24 --only-under-pressure` manually to confirm the binary still works",
      },
    ],
    recommendation: "verify-launchd",
    rationale: `Daemon scheduled every 15 min — 12h+ silence indicates launchd job is unloaded, throttled, or crashing. Verifying launchctl state is the cheap diagnostic step.`,
    riskClass: "low",
    evidence: { latestUpdatedAt: latest.updatedAt, ageHours: Number(ageHours) },
    rollback: `n/a — verification only.`,
  };
}

// ─── Risk → action policy ────────────────────────────────────────────────
// Low risk + action mentions "drop a docket task" → auto-apply.
// Everything else stages a proposal.
function shouldAutoApply(proposal) {
  if (proposal.riskClass !== "low") return false;
  const rec = (proposal.recommendation || "").toLowerCase();
  const opt = (proposal.options || []).find((o) => (o.label || "").toLowerCase() === rec);
  const action = (opt?.action || "").toLowerCase();
  // Auto-apply only "drop a docket task" style actions. Config edits never auto-apply.
  return (
    action.includes("drop a docket task") ||
    (action.includes("promote") && !action.includes("openclaw.json"))
  );
}

// ─── Auto-apply: drop a follow-on docket task ────────────────────────────
function dropFollowupDocketTask(decision) {
  if (!existsSync(DOCKET_DIR)) mkdirSync(DOCKET_DIR, { recursive: true });
  const ts = Date.now();
  const taskId = `task-decision-${ts}`;
  const nowIso = new Date(ts).toISOString();
  const recOption = (decision.options || []).find((o) => o.label === decision.recommendation);
  const intent = `Decision-engine auto-promotion. Situation: ${decision.situation}. Recommended action: ${recOption?.action || decision.recommendation}. Rationale: ${decision.rationale}. Rollback: ${decision.rollback}. Decision id: ${decision.id}.`;
  const task = {
    id: taskId,
    title: `Decision-engine: ${decision.situation.slice(0, 80)}`,
    status: "pending",
    risk: "low",
    commandKind: "claude-cli-build",
    surface: "chuck-cockpit",
    intent,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: ENGINE_KIND,
    source: {
      kind: ENGINE_KIND,
      category: decision.category,
      fingerprint: decision.fingerprint,
      decisionId: decision.id,
    },
    heartbeats: [{ at: nowIso, phase: "pending", message: `Auto-promoted by ${ENGINE_KIND}` }],
  };
  writeJson(join(DOCKET_DIR, `${taskId}.json`), task);
  return { taskId, action: `dropped docket task ${taskId}` };
}

// ─── Telegram notify ─────────────────────────────────────────────────────
//
// Preferred path: openclaw message send (gateway-routed, observable in event
// ledger). Falls back to raw Bot API curl if the openclaw CLI fails or times
// out — the decision engine must remain delivery-resilient even when the
// gateway is degraded.
//
// Sync (spawnSync) by intent: the caller is a sync `for` loop in `runScan`
// and decision-engine is a one-shot CLI scan that exits on completion. Total
// per-scan budget is bounded by MAX_PROPOSALS_PER_SCAN × OPENCLAW_NATIVE_TIMEOUT.
const OPENCLAW_CLI = "/Users/josephmatsiko/Projects/openclaw/dist/index.js";
const OPENCLAW_NATIVE_TIMEOUT_MS = 30_000;

function sendViaOpenclawSync(channel, target, text) {
  const start = Date.now();
  const res = spawnSync(
    process.execPath,
    [
      OPENCLAW_CLI,
      "message",
      "send",
      "--channel",
      channel,
      "--target",
      target,
      "--message",
      text,
      "--silent",
      "--json",
    ],
    { timeout: OPENCLAW_NATIVE_TIMEOUT_MS, encoding: "utf8" },
  );
  const durationMs = Date.now() - start;
  if (res.error) {
    return { ok: false, durationMs, error: `openclaw native: ${res.error.message}` };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || "").slice(-300).trim();
    return {
      ok: false,
      durationMs,
      error: `openclaw native exit ${res.status}: ${stderr || "unknown"}`,
    };
  }
  try {
    const stdout = res.stdout || "";
    const lastBrace = stdout.lastIndexOf("\n{");
    const payloadJson = lastBrace >= 0 ? stdout.slice(lastBrace).trim() : stdout.trim();
    const payload = JSON.parse(payloadJson);
    const ok = payload?.payload?.ok === true || payload?.action === "send";
    const messageId =
      payload?.payload?.messageId ??
      payload?.payload?.payload?.messageId ??
      payload?.payload?.id ??
      null;
    if (ok) {
      return { ok: true, durationMs, messageId, transport: "openclaw-native" };
    }
    return {
      ok: false,
      durationMs,
      error: `openclaw native payload not-ok: ${payloadJson.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      ok: false,
      durationMs,
      error: `openclaw native parse failed: ${err?.message ?? err}`,
    };
  }
}

function sendTelegramNotification(decision) {
  const recOption = (decision.options || []).find((o) => o.label === decision.recommendation);
  const text = [
    `Chuck decision proposal (${decision.riskClass.toUpperCase()})`,
    ``,
    `${decision.situation}`,
    ``,
    `Recommendation: ${decision.recommendation} — ${recOption?.action || ""}`,
    `Rationale: ${decision.rationale}`,
    ``,
    `Reply with /decision approve ${decision.id} or /decision reject ${decision.id}`,
  ].join("\n");

  // Preferred path: openclaw native.
  const native = sendViaOpenclawSync("telegram", TELEGRAM_CHAT_ID, text);
  if (native.ok) {
    return {
      sent: true,
      messageId: native.messageId,
      transport: native.transport,
      durationMs: native.durationMs,
    };
  }

  // Fallback: raw Bot API curl.
  const cfg = readJson(OPENCLAW_CONFIG, {});
  const token = cfg?.channels?.telegram?.botToken;
  if (!token) {
    return {
      sent: false,
      reason: `${native.error}; raw fallback skipped (no botToken in openclaw.json)`,
    };
  }
  try {
    const safe = text.replace(/'/g, `'\\''`);
    const cmd = `curl -sS -X POST 'https://api.telegram.org/bot${token}/sendMessage' --data-urlencode 'chat_id=${TELEGRAM_CHAT_ID}' --data-urlencode 'text=${safe}'`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 10_000 });
    const parsed = JSON.parse(out);
    if (parsed?.ok) {
      return {
        sent: true,
        messageId: parsed?.result?.message_id,
        transport: "raw-bot-api",
        nativeError: native.error,
      };
    }
    return {
      sent: false,
      reason: `${native.error}; raw fallback api not-ok: ${parsed?.description || "unknown"}`,
    };
  } catch (err) {
    return {
      sent: false,
      reason: `${native.error}; raw fallback threw: ${err?.message || String(err)}`,
    };
  }
}

// ─── Decision file IO ────────────────────────────────────────────────────
function writeDecision(decision) {
  writeJson(join(DECISIONS_DIR, `${decision.id}.json`), decision);
}

function loadDecisions() {
  if (!existsSync(DECISIONS_DIR)) return [];
  return readdirSync(DECISIONS_DIR)
    .filter((n) => n.startsWith("decision-") && n.endsWith(".json"))
    .map((n) => readJson(join(DECISIONS_DIR, n), null))
    .filter(Boolean);
}

function loadLastScan() {
  return readJson(LAST_SCAN_PATH, { fingerprints: {} });
}

function saveLastScan(state) {
  writeJson(LAST_SCAN_PATH, state);
}

// ─── Main scan ───────────────────────────────────────────────────────────
async function runScan({ dryRun = false } = {}) {
  ensureDirs();
  if (!dryRun) emitEvent("chuck.decision.scan.started", { dryRun: false });

  const tasks = loadDocket();
  const events = loadEvents(500);

  const detectors = [
    () => detectFailedTaskCluster(tasks),
    () => detectZombieClusterEvents(events),
    () => detectChannelDrift(events),
    () => detectScannerFailureRate(tasks),
    () => detectOrphanMcpScripts(),
    () => detectStaleMacHeal(),
  ];

  const lastScan = loadLastScan();
  const fpDeduped = lastScan.fingerprints || {};
  const cutoffDedup = Date.now() - FINGERPRINT_DEDUP_WINDOW_MS;
  const allHits = [];
  for (const d of detectors) {
    let hit = null;
    try {
      hit = d();
    } catch (err) {
      // detector failures shouldn't kill the scan
      hit = null;
      console.error(`detector error: ${err?.message || err}`);
    }
    if (!hit) continue;
    const last = fpDeduped[hit.fingerprint];
    if (last && last.ts && Date.parse(last.ts) >= cutoffDedup) continue;
    // also skip if a rejected decision exists for this fingerprint
    const rejected = loadDecisions().some(
      (dec) => dec.fingerprint === hit.fingerprint && dec.status === "rejected",
    );
    if (rejected) continue;
    allHits.push(hit);
  }

  const toEmit = allHits.slice(0, MAX_PROPOSALS_PER_SCAN);
  const skipped = allHits.length - toEmit.length;

  const proposals = [];
  for (const hit of toEmit) {
    const id = decisionId();
    const proposal = {
      id,
      ts: new Date().toISOString(),
      category: hit.category,
      situation: hit.situation,
      options: hit.options,
      recommendation: hit.recommendation,
      rationale: hit.rationale,
      riskClass: hit.riskClass,
      autoApply: false,
      applied: false,
      appliedAt: null,
      appliedAction: null,
      rollback: hit.rollback,
      evidence: hit.evidence,
      approvalNeeded: hit.riskClass !== "low",
      approvalChannel: "telegram",
      approvalChatId: TELEGRAM_CHAT_ID,
      fingerprint: hit.fingerprint,
      status: "open",
    };
    proposal.autoApply = shouldAutoApply(proposal);

    if (dryRun) {
      proposals.push({ ...proposal, dryRun: true });
      continue;
    }

    // Real run: write proposal, possibly auto-apply, possibly notify.
    if (proposal.autoApply) {
      const result = dropFollowupDocketTask(proposal);
      proposal.applied = true;
      proposal.appliedAt = new Date().toISOString();
      proposal.appliedAction = result.action;
      proposal.status = "applied";
    }
    writeDecision(proposal);
    emitEvent("chuck.decision.proposed", {
      decisionId: proposal.id,
      category: proposal.category,
      riskClass: proposal.riskClass,
      recommendation: proposal.recommendation,
    });
    if (proposal.applied) {
      emitEvent("chuck.decision.applied", {
        decisionId: proposal.id,
        action: proposal.appliedAction,
      });
    } else if (proposal.approvalNeeded) {
      const tg = sendTelegramNotification(proposal);
      emitEvent("chuck.decision.notification_sent", {
        decisionId: proposal.id,
        channel: "telegram",
        chatId: TELEGRAM_CHAT_ID,
        sent: tg.sent,
        reason: tg.reason || null,
        transport: tg.transport || null,
        messageId: tg.messageId ?? null,
      });
    }
    fpDeduped[proposal.fingerprint] = { ts: proposal.ts, decisionId: proposal.id };
    proposals.push(proposal);
  }

  if (!dryRun) {
    saveLastScan({ lastScanAt: new Date().toISOString(), fingerprints: fpDeduped });
  }

  return {
    dryRun,
    detectorsRun: detectors.length,
    hits: allHits.length,
    emitted: proposals.length,
    floodSkipped: skipped,
    proposals: proposals.map((p) => ({
      id: p.id,
      category: p.category,
      riskClass: p.riskClass,
      autoApply: p.autoApply,
      applied: p.applied,
      recommendation: p.recommendation,
    })),
  };
}

// ─── Status / apply / reject ────────────────────────────────────────────
function runStatus() {
  const decisions = loadDecisions();
  const open = decisions.filter((d) => d.status === "open");
  const applied = decisions.filter((d) => d.status === "applied");
  const rejected = decisions.filter((d) => d.status === "rejected");
  const last = readJson(LAST_SCAN_PATH, null);
  return {
    lastScanAt: last?.lastScanAt || null,
    counts: {
      total: decisions.length,
      open: open.length,
      applied: applied.length,
      rejected: rejected.length,
    },
    open: open.map((d) => ({
      id: d.id,
      ts: d.ts,
      category: d.category,
      riskClass: d.riskClass,
      situation: d.situation,
      recommendation: d.recommendation,
    })),
  };
}

function runApply(decisionId) {
  const path = join(DECISIONS_DIR, `${decisionId}.json`);
  if (!existsSync(path)) {
    console.error(`decision not found: ${decisionId}`);
    process.exit(2);
  }
  const dec = readJson(path, null);
  if (!dec) {
    console.error(`unreadable: ${path}`);
    process.exit(2);
  }
  if (dec.status === "applied") {
    console.log("already applied");
    return;
  }
  if (dec.status === "rejected") {
    console.log("already rejected; cannot apply");
    return;
  }
  const result = dropFollowupDocketTask(dec);
  dec.applied = true;
  dec.appliedAt = new Date().toISOString();
  dec.appliedAction = result.action;
  dec.status = "applied";
  writeDecision(dec);
  emitEvent("chuck.decision.applied", {
    decisionId: dec.id,
    action: dec.appliedAction,
    manual: true,
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

function runReject(decisionId, reason) {
  const path = join(DECISIONS_DIR, `${decisionId}.json`);
  if (!existsSync(path)) {
    console.error(`decision not found: ${decisionId}`);
    process.exit(2);
  }
  const dec = readJson(path, null);
  if (!dec) {
    console.error(`unreadable: ${path}`);
    process.exit(2);
  }
  dec.status = "rejected";
  dec.rejectedAt = new Date().toISOString();
  dec.rejectedReason = reason || null;
  writeDecision(dec);
  emitEvent("chuck.decision.rejected", { decisionId: dec.id, reason: reason || null });
  console.log(JSON.stringify({ ok: true, status: "rejected" }, null, 2));
}

// ─── CLI ─────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "scan";
  if (cmd === "scan") {
    const dryRun = argv.includes("--dry-run");
    const summary = await runScan({ dryRun });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (cmd === "status") {
    console.log(JSON.stringify(runStatus(), null, 2));
    return;
  }
  if (cmd === "apply") {
    const id = argv[1];
    if (!id) {
      console.error("usage: apply <decision-id>");
      process.exit(2);
    }
    runApply(id);
    return;
  }
  if (cmd === "reject") {
    const id = argv[1];
    if (!id) {
      console.error('usage: reject <decision-id> [--reason "..."]');
      process.exit(2);
    }
    const ri = argv.indexOf("--reason");
    const reason = ri >= 0 ? argv[ri + 1] : null;
    runReject(id, reason);
    return;
  }
  console.error(`unknown command: ${cmd}`);
  console.error(
    `usage: chuck-decision-engine.mjs {scan [--dry-run] | status | apply <id> | reject <id> [--reason "..."]}`,
  );
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
