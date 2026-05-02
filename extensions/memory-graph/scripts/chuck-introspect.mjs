#!/usr/bin/env node
// =============================================================================
// TRANSITIONAL DUPLICATE — Unit 11 of the openclaw-first migration (2026-05-01).
// =============================================================================
// The CANONICAL implementation lives at:
//   extensions/skill-introspect/src/* (re-exported via
//   @openclaw/skill-introspect api.ts)
//
// This .mjs is kept alive ONLY for the LaunchAgent
// `~/Library/LaunchAgents/com.openclaw.chuck-introspect.plist` which invokes
// `node chuck-introspect.mjs scan` every 2h (StartInterval=7200). Vanilla Node
// ESM cannot import .ts at runtime, so the launchd-driven scan keeps a
// duplicate of the bundle/prompt/parse/idempotency/record schema until openclaw
// cron supports long-running plugin daemons (then the LaunchAgent retires and
// the plugin tool becomes the only surface).
//
// EDITS: bug fixes go in BOTH places (here AND
// extensions/skill-introspect/src/*.ts). Wire format (introspect record JSON,
// last-scan.json fingerprint history, bus event names) MUST stay byte-identical
// so live state from one engine is readable by the other.
// =============================================================================
//
// chuck-introspect — Chuck's novel-situation reasoning loop.
//
// Where chuck-decision-engine pattern-detects from a fixed list of six rules
// (failed-task-cluster, zombie-cluster, channel-drift, scanner-tune,
// orphan-mcp, stale-mac-heal), this layer reads recent state and asks
// claude-cli (Opus 4.7 via Joseph's Max sub) to introspect for things the
// rule-based engine WOULD NOT catch — surprising patterns, emerging risks,
// cross-subsystem correlations, drift from established discipline, things
// technically working but architecturally wrong.
//
// Two modes:
//   scan              — heavy reasoning pass (every 2h via launchd)
//   focus "<topic>"   — manual targeted introspection
//
// Output: JSON observation files at chuck-v3/introspections/introspect-*.json
// + bus events. Observations are PROPOSALS — never auto-applied. Joseph reviews
// via `chuck-introspect.mjs status` and acks via apply/dismiss.
//
// Idempotency: fingerprint (sha1 of category + recommendation slug) dedup
// against last 50 observations + any undismissed-from-last-7-days. Cap 3
// observations per scan.
//
// CLI:
//   node chuck-introspect.mjs scan [--dry-run]
//   node chuck-introspect.mjs focus "<topic>"
//   node chuck-introspect.mjs status
//   node chuck-introspect.mjs apply <introspect-id>
//   node chuck-introspect.mjs dismiss <introspect-id> [--reason "..."]

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const WORKSPACE_STATE = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V3 = join(WORKSPACE_STATE, "chuck-v3");
const EVENTS_PATH = join(WORKSPACE_STATE, "apex-events.jsonl");
const DOCKET_DIR = join(CHUCK_V3, "docket");
const INTROSPECTIONS_DIR = join(CHUCK_V3, "introspections");
const LAST_SCAN_PATH = join(INTROSPECTIONS_DIR, "last-scan.json");
const DECISIONS_DIR = join(CHUCK_V3, "decisions");
const MAC_HEAL_RECEIPTS = join(CHUCK_V3, "mac-self-heal", "receipts");
const NOTIFICATION_LEDGER = join(CHUCK_V3, "notification-ledger");
const SELF_IMPROVEMENT_LAST = join(CHUCK_V3, "self-improvement", "last-scan.json");
const HEALTH_SNAPSHOT = join(CHUCK_V3, "health-snapshot.json");
const PRIORS_LATEST = join(CHUCK_V3, "priors", "latest.json");
const DISSENT_DIR = join(CHUCK_V3, "dissent");

const ENGINE_KIND = "chuck-introspect";

