#!/usr/bin/env node
// Research worker — Perplexity Mac app (ai.perplexity.mac).
//
// Full protocol (per Joseph 2026-04-24):
//
//   1. `open perplexity-app://` — guarantees a window.
//   2. Standardize window position + size so fixed coordinates hold.
//   3. Open Settings (click sidebar gear) → screenshot → vision-read
//      Incognito Mode toggle state → remember `wasOff` → if OFF, click
//      the toggle ON → close Settings (Escape).
//   4. Cmd+Shift+P — new thread.
//   5. Pre-click the mode icon matching `mode` param:
//        - "research" (default): magnifier icon
//        - "labs" (a.k.a. "create anything"): lightbulb icon
//   6. Pasteboard-paste prompt → Return.
//   7. Vision-poll: screencapture + `claude -p @<path>` reads
//      `{reply, streaming, incognito}` JSON. Reply must stabilize AND
//      the "Expires in N hours" banner MUST be visible; absent → abort.
//   8. For one-shot calls, ALWAYS (`finally`) re-open Settings, flip
//      Incognito back to original state if we changed it, close Settings.
//   9. Restore user's clipboard.
//
// This driver is sovereign-hardened: it does not read or modify anything
// outside the Perplexity app window + clipboard + local screenshots
// (which are auto-deleted after read). It respects multi-user shared
// Max account by saving/restoring the Incognito toggle.
//
// Shared-Max native/Comet profile invariant (updated 2026-04-28):
//   - The Perplexity Mac app and Comet are logged into the shared Max
//     account Joseph described; Chuck drives that profile in Incognito.
//   - Joseph's personal Perplexity account is also allowed on other
//     surfaces, but receipts must tag which account profile/surface was used.
//   - Incognito is not a synonym for "disposable one-shot prompt".
//   - Treat Perplexity Incognito as one active ephemeral thread lane, not
//     as a pool of parallel Incognito threads.
//   - Do not close Perplexity windows/threads just to clean up.
//   - Long tasks should own the active Incognito thread lease and keep that
//     lane alive until the task completes, expires, changes run, or Joseph
//     closes it.
//   - The helper below is a work-session primitive: it reuses an active
//     Incognito lease for continuity, leaves the app/thread open after the
//     answer, and restores the account-level toggle only when explicitly
//     running in one-shot/sleep mode.

import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createWorkstationLease, restoreWorkstation } from "./chuck-surface-control.mjs";

const execFileP = promisify(execFile);
const HOME = homedir();
const PERPLEXITY_LEASE_DIR = join(
  HOME,
  ".openclaw",
  "workspace",
  "state",
  "chuck-v2",
  "perplexity-leases",
);
const ACTIVE_PERPLEXITY_LEASE_PATH = join(PERPLEXITY_LEASE_DIR, "active-mac-app-lease.json");

const APP_NAME = "Perplexity";
const APP_URL_SCHEME = "perplexity-app://";

// Legacy standardized window layout. The current shared-Max profile protocol
// prefers Perplexity fullscreen so the sidebar/settings route is stable.
// Set PERPLEXITY_MAC_STANDARDIZE=1 only when intentionally using the old
// fixed-window coordinate path.
const WINDOW_POS = [100, 40];
const WINDOW_SIZE = [1000, 800];

function readJsonSafe(path, fallback = null) {
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
  mkdirSync(PERPLEXITY_LEASE_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function leaseExpiryIso(now = Date.now()) {
  const hours = Number(process.env.CHUCK_PERPLEXITY_LEASE_HOURS ?? 8);
  const ttlHours = Number.isFinite(hours) && hours > 0 ? hours : 8;
  return new Date(now + ttlHours * 60 * 60 * 1000).toISOString();
}

function activePerplexityMacLease({
  mode = "research",
  runId = process.env.CHUCK_RUN_ID ?? null,
  now = Date.now(),
} = {}) {
  const lease = readJsonSafe(ACTIVE_PERPLEXITY_LEASE_PATH, null);
  if (!lease || lease.status !== "active") {
    return null;
  }
  if (lease.mode !== mode) {
    return null;
  }
  if (runId && lease.runId && lease.runId !== runId) {
    return null;
  }
  if (lease.expiresAt && Date.parse(lease.expiresAt) <= now) {
    return null;
  }
  return lease;
}

function threadPolicyFromEnv(policy = process.env.CHUCK_PERPLEXITY_THREAD_POLICY ?? "auto") {
  const normalized = policy.trim().toLowerCase();
  if (["auto", "reuse", "fresh", "reset"].includes(normalized)) {
    return normalized;
  }
  return "auto";
}

function persistActivePerplexityMacLease({
  mode,
  incognitoConfirmed,
  threadState,
  modelUsed,
} = {}) {
  const existing = activePerplexityMacLease({ mode });
  const now = new Date().toISOString();
  const lease = {
    leaseId:
      existing?.leaseId ??
      `pplx-mac-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    runId: process.env.CHUCK_RUN_ID ?? existing?.runId ?? null,
    surface: "perplexity/mac-app",
    mode,
    status: "active",
    incognitoRequired: true,
    incognitoVerified: Boolean(incognitoConfirmed),
    startedAt: existing?.startedAt ?? now,
    lastObservedAt: now,
    expiresAt: existing?.expiresAt ?? leaseExpiryIso(),
    thread: {
      activeIncognitoLease: Boolean(threadState?.activeIncognitoLease),
      freshThread: Boolean(threadState?.freshThread),
      composerVisible: Boolean(threadState?.composerVisible),
      conversationVisible: Boolean(threadState?.conversationVisible),
      incognitoVisible: Boolean(threadState?.incognitoVisible),
      reason: threadState?.reason ?? "",
    },
    modelUsed: modelUsed ?? existing?.modelUsed ?? null,
    reasons: [
      "shared-Max native/Comet profile rule: Perplexity is driven in Incognito",
      "active-work rule: keep the Incognito thread open for Scout/Deepen continuity",
      "release only when the work session sleeps, expires, or Joseph closes it",
    ],
  };
  writeJsonAtomic(ACTIVE_PERPLEXITY_LEASE_PATH, lease);
  writeJsonAtomic(join(PERPLEXITY_LEASE_DIR, `${lease.leaseId}.json`), lease);
  return lease;
}

function shouldKeepPerplexityLeaseOpen() {
  if (
    process.env.CHUCK_PERPLEXITY_RESTORE_ORIGINAL === "1" ||
    process.env.CHUCK_PERPLEXITY_ONE_SHOT === "1"
  ) {
    return false;
  }
  if (process.env.CHUCK_SURFACES_SLEEP === "1" || process.env.CHUCK_FAMILIES_SLEEP === "1") {
    return false;
  }
  return true;
}

// Coordinates are expressed as screen-point ratios for Joseph's fullscreen
// Perplexity protocol. Screenshots are Retina pixels; cliclick uses macOS
// points, so these ratios are derived from Finder desktop bounds.
const COORDS = {
  sidebarToggle: [22 / 1470, 60 / 956], // top-left sidebar/tab toggle
  backButton: [356 / 1470, 61 / 956], // thread back button to home/new composer
  sidebarGear: [296 / 1470, 917 / 956], // account-settings gear
  settingsClose: [536 / 1470, 273 / 956], // X button in Settings modal
  incognitoToggle: [922 / 1470, 398 / 956], // Incognito Mode switch
  composerCenter: [735 / 1470, 870 / 956], // current fullscreen bottom composer
  // Mode icons below composer (left side):
  modeSearch: [485 / 1470, 915 / 956], // magnifier — default
  modeResearch: [526 / 1470, 915 / 956], // atom/link icon — reserved
  modeLabs: [563 / 1470, 915 / 956], // lightbulb — create
  sendButton: [1310 / 1470, 915 / 956], // send arrow appears after text
};

const OCR_BIN = join(HOME, ".openclaw", "workspace", "bin", "apex-ocr");

// --- shell helpers -------------------------------------------------------

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Per-call timeouts on every shell helper. Why: 2026-04-25 fleet pass
// had perp-mac wedge for the full 8-min outer Promise.race window AND
// keep respawning pbcopy after the wrapper rejected, since the inner
// driver's spawned children don't get cancelled when Promise.race
// loses. Per-call timeouts make each AppleScript / cliclick / pbcopy /
// screencapture call fail FAST so escalation can move within seconds,
// not minutes.
async function osa(script, opts = {}) {
  const { timeoutMs = 12_000, ...rest } = opts;
  const r = await execFileP("osascript", ["-e", script], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    ...rest,
  });
  return r.stdout.trim();
}

async function cliclick(cmd, { timeoutMs = 5000 } = {}) {
  // cliclick takes ONE OR MORE separate-argument commands. Single-command
  // strings (e.g. "c:100,200" — comma is coordinate syntax, not a command
  // separator; or "kp:return") must be passed as one arg. Multi-command
  // strings using comma joining (e.g. "kd:cmd,kd:shift") need to be split
  // into separate args. Split ONLY on commas that PRECEDE a known cliclick
  // command prefix, so "c:100,200" stays whole and "kd:cmd,kd:shift" splits.
  // Fix landed 2026-04-26 — was previously passing comma-joined strings as
  // one arg, cliclick threw "Invalid key 'kd:shift'".
  const parts = cmd.split(/,(?=(?:kd|ku|kp|c|t|m|w|d|tc|cc|wc):)/);
  await execFileP("/opt/homebrew/bin/cliclick", parts, {
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
}

async function systemKeystroke(key, modifiers = []) {
  const using =
    modifiers.length > 0 ? ` using {${modifiers.map((m) => `${m} down`).join(", ")}}` : "";
  await osa(`tell application "System Events" to keystroke ${JSON.stringify(key)}${using}`);
}

async function systemKeyCode(code, modifiers = []) {
  const using =
    modifiers.length > 0 ? ` using {${modifiers.map((m) => `${m} down`).join(", ")}}` : "";
  await osa(`tell application "System Events" to key code ${code}${using}`);
}

async function clickAt([x, y]) {
  await cliclick(`c:${x},${y}`);
  await sleep(200);
}

async function desktopBounds() {
  const raw = await osa('tell application "Finder" to get bounds of window of desktop');
  const nums = raw.split(",").map((s) => Number(s.trim()));
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
    throw new Error(`Could not parse desktop bounds: ${raw}`);
  }
  const [left, top, right, bottom] = nums;
  return { left, top, width: right - left, height: bottom - top };
}

async function coord(name) {
  const ratio = COORDS[name];
  if (!ratio) {
    throw new Error(`Unknown Perplexity coordinate: ${name}`);
  }
  const bounds = await desktopBounds();
  return [
    Math.round(bounds.left + bounds.width * ratio[0]),
    Math.round(bounds.top + bounds.height * ratio[1]),
  ];
}

async function pbpaste({ timeoutMs = 5000 } = {}) {
  const { stdout } = await execFileP("pbpaste", [], {
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  return stdout;
}

async function pbcopy(text, { timeoutMs = 5000 } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      reject(new Error(`pbcopy timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`pbcopy exit ${code}: ${stderr.trim()}`));
      }
    });
    child.stdin.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.end(String(text));
  });
}

