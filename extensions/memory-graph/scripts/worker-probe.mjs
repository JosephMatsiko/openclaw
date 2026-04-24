#!/usr/bin/env node
// Worker probe — quick health + capability check for subordinate workers.
//
// The Sovereign Gateway dispatches subordinate workers (Claude, Gemini,
// NotebookLM via Chrome, local models, etc.). Before fanning out research
// or long tasks, the orchestrator probes each worker so the bundle can
// skip unhealthy ones instead of failing hard. Cached per-process for
// PROBE_TTL_MS to avoid per-call overhead.
//
// Probes are cheap + non-destructive:
//   - claude:  `claude -p "ok"` (Sonnet), < 10s
//   - gemini:  `gemini -p "ok"` (Pro), < 10s  — fails when OAuth not set up
//
// Extend as the worker roster grows (NotebookLM, steward-toolkit, etc.).
//
// Usage:
//   node worker-probe.mjs --json
//   node worker-probe.mjs                       (human-readable)
//   node worker-probe.mjs --only claude,gemini
//
// Library:
//   import { probeAll, probeWorker, isHealthy } from "./worker-probe.mjs";
//   const health = await probeAll();
//   if (!isHealthy(health, "gemini")) { /* skip */ }

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PROBE_TTL_MS = 5 * 60 * 1000; // 5 min in-process cache.
const cache = new Map(); // worker → { at, result }

function now() {
  return Date.now();
}

function run(cmd, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, code: -1, stdout, stderr: stderr + "\n[timeout]" });
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function probeClaude() {
  const t0 = now();
  const res = await run("claude", ["-p", "ok", "--model", "sonnet", "--output-format", "text"], {
    timeoutMs: 20_000,
  });
  return {
    worker: "claude",
    healthy: res.ok && res.stdout.trim().length > 0,
    latencyMs: now() - t0,
    details: res.ok ? "ok" : `exit=${res.code} ${res.stderr.slice(0, 160)}`,
  };
}

async function probeGemini() {
  const t0 = now();
  // Probe via Flash (1000/day quota; Pro only has 60/day so a Pro probe
  // can exhaust the actual daily work budget).
  const res = await run(
    "gemini",
    ["-p", "ok", "--model", "gemini-2.5-flash", "--output-format", "text"],
    { timeoutMs: 45_000 },
  );
  const stdoutTrim = res.stdout.trim();
  const bundle = res.stderr + "\n" + res.stdout;
  // Capacity check must run BEFORE the empty-stdout heuristic — a 429
  // quota error produces empty stdout + the capacity message on stderr,
  // which would otherwise match looksLikePrompt and be misreported as
  // "not authenticated" (2026-04-23: observed in the wild).
  const capacityExhausted =
    /exhausted your capacity/i.test(bundle) || /TerminalQuotaError|QUOTA_EXHAUSTED/i.test(bundle);
  const looksLikePrompt =
    !capacityExhausted &&
    (/\[y\/n\]/i.test(stdoutTrim) || /\bsign in\b/i.test(stdoutTrim) || stdoutTrim.length === 0);
  // Quota-exhausted is not "healthy" for dispatch purposes, but it IS
  // authenticated — report with a distinct status so operators can
  // distinguish transient quota from persistent auth failure.
  const healthy = res.ok && !looksLikePrompt && !capacityExhausted;
  let details = "ok (flash)";
  if (!healthy) {
    if (capacityExhausted) {
      const m = bundle.match(/reset after (\d+h[\d]*m?[\d]*s?|\d+m[\d]*s?|\d+s)/i);
      const resetIn = m ? m[1] : "unknown";
      details = `AUTH OK — flash quota exhausted, resets in ${resetIn}`;
    } else if (looksLikePrompt) {
      details = "not authenticated — run `gemini` in a terminal once to complete OAuth";
    } else {
      details = `exit=${res.code} ${(res.stderr || res.stdout).slice(0, 160)}`;
    }
  }
  return {
    worker: "gemini",
    healthy,
    latencyMs: now() - t0,
    details,
  };
}