const HOUR_MS = 60 * 60 * 1000;
const MAX_OBSERVATIONS_PER_SCAN = 3;
const FINGERPRINT_HISTORY_CAP = 50;
const DEDUP_WINDOW_MS = 7 * 24 * HOUR_MS;
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;
const PRIOR_HEAD_CHARS = 8000;
const HEALTH_HEAD_CHARS = 4000;

// ─── FS / util helpers ───────────────────────────────────────────────────
function ensureDirs() {
  for (const d of [INTROSPECTIONS_DIR]) {
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

function readTextHead(path, maxChars) {
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path, "utf8");
    if (buf.length <= maxChars) return buf;
    return buf.slice(0, maxChars) + `\n…[truncated ${buf.length - maxChars} chars]`;
  } catch {
    return null;
  }
}

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

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function fingerprint(category, recommendation) {
  return createHash("sha1")
    .update(`${slugify(category)}::${slugify(recommendation)}`)
    .digest("hex")
    .slice(0, 16);
}

function introspectId() {
  return `introspect-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function emitEvent(type, payload) {
  const ev = {
    id: `e-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
    ts: new Date().toISOString(),
    actor: "chuck",
    source: ENGINE_KIND,
    type,
    payload: payload ?? {},
  };
  try {
    appendFileSync(EVENTS_PATH, JSON.stringify(ev) + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

// Build the env for the claude-cli child. Same PATH-augmentation pattern as
// chuck-docket-executor.buildExecutorEnv — under launchd PATH is minimal and
// `claude` lives in ~/.nvm/versions/node/.../bin which won't be on it.
function buildExecutorEnv() {
  const home = process.env.HOME ?? HOME;
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

// ─── State bundling ──────────────────────────────────────────────────────
function bundleRecentEvents() {
  const lines = tailLines(EVENTS_PATH, 100);
  return lines.join("\n");
}

function listJsonByMtime(dir, limit) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => {
        const p = join(dir, n);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(p).mtimeMs;
        } catch {
          /* ignore */
        }
        return { path: p, name: n, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function bundleDocketTasks(limit = 20) {
  const entries = listJsonByMtime(DOCKET_DIR, limit);
  const tasks = entries
    .map((e) => readJson(e.path, null))
    .filter(Boolean)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      risk: t.risk,
      commandKind: t.commandKind,
      surface: t.surface,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      createdBy: t.createdBy,
      lastHeartbeat:
        Array.isArray(t.heartbeats) && t.heartbeats.length
          ? t.heartbeats[t.heartbeats.length - 1]
          : null,
      sourceKind: t?.source?.kind || null,
    }));
  return tasks;
}

function bundleHealReceipts(limit = 5) {
  const entries = listJsonByMtime(MAC_HEAL_RECEIPTS, limit);
  return entries
    .map((e) => readJson(e.path, null))
    .filter(Boolean)
    .map((r) => ({
      id: r.id || r.runId,
      ts: r.ts || r.startedAt || r.completedAt,
      actionsApplied: r.actionsApplied ?? r.applied ?? null,
      summary: r.summary || r.note || null,
    }));
}

function bundleNotifications(limit = 10) {
  const entries = listJsonByMtime(NOTIFICATION_LEDGER, limit);
  return entries
    .map((e) => readJson(e.path, null))
    .filter(Boolean)
    .map((n) => ({
      id: n.id,
      ts: n.ts || n.createdAt,
      kind: n.kind || n.type,
      channel: n.channel,
      title: n.title,
      sent: n.sent,
    }));
}

function bundleOpenDecisions() {
  if (!existsSync(DECISIONS_DIR)) return [];
  return readdirSync(DECISIONS_DIR)
    .filter((n) => n.startsWith("decision-") && n.endsWith(".json"))
    .map((n) => readJson(join(DECISIONS_DIR, n), null))
    .filter(Boolean)
    .filter((d) => d.status === "open" || (d.applied === false && d.status !== "rejected"))
    .map((d) => ({
      id: d.id,
      ts: d.ts,
      category: d.category,
      situation: d.situation,
      recommendation: d.recommendation,
      riskClass: d.riskClass,
      status: d.status,
    }));
}

function bundleSelfImprovementRuns() {
  // self-improvement-scanner writes a single last-scan.json; collect last 5
  // scan entries from inside it if present. Schema-tolerant.
  const data = readJson(SELF_IMPROVEMENT_LAST, null);
  if (!data) return [];
  if (Array.isArray(data?.recentScans)) return data.recentScans.slice(-5);
  if (Array.isArray(data?.scans)) return data.scans.slice(-5);
  // Fall back to a one-shot summary.
  return [
    {
      lastScanAt: data?.lastScanAt || data?.ts || null,
      hits: data?.hits ?? data?.detectedCount ?? null,
      promoted: data?.promoted ?? null,
    },
  ];
}

function bundleDissents(limit = 20) {
  if (!existsSync(DISSENT_DIR)) return [];
  return readdirSync(DISSENT_DIR)
    .filter((n) => n.endsWith(".json"))
    .slice(0, limit)
    .map((n) => readJson(join(DISSENT_DIR, n), null))
    .filter(Boolean)
    .filter((d) => d.status !== "resolved" && d.resolvedAt == null)
    .map((d) => ({
      id: d.id,
      ts: d.ts || d.createdAt,
      topic: d.topic || d.subject,
      voices: d.voices || d.dissenters,
      summary: d.summary,
    }));
}

function bundleState() {
  const events = bundleRecentEvents();
  const docket = bundleDocketTasks(20);
  const healReceipts = bundleHealReceipts(5);
  const notifications = bundleNotifications(10);
  const openDecisions = bundleOpenDecisions();
  const selfImprovement = bundleSelfImprovementRuns();
  const healthSnapshot = readJson(HEALTH_SNAPSHOT, null);
  // priors/latest.json can be 200KB+; head-truncate
  const priorsLatestRaw = readTextHead(PRIORS_LATEST, PRIOR_HEAD_CHARS);
  const dissents = bundleDissents();

  return {
    bundledAt: new Date().toISOString(),
    recentEvents: events,
    docket,
    healReceipts,
    notifications,
    openDecisions,
    selfImprovement,
    healthSnapshot: healthSnapshot
      ? JSON.stringify(healthSnapshot, null, 2).slice(0, HEALTH_HEAD_CHARS)
      : null,
    priorsLatestHead: priorsLatestRaw,
    dissents,
  };
}

function renderStateForPrompt(bundle) {
  const sections = [];
  sections.push(`# Recent apex-events (last 100 lines)\n${bundle.recentEvents || "(none)"}`);
  sections.push(`# Docket tasks (last 20 by mtime)\n${JSON.stringify(bundle.docket, null, 2)}`);
  sections.push(
    `# mac-self-heal receipts (last 5)\n${JSON.stringify(bundle.healReceipts, null, 2)}`,
  );
  sections.push(
    `# Notification ledger (last 10)\n${JSON.stringify(bundle.notifications, null, 2)}`,
  );
  sections.push(
    `# Open decision proposals (chuck-decision-engine output)\n${JSON.stringify(bundle.openDecisions, null, 2)}`,
  );
  sections.push(
    `# Self-improvement scanner — recent runs\n${JSON.stringify(bundle.selfImprovement, null, 2)}`,
  );
  sections.push(
    `# Health snapshot${bundle.healthSnapshot ? "" : " (missing)"}\n${bundle.healthSnapshot || "(none)"}`,
  );
  sections.push(
    `# Active priors — head of chuck-v3/priors/latest.json${bundle.priorsLatestHead ? "" : " (missing)"}\n${bundle.priorsLatestHead || "(none)"}`,
  );
  sections.push(`# Open dissents\n${JSON.stringify(bundle.dissents, null, 2)}`);
  return sections.join("\n\n---\n\n");
}

// ─── Prompt construction ─────────────────────────────────────────────────
const SCAN_PROMPT_PREFIX = `You are Chuck's introspection layer. Read the recent state below.
Identify up to ${MAX_OBSERVATIONS_PER_SCAN} NOVEL observations that the rule-based decision-engine
would NOT catch. Look for: surprising patterns, emerging risks, cross-
subsystem correlations, drift from established discipline, things that
are technically working but architecturally wrong.

For each observation, emit:
{
  "id": "<unique slug>",
  "category": "<short kind>",
  "observation": "<what you see, 1-2 sentences>",
  "why_novel": "<why pattern-detect would miss this, 1 sentence>",
  "recommendation": "<concrete action, 1 sentence>",
  "risk_class": "low|medium|high",
  "rationale": "<why this matters, 1-3 sentences>",
  "evidence": [{"source": "<file or event>", "snippet": "<excerpt>"}]
}

Be terse. Quality over quantity — emit 0 observations if nothing
genuine. Don't repeat what the decision-engine already proposed
(their ids start "decision-"; your work starts "introspect-").

Output a JSON array of observation objects (no prose, no markdown fences).
If nothing novel, output an empty array: [].`;

function buildScanPrompt(bundle) {
  const state = renderStateForPrompt(bundle);
  return `${SCAN_PROMPT_PREFIX}\n\n<STATE>\n${state}\n</STATE>`;
}

function buildFocusPrompt(topic, bundle) {
  const state = renderStateForPrompt(bundle);
  return `You are Chuck's introspection layer. Joseph asked:

<TOPIC>
${topic}
</TOPIC>

Read the recent state below and respond with focused analysis. Answer
specifically what was asked. Then, IF (and only if) you identify concrete
novel observations or recommendations relevant to the topic, append a JSON
array of observation objects in the same schema the scan mode uses:

{
  "id": "<unique slug>",
  "category": "<short kind>",
  "observation": "<what you see, 1-2 sentences>",
  "why_novel": "<why pattern-detect would miss this, 1 sentence>",
  "recommendation": "<concrete action, 1 sentence>",
  "risk_class": "low|medium|high",
  "rationale": "<why this matters, 1-3 sentences>",
  "evidence": [{"source": "<file or event>", "snippet": "<excerpt>"}]
}

Wrap the JSON array in <OBSERVATIONS>...</OBSERVATIONS> tags so it can be
parsed out from your prose. If nothing actionable, write
<OBSERVATIONS>[]</OBSERVATIONS>.

<STATE>
${state}
</STATE>`;
}

// ─── claude-cli dispatch ─────────────────────────────────────────────────
function dispatchClaudeCli(prompt) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const args = ["-p", "--model", "opus", "--permission-mode", "bypassPermissions", prompt];
    const child = spawn("claude", args, {
      env: buildExecutorEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const t = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, CLAUDE_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolvePromise({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

// ─── Response parsing ────────────────────────────────────────────────────
function tryParseObservations(raw) {
  if (!raw || typeof raw !== "string") return [];
  let text = raw.trim();

  // Strip <OBSERVATIONS>...</OBSERVATIONS> wrapper if present (focus mode).
  const obsTagMatch = text.match(/<OBSERVATIONS>([\s\S]*?)<\/OBSERVATIONS>/i);
  if (obsTagMatch) text = obsTagMatch[1].trim();

  // Strip markdown fences.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Try outright parse.
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try to find a JSON array substring.
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
    if (parsed == null) {
      // Try a JSON object substring with .observations.
      const oStart = text.indexOf("{");
      const oEnd = text.lastIndexOf("}");
      if (oStart !== -1 && oEnd > oStart) {
        try {
          parsed = JSON.parse(text.slice(oStart, oEnd + 1));
        } catch {
          parsed = null;
        }
      }
    }
  }
  if (parsed == null) return [];
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.observations)) return parsed.observations;
  return [];
}

function normalizeObservation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const category = String(raw.category || "uncategorized").trim();
  const observation = String(raw.observation || "").trim();
  const recommendation = String(raw.recommendation || "").trim();
  if (!observation || !recommendation) return null;
  const riskClassRaw = String(raw.risk_class || raw.riskClass || "low").toLowerCase();
  const riskClass = ["low", "medium", "high"].includes(riskClassRaw) ? riskClassRaw : "low";
  let evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  evidence = evidence
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      source: String(e.source || "").slice(0, 200),
      snippet: String(e.snippet || "").slice(0, 600),
    }));
  return {
    proposedId: String(raw.id || "").trim() || null,
    category,
    observation,
    whyNovel: String(raw.why_novel || raw.whyNovel || "").trim(),
    recommendation,
    riskClass,
    rationale: String(raw.rationale || "").trim(),
    evidence,
  };
}