async function screenshot(path, { timeoutMs = 10_000 } = {}) {
  await execFileP("screencapture", ["-x", path], {
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
}

// Cropped screenshot — used for the Incognito-toggle region only.
// `-R x,y,w,h` constrains capture to a rectangle. Massively reduces
// the vision model's "haystack" from 1440×900 to a tight band around
// the toggle — fixes the "returns UNKNOWN on full-screen" smoke-test
// failure from 2026-04-24.
async function screenshotRegion(path, [x, y, w, h], { timeoutMs = 10_000 } = {}) {
  await execFileP("screencapture", ["-x", "-R", `${x},${y},${w},${h}`, path], {
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
}

async function ocrLines(imagePath) {
  if (!existsSync(OCR_BIN)) {
    return [];
  }
  try {
    const { stdout } = await execFileP(OCR_BIN, [imagePath, "--fast"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 20_000,
      killSignal: "SIGTERM",
    });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed.lines) ? parsed.lines : [];
  } catch {
    return [];
  }
}

async function screenHasText(pattern) {
  const shot = join(tmpdir(), `perp-mac-ocr-${Date.now()}.png`);
  try {
    await activateApp();
    await sleep(150);
    await screenshot(shot);
    const lines = await ocrLines(shot);
    return lines.some((line) => pattern.test(String(line.text ?? "")));
  } finally {
    try {
      unlinkSync(shot);
    } catch {
      /* best effort */
    }
  }
}

async function clickScreenOcrLine(pattern) {
  const bounds = await desktopBounds();
  const shot = join(tmpdir(), `perp-mac-click-ocr-${Date.now()}.png`);
  try {
    await screenshot(shot);
    const lines = await ocrLines(shot);
    const hit = lines.find((line) => pattern.test(String(line.text ?? "")) && line.bbox);
    if (!hit?.bbox) {
      return null;
    }
    const x = Math.round(bounds.left + bounds.width * (hit.bbox.x + hit.bbox.w / 2));
    const y = Math.round(bounds.top + bounds.height * (hit.bbox.y + hit.bbox.h / 2));
    await clickAt([x, y]);
    return { text: String(hit.text ?? ""), x, y };
  } finally {
    try {
      unlinkSync(shot);
    } catch {
      /* best effort */
    }
  }
}

async function mainPaneOcrState() {
  const bounds = await desktopBounds();
  const shot = join(tmpdir(), `perp-mac-main-local-${Date.now()}.png`);
  try {
    // Ignore the left rail history; inspect only the main conversation area.
    await screenshotRegion(shot, [
      Math.round(bounds.width * 0.23),
      0,
      Math.round(bounds.width * 0.77),
      bounds.height,
    ]);
    const lines = await ocrLines(shot);
    const fullText = lines.map((line) => String(line.text ?? "")).join("\n");
    return {
      lines,
      fullText,
      composerVisible: /\bAsk anything\b/i.test(fullText),
      conversationVisible:
        /\b(Sources|Related|Summary|Progress|assistant|Answer)\b/i.test(fullText) ||
        /Update spec draft/i.test(fullText),
      incognitoVisible: /\b(Incognito|Expires in)\b/i.test(fullText),
    };
  } finally {
    try {
      unlinkSync(shot);
    } catch {
      /* best effort */
    }
  }
}

// --- app / window control ------------------------------------------------

async function activateApp() {
  await execFileP("open", [APP_URL_SCHEME]);
  await sleep(1500);
  await osa(`tell application "${APP_NAME}" to reopen`).catch(() => {});
  await osa(`tell application "${APP_NAME}" to activate`);
  await sleep(500);
}

async function standardizeWindow() {
  if (process.env.PERPLEXITY_MAC_STANDARDIZE !== "1") {
    return;
  }
  // Set the front window's position + size so all fixed coords hold.
  const [px, py] = WINDOW_POS;
  const [sx, sy] = WINDOW_SIZE;
  try {
    await osa(
      `tell application "System Events" to tell process "${APP_NAME}" to tell window 1 to set position to {${px}, ${py}}`,
    );
    await osa(
      `tell application "System Events" to tell process "${APP_NAME}" to tell window 1 to set size to {${sx}, ${sy}}`,
    );
    await sleep(300);
  } catch (e) {
    process.stderr.write(`[perp-mac] standardizeWindow warning: ${e?.message ?? e}\n`);
  }
}

// --- vision helpers ------------------------------------------------------

async function visionAsk({ imagePath, prompt, timeoutMs = 90_000 }) {
  const fullPrompt = `@${imagePath}\n\n${prompt}`;
  return new Promise((resolve, reject) => {
    const args = ["-p", fullPrompt, "--model", "opus", "--output-format", "text"];
    let stdout = "";
    let stderr = "";
    const child = execFile("claude", args, {
      maxBuffer: 20 * 1024 * 1024,
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`visionAsk timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`claude -p exit ${code}: ${stderr.trim()}`));
      }
    });
  });
}

// Pixel-color check at toggle position. Yellow background = ON, grey = OFF.
// Verified empirically 2026-04-25 via live UI test: ON state shows bright
// yellow (~R240, G180, B50), OFF shows neutral grey (~R110, G110, B110).
// This replaces the unreliable Claude-vision call (network round-trip,
// sometimes returns UNKNOWN) with a deterministic local pixel sample.
//
// Uses `screencapture -R x,y,w,h -t bmp` to grab a tiny region around the
// toggle. BMP has a simple binary header so we can parse it in pure Node
// without dependencies. Falls back to vision if screencapture fails.
async function probeTogglePixel([screenX, screenY], { sampleSize = 10 } = {}) {
  const tmp = join(tmpdir(), `perp-toggle-pixel-${process.pid}-${Date.now()}.bmp`);
  const half = Math.floor(sampleSize / 2);
  try {
    await execFileP(
      "/usr/sbin/screencapture",
      [
        "-R",
        `${screenX - half},${screenY - half},${sampleSize},${sampleSize}`,
        "-t",
        "bmp",
        "-x", // silent (no shutter sound)
        tmp,
      ],
      { timeout: 5000 },
    );
    const buf = readFileSync(tmp);
    if (buf.length < 60) {
      throw new Error(`bmp too small (${buf.length} bytes)`);
    }
    // BMP file header: bytes 0-1 "BM" magic, 10-13 = data offset (uint32 LE)
    if (buf[0] !== 0x42 || buf[1] !== 0x4d) {
      throw new Error("not a BMP file");
    }
    const dataOffset = buf.readUInt32LE(10);
    // DIB header: 18-21 width (LE), 22-25 height (signed LE — negative=top-down),
    // 28-29 bits per pixel.
    const width = buf.readUInt32LE(18);
    const height = Math.abs(buf.readInt32LE(22));
    const bpp = buf.readUInt16LE(28);
    if (width === 0 || height === 0 || (bpp !== 24 && bpp !== 32)) {
      throw new Error(`unexpected bmp shape w=${width} h=${height} bpp=${bpp}`);
    }
    const bytesPerPixel = bpp / 8;
    const rowBytes = Math.floor((bpp * width + 31) / 32) * 4;
    // Average a small cluster around the center to reduce sensitivity to
    // anti-aliasing on the toggle bar's edge.
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    let rSum = 0,
      gSum = 0,
      bSum = 0,
      n = 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || px >= width || py < 0 || py >= height) {
          continue;
        }
        const off = dataOffset + py * rowBytes + px * bytesPerPixel;
        if (off + 2 >= buf.length) {
          continue;
        }
        // BMP stores BGR (or BGRA): byte 0 = B, byte 1 = G, byte 2 = R.
        bSum += buf[off];
        gSum += buf[off + 1];
        rSum += buf[off + 2];
        n += 1;
      }
    }
    if (n === 0) {
      throw new Error("no pixels sampled");
    }
    return { r: Math.round(rSum / n), g: Math.round(gSum / n), b: Math.round(bSum / n), n };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
}

function classifyTogglePixel({ r, g, b }) {
  // Yellow/orange (Perplexity's "ON" color): R high, G mid-high, B low.
  // Empirical center: ~R240 G180 B50. Generous bounds: R>200 G>130 B<100.
  if (r > 200 && g > 130 && b < 100) {
    return "ON";
  }
  // Grey (OFF): R, G, B roughly equal, mid-range.
  // Empirical center: ~R110 G110 B110. Bounds: |R-G|<35, |G-B|<35, all in [50,180].
  if (
    Math.abs(r - g) < 35 &&
    Math.abs(g - b) < 35 &&
    r >= 50 &&
    r <= 180 &&
    g >= 50 &&
    g <= 180 &&
    b >= 50 &&
    b <= 180
  ) {
    return "OFF";
  }
  return "UNKNOWN";
}

function isToggleYellow({ r, g, b }) {
  return r > 190 && g > 120 && b < 130 && r > b + 80;
}

function isToggleNeutral({ r, g, b }) {
  return Math.abs(r - g) < 45 && Math.abs(g - b) < 45 && r >= 30 && r <= 190;
}

async function probeToggleTrack() {
  const [cx, cy] = await coord("incognitoToggle");
  const points = [
    ["left-track", [cx - 24, cy]],
    ["left-inner", [cx - 14, cy]],
    ["center", [cx, cy]],
    ["right-inner", [cx + 14, cy]],
    ["right-track", [cx + 24, cy]],
  ];
  const samples = [];
  for (const [name, point] of points) {
    samples.push({ name, point, ...(await probeTogglePixel(point, { sampleSize: 6 })) });
  }
  const yellowSamples = samples.filter((sample) => isToggleYellow(sample));
  if (yellowSamples.length > 0) {
    return { state: "ON", samples };
  }
  const nonWhiteSamples = samples.filter(
    (sample) => !(sample.r > 220 && sample.g > 220 && sample.b > 220),
  );
  if (nonWhiteSamples.some((sample) => isToggleNeutral(sample))) {
    return { state: "OFF", samples };
  }
  return { state: "UNKNOWN", samples };
}

function formatToggleSample(sample) {
  return `${sample.name}=${Number(sample.r)},${Number(sample.g)},${Number(sample.b)}`;
}

function extractStructuredReplyFromLocalOcr(lines) {
  const mainLines = lines
    .filter((line) => {
      const box = line?.bbox;
      return box && box.x >= 0.25 && box.y >= 0.18 && box.y <= 0.94;
    })
    .map((line) => String(line.text ?? "").trim())
    .filter(Boolean)
    .map((line) => line.replace(/^MISSING[\s_]+EVIDENCE\s*:/i, "MISSING_EVIDENCE:"));

  const claimIndexes = [];
  for (let i = 0; i < mainLines.length; i += 1) {
    if (/^CLAIMS\s*:?\s*$/i.test(mainLines[i])) {
      claimIndexes.push(i);
    }
  }
  const start = claimIndexes.at(-1);
  if (start === undefined) {
    return null;
  }

  const replyLines = [];
  for (const line of mainLines.slice(start)) {
    if (/\bAsk anything\b/i.test(line)) {
      continue;
    }
    if (/^(Show more|Perplexity\s+Max|Images|Sources)\b/i.test(line)) {
      continue;
    }
    if (/^(Shortcuts|Home|Discover|Spaces|Library)\b/i.test(line)) {
      continue;
    }
    replyLines.push(line);
  }

  const reply = replyLines.join("\n").trim();
  const lower = reply.toLowerCase();
  if (
    !lower.includes("claims:") ||
    !lower.includes("risks:") ||
    !lower.includes("missing_evidence:")
  ) {
    return null;
  }
  return reply;
}

async function readIncognitoToggleState(imagePath) {
  // Local instrument first: sample both sides of the switch track. Sampling
  // the center alone hits the white knob in both states, which is useless.
  try {
    const track = await probeToggleTrack();
    if (track.state === "ON" || track.state === "OFF") {
      process.stderr.write(
        `[perp-mac] toggle track → ${track.state} (${track.samples.map(formatToggleSample).join(" ")})\n`,
      );
      return track.state;
    }
    process.stderr.write(
      `[perp-mac] toggle track ambiguous (${track.samples.map(formatToggleSample).join(" ")}); falling back\n`,
    );
  } catch (e) {
    process.stderr.write(
      `[perp-mac] toggle track probe failed (${e?.message ?? e}); falling back\n`,
    );
  }

  try {
    const px = await probeTogglePixel(await coord("incognitoToggle"));
    const classified = classifyTogglePixel(px);
    if (classified === "ON" || classified === "OFF") {
      process.stderr.write(
        `[perp-mac] toggle center rgb=(${px.r},${px.g},${px.b}) → ${classified}\n`,
      );
      return classified;
    }
  } catch {
    // Ignore; final fallback is below.
  }

  // Last-resort model vision. The driver must still fail closed if this is
  // unavailable or unconvincing.
  const prompt = [
    "This image shows a single toggle switch labeled 'Incognito Mode'.",
    "Is the switch ON (filled/colored knob on the right side, toggle enabled)",
    "or OFF (grey knob on the left side, toggle disabled)?",
    'Answer EXACTLY one word: "ON" or "OFF".',
  ].join(" ");
  const raw = await visionAsk({ imagePath, prompt });
  const up = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (up.startsWith("ON")) {
    return "ON";
  }
  if (up.startsWith("OFF")) {
    return "OFF";
  }
  return "UNKNOWN";
}

async function readReplyState(imagePath) {
  const localLines = await ocrLines(imagePath);
  const localText = localLines.map((line) => String(line.text ?? "")).join("\n");
  const localProof = localText
    .match(/\b(?:SURFACE[\s_]*PROOF[\s_]*OK|APEX\s*OK\s*[A-Z0-9]+)\b[^\n]*/i)?.[0]
    ?.trim();
  if (localProof) {
    const normalizedProof = /SURFACE[\s_]*PROOF[\s_]*OK/i.test(localProof)
      ? "SURFACE_PROOF_OK"
      : localProof.replaceAll(/\s+/g, "");
    return {
      reply: normalizedProof,
      streaming: false,
      incognito: /\b(Incognito|Expires in)\b/i.test(localText),
      raw: "local-ocr-proof-token",
    };
  }
  const localStructuredReply = extractStructuredReplyFromLocalOcr(localLines);
  if (localStructuredReply) {
    return {
      reply: localStructuredReply,
      streaming: false,
      incognito: /\b(Incognito|Expires in)\b/i.test(localText),
      raw: "local-ocr-structured-reply",
    };
  }
  const prompt = [
    "You are inspecting a screenshot of the Perplexity Mac app's thread view.",
    "Answer strictly as JSON on a single line, no prose, no code fences:",
    "",
    '{ "reply": "<the assistant\'s full reply text verbatim, or empty string if no reply yet>",',
    '  "streaming": <true if a stop-button or typing-cursor indicates generation is in progress, else false>,',
    '  "incognito": <true if the thread shows an "Expires in N hours" banner near the top, else false> }',
    "",
    'Do NOT include suggested follow-up questions or "Related"/"Sources"/"Videos" chips in "reply" — only the assistant\'s main answer body.',
    "If the app is in an error/empty/settings state with no reply, set reply to empty string and streaming to false.",
  ].join("\n");
  const raw = await visionAsk({ imagePath, prompt });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    return { reply: "", streaming: false, incognito: null, raw };
  }
  try {
    const parsed = JSON.parse(m[0]);
    return {
      reply: String(parsed.reply ?? "").trim(),
      streaming: !!parsed.streaming,
      incognito: parsed.incognito === null ? null : !!parsed.incognito,
    };
  } catch {
    return { reply: "", streaming: false, incognito: null, raw };
  }
}

// --- Settings flow: open, read incognito, toggle if needed, close --------

async function ensureSidebarOpen() {
  await activateApp();
  const open = await screenHasText(/\b(New Thread|therivende85730|Shortcuts)\b/i);
  if (open) {
    return;
  }
  await clickAt(await coord("sidebarToggle"));
  await sleep(500);
}

function settingsIncognitoRegion() {
  return desktopBounds().then((bounds) => [
    Math.round(bounds.width * 0.34),
    Math.round(bounds.height * 0.36),
    Math.round(bounds.width * 0.36),
    Math.round(bounds.height * 0.14),
  ]);
}

async function openSettings() {
  await activateApp();
  // Perplexity Mac does not reliably honor Cmd+, here. The stable route is:
  // expose the left rail, then press the account settings gear.
  await ensureSidebarOpen();
  await clickAt(await coord("sidebarGear"));
  await sleep(700);
}

async function closeSettings() {
  // Escape usually closes the modal, but Perplexity can keep Settings focused
  // after automation. Fall back to the visible X button and verify locally.
  await activateApp();
  await cliclick("kp:esc");
  await sleep(400);
  if (await screenHasText(/\bSettings\b/i)) {
    await clickAt(await coord("settingsClose"));
    await sleep(500);
  }
}

export async function verifyIncognitoOn({ settingsOpen = false } = {}) {
  // Opens settings if not already open, reads toggle, closes if we opened it.
  if (!settingsOpen) {
    await openSettings();
  }
  const shot = join(tmpdir(), `perp-mac-settings-${Date.now()}.png`);
  try {
    await screenshotRegion(shot, await settingsIncognitoRegion());
    const state = await readIncognitoToggleState(shot);
    return state; // "ON" | "OFF" | "UNKNOWN"
  } finally {
    try {
      unlinkSync(shot);
    } catch {
      /* best effort */
    }
    if (!settingsOpen) {
      await closeSettings();
    }
  }
}

async function setIncognitoState(target) {
  // target: "ON" or "OFF". Opens settings, verifies current, flips if
  // different, closes. Returns the original state so caller can restore.
  await openSettings();
  const shot = join(tmpdir(), `perp-mac-settings-${Date.now()}.png`);
  let original = "UNKNOWN";
  try {
    // Widened crop 2026-04-25: was [600, 285, 260, 80] which often missed
    // the row label on the current Settings layout, leaving vision with
    // no anchor text → frequent UNKNOWN. Wider region captures label +
    // switch + surrounding rows for stable disambiguation.
    await screenshotRegion(shot, await settingsIncognitoRegion());
    original = await readIncognitoToggleState(shot);
    if (original === "UNKNOWN") {
      // Fixed 2026-04-25: previous code overwrote UNKNOWN to opposite-of-
      // target then force-clicked. The finally block then "restored" — but
      // the second vision read could ALSO return UNKNOWN, retriggering
      // overwrite-and-flip in a loop. Verified wedge: 50min hang in
      // Step 1 verification panel + 8min Promise.race timeout firing.
      // New behavior: emit telemetry, do NOT click (we can't verify the
      // resulting state without ground truth), and leave original=UNKNOWN
      // so the finally block's existing UNKNOWN-check skips restore.
      // Graceful degradation: user may not get incognito this turn, but
      // the call returns instead of wedging.
      process.stderr.write(
        `[perp-mac] vision couldn't read Incognito toggle state — skipping toggle (no click, no restore)\n`,
      );
      try {
        const { emit } = await import("./apex-event-bus.mjs");
        await emit({
          source: "research-perplexity-mac",
          type: "incognito-vision-unknown",
          payload: { target, shot, action: "no-op" },
        });
      } catch {
        /* bus optional */
      }
      // Fall through with original = "UNKNOWN". The if/else-if below
      // is restructured so UNKNOWN skips the click block entirely.
    } else if (original !== target) {
      process.stderr.write(`[perp-mac] Incognito was ${original}; clicking toggle to ${target}\n`);
      await clickAt(await coord("incognitoToggle"));
      await sleep(500);
      const verifyShot = join(tmpdir(), `perp-mac-settings-verify-${Date.now()}.png`);
      try {
        await screenshotRegion(verifyShot, await settingsIncognitoRegion());
        const verified = await readIncognitoToggleState(verifyShot);
        if (verified !== target) {
          throw new Error(
            `Incognito toggle verification failed: expected ${target}, saw ${verified}`,
          );
        }
        process.stderr.write(`[perp-mac] Incognito verified ${verified}\n`);
      } finally {
        try {
          unlinkSync(verifyShot);
        } catch {
          /* best effort */
        }
      }
    } else {
      process.stderr.write(`[perp-mac] Incognito already ${target}\n`);
    }
  } finally {
    try {
      unlinkSync(shot);
    } catch {
      /* best effort */
    }
    await closeSettings();
  }
  return original;
}

// --- mode selection ------------------------------------------------------

async function selectMode(mode) {
  let coordName;
  if (mode === "labs" || mode === "create") {
    coordName = "modeLabs";
  } else if (mode === "research") {
    // Default mode — magnifier/search — is pre-selected on a fresh
    // thread. Clicking it anyway is idempotent.
    coordName = "modeSearch";
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
  await clickAt(await coord(coordName));
  await sleep(300);
}

async function localFreshThreadState() {
  const state = await mainPaneOcrState();
  return {
    freshThread: state.composerVisible && !state.conversationVisible,
    composerVisible: state.composerVisible,
    existingThreadTitle: null,
    conversationVisible: state.conversationVisible,
    incognitoVisible: state.incognitoVisible,
    reason:
      state.composerVisible && !state.conversationVisible
        ? "local OCR saw blank composer in main pane"
        : `local OCR could not prove blank main pane: ${state.fullText.slice(0, 160)}`,
    source: "local-ocr",
  };
}

async function assertFreshThreadBeforeSubmit({
  requireIncognitoVisible = false,
  incognitoVerifiedBySettings = false,
} = {}) {
  const local = await localFreshThreadState();
  if (
    local.freshThread &&
    local.composerVisible &&
    !local.conversationVisible &&
    (!requireIncognitoVisible || local.incognitoVisible || incognitoVerifiedBySettings)
  ) {
    process.stderr.write(
      `[perp-mac] fresh thread verified by local OCR (incognitoVisible=${local.incognitoVisible}; settingsVerified=${incognitoVerifiedBySettings})\n`,
    );
    return local;
  }

  const shot = join(tmpdir(), `perp-mac-fresh-thread-${Date.now()}.png`);
  try {
    await screenshot(shot);
    const prompt = [
      "You are inspecting a screenshot of the Perplexity Mac app.",
      "The automation is about to paste a prompt. It must ONLY proceed if this is a fresh, blank Perplexity thread.",
      "Return strict JSON on one line, no prose:",
      "",
      '{ "freshThread": <true|false>,',
      '  "composerVisible": <true|false>,',
      '  "existingThreadTitle": <string|null>,',
      '  "conversationVisible": <true|false>,',
      '  "incognitoVisible": <true|false>,',
      '  "reason": "<short reason>" }',
      "",
      "freshThread=true only if the screen shows a blank/new Perplexity composer and no prior conversation messages.",
      "If the title is a named prior thread such as 'Update spec draft', or any user/assistant messages are visible, set freshThread=false.",
      "If the screenshot is not Perplexity, set freshThread=false and explain that.",
    ].join("\n");
    const raw = await visionAsk({ imagePath: shot, prompt });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) {
      throw new Error(`fresh-thread verification returned no JSON: ${raw.slice(0, 300)}`);
    }
    const parsed = JSON.parse(m[0]);
    if (
      !parsed.freshThread ||
      !parsed.composerVisible ||
      parsed.conversationVisible ||
      (requireIncognitoVisible && !parsed.incognitoVisible && !incognitoVerifiedBySettings)
    ) {
      throw new Error(
        `fresh-thread verification failed: ${JSON.stringify({
          freshThread: parsed.freshThread,
          composerVisible: parsed.composerVisible,
          existingThreadTitle: parsed.existingThreadTitle ?? null,
          conversationVisible: parsed.conversationVisible,
          incognitoVisible: parsed.incognitoVisible,
          reason: parsed.reason ?? "",
          requireIncognitoVisible,
          incognitoVerifiedBySettings,
          local,
        })}`,
      );
    }
    process.stderr.write(
      `[perp-mac] fresh thread verified (incognitoVisible=${parsed.incognitoVisible}; reason=${parsed.reason ?? "ok"})\n`,
    );
    return parsed;
  } finally {
    try {
      unlinkSync(shot);
    } catch {
      /* best effort */
    }
  }
}

function acceptsFreshThreadProof(
  local,
  { requireIncognitoVisible = false, incognitoVerifiedBySettings = false } = {},
) {
  return (
    local.freshThread &&
    local.composerVisible &&
    !local.conversationVisible &&
    (!requireIncognitoVisible || local.incognitoVisible || incognitoVerifiedBySettings)
  );
}

function acceptsActiveIncognitoLeaseProof(local, { incognitoVerifiedBySettings = false } = {}) {
  return (
    local.conversationVisible &&
    (local.composerVisible || incognitoVerifiedBySettings) &&
    (local.incognitoVisible || incognitoVerifiedBySettings)
  );
}

async function proveActiveIncognitoLease(local, opts = {}) {
  const { incognitoVerifiedBySettings = false } = opts;
  if (!local.conversationVisible || (!local.composerVisible && !incognitoVerifiedBySettings)) {
    return null;
  }
  if (incognitoVerifiedBySettings) {
    return {
      ...local,
      composerVisible: true,
      incognitoVisible: true,
      reason: "active Incognito lease with composer visible; Incognito verified in Settings",
    };
  }
  if (local.incognitoVisible) {
    return local;
  }
  const fullScreenIncognitoVisible = await screenHasText(/Incognito|Expires/i);
  process.stderr.write(
    `[perp-mac] active-lease full-screen incognito banner=${fullScreenIncognitoVisible}\n`,
  );
  if (!fullScreenIncognitoVisible) {
    return null;
  }
  return {
    ...local,
    incognitoVisible: true,
    reason: "active Incognito lease with composer visible; banner verified by full-screen OCR",
  };
}

async function openFreshThreadForSubmit(opts = {}) {
  const {
    allowActiveIncognitoLease = false,
    preferActiveIncognitoLease = false,
    ...freshOpts
  } = opts;
  if (allowActiveIncognitoLease && preferActiveIncognitoLease) {
    const persistedLease = activePerplexityMacLease({ mode: freshOpts.mode ?? "research" });
    if (persistedLease) {
      const local = await localFreshThreadState();
      const activeLease = await proveActiveIncognitoLease(local, freshOpts);
      if (activeLease && acceptsActiveIncognitoLeaseProof(activeLease, freshOpts)) {
        process.stderr.write(
          `[perp-mac] reusing persisted active Incognito lease ${persistedLease.leaseId}\n`,
        );
        return {
          ...activeLease,
          activeIncognitoLease: true,
          persistedLeaseId: persistedLease.leaseId,
          reason: `reusing persisted active Incognito lease ${persistedLease.leaseId}; ${activeLease.reason ?? ""}`,
        };
      }
      process.stderr.write(
        `[perp-mac] persisted lease ${persistedLease.leaseId} exists but current screen did not prove reusable Incognito thread: ${local.reason}\n`,
      );
    }
  }
  const attempts = [
    {
      label: "cmd-shift-p",
      run: async () => systemKeystroke("p", ["command", "shift"]),
    },
    {
      label: "cmd-n",
      run: async () => systemKeystroke("n", ["command"]),
    },
    {
      label: "back-to-home",
      run: async () => clickAt(await coord("backButton")),
    },
    {
      label: "sidebar-new-thread",
      run: async () => {
        await ensureSidebarOpen();
        const clicked = await clickScreenOcrLine(/\bNew Thread\b/i);
        if (!clicked) {
          throw new Error("New Thread button not found by local OCR");
        }
      },
    },
  ];

  let last = null;
  for (const attempt of attempts) {
    try {
      await attempt.run();
      await sleep(1200);
      const local = await localFreshThreadState();
      last = local;
      if (acceptsFreshThreadProof(local, freshOpts)) {
        process.stderr.write(
          `[perp-mac] fresh thread opened via ${attempt.label} (${local.reason})\n`,
        );
        return local;
      }
      const activeLease = allowActiveIncognitoLease
        ? await proveActiveIncognitoLease(local, freshOpts)
        : null;
      if (activeLease && acceptsActiveIncognitoLeaseProof(activeLease, freshOpts)) {
        process.stderr.write(
          `[perp-mac] active Incognito lease accepted via ${attempt.label}; reusing current thread\n`,
        );
        return {
          ...activeLease,
          activeIncognitoLease: true,
        };
      }
      process.stderr.write(
        `[perp-mac] ${attempt.label} did not yield fresh thread: ${local.reason}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[perp-mac] ${attempt.label} failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // Final proof path keeps the old vision fallback available, but only after
  // the deterministic shortcut/OCR routes have failed.
  if (last) {
    const activeLease = allowActiveIncognitoLease
      ? await proveActiveIncognitoLease(last, freshOpts)
      : null;
    if (activeLease && acceptsActiveIncognitoLeaseProof(activeLease, freshOpts)) {
      process.stderr.write(
        "[perp-mac] active Incognito lease accepted after deterministic attempts; reusing current thread\n",
      );
      return {
        ...activeLease,
        activeIncognitoLease: true,
      };
    }
    if (allowActiveIncognitoLease && freshOpts.incognitoVerifiedBySettings) {
      process.stderr.write(
        "[perp-mac] fresh thread not provable; reusing current Incognito lease because Settings verified Incognito ON\n",
      );
      return {
        ...last,
        activeIncognitoLease: true,
        freshThread: false,
        composerVisible: true,
        conversationVisible: true,
        incognitoVisible: true,
        reason: "fresh thread not provable; active Incognito lease accepted by Settings proof",
      };
    }
    process.stderr.write(
      `[perp-mac] deterministic fresh-thread attempts exhausted; last=${last.reason}\n`,
    );
  }
  return await assertFreshThreadBeforeSubmit(freshOpts);
}

async function openPerplexityThreadForSubmit(opts = {}) {
  const { mode = "research", threadPolicy = threadPolicyFromEnv(), ...rest } = opts;
  const policy = threadPolicyFromEnv(threadPolicy);
  if (policy !== "fresh" && policy !== "reset") {
    const persistedLease = activePerplexityMacLease({ mode });
    if (persistedLease) {
      const local = await localFreshThreadState();
      const activeLease = await proveActiveIncognitoLease(local, rest);
      if (activeLease && acceptsActiveIncognitoLeaseProof(activeLease, rest)) {
        process.stderr.write(
          `[perp-mac] singleton active Incognito lane reused (${persistedLease.leaseId}; policy=${policy})\n`,
        );
        return {
          ...activeLease,
          activeIncognitoLease: true,
          persistedLeaseId: persistedLease.leaseId,
          reason: `singleton active Incognito lane reused (${persistedLease.leaseId}); ${activeLease.reason ?? ""}`,
        };
      }
      process.stderr.write(
        `[perp-mac] active lease ${persistedLease.leaseId} exists but screen proof failed: ${local.reason}\n`,
      );
      if (policy === "reuse") {
        throw new Error(
          `Perplexity active lease ${persistedLease.leaseId} could not be proven reusable`,
        );
      }
    } else if (policy === "reuse") {
      throw new Error(
        "Perplexity thread policy is reuse, but no active singleton lease exists for this run/mode",
      );
    }
  }
  return await openFreshThreadForSubmit({
    ...rest,
    mode,
    allowActiveIncognitoLease: policy === "auto",
    preferActiveIncognitoLease: false,
  });
}

export async function provePerplexityMacLease({
  restoreOriginal = true,
  requireFreshIncognitoBanner = true,
} = {}) {
  const savedPb = await pbpaste();
  let originalIncognito = null;
  const startedAt = new Date().toISOString();
  const proof = {
    ok: false,
    startedAt,
    endedAt: null,
    originalIncognito: null,
    verifiedIncognito: null,
    freshThread: null,
    restored: false,
    restoreOriginal,
  };

  try {
    await activateApp();
    await standardizeWindow();

    originalIncognito = await setIncognitoState("ON");
    proof.originalIncognito = originalIncognito;

    const verified = await verifyIncognitoOn();
    proof.verifiedIncognito = verified;
    if (verified !== "ON") {
      throw new Error(`Perplexity lease proof failed: expected Incognito ON, saw ${verified}`);
    }

    const fresh = await openFreshThreadForSubmit({
      requireIncognitoVisible: requireFreshIncognitoBanner,
      incognitoVerifiedBySettings: verified === "ON",
    });
    proof.freshThread = {
      freshThread: Boolean(fresh.freshThread),
      activeIncognitoLease: Boolean(fresh.activeIncognitoLease),
      composerVisible: Boolean(fresh.composerVisible),
      conversationVisible: Boolean(fresh.conversationVisible),
      incognitoVisible: Boolean(fresh.incognitoVisible),
      reason: fresh.reason ?? "",
    };
    proof.ok = true;
    return proof;
  } finally {
    if (
      restoreOriginal &&
      originalIncognito &&
      originalIncognito !== "ON" &&
      originalIncognito !== "UNKNOWN"
    ) {
      try {
        await setIncognitoState(originalIncognito);
        proof.restored = true;
      } catch (e) {
        proof.restoreError = e instanceof Error ? e.message : String(e);
      }
    }
    if (typeof savedPb === "string") {
      await pbcopy(savedPb).catch(() => {});
    }
    proof.endedAt = new Date().toISOString();
  }
}

function defaultReplyCanaryNonce() {
  return `APEXOK${Date.now().toString(36).toUpperCase()}${Math.random()
    .toString(36)
    .slice(2, 7)
    .toUpperCase()}`;
}

function localReplyCanaryState({ nonce, textState }) {
  const fullText = textState.fullText;
  const occurrences = fullText.split(nonce).length - 1;
  const assistantText = fullText
    .split(/\bPerplexity\b/i)
    .slice(1)
    .join("\n");
  const assistantNonceObserved = assistantText.includes(nonce);
  return {
    // The user's submitted prompt is visible in the thread, so a single
    // occurrence is not proof. Pass only when OCR sees the nonce in the
    // assistant region or sees at least prompt+reply occurrences.
    nonceObserved: assistantNonceObserved || occurrences >= 2,
    occurrences,
    assistantNonceObserved,
    incognitoVisible: textState.incognitoVisible,
    composerVisible: textState.composerVisible,
    textSnippet: fullText.slice(-500),
  };
}

export async function canaryPerplexityMacReply({
  nonce = defaultReplyCanaryNonce(),
  restoreOriginal = true,
  mode = "research",
  initialWaitMs = 5_000,
  pollUntilObservedMs = 120_000,
  tickMs = 2_000,
  requireFreshIncognitoBanner = true,
} = {}) {
  if (!/^[A-Z0-9]{10,80}$/.test(nonce)) {
    throw new Error("canaryPerplexityMacReply: nonce must be OCR-friendly uppercase A-Z/0-9");
  }
  if (!["research", "labs", "create"].includes(mode)) {
    throw new Error(`canaryPerplexityMacReply: invalid mode '${mode}'`);
  }

  const savedPb = await pbpaste();
  let originalIncognito = null;
  const startedAt = new Date().toISOString();
  const proof = {
    ok: false,
    startedAt,
    endedAt: null,
    nonce,
    originalIncognito: null,
    verifiedIncognito: null,
    freshThread: null,
    replyObserved: false,
    incognitoObserved: false,
    restored: false,
    restoreOriginal,
    latencyMs: null,
    textSnippet: "",
  };

  const t0 = Date.now();
  try {
    await activateApp();
    await standardizeWindow();

    originalIncognito = await setIncognitoState("ON");
    proof.originalIncognito = originalIncognito;

    const verified = await verifyIncognitoOn();
    proof.verifiedIncognito = verified;
    if (verified !== "ON") {
      throw new Error(`Perplexity reply canary failed: expected Incognito ON, saw ${verified}`);
    }

    const fresh = await openFreshThreadForSubmit({
      requireIncognitoVisible: requireFreshIncognitoBanner,
      incognitoVerifiedBySettings: verified === "ON",
      allowActiveIncognitoLease: true,
    });
    proof.freshThread = {
      freshThread: Boolean(fresh.freshThread),
      activeIncognitoLease: Boolean(fresh.activeIncognitoLease),
      composerVisible: Boolean(fresh.composerVisible),
      conversationVisible: Boolean(fresh.conversationVisible),
      incognitoVisible: Boolean(fresh.incognitoVisible),
      reason: fresh.reason ?? "",
    };

    await selectMode(mode);
    await clickAt(await coord("composerCenter"));
    await pbcopy(`Health check: please echo this uppercase token exactly once: ${nonce}`);
    await systemKeystroke("v", ["command"]);
    await sleep(300);
    await systemKeyCode(36);

    await sleep(initialWaitMs);
    while (Date.now() - t0 < pollUntilObservedMs) {
      const state = localReplyCanaryState({
        nonce,
        textState: await mainPaneOcrState(),
      });
      proof.replyObserved = state.nonceObserved;
      proof.incognitoObserved = proof.incognitoObserved || state.incognitoVisible;
      proof.textSnippet = state.textSnippet;
      process.stderr.write(
        `[perp-mac] reply-canary tick: nonce=${state.nonceObserved} occurrences=${state.occurrences} assistant=${state.assistantNonceObserved} incog-banner=${state.incognitoVisible}\n`,
      );
      if (state.nonceObserved) {
        proof.ok = true;
        proof.latencyMs = Date.now() - t0;
        return proof;
      }
      await sleep(tickMs);
    }
    proof.latencyMs = Date.now() - t0;
    throw new Error(`Perplexity reply canary did not observe nonce ${nonce}`);
  } finally {
    if (
      restoreOriginal &&
      originalIncognito &&
      originalIncognito !== "ON" &&
      originalIncognito !== "UNKNOWN"
    ) {
      try {
        await setIncognitoState(originalIncognito);
        proof.restored = true;
      } catch (e) {
        proof.restoreError = e instanceof Error ? e.message : String(e);
      }
    }
    if (typeof savedPb === "string") {
      await pbcopy(savedPb).catch(() => {});
    }
    proof.endedAt = new Date().toISOString();
  }
}

// --- main ask ------------------------------------------------------------

export async function askPerplexityMac({
  prompt,
  mode = "research",
  incognito = true,
  threadPolicy = threadPolicyFromEnv(),
  initialWaitMs = 12_000,
  pollUntilStableMs = 300_000,
  tickMs = 4_000,
  stableTicksRequired = 3,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askPerplexityMac: prompt required");
  }
  if (!["research", "labs", "create"].includes(mode)) {
    throw new Error(`askPerplexityMac: invalid mode '${mode}'`);
  }

  const savedPb = await pbpaste();
  const workstation = await createWorkstationLease({ reason: "perplexity/mac-app" });
  let originalIncognito = null;
  let incognitoVerifiedBySettings = false;

  try {
    await activateApp();
    await standardizeWindow();

    // ---- Incognito gate: ensure ON, remember original ----
    if (incognito) {
      originalIncognito = await setIncognitoState("ON");
      incognitoVerifiedBySettings = true;
    }

    // ---- Thread lease: reuse active Incognito context before creating fresh ----
    const threadState = await openPerplexityThreadForSubmit({
      requireIncognitoVisible: false,
      incognitoVerifiedBySettings,
      mode,
      threadPolicy,
    });
    persistActivePerplexityMacLease({
      mode,
      incognitoConfirmed: incognitoVerifiedBySettings,
      threadState,
      modelUsed: `perplexity/mac-app (mode=${mode}; pending-reply)`,
    });

    // ---- Mode selection ----
    await cliclick("kp:esc").catch(() => {});
    await sleep(200);
    await selectMode(mode);

    // ---- Click composer to ensure focus, paste prompt, submit ----
    await cliclick("kp:esc").catch(() => {});
    await sleep(200);
    await clickAt(await coord("composerCenter"));
    await systemKeystroke("a", ["command"]);
    await sleep(150);
    await systemKeyCode(51);
    await sleep(150);
    await pbcopy(String(prompt));
    await systemKeystroke("v", ["command"]);
    await sleep(500);
    await systemKeyCode(36);

    await sleep(initialWaitMs);

    // ---- Vision-poll for reply stability + incognito banner ----
    const t0 = Date.now();
    let lastReply = "";
    let stableTicks = 0;
    let incognitoConfirmed = incognitoVerifiedBySettings;
    const tmp = tmpdir();
    while (Date.now() - t0 < pollUntilStableMs) {
      const shot = join(tmp, `perp-mac-${Date.now()}.png`);
      let state;
      try {
        await screenshot(shot);
        state = await readReplyState(shot);
      } finally {
        try {
          unlinkSync(shot);
        } catch {
          /* best effort */
        }
      }
      if (incognito && state.incognito) {
        incognitoConfirmed = true;
      }
      process.stderr.write(
        `[perp-mac] tick: len=${state.reply.length} streaming=${state.streaming} incog-banner=${state.incognito}\n`,
      );
      const shortProofToken = /\b(?:SURFACE_PROOF_OK|APEXOK[A-Z0-9]+)\b/.test(state.reply);
      if (
        !state.streaming &&
        state.reply &&
        state.reply === lastReply &&
        (state.reply.length >= 60 || shortProofToken)
      ) {
        stableTicks += 1;
        if (stableTicks >= stableTicksRequired) {
          // Shared-Max native/Comet profile invariant: Perplexity Fleet
          // runs through this app path must be incognito. Do not return
          // content if the app never shows the ephemeral-thread banner;
          // that would silently save a Fleet probe into shared account
          // history.
          if (incognito && !incognitoConfirmed) {
            throw new Error(
              "askPerplexityMac: Incognito banner never appeared and Settings did not verify Incognito — thread may have been saved to history",
            );
          }
          const incognitoLabel = !incognito
            ? ""
            : incognitoConfirmed
              ? "; incognito"
              : "; incognito-banner-missing";
          const modelUsed = `perplexity/mac-app (mode=${mode}${incognitoLabel})`;
          persistActivePerplexityMacLease({
            mode,
            incognitoConfirmed,
            threadState,
            modelUsed,
          });
          return {
            text: state.reply,
            modelUsed,
          };
        }
      } else {
        stableTicks = 0;
      }
      lastReply = state.reply;
      await sleep(tickMs);
    }
    throw new Error(`askPerplexityMac: reply never stabilized (lastLen=${lastReply.length})`);
  } finally {
    // ---- Restore clipboard/workstation. Keep Incognito lease open while work is active. ----
    if (
      !shouldKeepPerplexityLeaseOpen() &&
      originalIncognito &&
      originalIncognito !== "ON" &&
      originalIncognito !== "UNKNOWN"
    ) {
      try {
        await setIncognitoState(originalIncognito);
        process.stderr.write(`[perp-mac] Incognito restored to ${originalIncognito}\n`);
      } catch (e) {
        process.stderr.write(`[perp-mac] failed to restore Incognito: ${e?.message ?? e}\n`);
      }
    } else if (originalIncognito && originalIncognito !== "ON" && originalIncognito !== "UNKNOWN") {
      process.stderr.write(
        "[perp-mac] keeping Incognito ON because an active work lease may need continuity\n",
      );
    }
    if (typeof savedPb === "string") {
      await pbcopy(savedPb).catch(() => {});
    }
    await restoreWorkstation(workstation).catch(() => {});
  }
}

// --- Image generation ----------------------------------------------------
//
// Joseph's Pro Max sub bundles a multi-model image router (Flux,
// GPT-Image-1, Nano Banana, Seedream 4.5, Stable Diffusion). The router
// auto-selects from the prompt — describing the image is enough. When
// the user wants a specific model, prefix with a hint phrase.
//
// On the Mac app, the rendered image appears inline in the assistant
// turn. We extract via the macOS contextual menu: right-click on the
// image → "Save image as..." OR Cmd+S then a Save panel. Either path
// runs through cliclick coordinates + AppleScript (System Events) to
// drive the panel.
//
// Strategy implemented here:
//   1. Submit prompt (with optional model hint) using existing flow.
//   2. After reply stabilizes, screenshot + vision-locate the image
//      bounding box inside the chat area.
//   3. Right-click at the box's center, click "Save image as…" entry.
//      In the Save panel, type the target filename (Cmd+Shift+G to set
//      the directory path), press Return.
//   4. Verify the file landed in outDir; collect its path. If multiple
//      images appear, repeat per box.
//
// Notes:
//   - Selectors here are coordinate-based and depend on the standardized
//      window layout (1000×800 at {100,40}). The right-click menu and
//      Save panel positions are speculative until verified live.
//   - We use Cmd+Shift+G ("Go to folder") in the Save panel to set the
//      destination — robust against panel layout changes.
//   - If vision can't locate an image, we emit a signal and return
//      ok=false rather than guessing coordinates.

const IMAGE_MODEL_HINTS = {
  auto: "",
  flux: "Use Flux to generate this image: ",
  "gpt-image": "Use GPT-Image-1 to generate this image: ",
  "nano-banana": "Use Nano Banana to generate this image: ",
  seedream: "Use Seedream to generate this image: ",
  sd: "Use Stable Diffusion to generate this image: ",
};

function expandPath(p) {
  if (typeof p !== "string") {
    return p;
  }
  if (p.startsWith("~/")) {
    return join(HOME, p.slice(2));
  }
  if (p === "~") {
    return HOME;
  }
  return p;
}

async function readImageBox(imagePath) {
  // Vision returns the bounding box of the most prominent generated image
  // in the assistant's reply. Coordinates are in screen-pixel space of
  // the screenshot (full screen). Returns null if no image is present.
  const prompt = [
    "Look at this Perplexity Mac app screenshot.",
    "If the assistant's reply contains a generated image (a photo/illustration/diagram, NOT a small icon or avatar),",
    "return the bounding box of the LARGEST generated image as JSON on a single line, no prose:",
    "",
    '{ "x": <left>, "y": <top>, "w": <width>, "h": <height>, "confidence": <0-1> }',
    "",
    "If no generated image is visible, return:",
    '{ "x": null, "y": null, "w": null, "h": null, "confidence": 0 }',
    "",
    "Coordinates are in pixels of THIS screenshot. Be precise.",
  ].join("\n");
  const raw = await visionAsk({ imagePath, prompt });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    return null;
  }
  try {
    const parsed = JSON.parse(m[0]);
    if (parsed.x == null || parsed.y == null) {
      return null;
    }
    return {
      x: Number(parsed.x),
      y: Number(parsed.y),
      w: Number(parsed.w),
      h: Number(parsed.h),
      confidence: Number(parsed.confidence ?? 0),
    };
  } catch {
    return null;
  }
}

async function snapshotDirState(dir) {
  if (!existsSync(dir)) {
    return new Map();
  }
  const out = new Map();
  for (const name of readdirSync(dir)) {
    try {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isFile()) {
        out.set(full, st.mtimeMs);
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

function diffNewFiles(before, dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) {
      continue;
    }
    const prev = before.get(full);
    if (prev === undefined || prev !== st.mtimeMs) {
      out.push(full);
    }
  }
  return out;
}

async function saveImageViaContextMenu({ box, outDir, baseName }) {
  // Right-click center of the image, pick "Save image as…", then in
  // the Save panel: Cmd+Shift+G to set folder, type folder path,
  // Return; then Tab to filename field (or Cmd+A select-all),
  // type filename, Return to save.
  const cx = Math.round(box.x + box.w / 2);
  const cy = Math.round(box.y + box.h / 2);
  // cliclick right-click: `rc:x,y`
  await cliclick(`rc:${cx},${cy}`);
  await sleep(700);

  // Click the "Save image as…" menu item via System Events. Menu wording
  // can vary ("Save Image As…", "Save image as…", "Download image"). We
  // try each in order.
  const tryItems = ["Save image as…", "Save Image As…", "Download image", "Download Image"];
  let clicked = false;
  for (const label of tryItems) {
    try {
      await osa(
        `tell application "System Events" to tell process "${APP_NAME}" to click menu item "${label}" of menu 1 of window 1`,
      );
      clicked = true;
      break;
    } catch {
      /* try next */
    }
  }
  if (!clicked) {
    // Fall back: use keyboard navigation in the right-click menu.
    // Type "S" to focus a "Save…" entry, press Return.
    await systemKeystroke("S");
    await sleep(200);
    await systemKeyCode(36);
  }
  await sleep(900);

  // Save panel up. Cmd+Shift+G to open "Go to folder" sheet.
  await systemKeystroke("g", ["command", "shift"]);
  await sleep(400);
  // Use pasteboard for the path — robust against typing-rate quirks.
  const savedPb2 = await pbpaste();
  await pbcopy(outDir);
  await systemKeystroke("v", ["command"]);
  await sleep(300);
  await systemKeyCode(36);
  await sleep(500);
  // Now focus filename field. Cmd+A select-all in case there's a default.
  await systemKeystroke("a", ["command"]);
  await sleep(150);
  await pbcopy(baseName);
  await systemKeystroke("v", ["command"]);
  await sleep(200);
  await systemKeyCode(36);
  await sleep(800);
  // Restore clipboard.
  await pbcopy(savedPb2).catch(() => {});
}

export async function generateImageViaPerplexity({
  prompt,
  model = "auto",
  outDir = "~/.openclaw/workspace/state/imagen-out",
  closeWhenDone = true,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("generateImageViaPerplexity: prompt required");
  }
  if (!Object.hasOwn(IMAGE_MODEL_HINTS, model)) {
    throw new Error(`generateImageViaPerplexity: invalid model '${model}'`);
  }
  const { wrapLifecycle } = await import("./apex-lifecycle.mjs");
  const { emit } = await import("./apex-event-bus.mjs");
  const resolvedOutDir = expandPath(outDir);
  if (!existsSync(resolvedOutDir)) {
    mkdirSync(resolvedOutDir, { recursive: true });
  }

  return wrapLifecycle(
    "research-perplexity-mac:generate-image",
    async () => {
      const t0 = Date.now();
      await emit({
        source: "research-perplexity-mac",
        type: "perplexity-image-started",
        payload: { model, promptLen: String(prompt).length, outDir: resolvedOutDir },
      });

      const hint = IMAGE_MODEL_HINTS[model] ?? "";
      const finalPrompt = hint + String(prompt);

      // Reuse the full ask flow — same incognito gate, same vision-poll,
      // same "Expires in N hours" verification.
      const before = await snapshotDirState(resolvedOutDir);
      const reply = await askPerplexityMac({
        prompt: finalPrompt,
        mode: "research",
        incognito: true,
        // Image gen on Pro Max via the router stretches the polling
        // window; chat profile (300s) is appropriate.
        pollUntilStableMs: 300_000,
        tickMs: 4_000,
        stableTicksRequired: 3,
      });

      // Reply stabilized — locate image. Take a fresh full screenshot.
      const shot = join(tmpdir(), `perp-mac-imggen-${Date.now()}.png`);
      let box = null;
      try {
        await screenshot(shot);
        box = await readImageBox(shot);
      } finally {
        try {
          unlinkSync(shot);
        } catch {
          /* best effort */
        }
      }

      if (!box || box.confidence < 0.4) {
        await emit({
          source: "research-perplexity-mac",
          type: "perplexity-image-completed",
          payload: {
            ok: false,
            model,
            reason: "no-image-located",
            confidence: box?.confidence ?? 0,
            latencyMs: Date.now() - t0,
          },
        });
        if (closeWhenDone) {
          try {
            await osa(`tell application "${APP_NAME}" to quit`);
          } catch {
            /* noop */
          }
        }
        return {
          ok: false,
          imagePaths: [],
          modelUsed: model === "auto" ? "perplexity-mac/router-auto" : `perplexity-mac/${model}`,
          latencyMs: Date.now() - t0,
          replyText: reply.text,
        };
      }

      // Build a stable filename and trigger Save-image-as flow.
      const ts = Date.now().toString(36);
      const baseName = `pplx-${ts}-0.png`;
      try {
        await saveImageViaContextMenu({
          box,
          outDir: resolvedOutDir,
          baseName,
        });
      } catch (err) {
        await emit({
          source: "research-perplexity-mac",
          type: "perplexity-image-completed",
          payload: {
            ok: false,
            model,
            reason: "save-flow-failed",
            error: err instanceof Error ? err.message : String(err),
            latencyMs: Date.now() - t0,
          },
        });
        if (closeWhenDone) {
          try {
            await osa(`tell application "${APP_NAME}" to quit`);
          } catch {
            /* noop */
          }
        }
        return {
          ok: false,
          imagePaths: [],
          modelUsed: model === "auto" ? "perplexity-mac/router-auto" : `perplexity-mac/${model}`,
          latencyMs: Date.now() - t0,
          replyText: reply.text,
        };
      }

      // Detect newly-saved files in outDir.
      const newFiles = diffNewFiles(before, resolvedOutDir);
      const imagePaths =
        newFiles.length > 0
          ? newFiles
          : existsSync(join(resolvedOutDir, baseName))
            ? [join(resolvedOutDir, baseName)]
            : [];

      if (closeWhenDone) {
        try {
          await osa(`tell application "${APP_NAME}" to quit`);
        } catch {
          /* noop */
        }
      }

      const latencyMs = Date.now() - t0;
      const ok = imagePaths.length > 0;
      await emit({
        source: "research-perplexity-mac",
        type: "perplexity-image-completed",
        payload: { ok, model, imageCount: imagePaths.length, latencyMs },
      });
      return {
        ok,
        imagePaths,
        modelUsed: model === "auto" ? "perplexity-mac/router-auto" : `perplexity-mac/${model}`,
        latencyMs,
        replyText: reply.text,
      };
    },
    { payloadOnStart: { model, outDir: resolvedOutDir } },
  );
}

// --- CLI -----------------------------------------------------------------

async function mainCli() {
  const args = process.argv.slice(2);
  let prompt = "";
  let mode = "research";
  let incognito = true;
  let imageMode = false;
  let imageModel = "auto";
  let imageOutDir;
  let threadPolicy = threadPolicyFromEnv();
  let doctorMode = false;
  let doctorNoRestore = false;
  let doctorAllowNoBanner = false;
  let replyCanaryMode = false;
  let replyCanaryNoRestore = false;
  let replyCanaryAllowNoBanner = false;
  let replyCanaryNonce;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--mode") {
      mode = args[++i] ?? "research";
    } else if (a === "--no-incognito") {
      incognito = false;
    } else if (a === "--image") {
      imageMode = true;
    } else if (a === "--model") {
      imageModel = args[++i] ?? "auto";
    } else if (a === "--out-dir") {
      imageOutDir = args[++i];
    } else if (a === "--thread-policy") {
      threadPolicy = threadPolicyFromEnv(args[++i]);
    } else if (a === "--doctor" || a === "--lease-check") {
      doctorMode = true;
    } else if (a === "--doctor-no-restore") {
      doctorNoRestore = true;
    } else if (a === "--doctor-allow-no-banner") {
      doctorAllowNoBanner = true;
    } else if (a === "--reply-canary" || a === "--submit-canary") {
      replyCanaryMode = true;
    } else if (a === "--reply-canary-no-restore") {
      replyCanaryNoRestore = true;
    } else if (a === "--reply-canary-allow-no-banner") {
      replyCanaryAllowNoBanner = true;
    } else if (a === "--nonce") {
      replyCanaryNonce = args[++i];
    } else if (a === "--prompt" || a === "-p") {
      prompt = args[++i] ?? "";
    } else if (!a.startsWith("--")) {
      prompt = args.slice(i).join(" ");
      break;
    }
  }
  if (doctorMode) {
    const proof = await provePerplexityMacLease({
      restoreOriginal: !doctorNoRestore,
      requireFreshIncognitoBanner: !doctorAllowNoBanner,
    });
    process.stdout.write(JSON.stringify(proof, null, 2) + "\n");
    return;
  }
  if (replyCanaryMode) {
    const proof = await canaryPerplexityMacReply({
      ...(replyCanaryNonce ? { nonce: replyCanaryNonce } : {}),
      restoreOriginal: !replyCanaryNoRestore,
      mode,
      requireFreshIncognitoBanner: !replyCanaryAllowNoBanner,
    });
    process.stdout.write(JSON.stringify(proof, null, 2) + "\n");
    return;
  }
  if (!prompt) {
    console.error(
      "Usage: research-perplexity-mac.mjs [--doctor|--reply-canary] [--mode research|labs] [--thread-policy auto|reuse|fresh|reset] [--no-incognito] [--image [--model M] [--out-dir D]] '<prompt>'",
    );
    process.exit(2);
  }
  if (imageMode) {
    const r = await generateImageViaPerplexity({
      prompt,
      model: imageModel,
      ...(imageOutDir ? { outDir: imageOutDir } : {}),
    });
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return;
  }
  const r = await askPerplexityMac({ prompt, mode, incognito, threadPolicy });
  process.stdout.write(r.text + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((err) => {
    console.error(`[perplexity-mac] ${err?.stack ?? err}`);
    process.exit(1);
  });
}