// Ollama probe — HTTP GET to /api/tags. When the daemon is up, it lists
// installed local models. Treated as healthy when at least one chat model
// AND one embedding model exist (nomic-embed-text or similar).
async function probeOllama() {
  const t0 = now();
  const url = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        worker: "ollama",
        healthy: false,
        latencyMs: now() - t0,
        details: `http ${res.status}`,
      };
    }
    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];
    const names = models.map((m) => String(m.name ?? "").toLowerCase());
    const hasChat = names.some((n) => !n.includes("embed") && !n.includes("nomic"));
    const hasEmbed = names.some((n) => n.includes("embed") || n.includes("nomic"));
    const healthy = hasChat; // embed optional — chat is the blocker
    const parts = [`${names.length} models`];
    if (hasChat) {
      parts.push("chat:yes");
    } else {
      parts.push("chat:MISSING");
    }
    if (hasEmbed) {
      parts.push("embed:yes");
    } else {
      parts.push("embed:no (pull nomic-embed-text)");
    }
    return {
      worker: "ollama",
      healthy,
      latencyMs: now() - t0,
      details: parts.join(" "),
      models: names,
    };
  } catch (err) {
    return {
      worker: "ollama",
      healthy: false,
      latencyMs: now() - t0,
      details: `unreachable at ${url} — ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Searxng probe — HTTP GET to /stats (or /search?q=...&format=json). Treated
// as healthy when the instance responds with valid JSON.
async function probeSearxng() {
  const t0 = now();
  const url = process.env.SEARXNG_URL || "http://127.0.0.1:8080";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${url}/search?q=ping&format=json`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return {
        worker: "searxng",
        healthy: false,
        latencyMs: now() - t0,
        details: `http ${res.status}`,
      };
    }
    const data = await res.json().catch(() => null);
    const hits = Array.isArray(data?.results) ? data.results.length : 0;
    return {
      worker: "searxng",
      healthy: Boolean(data),
      latencyMs: now() - t0,
      details: data ? `ok (${hits} hits on 'ping')` : "bad json",
    };
  } catch (err) {
    return {
      worker: "searxng",
      healthy: false,
      latencyMs: now() - t0,
      details: `unreachable at ${url} — ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Cookie-based probe factory for Chrome-web subscription workers. Each
// worker has no CLI; presence of a session cookie for its domain in the
// main Chrome profile is the gate. Factory avoids 60-LOC duplication
// per worker.
function makeCookieProbe({ worker, domains, matchNames }) {
  return async function probe() {
    const t0 = now();
    const cookiesPath =
      process.env.CHROME_COOKIES_PATH ??
      join(homedir(), "Library", "Application Support", "Google", "Chrome", "Default", "Cookies");
    if (!existsSync(cookiesPath)) {
      return {
        worker,
        healthy: false,
        latencyMs: now() - t0,
        details: `Chrome cookies DB not found at ${cookiesPath}`,
      };
    }
    let db;
    try {
      db = new DatabaseSync(`file:${cookiesPath}?mode=ro&immutable=1`, { readOnly: true });
    } catch (err) {
      return {
        worker,
        healthy: false,
        latencyMs: now() - t0,
        details: `cookies open failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      const domainList = Array.isArray(domains) ? domains : [domains];
      const domainClauses = domainList
        .flatMap((d) => [`host_key = '${d}'`, `host_key = '.${d}'`, `host_key LIKE '%.${d}'`])
        .join(" OR ");
      const nameClauses = (matchNames ?? ["%session%", "%auth%", "cf_clearance"])
        .map((n) => (n.includes("%") ? `name LIKE '${n}'` : `name = '${n}'`))
        .join(" OR ");
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM cookies WHERE (${domainClauses}) AND (${nameClauses})`)
        .get();
      const n = Number(row?.n ?? 0);
      const healthy = n > 0;
      return {
        worker,
        healthy,
        latencyMs: now() - t0,
        details: healthy
          ? `${n} session cookie(s) on ${domainList.join(", ")}`
          : `no session cookies for ${domainList.join(", ")} — sign in once`,
      };
    } catch (err) {
      return {
        worker,
        healthy: false,
        latencyMs: now() - t0,
        details: `cookies query failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      db.close();
    }
  };
}