// ─── Idempotency / dedup ────────────────────────────────────────────────
function loadLastScan() {
  return readJson(LAST_SCAN_PATH, { fingerprints: [], lastScanAt: null });
}

function saveLastScan(state) {
  writeJson(LAST_SCAN_PATH, state);
}

function loadAllIntrospections() {
  if (!existsSync(INTROSPECTIONS_DIR)) return [];
  return readdirSync(INTROSPECTIONS_DIR)
    .filter((n) => n.startsWith("introspect-") && n.endsWith(".json"))
    .map((n) => readJson(join(INTROSPECTIONS_DIR, n), null))
    .filter(Boolean);
}

function isFingerprintBlocked(fp, lastScan, allRecords) {
  // Block if in last 50 fingerprint history
  if (Array.isArray(lastScan.fingerprints) && lastScan.fingerprints.includes(fp)) return true;
  // Block if any undismissed introspection from last 7 days has same fingerprint
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const r of allRecords) {
    if (!r?.fingerprint || r.fingerprint !== fp) continue;
    if (r.dismissed) continue;
    const t = r.ts ? Date.parse(r.ts) : 0;
    if (t >= cutoff) return true;
  }
  return false;
}

// ─── Write introspection record ─────────────────────────────────────────
function writeIntrospection(record) {
  const path = join(INTROSPECTIONS_DIR, `${record.id}.json`);
  writeJson(path, record);
  return path;
}

