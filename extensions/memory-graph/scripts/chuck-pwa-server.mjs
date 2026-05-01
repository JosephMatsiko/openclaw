#!/usr/bin/env node
// chuck-pwa-server — serves the Chuck v3 PWA + the API endpoints the PWA
// needs to be functional. Replaces the standalone `python3 -m http.server`
// that was previously serving the PWA static files only (and returning 404
// for the API calls the PWA expected — the structural reason the 10/10
// cascade gap stayed open even though the PWA UI looked complete).
//
// Endpoints (all under /api/chuck-v3/ unless noted):
//   GET  /api/chuck-v3/push/vapid-public       — returns { publicKey }
//   POST /api/chuck-v3/push/subscribe          — accepts a PushSubscription JSON,
//                                                 persists via chuck-web-push.saveSubscription
//   POST /api/chuck-v3/push/unsubscribe        — accepts { endpoint }, removes the saved sub
//   GET  /api/chuck-v3/push/subscriptions      — returns { count, subscriptions: [...] }
//   GET  /api/chuck-v3/health                  — server liveness
//   GET  /                                     — static PWA index.html
//   GET  /<path>                               — static files from PWA dir
//
// The PWA also fetches /api/chuck-v3/docket, /status-strip, /decisions —
// those are stub-handled here as 200 + empty payload so the PWA renders an
// empty-state instead of crashing on 404. Wire to real sources in a future pass.
//
// State + creds:
//   VAPID keys: ~/.openclaw/credentials/web-push-vapid.json (RFC 8292)
//   Subscriptions: ~/.openclaw/workspace/state/chuck-v3/push-subscriptions/sub-<hash>.json
//   Static dir: ~/.openclaw/workspace/state/chuck-v3/pwa/
//
// Listening port: env CHUCK_PWA_PORT or default 8093 (matches the python server
// the PWA was originally accessed through, so existing iPad bookmarks keep
// working — if Joseph already added the PWA to home screen, the URL is the same).
//
// CLI:
//   node chuck-pwa-server.mjs                    — run as foreground server
//   node chuck-pwa-server.mjs --port 8093        — explicit port
//   node chuck-pwa-server.mjs --status           — check if running on port

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";
import {
  loadVapidKeys,
  listSubscriptions,
  removeSubscription,
  saveSubscription,
} from "./chuck-web-push.mjs";

const HOME = homedir();
const CHUCK_V3 = join(HOME, ".openclaw", "workspace", "state", "chuck-v3");
const PWA_DIR = join(CHUCK_V3, "pwa");
const DOCKET_DIR = join(CHUCK_V3, "docket");
const DECISIONS_DIR = join(CHUCK_V3, "decisions");
const HEALTH_SNAPSHOT_PATH = join(CHUCK_V3, "health-snapshot.json");
const EXECUTOR_CONTROL_PATH = join(CHUCK_V3, "executor-control.json");
const RUNTIME_CHOOSER_STATE_PATH = join(CHUCK_V3, "runtime-chooser", "state.json");
// Defaults are evidence-derived, not arbitrary:
//   PORT 8093 = same port the python http.server used; iPad PWA installs and
//               existing bookmarks keep working without re-pinning.
//   MAX_BODY_BYTES 64KB = a PushSubscription JSON is typically ~500-2000 bytes;
//                64KB caps any pathological client without being restrictive.
const PORT = parseInt(
  process.env.CHUCK_PWA_PORT || process.argv.find((a, i, arr) => arr[i - 1] === "--port") || "8093",
  10,
);
// 256KB body cap: push subs are tiny (~1KB) but the new /ask endpoint
// accepts a chat prompt which can be a long brief or pasted excerpt.
// 256KB is comfortably above any reasonable Telegram-style prompt and
// still caps pathological clients.
const MAX_BODY_BYTES = 256 * 1024;
const APEX_PANEL_ASK_PATH = join(
  HOME,
  "Projects",
  "openclaw",
  "extensions",
  "memory-graph",
  "scripts",
  "apex-panel-ask.mjs",
);
// Per-voice timeout for the /ask endpoint. Web voices (Chrome-driver-backed)
// can take 60-120s to load + answer; CLI voices answer in 5-30s. 180s is
// the upper bound, kept conservative because the iPad request is held
// open in the meantime.
const ASK_PER_VOICE_TIMEOUT_MS = 180_000;

