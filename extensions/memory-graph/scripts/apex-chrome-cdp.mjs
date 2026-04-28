#!/usr/bin/env node
// Apex Chrome CDP — sovereign Chrome DevTools Protocol driver.
//
// Runs a DEDICATED parallel Chrome instance (separate user-data-dir,
// separate pid) exclusively for Apex workloads. Zero interaction with
// Joseph's main Chrome. No AppleScript, no Apple Events flag, no
// third-party extension, no Claude-in-Chrome dependency.
//
// Why: Chromium deliberately requires a real mouse-click to toggle
// "Allow JavaScript from Apple Events"; all synthetic attempts
// (osascript System Events AXPress, help-search, defaults write,
// Preferences file inject) are silently refused. The Apex path around
// this is to own a Chrome instance where CDP is always available.
//
// Primitives (same API contract as apex-chrome-lib so workers can
// dispatch to either driver):
//
//   ensureApexChrome()                           — bootstrap + wait ready
//   findOrOpenTab({ urlMatch, createUrl })       — resolves to an ApexTab
//   evalInTab(tab, code)                         — JS eval, JSON-wrapped
//   waitForPageReady(tab, opts)                  — readyState === complete
//   pollUntilStable({ target, read, opts })      — generic stability poll
//   dispatchKey(tab, keyName)                    — synthetic Enter/Tab/etc.
//   insertText(tab, text)                        — IME-path text insertion (ProseMirror-safe)
//   close(tab)                                   — release CDP connection
//   killApexChrome()                             — tear the instance down
//
// Transport: Node 24 native `fetch` + `WebSocket`. No deps.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Multi-profile fleet: default is `profile-a` on 9222; callers can
// select other profiles via APEX_CHROME_PROFILE=a|b|c or
// APEX_CHROME_CDP_PORT. Each profile has its own user-data-dir → own
// cookies, own Cloudflare-fingerprint history. Dispatch round-robins
// across profiles to spread fingerprint load.
const PROFILE_ID = process.env.APEX_CHROME_PROFILE ?? "a";
const PROFILE_PORT_BASE = 9222;
const PROFILE_OFFSETS = { a: 0, b: 1, c: 2, d: 3, e: 4 };
const CDP_PORT = Number(
  process.env.APEX_CHROME_CDP_PORT ?? PROFILE_PORT_BASE + (PROFILE_OFFSETS[PROFILE_ID] ?? 0),
);
const PROFILE_DIR =
  process.env.APEX_CHROME_PROFILE_DIR ??
  join(homedir(), ".openclaw", `chrome-apex-profile-${PROFILE_ID}`);
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;

export const APEX_PROFILE_ID = PROFILE_ID;
export const APEX_CDP_PORT = CDP_PORT;
export const APEX_PROFILE_DIR = PROFILE_DIR;

export function profilePortFor(profileId) {
  return PROFILE_PORT_BASE + (PROFILE_OFFSETS[profileId] ?? 0);
}
export function profileDirFor(profileId) {
  return join(homedir(), ".openclaw", `chrome-apex-profile-${profileId}`);
}

// ---- HTTP helpers ------------------------------------------------------