// ─── Scan ────────────────────────────────────────────────────────────────
async function runScan({ dryRun = false } = {}) {
  ensureDirs();
  const scanRunId = randomUUID();
  const startedAt = Date.now();

  const bundle = bundleState();
  const prompt = buildScanPrompt(bundle);

  if (dryRun) {
    return {
      mode: "scan",
      dryRun: true,
      scanRunId,
      promptSize: prompt.length,
      promptHead: prompt.slice(0, 1200),
      bundleStats: {
        recentEventsBytes: bundle.recentEvents?.length || 0,
        docketCount: bundle.docket.length,
        healReceiptsCount: bundle.healReceipts.length,
        notificationsCount: bundle.notifications.length,
        openDecisionsCount: bundle.openDecisions.length,
        selfImprovementCount: bundle.selfImprovement.length,
        healthSnapshotPresent: bundle.healthSnapshot != null,
        priorsLatestHeadBytes: bundle.priorsLatestHead?.length || 0,
        dissentsCount: bundle.dissents.length,
      },
    };
  }

  emitEvent("chuck.introspect.scan.started", { scanRunId, promptSize: prompt.length });

  let result;
  try {
    result = await dispatchClaudeCli(prompt);
  } catch (err) {
    emitEvent("chuck.introspect.scan.completed", {
      scanRunId,
      observationsCount: 0,
      durationMs: Date.now() - startedAt,
      error: `dispatch threw: ${err?.message || err}`,
    });
    return { mode: "scan", scanRunId, observations: [], error: String(err?.message || err) };
  }

  if (result.timedOut || result.exitCode !== 0) {
    emitEvent("chuck.introspect.scan.completed", {
      scanRunId,
      observationsCount: 0,
      durationMs: Date.now() - startedAt,
      error: result.timedOut ? "claude-cli timed out" : `claude-cli exit=${result.exitCode}`,
      stderrTail: (result.stderr || "").slice(-400),
    });
    return {
      mode: "scan",
      scanRunId,
      observations: [],
      error: result.timedOut ? "timeout" : `exit=${result.exitCode}`,
    };
  }

  const parsed = tryParseObservations(result.stdout);
  const lastScan = loadLastScan();
  const allRecords = loadAllIntrospections();

  const emitted = [];
  const skipped = [];
  for (const raw of parsed) {
    if (emitted.length >= MAX_OBSERVATIONS_PER_SCAN) break;
    const obs = normalizeObservation(raw);
    if (!obs) {
      skipped.push({ reason: "malformed", raw });
      continue;
    }
    const fp = fingerprint(obs.category, obs.recommendation);
    if (isFingerprintBlocked(fp, lastScan, allRecords)) {
      skipped.push({ reason: "duplicate-fingerprint", fp, category: obs.category });
      continue;
    }
    const id = introspectId();
    const nowIso = new Date().toISOString();
    const record = {
      id,
      ts: nowIso,
      scanRunId,
      mode: "scan",
      category: obs.category,
      observation: obs.observation,
      whyNovel: obs.whyNovel,
      recommendation: obs.recommendation,
      riskClass: obs.riskClass,
      rationale: obs.rationale,
      evidence: obs.evidence,
      fingerprint: fp,
      proposedId: obs.proposedId,
      applied: false,
      appliedAt: null,
      dismissed: false,
      dismissedAt: null,
      dismissedReason: null,
    };
    writeIntrospection(record);
    emitEvent("chuck.introspect.observed", {
      introspectId: id,
      category: record.category,
      riskClass: record.riskClass,
      recommendation: record.recommendation,
    });
    emitted.push(record);
    // update fingerprint history
    lastScan.fingerprints = [
      fp,
      ...(Array.isArray(lastScan.fingerprints)
        ? lastScan.fingerprints.filter((f) => f !== fp)
        : []),
    ].slice(0, FINGERPRINT_HISTORY_CAP);
  }

  lastScan.lastScanAt = new Date().toISOString();
  lastScan.lastScanRunId = scanRunId;
  lastScan.lastEmittedCount = emitted.length;
  saveLastScan(lastScan);

  const durationMs = Date.now() - startedAt;
  emitEvent("chuck.introspect.scan.completed", {
    scanRunId,
    observationsCount: emitted.length,
    durationMs,
  });

  return {
    mode: "scan",
    scanRunId,
    durationMs,
    promptSize: prompt.length,
    rawSize: (result.stdout || "").length,
    parsedCount: parsed.length,
    emitted: emitted.map((e) => ({
      id: e.id,
      category: e.category,
      riskClass: e.riskClass,
      observation: e.observation,
      recommendation: e.recommendation,
    })),
    skipped,
  };
}

