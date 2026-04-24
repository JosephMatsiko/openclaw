#!/usr/bin/env node
// apex-ring: 1
// apex-profile-worker-daemon — long-running child fork, pinned to ONE
// Chrome profile for its lifetime.
//
// Why a daemon and not a subprocess-per-ask: apex-chrome-cdp.mjs reads
// `APEX_CHROME_PROFILE` at module-load and freezes the port/profile
// there. In-process rotation is blocked by that frozen const. Spawning
// a fresh subprocess per worker call burns ~2s × 5 workers on every ask
// — ~17 min/day at Joseph's volume. The actor-per-profile pattern
// (three long-running children, each bound to profile a/b/c via env at
// fork-time) preserves per-process CDP isolation without the spawn tax:
// children live across many asks, their CDP connection to the right
// port is established once, module state freezes correctly.
//
// Protocol: IPC channel (node's child_process.fork default).
//   Parent → Child:
//     { jobId, workerId, prompt }          — dispatch a Chrome worker
//     { shutdown: true }                   — graceful exit
//   Child → Parent:
//     { jobId, ok: true, text, modelUsed }
//     { jobId, ok: false, error: { code, message, retryable } }
//
// Error codes surfaced for intelligent parent retry logic (per ChatGPT
// 5.5 Thinking's review 2026-04-23): CF_CHALLENGE, TIMEOUT,
// NOT_SIGNED_IN, WORKER_CRASH, UNKNOWN_WORKER, UNKNOWN.

import process from "node:process";

const PROFILE = process.env.APEX_CHROME_PROFILE ?? "a";

// Cookie-refresh fold (panel 2026-04-23, Opus CLI + ChatGPT + Perplexity):
// running cookie-refresh as a standalone watcher was a TCP-mode convenience
// — it spawned a subprocess with APEX_CHROME_PROFILE=<p> that connected
// to the already-running Chrome on port 9222/9223/9224 and pushed fresh
// cookies. This pattern breaks the moment we swap to --remote-debugging-pipe:
// there is no port to connect to; only the worker that owns the pipe fds
// can drive Chrome. Rather than fix that after the transport swap, fold
// cookie-refresh INTO the worker now. Same worker, same CDP connection,
// hourly setInterval on the already-attached Chrome. Simpler architecture,
// one fewer watcher, pipe-mode clean.
const COOKIE_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1h
let cookieRefreshTimer = null;
let cookieRefreshInFlight = false;

async function runCookieRefresh() {
  if (cookieRefreshInFlight) {
    return;
  }
  cookieRefreshInFlight = true;
  try {
    const mod = await import("./apex-chrome-cookies-sideload.mjs");
    const r = await mod.sideloadCookies();
    process.stderr.write(
      `[profile-worker profile=${PROFILE}] cookie-refresh pushed=${r.pushed}/${r.total ?? r.pushed}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[profile-worker profile=${PROFILE}] cookie-refresh failed: ${String(err?.message ?? err)}\n`,
    );
  } finally {
    cookieRefreshInFlight = false;
  }
}

function startCookieRefresh() {
  // Kick off a first refresh ~30s after daemon boot (staggered — let the
  // CDP connection stabilize first), then every hour.
  setTimeout(() => {
    void runCookieRefresh();
  }, 30_000);
  cookieRefreshTimer = setInterval(() => {
    void runCookieRefresh();
  }, COOKIE_REFRESH_INTERVAL_MS);
  // Don't let the timer keep the process alive on its own — the IPC
  // channel is the source of truth for daemon lifetime.
  if (cookieRefreshTimer.unref) {
    cookieRefreshTimer.unref();
  }
}

// Lazy-loaded worker registry. Dynamic import defers loading
// apex-chrome-cdp.mjs until after APEX_CHROME_PROFILE is read by the
// child. First call per workerId pays ~200-500ms import; subsequent
// calls hit module cache.
const WORKERS = {
  "chatgpt-plus": () => import("./research-chatgpt-chat.mjs").then((m) => m.askChatGPTChat),
  "perplexity-pro": () => import("./research-perplexity-chat.mjs").then((m) => m.askPerplexityChat),
  "claude-ai": () => import("./research-claude-ai-chat.mjs").then((m) => m.askClaudeAiChat),
  aistudio: () => import("./research-aistudio-chat.mjs").then((m) => m.askAiStudioChat),
  grok: () => import("./research-grok-chat.mjs").then((m) => m.askGrokChat),
  "chatgpt-codex": () => import("./research-chatgpt-codex.mjs").then((m) => m.askCodex),
};

function classifyError(err) {
  const msg = String(err?.message ?? err ?? "");
  if (/turnstile|cf-challenge|cloudflare/i.test(msg)) {
    return { code: "CF_CHALLENGE", retryable: true };
  }
  if (/not-signed-in|not signed in|login/i.test(msg)) {
    return { code: "NOT_SIGNED_IN", retryable: false };
  }
  if (/timed? ?out|timeout/i.test(msg)) {
    return { code: "TIMEOUT", retryable: true };
  }
  return { code: "WORKER_ERROR", retryable: true };
}

async function handleJob({ jobId, workerId, prompt }) {
  const loader = WORKERS[workerId];
  if (!loader) {
    return {
      jobId,
      ok: false,
      error: { code: "UNKNOWN_WORKER", message: `no handler for ${workerId}`, retryable: false },
    };
  }
  try {
    const ask = await loader();
    const result = await ask({ prompt });
    return {
      jobId,
      ok: true,
      text: result.text ?? "",
      modelUsed: result.modelUsed ?? workerId,
    };
  } catch (err) {
    const { code, retryable } = classifyError(err);
    return {
      jobId,
      ok: false,
      error: { code, message: String(err?.message ?? err), retryable },
    };
  }
}

process.on("message", async (msg) => {
  if (msg?.shutdown) {
    // Let in-flight jobs finish naturally — parent should stop sending.
    process.stderr.write(`[profile-worker profile=${PROFILE}] shutdown signal\n`);
    setTimeout(() => process.exit(0), 2000);
    return;
  }
  if (!msg?.jobId || !msg?.workerId) {
    process.stderr.write(
      `[profile-worker profile=${PROFILE}] bad message: ${JSON.stringify(msg)}\n`,
    );
    return;
  }
  const response = await handleJob(msg);
  try {
    process.send(response);
  } catch (err) {
    // Channel may have closed during a long job — can't report, log only.
    process.stderr.write(
      `[profile-worker profile=${PROFILE}] send failed jobId=${msg.jobId}: ${String(err)}\n`,
    );
  }
});

process.on("disconnect", () => {
  process.stderr.write(`[profile-worker profile=${PROFILE}] disconnected\n`);
  process.exit(0);
});

process.stderr.write(`[profile-worker pid=${process.pid} profile=${PROFILE}] ready\n`);

// Start the in-daemon cookie-refresh schedule. See comment above the
// refresh helpers for the rationale — this replaces the separate
// watchers/apex-chrome-cookie-refresh.mjs watcher, which cannot reach
// the daemon's Chrome in pipe mode (there's no port, and the profile
// directory is exclusively locked by the daemon's Chrome instance).
startCookieRefresh();