// Allowed origins for CORS. PWA is served from this host so default same-origin
// (no CORS headers needed) is fine, but we set Access-Control-Allow-Origin
// liberally for the API namespace so a browser-installed PWA whose
// origin is `chrome-extension://` (rare) or `localhost:8093` (dev) doesn't
// hit a preflight wall. We tighten if Joseph requests.
const CORS_ORIGIN = "*";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, body) {
  setSecurityHeaders(res);
  setCorsHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function sendNotFound(res, msg = "Not Found") {
  setSecurityHeaders(res);
  setCorsHeaders(res);
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(msg);
}

function sendStatic(req, res) {
  // Resolve the URL path safely against PWA_DIR. Reject anything containing
  // `..` after normalization (path-traversal defense). Default to index.html
  // for / and any deep path that doesn't match a file (SPA-style fallback).
  let urlPath = req.url.split("?")[0].split("#")[0];
  if (urlPath === "/") urlPath = "/index.html";
  // Strip leading slash for path.join
  const rel = urlPath.replace(/^\/+/, "");
  const resolved = normalize(join(PWA_DIR, rel));
  if (
    !resolved.startsWith(PWA_DIR + "/") &&
    resolved !== PWA_DIR &&
    resolved !== join(PWA_DIR, "index.html")
  ) {
    return sendNotFound(res, "Path traversal denied");
  }
  let target = resolved;
  if (!existsSync(target) || !statSync(target).isFile()) {
    // SPA fallback: anything that doesn't match a real file → index.html
    target = join(PWA_DIR, "index.html");
    if (!existsSync(target)) {
      return sendNotFound(res, `PWA index missing at ${target}`);
    }
  }
  setSecurityHeaders(res);
  setCorsHeaders(res);
  const buf = readFileSync(target);
  const mime = MIME[extname(target)] || "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", mime);
  // Hash-length-byte ETag for static. Browsers will revalidate.
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Length", String(buf.length));
  res.end(buf);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text) return resolve({});
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON: ${err?.message || err}`));
      }
    });
    req.on("error", reject);
  });
}

function isValidSubscription(obj) {
  // Minimum-fields sanity check on a PushSubscription serialization.
  return (
    obj &&
    typeof obj === "object" &&
    typeof obj.endpoint === "string" &&
    obj.endpoint.startsWith("https://") &&
    obj.keys &&
    typeof obj.keys === "object" &&
    typeof obj.keys.p256dh === "string" &&
    typeof obj.keys.auth === "string"
  );
}

// ─── route handlers ────────────────────────────────────────────────────────
async function handleVapidPublic(req, res) {
  let keys;
  try {
    keys = loadVapidKeys();
  } catch (err) {
    return sendJson(res, 500, { error: `vapid load failed: ${err?.message || err}` });
  }
  if (!keys?.publicKey) {
    return sendJson(res, 500, { error: "vapid keys present but missing publicKey" });
  }
  return sendJson(res, 200, { publicKey: keys.publicKey });
}

async function handleSubscribe(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err?.message || String(err) });
  }
  if (!isValidSubscription(body)) {
    return sendJson(res, 400, {
      error: "invalid PushSubscription shape; need endpoint + keys.p256dh + keys.auth",
    });
  }
  const userAgent = typeof body.userAgent === "string" ? body.userAgent : null;
  const { userAgent: _, ...sub } = body;
  let result;
  try {
    result = saveSubscription({ ...sub, userAgent });
  } catch (err) {
    return sendJson(res, 500, { error: `save failed: ${err?.message || err}` });
  }
  return sendJson(res, result?.deduped ? 200 : 201, {
    ok: true,
    deduped: !!result?.deduped,
    file: result?.file || null,
    endpointPreview: sub.endpoint.slice(0, 60) + "...",
  });
}

async function handleUnsubscribe(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err?.message || String(err) });
  }
  if (!body?.endpoint || typeof body.endpoint !== "string") {
    return sendJson(res, 400, { error: "missing 'endpoint' string" });
  }
  let result;
  try {
    result = removeSubscription(body.endpoint);
  } catch (err) {
    return sendJson(res, 500, { error: `remove failed: ${err?.message || err}` });
  }
  return sendJson(res, 200, { ok: true, removed: !!result?.ok });
}

async function handleSubscriptionsList(req, res) {
  let subs;
  try {
    subs = await listSubscriptions();
  } catch (err) {
    return sendJson(res, 500, { error: `list failed: ${err?.message || err}` });
  }
  return sendJson(res, 200, { count: subs.length, subscriptions: subs });
}

async function handleHealth(req, res) {
  let vapidOk = false;
  try {
    vapidOk = !!loadVapidKeys()?.publicKey;
  } catch {
    /* ignore */
  }
  let subCount = 0;
  try {
    subCount = (await listSubscriptions()).length;
  } catch {
    /* ignore */
  }
  return sendJson(res, 200, {
    ok: true,
    server: "chuck-pwa-server",
    pid: process.pid,
    pwaDir: PWA_DIR,
    vapidConfigured: vapidOk,
    subscriptionCount: subCount,
    uptimeMs: Math.round(process.uptime() * 1000),
  });
}

// ─── PWA real-data endpoints (wired 2026-04-30) ────────────────────────────

function readJsonSafe(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// /api/chuck-v3/docket — read all task files, sort by updatedAt desc, return
// a compact view (the PWA renders cards; full task JSON would be too noisy).
// Defaults: max 100 tasks, only non-archived states. Tunable via query string.
async function handleDocket(req, res) {
  if (!existsSync(DOCKET_DIR)) {
    return sendJson(res, 200, {
      tasks: [],
      updatedAt: new Date().toISOString(),
      source: "no-docket-dir",
    });
  }
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const limit = Math.max(
    1,
    Math.min(500, parseInt(url.searchParams.get("limit") || "100", 10) || 100),
  );
  const includeStates = (
    url.searchParams.get("status") ||
    "pending,running,failed,failed-validation,blocked,completed,skipped"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const includeSet = new Set(includeStates);
  let entries;
  try {
    entries = readdirSync(DOCKET_DIR).filter((f) => f.endsWith(".json"));
  } catch (err) {
    return sendJson(res, 500, { error: `readdir failed: ${err?.message || err}` });
  }
  const tasks = [];
  for (const f of entries) {
    const full = join(DOCKET_DIR, f);
    const t = readJsonSafe(full);
    if (!t || typeof t !== "object" || !t.id) continue;
    const status = t.status || "unknown";
    if (!includeSet.has(status)) continue;
    tasks.push({
      id: t.id,
      title: t.title || "(untitled)",
      status,
      risk: t.risk || null,
      commandKind: t.commandKind || null,
      surface: t.surface || null,
      createdAt: t.createdAt || null,
      updatedAt: t.updatedAt || t.createdAt || null,
      createdBy: t.createdBy || null,
      sourceKind: t.source?.kind || null,
      lastPhase:
        Array.isArray(t.heartbeats) && t.heartbeats.length > 0
          ? t.heartbeats[t.heartbeats.length - 1]?.phase
          : null,
      promotedFrom: t.promotedFrom?.introspectId || null,
    });
  }
  // Sort by updatedAt desc
  tasks.sort((a, b) => {
    const ta = a.updatedAt || "";
    const tb = b.updatedAt || "";
    return tb.localeCompare(ta);
  });
  const truncated = tasks.length > limit;
  const out = truncated ? tasks.slice(0, limit) : tasks;
  return sendJson(res, 200, {
    tasks: out,
    count: out.length,
    totalMatched: tasks.length,
    truncated,
    updatedAt: new Date().toISOString(),
    statusFilter: includeStates,
  });
}

// /api/chuck-v3/status-strip — synthesize a small status snapshot from health
// + executor-control + runtime-chooser state. Cheap reads; computed per request.
async function handleStatusStrip(req, res) {
  const health = readJsonSafe(HEALTH_SNAPSHOT_PATH);
  const executor = readJsonSafe(EXECUTOR_CONTROL_PATH);
  const chooser = readJsonSafe(RUNTIME_CHOOSER_STATE_PATH);
  const latestProbe = chooser?.history?.[chooser.history.length - 1] || null;
  const probes = latestProbe?.probes || [];
  return sendJson(res, 200, {
    ok: true,
    ts: new Date().toISOString(),
    health: health
      ? {
          generatedAt: health.generatedAt,
          selectedVoices: (health.selectedVoices || []).slice(0, 12),
          summary: health.summary || null,
        }
      : null,
    executor: executor
      ? {
          mode: executor.mode,
          paused: executor.paused === true,
          reason: executor.reason || null,
          updatedAt: executor.updatedAt,
        }
      : null,
    runtime: {
      currentWinner: chooser?.currentWinner || null,
      lastUpdatedAt: chooser?.lastUpdatedAt || null,
      latestProbe: latestProbe
        ? {
            ts: latestProbe.ts,
            winner: latestProbe.winner,
            probes: probes.map((p) => ({
              runtime: p.runtime,
              ok: p.ok,
              score: p.score,
              latencyMs: p.latencyMs,
              rateLimited: p.rateLimited,
            })),
          }
        : null,
    },
  });
}

// /api/chuck-v3/decisions — read decision-*.json (skip last-scan.json), sort
// by ts desc, return compact view.
async function handleDecisions(req, res) {
  if (!existsSync(DECISIONS_DIR)) {
    return sendJson(res, 200, {
      decisions: [],
      updatedAt: new Date().toISOString(),
      source: "no-decisions-dir",
    });
  }
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const limit = Math.max(
    1,
    Math.min(200, parseInt(url.searchParams.get("limit") || "50", 10) || 50),
  );
  let entries;
  try {
    entries = readdirSync(DECISIONS_DIR).filter(
      (f) => f.startsWith("decision-") && f.endsWith(".json"),
    );
  } catch (err) {
    return sendJson(res, 500, { error: `readdir failed: ${err?.message || err}` });
  }
  const decisions = [];
  for (const f of entries) {
    const d = readJsonSafe(join(DECISIONS_DIR, f));
    if (!d || typeof d !== "object" || !d.id) continue;
    decisions.push({
      id: d.id,
      ts: d.ts || null,
      category: d.category || null,
      situation: d.situation || null,
      recommendation: d.recommendation || null,
      rationale: d.rationale || null,
      riskClass: d.riskClass || null,
      autoApply: d.autoApply === true,
      applied: d.applied === true,
      appliedAt: d.appliedAt || null,
      appliedAction: d.appliedAction || null,
      optionLabels: Array.isArray(d.options) ? d.options.map((o) => o?.label).filter(Boolean) : [],
    });
  }
  decisions.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  const truncated = decisions.length > limit;
  const out = truncated ? decisions.slice(0, limit) : decisions;
  return sendJson(res, 200, {
    decisions: out,
    count: out.length,
    totalMatched: decisions.length,
    truncated,
    updatedAt: new Date().toISOString(),
  });
}

// ─── voices catalog (PWA chat toggle) ───────────────────────────────────────
//
// Subset of the apex-panel-ask VOICES block, ordered for the chat toggle
// dropdown. Outage-resilient voices come first so a Joseph who lost Anthropic
// + OpenAI sees gemini-web / grok-web / perplexity-web at the top of the
// list. Ids match apex-panel-ask --only flag values exactly.
const PWA_VOICES = [
  {
    id: "gemini-web",
    label: "Gemini-Web",
    family: "google",
    surface: "web-chrome",
    outageResilient: true,
    note: "Recommended outage default — Google AI Pro, unmetered.",
  },
  {
    id: "grok-web",
    label: "Grok-Web",
    family: "xai",
    surface: "web-chrome",
    outageResilient: true,
    note: "xAI family — independent of Anthropic + OpenAI.",
  },
  {
    id: "perplexity-web",
    label: "Perplexity-Web",
    family: "perplexity",
    surface: "web-chrome",
    outageResilient: true,
    note: "Best for grounded citations + recency.",
  },
  {
    id: "claude-ai",
    label: "Opus-47-Adaptive",
    family: "anthropic",
    surface: "web-chrome",
    outageResilient: false,
    note: "Claude Opus 4.7 via claude.ai web chat.",
  },
  {
    id: "chatgpt-web",
    label: "ChatGPT-Web",
    family: "openai",
    surface: "web-chrome",
    outageResilient: false,
    note: "GPT-5.5 via chatgpt.com.",
  },
  {
    id: "claude-cli",
    label: "Opus-47-CLI",
    family: "anthropic",
    surface: "cli",
    outageResilient: false,
    note: "Fast Anthropic path (Max sub).",
  },
  {
    id: "gemini-cli",
    label: "Gemini-Pro-CLI",
    family: "google",
    surface: "cli",
    outageResilient: true,
    note: "Quota-bound but reliable.",
  },
  {
    id: "ollama-local",
    label: "Ollama-Local",
    family: "local",
    surface: "local-runtime",
    outageResilient: true,
    note: "Last-resort offline; no network needed.",
  },
];

function handleVoicesList(req, res) {
  return sendJson(res, 200, {
    voices: PWA_VOICES,
    defaultVoice: "gemini-web",
    updatedAt: new Date().toISOString(),
  });
}

// ─── /api/chuck-v3/ask — single-voice chat dispatch ────────────────────────
//
// Body: { voice: string, prompt: string, label?: string }
// Returns: { ok, voice, label, reply, replyPath, chars, ms, transport }
//
// Spawns apex-panel-ask.mjs with --only <voice> --prompt <text> --suffix ""
// (suffix="" disables the dispatcher's default 4-question suffix). On
// success, reads the saved <Label>-<Voice>-<Date>.md artifact and returns
// the body inline so the PWA can render without a second fetch.
async function handleAsk(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err?.message || String(err) });
  }
  const voice = typeof body?.voice === "string" ? body.voice.trim() : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  const label =
    typeof body?.label === "string" && body.label.trim() ? body.label.trim() : "CHUCK-PWA";
  if (!voice) return sendJson(res, 400, { error: "voice required" });
  if (!prompt) return sendJson(res, 400, { error: "prompt required" });
  if (!PWA_VOICES.some((v) => v.id === voice)) {
    return sendJson(res, 400, { error: `unknown voice: ${voice}` });
  }
  if (!existsSync(APEX_PANEL_ASK_PATH)) {
    return sendJson(res, 500, { error: `dispatch script not found at ${APEX_PANEL_ASK_PATH}` });
  }
  const start = Date.now();
  const args = [
    APEX_PANEL_ASK_PATH,
    "--only",
    voice,
    "--prompt",
    prompt,
    "--label",
    label,
    "--suffix",
    "",
    "--json",
  ];
  const result = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, ASK_PER_VOICE_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
  const ms = Date.now() - start;
  if (result.timedOut) {
    return sendJson(res, 504, {
      ok: false,
      voice,
      label,
      ms,
      error: `voice exceeded ${ASK_PER_VOICE_TIMEOUT_MS}ms`,
      stderrTail: result.stderr.slice(-500),
    });
  }
  if (result.code !== 0) {
    return sendJson(res, 502, {
      ok: false,
      voice,
      label,
      ms,
      error: `dispatch exit ${result.code}`,
      stderrTail: result.stderr.slice(-500),
    });
  }
  // Parse the final JSON object from stdout; the dispatch script may print
  // log lines + a closing JSON payload.
  let payload = null;
  try {
    const lastBrace = result.stdout.lastIndexOf("\n{");
    const candidate = lastBrace >= 0 ? result.stdout.slice(lastBrace).trim() : result.stdout.trim();
    payload = JSON.parse(candidate);
  } catch {
    /* fall through */
  }
  const voiceResult = Array.isArray(payload?.results) ? payload.results[0] : null;
  const replyPath = voiceResult?.path || null;
  let reply = "";
  if (replyPath && existsSync(replyPath)) {
    try {
      reply = readFileSync(replyPath, "utf8");
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        voice,
        label,
        ms,
        error: `read reply file failed: ${err?.message || err}`,
      });
    }
  }
  return sendJson(res, voiceResult?.ok ? 200 : 502, {
    ok: voiceResult?.ok === true,
    voice,
    label,
    ms,
    reply,
    replyPath,
    chars: reply.length,
    transport: voice.endsWith("-web") || voice.endsWith("-mac") ? "chrome-driver" : "cli",
    voiceMeta: voiceResult ?? null,
  });
}

// ─── router ────────────────────────────────────────────────────────────────
async function route(req, res) {
  if (req.method === "OPTIONS") {
    setSecurityHeaders(res);
    setCorsHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }
  const url = req.url.split("?")[0];
  if (req.method === "GET" && url === "/api/chuck-v3/push/vapid-public")
    return handleVapidPublic(req, res);
  if (req.method === "POST" && url === "/api/chuck-v3/push/subscribe")
    return handleSubscribe(req, res);
  if (req.method === "POST" && url === "/api/chuck-v3/push/unsubscribe")
    return handleUnsubscribe(req, res);
  if (req.method === "GET" && url === "/api/chuck-v3/push/subscriptions")
    return handleSubscriptionsList(req, res);
  if (req.method === "GET" && url === "/api/chuck-v3/health") return handleHealth(req, res);
  if (req.method === "GET" && url === "/api/chuck-v3/docket") return handleDocket(req, res);
  if (req.method === "GET" && url === "/api/chuck-v3/status-strip")
    return handleStatusStrip(req, res);
  if (req.method === "GET" && url === "/api/chuck-v3/decisions") return handleDecisions(req, res);
  if (req.method === "GET" && url === "/api/chuck-v3/voices") return handleVoicesList(req, res);
  if (req.method === "POST" && url === "/api/chuck-v3/ask") return handleAsk(req, res);
  if (req.method === "GET") return sendStatic(req, res);
  setSecurityHeaders(res);
  setCorsHeaders(res);
  res.statusCode = 405;
  res.end("Method Not Allowed");
}

async function main() {
  if (process.argv.includes("--status")) {
    // Try to hit /api/chuck-v3/health
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 3000);
      const r = await fetch(`http://127.0.0.1:${PORT}/api/chuck-v3/health`, { signal: ac.signal });
      const j = await r.json();
      console.log(JSON.stringify(j, null, 2));
    } catch (err) {
      console.log(
        JSON.stringify({ ok: false, error: err?.message || String(err), port: PORT }, null, 2),
      );
      process.exit(1);
    }
    return;
  }
  if (!existsSync(PWA_DIR)) {
    console.error(`[chuck-pwa-server] PWA dir missing: ${PWA_DIR}`);
    process.exit(1);
  }
  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error(`[chuck-pwa-server] route error: ${err?.stack || err}`);
      try {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "internal" }));
        }
      } catch {
        /* swallow */
      }
    });
  });
  server.on("error", (err) => {
    console.error(`[chuck-pwa-server] listen error: ${err?.message || err}`);
    process.exit(1);
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.error(`[chuck-pwa-server] listening on http://0.0.0.0:${PORT}/ (pwa=${PWA_DIR})`);
  });
  // Graceful shutdown
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