// ─── Focus ───────────────────────────────────────────────────────────────
async function runFocus(topic) {
  ensureDirs();
  const scanRunId = randomUUID();
  const startedAt = Date.now();
  const bundle = bundleState();
  const prompt = buildFocusPrompt(topic, bundle);

  emitEvent("chuck.introspect.scan.started", {
    scanRunId,
    mode: "focus",
    topic,
    promptSize: prompt.length,
  });

  let result;
  try {
    result = await dispatchClaudeCli(prompt);
  } catch (err) {
    emitEvent("chuck.introspect.scan.completed", {
      scanRunId,
      mode: "focus",
      observationsCount: 0,
      durationMs: Date.now() - startedAt,
      error: `dispatch threw: ${err?.message || err}`,
    });
    return { mode: "focus", scanRunId, observations: [], error: String(err?.message || err) };
  }

  if (result.timedOut || result.exitCode !== 0) {
    emitEvent("chuck.introspect.scan.completed", {
      scanRunId,
      mode: "focus",
      observationsCount: 0,
      durationMs: Date.now() - startedAt,
      error: result.timedOut ? "claude-cli timed out" : `claude-cli exit=${result.exitCode}`,
    });
    return {
      mode: "focus",
      scanRunId,
      observations: [],
      error: result.timedOut ? "timeout" : `exit=${result.exitCode}`,
    };
  }

  const stdout = result.stdout || "";
  const parsed = tryParseObservations(stdout);
  const lastScan = loadLastScan();
  const allRecords = loadAllIntrospections();

  const emitted = [];
  for (const raw of parsed) {
    if (emitted.length >= MAX_OBSERVATIONS_PER_SCAN) break;
    const obs = normalizeObservation(raw);
    if (!obs) continue;
    const fp = fingerprint(obs.category, obs.recommendation);
    // Focus-mode does NOT block on fingerprint dedup — Joseph asked specifically;
    // but still skip exact-duplicates from the last 24h to avoid identical
    // re-emit on accidental double-fires.
    const cutoff = Date.now() - 24 * HOUR_MS;
    const dup = allRecords.find(
      (r) => r.fingerprint === fp && !r.dismissed && r.ts && Date.parse(r.ts) >= cutoff,
    );
    if (dup) continue;
    const id = introspectId();
    const nowIso = new Date().toISOString();
    const record = {
      id,
      ts: nowIso,
      scanRunId,
      mode: "focus",
      topic,
      category: obs.category,
      observation: obs.observation,
      whyNovel: obs.whyNovel,
      recommendation: obs.recommendation,
      riskClass: obs.riskClass,
      rationale: obs.rationale,
      evidence: obs.evidence,
      fingerprint: fp,
      proposedId: obs.proposedId,
      applied: false,
      appliedAt: null,
      dismissed: false,
      dismissedAt: null,
      dismissedReason: null,
    };
    writeIntrospection(record);
    emitEvent("chuck.introspect.observed", {
      introspectId: id,
      category: record.category,
      riskClass: record.riskClass,
      recommendation: record.recommendation,
      mode: "focus",
    });
    emitted.push(record);
    lastScan.fingerprints = [
      fp,
      ...(Array.isArray(lastScan.fingerprints)
        ? lastScan.fingerprints.filter((f) => f !== fp)
        : []),
    ].slice(0, FINGERPRINT_HISTORY_CAP);
  }

  lastScan.lastFocusAt = new Date().toISOString();
  lastScan.lastFocusTopic = topic;
  saveLastScan(lastScan);

  const durationMs = Date.now() - startedAt;
  emitEvent("chuck.introspect.scan.completed", {
    scanRunId,
    mode: "focus",
    observationsCount: emitted.length,
    durationMs,
  });

  return {
    mode: "focus",
    scanRunId,
    durationMs,
    topic,
    promptSize: prompt.length,
    answer: stdout,
    emitted: emitted.map((e) => ({
      id: e.id,
      category: e.category,
      riskClass: e.riskClass,
      observation: e.observation,
      recommendation: e.recommendation,
    })),
  };
}