const probeChatGPT = makeCookieProbe({
  worker: "chatgpt",
  domains: ["chatgpt.com"],
  matchNames: [
    "%session%",
    "__Secure-next-auth.session-token",
    "__Secure-next-auth.callback-url",
    "cf_clearance",
  ],
});

const probePerplexity = makeCookieProbe({
  worker: "perplexity",
  domains: ["perplexity.ai"],
  matchNames: [
    "%session%",
    "%auth%",
    "next-auth.session-token",
    "__Secure-next-auth.session-token",
    "cf_clearance",
  ],
});

const probeGrok = makeCookieProbe({
  worker: "grok",
  domains: ["grok.com", "x.ai"],
  matchNames: ["%session%", "%auth%", "auth_token", "cf_clearance", "_grok_session"],
});

const probeClaudeAi = makeCookieProbe({
  worker: "claude-ai",
  domains: ["claude.ai"],
  matchNames: ["%session%", "%auth%", "sessionKey", "cf_clearance"],
});

const probeAiStudio = makeCookieProbe({
  worker: "aistudio",
  domains: ["aistudio.google.com", "google.com"],
  matchNames: ["%session%", "SID", "HSID", "SSID", "SAPISID", "APISID"],
});

// Codex shares ChatGPT Plus cookies (chatgpt.com/codex is Plus-gated).
const probeCodex = makeCookieProbe({
  worker: "codex",
  domains: ["chatgpt.com"],
  matchNames: ["%session%", "__Secure-next-auth.session-token", "cf_clearance"],
});

const REGISTRY = {
  claude: probeClaude,
  gemini: probeGemini,
  chatgpt: probeChatGPT,
  perplexity: probePerplexity,
  grok: probeGrok,
  "claude-ai": probeClaudeAi,
  aistudio: probeAiStudio,
  codex: probeCodex,
  ollama: probeOllama,
  searxng: probeSearxng,
};

export async function probeWorker(name, { forceRefresh = false } = {}) {
  const probe = REGISTRY[name];
  if (!probe) {
    return {
      worker: name,
      healthy: false,
      latencyMs: 0,
      details: `no probe registered for '${name}'`,
    };
  }
  if (!forceRefresh) {
    const cached = cache.get(name);
    if (cached && now() - cached.at < PROBE_TTL_MS) {
      return cached.result;
    }
  }
  const result = await probe();
  cache.set(name, { at: now(), result });
  return result;
}

export async function probeAll({ workers = Object.keys(REGISTRY), forceRefresh = false } = {}) {
  const results = await Promise.all(workers.map((w) => probeWorker(w, { forceRefresh })));
  const health = {};
  for (const r of results) {
    health[r.worker] = r;
  }
  return health;
}

export function isHealthy(health, worker) {
  const r = health?.[worker];
  return Boolean(r && r.healthy);
}

// ---- CLI ----

function parseArgs(argv) {
  const out = { only: null, asJson: false, forceRefresh: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--json") {
      out.asJson = true;
    } else if (t === "--refresh") {
      out.forceRefresh = true;
    } else if (t === "--only") {
      out.only = String(argv[i + 1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
    } else if (t === "-h" || t === "--help") {
      console.log("usage: worker-probe.mjs [--json] [--refresh] [--only claude,gemini]");
      process.exit(0);
    }
  }
  return out;
}

async function mainCli() {
  const args = parseArgs(process.argv.slice(2));
  const workers = args.only && args.only.length > 0 ? args.only : Object.keys(REGISTRY);
  const health = await probeAll({ workers, forceRefresh: args.forceRefresh });
  if (args.asJson) {
    console.log(JSON.stringify(health, null, 2));
    return;
  }
  for (const [name, r] of Object.entries(health)) {
    const tag = r.healthy ? "READY " : "DOWN  ";
    console.log(`${tag} ${name.padEnd(8)}  ${String(r.latencyMs).padStart(5)}ms  ${r.details}`);
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  mainCli().catch((err) => {
    console.error(`[worker-probe] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