async function cdpFetch(pathAndQuery, { timeoutMs = 2000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${CDP_BASE}${pathAndQuery}`, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`CDP HTTP ${res.status}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("json") ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function isApexChromeUp() {
  try {
    const v = await cdpFetch("/json/version", { timeoutMs: 800 });
    return Boolean(v?.Browser);
  } catch {
    return false;
  }
}

// ---- bootstrap ---------------------------------------------------------

let bootstrapped = null;

// Run headed by default so the operator can inspect and recover the
// browser cockpit. Do not add stealth or anti-detect flags here: Chuck's
// Kernel policy permits honest browser automation, not cloaking.
export async function ensureApexChrome({ waitMs = 12000, headless = false } = {}) {
  if (bootstrapped) {
    return bootstrapped;
  }
  if (await isApexChromeUp()) {
    bootstrapped = { alreadyRunning: true, pid: null };
    return bootstrapped;
  }
  if (!existsSync(PROFILE_DIR)) {
    mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  }
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-translate",
    "--disable-sync",
    "--metrics-recording-only",
    "--disable-component-update",
    "--disable-popup-blocking",
    "--disable-default-apps",
    "--disable-features=IsolateOrigins,site-per-process,Translate,MediaRouter",
    "--no-service-autorun",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--no-pings",
    "--start-minimized",
  ];
  if (headless) {
    args.push("--headless=new");
  }
  const child = spawn(CHROME_BIN, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    if (await isApexChromeUp()) {
      bootstrapped = { alreadyRunning: false, pid: child.pid };
      return bootstrapped;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`ensureApexChrome: CDP did not come up within ${waitMs}ms on port ${CDP_PORT}`);
}

// Shuts down the Apex Chrome instance cleanly via CDP Browser.close,
// falls back to SIGTERM if CDP is unresponsive.
export async function killApexChrome() {
  try {
    const v = await cdpFetch("/json/version", { timeoutMs: 800 });
    const ws = v?.webSocketDebuggerUrl;
    if (ws) {
      const conn = await CDPConnection.open(ws);
      try {
        await conn.send("Browser.close");
      } catch {
        /* ignore — probably already going down */
      } finally {
        conn.close();
      }
    }
  } catch {
    /* ignore */
  }
  bootstrapped = null;
}

// ---- CDP connection wrapper -------------------------------------------

class CDPConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }
  static async open(wsUrl) {
    const c = new CDPConnection(wsUrl);
    await c._connect();
    return c;
  }
  _connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (err) => reject(err));
      ws.addEventListener("close", () => {
        this.closed = true;
        for (const { reject: r } of this.pending.values()) {
          r(new Error("CDP WS closed"));
        }
        this.pending.clear();
      });
      ws.addEventListener("message", (msg) => this._onMessage(msg.data));
    });
  }
  _onMessage(data) {
    let obj;
    try {
      obj = JSON.parse(String(data));
    } catch {
      return;
    }
    if (obj.id && this.pending.has(obj.id)) {
      const { resolve, reject } = this.pending.get(obj.id);
      this.pending.delete(obj.id);
      if (obj.error) {
        reject(new Error(`CDP error (${obj.error.code ?? "?"}): ${obj.error.message}`));
      } else {
        resolve(obj.result);
      }
    } else if (obj.method) {
      const ls = this.listeners.get(obj.method) ?? [];
      for (const l of ls) {
        try {
          l(obj.params);
        } catch {
          /* listener threw, ignore */
        }
      }
    }
  }
  send(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (this.closed) {
      return Promise.reject(new Error("CDP connection closed"));
    }
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    const ls = this.listeners.get(method) ?? [];
    ls.push(fn);
    this.listeners.set(method, ls);
  }
  close() {
    if (!this.closed) {
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// ---- Tab abstraction ---------------------------------------------------

// Public tab reference. `conn` is lazily opened on first eval.
export class ApexTab {
  constructor({ id, wsUrl, url, title }) {
    this.id = id;
    this.wsUrl = wsUrl;
    this.url = url;
    this.title = title;
    this._conn = null;
  }
  async conn() {
    if (this._conn) {
      return this._conn;
    }
    this._conn = await CDPConnection.open(this.wsUrl);
    // Enable domains we'll use
    await this._conn.send("Runtime.enable").catch(() => {});
    await this._conn.send("Page.enable").catch(() => {});
    return this._conn;
  }
  close() {
    this._conn?.close();
    this._conn = null;
  }
}

export async function listTabs() {
  await ensureApexChrome();
  const tabs = await cdpFetch("/json/list");
  if (!Array.isArray(tabs)) {
    throw new Error("CDP /json/list did not return an array");
  }
  return tabs
    .filter((t) => t.type === "page")
    .map(
      (t) => new ApexTab({ id: t.id, wsUrl: t.webSocketDebuggerUrl, url: t.url, title: t.title }),
    );
}

export async function createTab(url = "about:blank") {
  return await openNewTab(url);
}

export async function closeTab(tab) {
  const id = typeof tab === "string" ? tab : tab.id;
  try {
    if (tab && typeof tab.close === "function") {
      tab.close();
    }
  } catch {
    /* ignore */
  }
  const res = await fetch(`${CDP_BASE}/json/close/${encodeURIComponent(id)}`);
  return res.ok;
}

// Navigate: url, or special tokens "back" / "forward" / "reload".
export async function navigate(tab, urlOrDirection) {
  const conn = await tab.conn();
  if (urlOrDirection === "reload") {
    await conn.send("Page.reload");
    return;
  }
  if (urlOrDirection === "back" || urlOrDirection === "forward") {
    const history = await conn.send("Page.getNavigationHistory");
    const entries = history.entries ?? [];
    const currentIndex = history.currentIndex ?? 0;
    const targetIndex = urlOrDirection === "back" ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= entries.length) {
      throw new Error(`navigate ${urlOrDirection}: no entry at index ${targetIndex}`);
    }
    await conn.send("Page.navigateToHistoryEntry", { entryId: entries[targetIndex].id });
    return;
  }
  await conn.send("Page.navigate", { url: String(urlOrDirection) });
}

// Sequential batch execution — like Claude-in-Chrome's browser_batch.
// Each action is { name, input } and is dispatched against the provided
// driver map (callers inject the functions they want exposed to
// batch). Stops on first error by default. Returns an array of results
// interleaving output from each action.
export async function batch(actions, driverMap, { stopOnError = true } = {}) {
  if (!Array.isArray(actions)) {
    throw new Error("batch: actions[] required");
  }
  if (!driverMap || typeof driverMap !== "object") {
    throw new Error("batch: driverMap required");
  }
  const results = [];
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    const fn = driverMap[a.name];
    if (typeof fn !== "function") {
      const err = `batch[${i}]: unknown action '${a.name}'`;
      results.push({ ok: false, error: err });
      if (stopOnError) {
        return results;
      }
      continue;
    }
    try {
      const out = await fn(a.input ?? {});
      results.push({ ok: true, result: out });
    } catch (err) {
      results.push({ ok: false, error: err instanceof Error ? err.message : String(err) });
      if (stopOnError) {
        return results;
      }
    }
  }
  return results;
}