// ─── Status / apply / dismiss ────────────────────────────────────────────
function runStatus() {
  const records = loadAllIntrospections().sort((a, b) => {
    const ta = a.ts ? Date.parse(a.ts) : 0;
    const tb = b.ts ? Date.parse(b.ts) : 0;
    return tb - ta;
  });
  const open = records.filter((r) => !r.applied && !r.dismissed);
  const applied = records.filter((r) => r.applied);
  const dismissed = records.filter((r) => r.dismissed);
  const lastScan = loadLastScan();
  return {
    lastScanAt: lastScan?.lastScanAt || null,
    lastFocusAt: lastScan?.lastFocusAt || null,
    counts: {
      total: records.length,
      open: open.length,
      applied: applied.length,
      dismissed: dismissed.length,
    },
    open: open.slice(0, 10).map((r) => ({
      id: r.id,
      ts: r.ts,
      mode: r.mode,
      category: r.category,
      riskClass: r.riskClass,
      observation: r.observation,
      recommendation: r.recommendation,
    })),
    recent: records.slice(0, 10).map((r) => ({
      id: r.id,
      ts: r.ts,
      category: r.category,
      state: r.applied ? "applied" : r.dismissed ? "dismissed" : "open",
    })),
  };
}

function findIntrospectionPath(id) {
  return join(INTROSPECTIONS_DIR, `${id}.json`);
}

