#!/usr/bin/env node
// Chuck surface control — local perception/action primitives for macOS apps.
//
// This is deliberately small and generic. App-specific drivers should use
// these primitives, then layer policy on top (leases, receipts, approval,
// incognito requirements, protected-path checks).
//
// Examples:
//   node chuck-surface-control.mjs snapshot --app Perplexity --json
//   node chuck-surface-control.mjs click-text --app Perplexity --text '^Settings$'
//   node chuck-surface-control.mjs click-ratio --app Perplexity --x 0.02 --y 0.06
//   node chuck-surface-control.mjs return-workstation --app Codex --json

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const HOME = homedir();
const OCR_BIN = join(HOME, ".openclaw", "workspace", "bin", "apex-ocr");
const SURFACE_STATE_DIR = join(
  HOME,
  ".openclaw",
  "workspace",
  "state",
  "chuck-v2",
  "surface-control",
);
const ACTIVE_LEASE_PATH = join(SURFACE_STATE_DIR, "active-workstation-lease.json");
const RECEIPTS_DIR = join(SURFACE_STATE_DIR, "return-receipts");

function usage() {
  return [
    "usage:",
    "  chuck-surface-control.mjs frontmost [--json]",
    "  chuck-surface-control.mjs capture-workstation [--json]",
    "  chuck-surface-control.mjs lease-start [--reason REASON] [--json]",
    "  chuck-surface-control.mjs lease-status [--json]",
    "  chuck-surface-control.mjs lease-return [--json]",
    "  chuck-surface-control.mjs return-workstation [--state JSON|--app APP] [--json]",
    "  chuck-surface-control.mjs snapshot [--app APP] [--out PATH] [--json]",
    "  chuck-surface-control.mjs ocr --image PATH [--json]",
    "  chuck-surface-control.mjs click-ratio [--app APP] --x RATIO --y RATIO [--json]",
    "  chuck-surface-control.mjs click-text [--app APP] --text REGEX [--index N] [--json]",
  ].join("\n");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function osa(script, opts = {}) {
  const { timeoutMs = 12_000, ...rest } = opts;
  const res = await execFileP("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    maxBuffer: 10 * 1024 * 1024,
    ...rest,
  });
  return res.stdout.trim();
}

async function activateApp(app) {
  if (!app) {
    return;
  }
  await execFileP("open", ["-a", app], {
    encoding: "utf8",
    timeout: 12_000,
    killSignal: "SIGTERM",
  }).catch(async () => {
    await osa(`tell application ${JSON.stringify(app)} to reopen`).catch(() => {});
  });
  await osa(`tell application ${JSON.stringify(app)} to activate`);
  await sleep(350);
}

async function frontmostApp() {
  return osa(
    'tell application "System Events" to name of first application process whose frontmost is true',
  );
}

async function frontWindowTitle(app) {
  if (!app) {
    return null;
  }
  return osa(`
    tell application "System Events"
      if not (exists process ${JSON.stringify(app)}) then return ""
      tell process ${JSON.stringify(app)}
        if (count of windows) = 0 then return ""
        return name of front window
      end tell
    end tell
  `).catch(() => null);
}

async function captureChromeFrontTab() {
  try {
    const raw = await osa(`
      tell application "Google Chrome"
        if (count of windows) = 0 then return "{}"
        set w to front window
        set t to active tab of w
        return "{\\"windowIndex\\":" & (index of w as text) & ",\\"tabIndex\\":" & (active tab index of w as text) & ",\\"url\\":" & quoted form of (URL of t as text) & ",\\"title\\":" & quoted form of (title of t as text) & "}"
      end tell
    `);
    const normalized = raw
      .replace(/"url":'([^']*)'/, (_, value) => `"url":${JSON.stringify(value)}`)
      .replace(/"title":'([^']*)'/, (_, value) => `"title":${JSON.stringify(value)}`);
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

async function captureWorkstation() {
  const app = await frontmostApp().catch(() => null);
  const state = {
    capturedAt: new Date().toISOString(),
    app,
    frontWindowTitle: await frontWindowTitle(app),
    chrome: null,
  };
  if (app === "Google Chrome") {
    state.chrome = await captureChromeFrontTab();
  }
  return state;
}

