#!/usr/bin/env node
// Apex Chrome Driver — sovereign facade over the Chrome-drive backends.
//
// One API, three backends, picked per-session:
//
//   "cdp"         → apex-chrome-cdp     — Apex Chrome instance on
//                   localhost:9222. Fastest (raw CDP), daemon-safe,
//                   works in any node subprocess. Preferred default.
//
//   "applescript" → apex-chrome-lib     — Joseph's main Chrome via
//                   osascript + `execute javascript`. Subject to the
//                   "Allow JavaScript from Apple Events" gate.
//
//   "claude-in-chrome" → NOT routable from subprocess. The Chrome-
//                   extension-backed MCP is only available inside a
//                   live Claude Code interactive session; it cannot be
//                   reached from a daemon or a .mjs subprocess. When
//                   callers ARE interactive, they should use
//                   mcp__Claude_in_Chrome__* tools directly — not this
//                   router. This file documents the reason and routes
//                   around it.
//
// Backend selection (in order unless overridden by APEX_CHROME_DRIVER):
//   1. CDP  — if Apex Chrome is already up at the configured port
//   2. AppleScript — if Chrome's Apple-Events JS gate is enabled
//   3. CDP with auto-bootstrap — spawn Apex Chrome ourselves
//
// Tab abstraction: every driver method takes or returns an object with
// a `_backend` tag so subsequent calls route to the matching backend.
//
// Exports:
//   pickBackend(), getBackendInfo()
//   findOrOpenTab, evalInTab, waitForPageReady, pollUntilStable,
//   insertText, dispatchKey, closeTab
//   resolveIntent (semantic: intent-to-selector; currently heuristic,
//     pluggable to an LLM later per the "Claude-in-Chrome as semantic
//     compiler" pattern)
//
// The API intentionally matches apex-chrome-lib so workers can swap
// their import from `./apex-chrome-lib.mjs` → `./apex-chrome-driver.mjs`
// with zero behavior change.

import { spawn } from "node:child_process";
import { findElements } from "./apex-chrome-cdp-observe.mjs";
import * as cdp from "./apex-chrome-cdp.mjs";
import * as applescript from "./apex-chrome-lib.mjs";

// ---- Backend selection -------------------------------------------------

// Cache the picked backend for this process (avoids re-probing).
let cachedBackend = null;