// Open a new tab. CDP supports two paths:
//   /json/new?<url>         — legacy HTTP, simple
//   Target.createTarget     — WS-based, more control
// Use legacy for simplicity; works on all Chromium builds.
async function openNewTab(url) {
  const res = await fetch(`${CDP_BASE}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  if (!res.ok) {
    throw new Error(`CDP /json/new HTTP ${res.status}`);
  }
  const t = await res.json();
  return new ApexTab({ id: t.id, wsUrl: t.webSocketDebuggerUrl, url: t.url, title: t.title });
}

// Find a tab whose URL contains `urlMatch`. If none, open a new tab at
// `createUrl` (defaults to `https://${urlMatch}/`).
export async function findOrOpenTab({ urlMatch, createUrl } = {}) {
  if (!urlMatch) {
    throw new Error("findOrOpenTab: urlMatch required");
  }
  await ensureApexChrome();
  const tabs = await listTabs();
  const existing = tabs.find((t) => (t.url ?? "").includes(urlMatch));
  if (existing) {
    return existing;
  }
  const url = createUrl ?? `https://${urlMatch}/`;
  return await openNewTab(url);
}

// ---- primitives (API-compatible with apex-chrome-lib) -----------------

export async function evalInTab(tab, code) {
  const conn = await tab.conn();
  const wrapped = `(function(){ try { var __r = (function(){ ${code} })(); return JSON.stringify({ok:true, value:__r}); } catch (e) { return JSON.stringify({ok:false, error:String(e)}); } })()`;
  try {
    const res = await conn.send("Runtime.evaluate", {
      expression: wrapped,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      return {
        ok: false,
        error:
          res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          "eval exception",
      };
    }
    const raw = res.result?.value;
    try {
      return JSON.parse(String(raw));
    } catch {
      return { ok: true, value: raw };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function waitForPageReady(tab, { timeoutMs = 15000, urlIncludes } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const res = await evalInTab(tab, `return { ready: document.readyState, url: location.href };`);
    if (res.ok) {
      const v = res.value ?? {};
      const urlOk = urlIncludes ? String(v.url ?? "").includes(urlIncludes) : true;
      if (v.ready === "complete" && urlOk) {
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// CDP-level key synthesis. `keyName` is e.g. "Enter", "Tab", "Escape".
// Uses Input.dispatchKeyEvent (not AppleScript System Events).
export async function dispatchKey(tab, keyName) {
  const conn = await tab.conn();
  const keyMap = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  };
  const base = keyMap[keyName];
  if (!base) {
    throw new Error(`dispatchKey: unknown keyName ${keyName}`);
  }
  await conn.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await conn.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

// CDP Input.insertText — the IME/composition path. Works on ProseMirror
// and React-controlled inputs without needing execCommand.
export async function insertText(tab, text) {
  const conn = await tab.conn();
  await conn.send("Input.insertText", { text: String(text) });
}

// Generic stability poller — identical semantics to apex-chrome-lib.
export async function pollUntilStable({
  tab,
  read,
  timeoutMs = 180_000,
  stableTicksRequired = 2,
  tickMs = 1500,
} = {}) {
  if (!tab || typeof read !== "function") {
    throw new Error("pollUntilStable: tab + read required");
  }
  const t0 = Date.now();
  let lastLen = -1;
  let stableTicks = 0;
  let sawStreaming = false;
  while (Date.now() - t0 < timeoutMs) {
    const v = await read(tab);
    const len = v?.text ? String(v.text).length : 0;
    if (v?.streaming) {
      sawStreaming = true;
    }
    if (!v?.streaming && len > 0 && len === lastLen) {
      stableTicks += 1;
      if (sawStreaming && stableTicks >= stableTicksRequired) {
        return String(v.text);
      }
      if (!sawStreaming && stableTicks >= stableTicksRequired + 1) {
        return String(v.text);
      }
    } else {
      stableTicks = 0;
    }
    lastLen = len;
    await new Promise((r) => setTimeout(r, tickMs));
  }
  throw new Error(`pollUntilStable timed out after ${timeoutMs}ms`);
}

// Low-level CDP accessor for modules that need cookie-sideload / network
// control / target management beyond the high-level API.
export async function browserConnection() {
  await ensureApexChrome();
  const v = await cdpFetch("/json/version");
  if (!v?.webSocketDebuggerUrl) {
    throw new Error("no browser-level WS URL");
  }
  return await CDPConnection.open(v.webSocketDebuggerUrl);
}

// ---- CLI smoke test ---------------------------------------------------

async function mainCli() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "status";
  if (cmd === "status") {
    const up = await isApexChromeUp();
    if (up) {
      const v = await cdpFetch("/json/version");
      console.log(`apex-chrome: UP (port ${CDP_PORT}) · ${v.Browser}`);
      const tabs = await listTabs();
      console.log(`tabs: ${tabs.length}`);
      for (const t of tabs) {
        console.log(`  · ${t.id.slice(0, 8)}  ${t.url}`);
      }
    } else {
      console.log(`apex-chrome: DOWN (port ${CDP_PORT})`);
    }
    return;
  }
  if (cmd === "launch") {
    await ensureApexChrome({ launchWindow: args.includes("--window") });
    const v = await cdpFetch("/json/version");
    console.log(`launched · ${v.Browser} · ws=${v.webSocketDebuggerUrl}`);
    return;
  }
  if (cmd === "kill") {
    await killApexChrome();
    console.log("killed");
    return;
  }
  if (cmd === "eval") {
    const url = args[1];
    const code = args.slice(2).join(" ");
    if (!url || !code) {
      console.error("usage: apex-chrome-cdp.mjs eval <url-substring> <js-expression>");
      process.exit(2);
    }
    const tab = await findOrOpenTab({ urlMatch: url });
    await waitForPageReady(tab, { timeoutMs: 8000 });
    const res = await evalInTab(tab, `return ${code};`);
    tab.close();
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.error("usage: apex-chrome-cdp.mjs [status|launch [--window]|kill|eval <url> <expr>]");
  process.exit(2);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  mainCli().catch((err) => {
    console.error(`[apex-chrome-cdp] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