function runApply(id) {
  const path = findIntrospectionPath(id);
  if (!existsSync(path)) {
    console.error(`introspection not found: ${id}`);
    process.exit(2);
  }
  const r = readJson(path, null);
  if (!r) {
    console.error(`unreadable: ${path}`);
    process.exit(2);
  }
  if (r.applied) {
    console.log(JSON.stringify({ ok: true, status: "already-applied" }, null, 2));
    return;
  }
  if (r.dismissed) {
    console.error(`cannot apply a dismissed introspection (${id})`);
    process.exit(2);
  }
  r.applied = true;
  r.appliedAt = new Date().toISOString();
  writeJson(path, r);
  emitEvent("chuck.introspect.applied", { introspectId: id, manual: true });
  console.log(JSON.stringify({ ok: true, status: "applied", appliedAt: r.appliedAt }, null, 2));
}

function runDismiss(id, reason) {
  const path = findIntrospectionPath(id);
  if (!existsSync(path)) {
    console.error(`introspection not found: ${id}`);
    process.exit(2);
  }
  const r = readJson(path, null);
  if (!r) {
    console.error(`unreadable: ${path}`);
    process.exit(2);
  }
  if (r.dismissed) {
    console.log(JSON.stringify({ ok: true, status: "already-dismissed" }, null, 2));
    return;
  }
  r.dismissed = true;
  r.dismissedAt = new Date().toISOString();
  r.dismissedReason = reason || null;
  writeJson(path, r);
  emitEvent("chuck.introspect.dismissed", { introspectId: id, reason: reason || null });
  console.log(JSON.stringify({ ok: true, status: "dismissed", reason: reason || null }, null, 2));
}