function ensureSurfaceStateDir() {
  mkdirSync(RECEIPTS_DIR, { recursive: true });
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function safeLeasePart(value) {
  return (
    String(value ?? "surface")
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/g, "-")
      .replaceAll(/^-|-$/g, "")
      .slice(0, 80) || "surface"
  );
}

function newLeaseId(reason = "surface-run") {
  return [
    new Date()
      .toISOString()
      .replaceAll(/[-:.TZ]/g, "")
      .slice(0, 14),
    process.pid,
    safeLeasePart(reason),
  ].join("-");
}

async function createWorkstationLease({
  reason = "surface-run",
  runId = process.env.CHUCK_RUN_ID ?? null,
} = {}) {
  ensureSurfaceStateDir();
  const workstation = process.env.CHUCK_WORKSTATION_STATE
    ? JSON.parse(process.env.CHUCK_WORKSTATION_STATE)
    : await captureWorkstation();
  const lease = {
    leaseId: newLeaseId(reason),
    status: "active",
    reason,
    runId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    workstation,
  };
  writeJsonAtomic(ACTIVE_LEASE_PATH, lease);
  writeJsonAtomic(join(SURFACE_STATE_DIR, `${lease.leaseId}.json`), lease);
  return lease;
}

function activeWorkstationLease() {
  return readJson(ACTIVE_LEASE_PATH, null);
}

function writeReturnReceipt(lease, result) {
  ensureSurfaceStateDir();
  const receipt = {
    leaseId: lease?.leaseId ?? null,
    reason: lease?.reason ?? null,
    runId: lease?.runId ?? null,
    pid: process.pid,
    startedAt: lease?.startedAt ?? null,
    endedAt: new Date().toISOString(),
    origin: lease?.workstation ?? lease ?? null,
    result,
  };
  const stem = lease?.leaseId ?? newLeaseId("manual-return");
  writeJsonAtomic(join(RECEIPTS_DIR, `${stem}-${Date.now()}.json`), receipt);
  if (lease?.leaseId) {
    const finalLease = {
      ...lease,
      status: result?.ok ? "returned" : "return-failed",
      endedAt: receipt.endedAt,
      returnResult: result,
    };
    writeJsonAtomic(join(SURFACE_STATE_DIR, `${lease.leaseId}.json`), finalLease);
    const active = activeWorkstationLease();
    if (active?.leaseId === lease.leaseId) {
      writeJsonAtomic(ACTIVE_LEASE_PATH, finalLease);
    }
  }
  return receipt;
}

async function restoreChromeTab(chrome) {
  if (!chrome || !chrome.url) {
    return false;
  }
  const script = `
    tell application "Google Chrome"
      activate
      set targetUrl to ${JSON.stringify(chrome.url)}
      repeat with w in windows
        repeat with i from 1 to (count of tabs of w)
          set t to tab i of w
          if (URL of t as text) is targetUrl then
            set active tab index of w to i
            set index of w to 1
            return "restored"
          end if
        end repeat
      end repeat
      return "missing"
    end tell
  `;
  return (await osa(script).catch(() => "missing")) === "restored";
}

async function verifyWorkstation(state = {}) {
  const target = state?.workstation ?? state ?? {};
  const targetApp = process.env.CHUCK_WORKSTATION_RETURN_APP || target?.app;
  if (!targetApp) {
    return { ok: false, reason: "no target app" };
  }
  const frontmost = await frontmostApp().catch(() => null);
  if (frontmost !== targetApp) {
    return { ok: false, reason: "frontmost mismatch", frontmost, targetApp };
  }
  if (targetApp === "Google Chrome" && target?.chrome?.url) {
    const chrome = await captureChromeFrontTab();
    return {
      ok: chrome?.url === target.chrome.url,
      frontmost,
      targetApp,
      restoredUrl: chrome?.url ?? null,
      targetUrl: target.chrome.url,
      reason: chrome?.url === target.chrome.url ? "verified" : "chrome tab mismatch",
    };
  }
  return { ok: true, frontmost, targetApp, reason: "verified" };
}