async function isAppleScriptGateOpen() {
  return new Promise((resolve) => {
    const p = spawn(
      "/usr/bin/osascript",
      [
        "-e",
        'tell application "Google Chrome" to tell active tab of front window to execute javascript "1"',
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve(false);
    }, 3000);
    p.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(true);
      } else {
        resolve(!stderr.includes("Apple Events") && !stderr.includes("-10004") && code === 0);
      }
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function pickBackend({ forceRefresh = false } = {}) {
  if (cachedBackend && !forceRefresh) {
    return cachedBackend;
  }
  const envOverride = process.env.APEX_CHROME_DRIVER;
  if (envOverride) {
    if (envOverride === "cdp" || envOverride === "applescript") {
      cachedBackend = envOverride;
      return cachedBackend;
    }
    if (envOverride === "claude-in-chrome") {
      throw new Error(
        "claude-in-chrome is not routable from subprocess — call mcp__Claude_in_Chrome__* tools directly in an interactive session",
      );
    }
  }
  // Priority 1: Apex Chrome (CDP) already up
  if (await cdp.isApexChromeUp()) {
    cachedBackend = "cdp";
    return cachedBackend;
  }
  // Priority 2: AppleScript gate open on main Chrome
  if (await isAppleScriptGateOpen()) {
    cachedBackend = "applescript";
    return cachedBackend;
  }
  // Priority 3: bootstrap CDP — spawns Apex Chrome on demand
  cachedBackend = "cdp";
  return cachedBackend;
}

export async function getBackendInfo() {
  const backend = await pickBackend();
  if (backend === "cdp") {
    const up = await cdp.isApexChromeUp();
    return { backend, apexChromeUp: up, port: Number(process.env.APEX_CHROME_CDP_PORT ?? 9222) };
  }
  return { backend, note: "drives Joseph's main Chrome via AppleScript" };
}

// ---- Tab shape ---------------------------------------------------------
//
// We wrap every backend tab in { _backend, handle } so later calls can
// dispatch. The object also exposes the handle's public fields (id,
// url, title, target) transparently for convenience.

function wrap(backend, handle, opts = {}) {
  const wrapped = { _backend: backend, handle, urlMatch: opts.urlMatch };
  if (backend === "cdp" && handle) {
    wrapped.id = handle.id;
    wrapped.url = handle.url;
    wrapped.title = handle.title;
    wrapped.close = () => handle.close?.();
  } else if (backend === "applescript" && handle) {
    wrapped.target = handle.target;
    wrapped.winIdx = handle.winIdx;
    wrapped.tabIdx = handle.tabIdx;
    wrapped.created = handle.created;
  }
  return wrapped;
}

// AppleScript "tab N of window M" handles go stale when parallel voices
// reorder Chrome windows or close tabs (each findOrOpenTab raises its
// window to front, shifting indices of others). When an op hits the
// AppleScript -1719 "Invalid index" / "Can't get tab N of window 1"
// error, refresh the tab's target by URL match and retry. Single retry
// proved insufficient under 5-voice parallel dispatch — the refresh
// itself raises a window which can re-stale a sibling voice's handle
// it just refreshed. Fix: serialize all Chrome AppleScript ops within
// this process via an in-process mutex AND retry up to 3 times.
const STALE_HANDLE_RX = /-1719|Invalid index|Can.t get tab|Can.t get window/i;
const MAX_REFRESH_RETRIES = 3;

let chromeAppleScriptLock = Promise.resolve();
async function withChromeAppleScriptLock(fn) {
  const prior = chromeAppleScriptLock;
  let release;
  chromeAppleScriptLock = new Promise((r) => {
    release = r;
  });
  try {
    await prior;
  } catch {
    /* prior chain may reject; we still proceed */
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

async function refreshAppleScriptTab(tab) {
  if (tab?._backend !== "applescript" || !tab.urlMatch) {
    return tab;
  }
  try {
    const fresh = await applescript.findOrOpenTab({ urlMatch: tab.urlMatch });
    tab.handle.target = fresh.target;
    tab.handle.winIdx = fresh.winIdx;
    tab.handle.tabIdx = fresh.tabIdx;
    tab.target = fresh.target;
    tab.winIdx = fresh.winIdx;
    tab.tabIdx = fresh.tabIdx;
  } catch {
    // Best-effort; the next op error will surface if refresh fails too.
  }
  return tab;
}

function isStaleHandleError(result) {
  if (!result) {
    return false;
  }
  if (result.ok) {
    return false;
  }
  return STALE_HANDLE_RX.test(String(result.error ?? ""));
}

// URL-verifying eval. The "tab N of window M" reference can silently
// address the WRONG tab after parallel voices' findOrOpenTab calls
// reorder windows. The lock + stale-error retry catches the loud case
// (-1719); this catches the silent case where eval succeeds but reads
// from a sibling voice's tab. Wraps user code to also return
// location.href, then verifies the URL still matches the tab's
// urlMatch substring.
async function evalInTabWithRetry(tab, code) {
  const expectedUrlMatch = tab?.urlMatch ?? "";
  const wrappedCode = `var __url = location.href; var __r = (function(){ ${code} })(); return { __r: __r, __url: __url };`;
  return await withChromeAppleScriptLock(async () => {
    let r = await applescript.evalInTab(tab.handle.target, wrappedCode);
    for (let attempt = 0; attempt < MAX_REFRESH_RETRIES; attempt++) {
      if (isStaleHandleError(r)) {
        await refreshAppleScriptTab(tab);
        r = await applescript.evalInTab(tab.handle.target, wrappedCode);
        continue;
      }
      // Silent wrong-tab: eval succeeded but URL mismatches what we
      // expected. Means sibling voices reordered our tab away.
      if (r.ok && expectedUrlMatch) {
        const seenUrl = String(r.value?.__url ?? "");
        if (!seenUrl.includes(expectedUrlMatch)) {
          await refreshAppleScriptTab(tab);
          r = await applescript.evalInTab(tab.handle.target, wrappedCode);
          continue;
        }
      }
      break;
    }
    // Unwrap our wrapper to return the user's original shape.
    if (r.ok && r.value && Object.prototype.hasOwnProperty.call(r.value, "__r")) {
      return { ok: true, value: r.value.__r };
    }
    return r;
  });
}

// ---- Unified API (matches apex-chrome-lib + adds absorbed UI) ---------

export async function findOrOpenTab({ urlMatch, createUrl } = {}) {
  const backend = await pickBackend();
  if (backend === "cdp") {
    const handle = await cdp.findOrOpenTab({ urlMatch, createUrl });
    return wrap("cdp", handle, { urlMatch });
  }
  // Serialize: parallel voices each calling findOrOpenTab without a lock
  // reorder windows mid-call, which is the root cause of the -1719 race.
  const handle = await withChromeAppleScriptLock(async () =>
    await applescript.findOrOpenTab({ urlMatch, createUrl }),
  );
  return wrap("applescript", handle, { urlMatch });
}

export async function evalInTab(tab, code) {
  if (tab?._backend === "cdp") {
    return await cdp.evalInTab(tab.handle, code);
  }
  if (tab?._backend === "applescript") {
    return await evalInTabWithRetry(tab, code);
  }
  throw new Error("evalInTab: tab missing _backend tag — was it created via findOrOpenTab?");
}

export async function waitForPageReady(tab, opts = {}) {
  if (tab?._backend === "cdp") {
    return await cdp.waitForPageReady(tab.handle, opts);
  }
  if (tab?._backend === "applescript") {
    // Don't hold the lock for the full wait duration — that blocks
    // sibling voices for 15-30s. Instead, do our own ready-poll using
    // the locked evalInTabWithRetry so each readyState check is
    // race-safe but the loop releases the lock between ticks.
    const { timeoutMs = 15000, urlIncludes } = opts ?? {};
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await evalInTabWithRetry(
        tab,
        `return { ready: document.readyState, url: location.href };`,
      );
      if (r.ok) {
        const v = r.value ?? {};
        const urlOk = urlIncludes ? String(v.url ?? "").includes(urlIncludes) : true;
        if (v.ready === "complete" && urlOk) {
          return true;
        }
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    return false;
  }
  throw new Error("waitForPageReady: missing _backend tag");
}

export async function pollUntilStable({ tab, read, ...rest } = {}) {
  if (tab?._backend === "cdp") {
    return await cdp.pollUntilStable({
      tab: tab.handle,
      read: async (t) => {
        const wrapped = wrap("cdp", t);
        return await read(wrapped);
      },
      ...rest,
    });
  }
  if (tab?._backend === "applescript") {
    return await applescript.pollUntilStable({
      target: tab.handle.target,
      read: async (_t) => {
        // Pass the original wrapped tab forward. Its evalInTab calls
        // through the locked evalInTabWithRetry pattern, which auto-
        // refreshes on stale-handle errors. Pre-emptive refresh on
        // every tick was tested 2026-04-28 and caused window-raise
        // thrashing; rely on retry-on-error instead.
        return await read(tab);
      },
      ...rest,
    });
  }
  throw new Error("pollUntilStable: missing _backend tag");
}

export async function insertText(tab, text) {
  if (tab?._backend === "cdp") {
    return await cdp.insertText(tab.handle, text);
  }
  if (tab?._backend === "applescript") {
    // AppleScript path doesn't have a direct equivalent; use evalInTab
    // + execCommand('insertText'). Workers should have their own
    // ProseMirror-aware paths in the AppleScript world.
    const code = `
      var el = document.activeElement;
      if (!el) return { ok: false, error: "no active element" };
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.value = (el.value || "") + ${JSON.stringify(String(text))};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true };
      }
      if (document.execCommand) {
        document.execCommand('insertText', false, ${JSON.stringify(String(text))});
        return { ok: true };
      }
      return { ok: false, error: "insertion failed" };
    `;
    return await evalInTabWithRetry(tab, code);
  }
  throw new Error("insertText: missing _backend tag");
}

export async function dispatchKey(tab, keyName) {
  if (tab?._backend === "cdp") {
    return await cdp.dispatchKey(tab.handle, keyName);
  }
  if (tab?._backend === "applescript") {
    if (keyName === "Enter") {
      return await applescript.keystrokeReturn();
    }
    // Limited keystroke surface under AppleScript.
    throw new Error(`dispatchKey: AppleScript backend only supports "Enter"; got ${keyName}`);
  }
  throw new Error("dispatchKey: missing _backend tag");
}

export async function closeTab(tab) {
  if (tab?._backend === "cdp") {
    return await cdp.closeTab(tab.handle);
  }
  if (tab?._backend === "applescript") {
    // apex-chrome-lib doesn't expose close; approximate via AppleScript.
    const script = `tell application "Google Chrome" to close ${tab.handle.target}`;
    const res = await applescript.runAppleScript(script);
    return res.ok;
  }
  return false;
}

// ---- Semantic compiler: intent → selector -----------------------------
//
// Usage: `const { selector, candidates } = await resolveIntent(tab,
// "send button"); await click({ selector, tab });`
//
// Current implementation: CSS heuristic + text match (the same one in
// apex-chrome-cdp-observe's findElements). The interface is designed
// for pluggable upgrades — callers receive `candidates` ranked by
// score; an LLM-backed resolver can later rerank without changing the
// API contract.

export async function resolveIntent(tab, intent, { limit = 5, useLlm = false } = {}) {
  if (tab?._backend !== "cdp") {
    // findElements is CDP-only right now; an AppleScript port is
    // trivial but unbuilt. Callers fallback to CSS selectors directly.
    return { selector: null, candidates: [], backend: tab?._backend };
  }
  const candidates = await findElements(tab.handle, intent, { limit });
  let best = candidates[0];
  let rerankReason = "heuristic-first-match";
  if (useLlm && candidates.length > 1) {
    try {
      const reranked = await llmRerank({ intent, candidates });
      if (reranked) {
        best = reranked;
        rerankReason = "llm-reranked";
      }
    } catch (err) {
      rerankReason = `llm-failed-fallback-heuristic: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return {
    selector: best?.refHint ?? null,
    candidates,
    backend: "cdp",
    rerankReason,
  };
}

// LLM-backed reranker — hand candidates + natural-language intent to
// Claude Opus, get back the best match. Used only when caller passes
// `useLlm: true`; default path is heuristic (free, fast).
async function llmRerank({ intent, candidates }) {
  const { spawn } = await import("node:child_process");
  const prompt = [
    `You are picking the single best DOM element for a natural-language intent.`,
    ``,
    `Intent: ${intent}`,
    ``,
    `Candidates (JSON):`,
    JSON.stringify(candidates, null, 2),
    ``,
    `Output ONLY the index (0-based) of the best match, nothing else.`,
  ].join("\n");
  const out = await new Promise((resolve, reject) => {
    const p = spawn(
      "claude",
      ["-p", prompt, "--model", "opus", "--fallback-model", "sonnet", "--output-format", "text"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      p.kill("SIGTERM");
      reject(new Error("llmRerank timeout"));
    }, 30_000);
    p.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    p.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
  const idx = Number.parseInt(out.match(/\d+/)?.[0] ?? "0", 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= candidates.length) {
    return null;
  }
  return candidates[idx];
}

// ---- CLI (smoke test / status) ----------------------------------------

async function mainCli() {
  const cmd = process.argv[2] ?? "status";
  if (cmd === "status") {
    const info = await getBackendInfo();
    console.log(`[apex-chrome-driver] picked backend: ${info.backend}`);
    for (const [k, v] of Object.entries(info)) {
      if (k === "backend") {
        continue;
      }
      console.log(`  ${k}: ${v}`);
    }
    return;
  }
  if (cmd === "eval") {
    const urlMatch = process.argv[3];
    const code = process.argv.slice(4).join(" ");
    if (!urlMatch || !code) {
      console.error("usage: apex-chrome-driver.mjs eval <url-substring> <js-expr>");
      process.exit(2);
    }
    const tab = await findOrOpenTab({ urlMatch });
    await waitForPageReady(tab, { timeoutMs: 8000 });
    const res = await evalInTab(tab, `return ${code};`);
    await closeTab(tab);
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.error("usage: apex-chrome-driver.mjs [status|eval <url> <expr>]");
  process.exit(2);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  mainCli().catch((err) => {
    console.error(`[apex-chrome-driver] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