// ─── CLI ─────────────────────────────────────────────────────────────────
function printUsage() {
  console.error(`Usage:
  node chuck-introspect.mjs scan [--dry-run]
  node chuck-introspect.mjs focus "<topic>"
  node chuck-introspect.mjs status
  node chuck-introspect.mjs apply <introspect-id>
  node chuck-introspect.mjs dismiss <introspect-id> [--reason "..."]`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "scan";

  if (cmd === "scan") {
    const dryRun = argv.includes("--dry-run");
    const summary = await runScan({ dryRun });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (cmd === "focus") {
    const topic = argv[1];
    if (!topic) {
      console.error('usage: focus "<topic>"');
      process.exit(2);
    }
    const summary = await runFocus(topic);
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
      console.error("usage: apply <introspect-id>");
      process.exit(2);
    }
    runApply(id);
    return;
  }

  if (cmd === "dismiss") {
    const id = argv[1];
    if (!id) {
      console.error('usage: dismiss <introspect-id> [--reason "..."]');
      process.exit(2);
    }
    const ri = argv.indexOf("--reason");
    const reason = ri >= 0 ? argv[ri + 1] : null;
    runDismiss(id, reason);
    return;
  }

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    printUsage();
    return;
  }

  console.error(`unknown command: ${cmd}`);
  printUsage();
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    // exit 0 — daemon-safe; we never want to crash the launchd job. Diagnostics
    // are logged to stderr (captured by the plist's StandardErrorPath).
    process.exit(0);
  });
}