async function restoreWorkstation(state = {}) {
  if (
    process.env.CHUCK_RETURN_WORKSTATION === "0" ||
    process.env.CHUCK_NO_RETURN_WORKSTATION === "1"
  ) {
    return { ok: true, skipped: true, reason: "disabled-by-env" };
  }
  const lease = state?.workstation ? state : null;
  const target = lease?.workstation ?? state ?? {};
  const targetApp = process.env.CHUCK_WORKSTATION_RETURN_APP || target?.app;
  if (!targetApp) {
    return { ok: false, reason: "no target app captured" };
  }
  let result = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (targetApp === "Google Chrome" && (await restoreChromeTab(target?.chrome))) {
        await sleep(250);
        const verification = await verifyWorkstation(target);
        result = {
          ok: verification.ok,
          app: targetApp,
          restored: "chrome-tab",
          attempt,
          verification,
        };
      } else {
        await activateApp(targetApp);
        await sleep(250);
        const verification = await verifyWorkstation(target);
        result = { ok: verification.ok, app: targetApp, restored: "app", attempt, verification };
      }
      if (result.ok) {
        break;
      }
    } catch (error) {
      result = {
        ok: false,
        app: targetApp,
        attempt,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    await sleep(350 * attempt);
  }
  if (!result) {
    result = { ok: false, app: targetApp, reason: "restore did not run" };
  }
  if (lease?.leaseId) {
    writeReturnReceipt(lease, result);
  }
  return result;
}

async function withWorkstationReturn(fn) {
  const lease = await createWorkstationLease({
    reason: process.env.CHUCK_WORKSTATION_REASON ?? "with-workstation-return",
  });
  let output;
  let originalError = null;
  try {
    output = await fn();
  } catch (error) {
    originalError = error;
  }
  const result = await restoreWorkstation(lease);
  if (!result.ok && process.env.CHUCK_WORKSTATION_DEBUG === "1") {
    process.stderr.write(
      `[chuck-surface-control] workstation restore failed: ${JSON.stringify(result)}\n`,
    );
  }
  if (originalError) {
    throw originalError;
  }
  if (!result.ok && process.env.CHUCK_WORKSTATION_STRICT === "1") {
    throw new Error(`workstation restore failed: ${JSON.stringify(result)}`);
  }
  return output;
}

async function desktopBounds() {
  const raw = await osa('tell application "Finder" to get bounds of window of desktop');
  const nums = raw.split(",").map((part) => Number(part.trim()));
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
    throw new Error(`Could not parse desktop bounds: ${raw}`);
  }
  const [left, top, right, bottom] = nums;
  return { left, top, width: right - left, height: bottom - top };
}

async function screenshot(path) {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  await execFileP("screencapture", ["-x", path], {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGTERM",
  });
  return path;
}

async function runOcr(imagePath) {
  if (!existsSync(OCR_BIN)) {
    throw new Error(`apex-ocr missing at ${OCR_BIN}`);
  }
  const res = await execFileP(OCR_BIN, [imagePath, "--fast"], {
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGTERM",
    maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = JSON.parse(res.stdout);
  return {
    ok: Boolean(parsed.ok),
    count: Number(parsed.count ?? 0),
    lines: Array.isArray(parsed.lines) ? parsed.lines : [],
    fullText: String(parsed.fullText ?? ""),
  };
}

function lineCenter(line, bounds) {
  const box = line.bbox ?? {};
  const x = Number(box.x ?? 0) + Number(box.w ?? 0) / 2;
  const y = Number(box.y ?? 0) + Number(box.h ?? 0) / 2;
  return {
    x: Math.round(bounds.left + bounds.width * x),
    y: Math.round(bounds.top + bounds.height * y),
  };
}

async function clickPoint(x, y) {
  await execFileP("/opt/homebrew/bin/cliclick", [`c:${x},${y}`], {
    encoding: "utf8",
    timeout: 5000,
    killSignal: "SIGTERM",
  });
  await sleep(200);
}

async function clickRatio(xRatio, yRatio) {
  const bounds = await desktopBounds();
  const x = Math.round(bounds.left + bounds.width * xRatio);
  const y = Math.round(bounds.top + bounds.height * yRatio);
  await clickPoint(x, y);
  return { x, y, xRatio, yRatio };
}

async function snapshot({ app = null, out = null } = {}) {
  await activateApp(app);
  const imagePath = out ?? join(tmpdir(), `chuck-surface-${Date.now()}.png`);
  await screenshot(imagePath);
  const [ocr, frontmost, bounds] = await Promise.all([
    runOcr(imagePath),
    frontmostApp().catch(() => null),
    desktopBounds(),
  ]);
  return { imagePath, frontmost, bounds, ocr };
}

async function clickText({ app = null, text, index = 0 } = {}) {
  if (!text) {
    throw new Error("--text is required");
  }
  const snap = await snapshot({ app });
  const pattern = new RegExp(text, "i");
  const matches = snap.ocr.lines.filter((line) => pattern.test(String(line.text ?? "")));
  if (matches.length === 0) {
    try {
      unlinkSync(snap.imagePath);
    } catch {
      // best effort
    }
    throw new Error(`No OCR text matched ${text}`);
  }
  const match = matches[index] ?? matches[0];
  const point = lineCenter(match, snap.bounds);
  await clickPoint(point.x, point.y);
  try {
    unlinkSync(snap.imagePath);
  } catch {
    // best effort
  }
  return {
    clicked: point,
    matchedText: match.text ?? "",
    confidence: match.confidence ?? null,
    matchCount: matches.length,
  };
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") {
      opts.json = true;
    } else if (token.startsWith("--")) {
      const key = token.slice(2);
      opts[key] = argv[i + 1];
      i += 1;
    } else {
      opts._.push(token);
    }
  }
  return opts;
}

function printResult(result, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (cmd === "frontmost") {
    printResult({ ok: true, frontmost: await frontmostApp() }, opts.json);
  } else if (cmd === "capture-workstation") {
    printResult({ ok: true, workstation: await captureWorkstation() }, opts.json);
  } else if (cmd === "lease-start") {
    printResult(
      { ok: true, lease: await createWorkstationLease({ reason: opts.reason ?? "manual-lease" }) },
      opts.json,
    );
  } else if (cmd === "lease-status") {
    printResult({ ok: true, activeLease: activeWorkstationLease() }, opts.json);
  } else if (cmd === "lease-return") {
    const lease = activeWorkstationLease();
    if (!lease) {
      printResult({ ok: false, reason: "no active workstation lease" }, opts.json);
    } else {
      printResult(await restoreWorkstation(lease), opts.json);
    }
  } else if (cmd === "return-workstation") {
    const state = opts.state ? JSON.parse(opts.state) : { app: opts.app };
    printResult(await restoreWorkstation(state), opts.json);
  } else if (cmd === "snapshot") {
    printResult(await snapshot({ app: opts.app, out: opts.out }), opts.json);
  } else if (cmd === "ocr") {
    if (!opts.image) {
      throw new Error("--image is required");
    }
    printResult(await runOcr(opts.image), opts.json);
  } else if (cmd === "click-ratio") {
    await activateApp(opts.app);
    const x = Number(opts.x);
    const y = Number(opts.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("--x and --y ratios are required");
    }
    printResult({ ok: true, clicked: await clickRatio(x, y) }, opts.json);
  } else if (cmd === "click-text") {
    printResult(
      {
        ok: true,
        ...(await clickText({
          app: opts.app,
          text: opts.text,
          index: Number(opts.index ?? 0),
        })),
      },
      opts.json,
    );
  } else {
    throw new Error(`Unknown command: ${cmd}\n${usage()}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(
      `[chuck-surface-control] ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exit(1);
  });
}

export {
  activateApp,
  activeWorkstationLease,
  captureWorkstation,
  clickRatio,
  clickText,
  createWorkstationLease,
  desktopBounds,
  frontmostApp,
  restoreWorkstation,
  runOcr,
  snapshot,
  withWorkstationReturn,
};
