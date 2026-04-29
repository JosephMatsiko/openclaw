#!/usr/bin/env node
// apex-ring: 3
// Research worker - Claude Mac app (com.anthropic.claudefordesktop).
//
// Native fullscreen-safe driver. The Claude desktop app exposes a shallow
// accessibility tree, so the load-bearing proof path uses exact bundle
// activation, OCR-guided controls, screenshot attribution, and workstation
// return receipts.

import { execFile, spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { emit } from "./apex-event-bus.mjs";
import { wrapLifecycle } from "./apex-lifecycle.mjs";
import { desktopBounds, runOcr, withWorkstationReturn } from "./chuck-surface-control.mjs";

const execFileP = promisify(execFile);

const APP_BUNDLE_ID = "com.anthropic.claudefordesktop";
const APP_NAME = "Claude";
const PROMPT_PREFIX = "[panel-ask]\n\n";
const SHORT_PROOF_RE = /\b(?:SURFACE_PROOF_OK|APEXOK[A-Z0-9]+)\b/;

const CONTROL_RATIOS = {
  chatComposer: [0.49, 0.455],
  chatSend: [0.805, 0.515],
  codeComposer: [0.6, 0.93],
  codeSend: [0.86, 0.935],
  newChat: [0.055, 0.098],
  modalClose: [0.827, 0.119],
};

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function osa(script, { timeoutMs = 12_000 } = {}) {
  const res = await execFileP("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    maxBuffer: 8 * 1024 * 1024,
  });
  return res.stdout.trim();
}

async function cliclick(command, { timeoutMs = 5000 } = {}) {
  await execFileP("/opt/homebrew/bin/cliclick", [command], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
}

async function clickPoint(x, y) {
  await cliclick(`c:${Math.round(x)},${Math.round(y)}`);
  await sleep(200);
}

async function clickRatio([xRatio, yRatio]) {
  const bounds = await desktopBounds();
  const x = bounds.left + bounds.width * xRatio;
  const y = bounds.top + bounds.height * yRatio;
  await clickPoint(x, y);
  return { x: Math.round(x), y: Math.round(y), xRatio, yRatio };
}

async function pbpaste({ timeoutMs = 5000 } = {}) {
  const { stdout } = await execFileP("pbpaste", [], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  return stdout;
}

async function writeToCommandStdin(command, args, input, { timeoutMs = 5000 } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 500) || "(no stderr)"}`));
        return;
      }
      resolve();
    });
    child.stdin.end(input);
  });
}

async function pbcopy(text, { timeoutMs = 5000 } = {}) {
  await writeToCommandStdin("pbcopy", [], String(text), { timeoutMs });
}

async function screenshot(path, { timeoutMs = 10_000 } = {}) {
  await execFileP("/usr/sbin/screencapture", ["-x", path], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  return path;
}

async function activateClaudeMac() {
  await execFileP("open", ["-b", APP_BUNDLE_ID], {
    encoding: "utf8",
    timeout: 12_000,
    killSignal: "SIGTERM",
  }).catch(async (error) => {
    throw new Error(`Claude Mac app not installed or not openable (${APP_BUNDLE_ID})`, {
      cause: error,
    });
  });
  await sleep(900);
  await osa(`tell application id "${APP_BUNDLE_ID}" to activate`).catch(() => {});
  await sleep(650);
}

async function frontmostBundleId() {
  return osa(
    'tell application "System Events" to bundle identifier of first application process whose frontmost is true',
    { timeoutMs: 5000 },
  ).catch(() => "");
}

async function ensureFrontmostClaude({ attempts = 3 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await activateClaudeMac();
    const bundleId = await frontmostBundleId();
    if (bundleId === APP_BUNDLE_ID) {
      return true;
    }
    await sleep(500 * attempt);
  }
  return false;
}

function lineMatches(line, pattern) {
  return pattern.test(String(line?.text ?? ""));
}

function lineCenter(line, bounds) {
  const box = line.bbox ?? {};
  return {
    x: Math.round(bounds.left + bounds.width * (Number(box.x ?? 0) + Number(box.w ?? 0) / 2)),
    y: Math.round(bounds.top + bounds.height * (Number(box.y ?? 0) + Number(box.h ?? 0) / 2)),
  };
}

async function captureOcr({ keepImage = false, label = "claude-mac" } = {}) {
  const imagePath = join(tmpdir(), `${label}-${Date.now()}.png`);
  await screenshot(imagePath);
  const [ocr, bounds] = await Promise.all([runOcr(imagePath), desktopBounds()]);
  if (!keepImage) {
    try {
      unlinkSync(imagePath);
    } catch {
      // best effort
    }
  }
  return { imagePath, ocr, bounds };
}

async function clickOcr(pattern, { index = 0, label = String(pattern) } = {}) {
  const snap = await captureOcr({ label: "claude-mac-click" });
  const matches = snap.ocr.lines.filter((line) => lineMatches(line, pattern));
  const match = matches[index] ?? matches[0];
  if (!match) {
    throw new Error(`Claude Mac OCR click could not find ${label}`);
  }
  const point = lineCenter(match, snap.bounds);
  await clickPoint(point.x, point.y);
  return { point, matchedText: match.text, matchCount: matches.length };
}

async function keystroke(key, modifiers = []) {
  const suffix = modifiers.length ? ` using {${modifiers.join(", ")}}` : "";
  await osa(`tell application "System Events" to keystroke ${JSON.stringify(key)}${suffix}`, {
    timeoutMs: 5000,
  });
}

async function pressReturn() {
  await osa('tell application "System Events" to key code 36', { timeoutMs: 5000 });
}

function classifyClaudeScreen(ocrText) {
  const text = String(ocrText ?? "");
  if (/How can I help you today\?/i.test(text)) {
    return "chat-home";
  }
  if (/Describe a task or ask a question/i.test(text)) {
    return "code-home";
  }
  if (/Directory/i.test(text) && /Connectors|Plugins|Skills/i.test(text)) {
    return "directory-modal";
  }
  if (/Customize Claude/i.test(text) || /^Customize$/im.test(text)) {
    return "customize";
  }
  if (/New chat/i.test(text) && /Search/i.test(text)) {
    return "main-sidebar";
  }
  return "unknown";
}

function visibleModeControls(ocrText) {
  const text = String(ocrText ?? "");
  return ["Chat", "Cowork", "Code", "Customize", "Design"].filter((mode) =>
    new RegExp(`\\b${mode}\\b`, "i").test(text),
  );
}

function transportProofsForClaudeMac({ screen = "unknown", ocrText = "" } = {}) {
  const checkedAt = new Date().toISOString();
  const modes = visibleModeControls(ocrText);
  const modeEvidence = `screen: ${screen}; visible controls: ${modes.join(", ") || "none"}`;
  const modeProved = screen === "chat-home" || screen === "code-home" || modes.length > 0;
  return [
    {
      surface: "claude/mac-app",
      criterion: "open-target",
      verdict: "proved",
      method: "native-bundle-activation",
      evidence: `frontmost bundle ${APP_BUNDLE_ID}`,
      checkedAt,
      caveats: [],
    },
    {
      surface: "claude/mac-app",
      criterion: "mode-switch",
      verdict: modeProved ? "proved" : "missing",
      method: "native-ocr-mode-map",
      evidence: modeEvidence,
      checkedAt,
      caveats: modeProved
        ? [
            "Mode proof confirms prompt-surface/mode targeting; per-mode task probes remain task-class calibration.",
          ]
        : ["No native Claude mode controls or prompt surface were visible."],
    },
  ];
}

async function closeModalIfPresent() {
  const snap = await captureOcr({ label: "claude-mac-modal" });
  const screen = classifyClaudeScreen(snap.ocr.fullText);
  if (screen === "directory-modal") {
    await clickRatio(CONTROL_RATIOS.modalClose).catch(() => {});
    await sleep(700);
    return true;
  }
  return false;
}

async function startFreshSurface() {
  await closeModalIfPresent();

  // Command+N is the least stateful route when Claude is in the normal chat
  // shell. It may no-op in custom subviews, so OCR fallbacks remain below.
  await keystroke("n", ["command down"]).catch(() => {});
  await sleep(900);

  let snap = await captureOcr({ label: "claude-mac-start" });
  let screen = classifyClaudeScreen(snap.ocr.fullText);
  if (screen === "directory-modal") {
    await closeModalIfPresent();
    snap = await captureOcr({ label: "claude-mac-after-modal" });
    screen = classifyClaudeScreen(snap.ocr.fullText);
  }

  if (screen === "chat-home" || screen === "code-home") {
    return { screen, ocrText: snap.ocr.fullText };
  }

  if (/New chat/i.test(snap.ocr.fullText)) {
    await clickOcr(/^New chat$/i, { label: "New chat" }).catch(async () => {
      await clickRatio(CONTROL_RATIOS.newChat);
    });
    await sleep(1000);
    snap = await captureOcr({ label: "claude-mac-new-chat" });
    screen = classifyClaudeScreen(snap.ocr.fullText);
    if (
      screen === "chat-home" ||
      screen === "code-home" ||
      /How can I help/i.test(snap.ocr.fullText)
    ) {
      return { screen: screen === "unknown" ? "chat-home" : screen, ocrText: snap.ocr.fullText };
    }
  }

  // Back out of Customize/Directory-like subviews, then retry New chat once.
  await keystroke("[", ["command down"]).catch(() => {});
  await sleep(700);
  snap = await captureOcr({ label: "claude-mac-after-back" });
  if (/New chat/i.test(snap.ocr.fullText)) {
    await clickOcr(/^New chat$/i, { label: "New chat" }).catch(async () => {
      await clickRatio(CONTROL_RATIOS.newChat);
    });
    await sleep(1000);
    snap = await captureOcr({ label: "claude-mac-after-retry" });
    screen = classifyClaudeScreen(snap.ocr.fullText);
  }

  if (screen === "chat-home" || screen === "code-home") {
    return { screen, ocrText: snap.ocr.fullText };
  }

  throw new Error(
    `Claude Mac did not reach a prompt surface; classified=${screen}; visible=${snap.ocr.fullText.slice(0, 300)}`,
  );
}

async function clickComposerForScreen(screen) {
  if (screen === "code-home") {
    await clickOcr(/Describe a task or ask a question/i, { label: "code composer" }).catch(
      async () => {
        await clickRatio(CONTROL_RATIOS.codeComposer);
      },
    );
    return;
  }
  await clickOcr(/How can I help you today\?/i, { label: "chat composer" }).catch(async () => {
    await clickRatio(CONTROL_RATIOS.chatComposer);
  });
}

async function submitForScreen(screen) {
  await pressReturn().catch(() => {});
  await sleep(700);
  if (screen === "code-home") {
    await clickRatio(CONTROL_RATIOS.codeSend).catch(() => {});
  } else {
    await clickRatio(CONTROL_RATIOS.chatSend).catch(() => {});
  }
}

function extractLikelyReply(ocrText) {
  const text = String(ocrText ?? "");
  const proof = text.match(SHORT_PROOF_RE);
  if (proof) {
    return proof[0];
  }
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[panel-ask\]$/i.test(line))
    .filter((line) => !/^Reply exactly:/i.test(line))
    .filter((line) => !/^How can I help/i.test(line))
    .filter((line) => !/^Opus 4\.7/i.test(line));
  return lines.slice(-20).join("\n").trim();
}

async function pollReply({ timeoutMs = 240_000, tickMs = 3000 } = {}) {
  const t0 = Date.now();
  let last = "";
  let stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    const snap = await captureOcr({ label: "claude-mac-reply" });
    const reply = extractLikelyReply(snap.ocr.fullText);
    const proof = SHORT_PROOF_RE.test(reply);
    process.stderr.write(`[claude-mac] tick: len=${reply.length} proof=${proof}\n`);
    if (proof) {
      return reply;
    }
    if (reply && reply === last && reply.length >= 60) {
      stable += 1;
      if (stable >= 2) {
        return reply;
      }
    } else {
      stable = 0;
    }
    last = reply;
    await sleep(tickMs);
  }
  throw new Error(`Claude Mac reply did not stabilize (lastLen=${last.length})`);
}

export async function askClaudeMac({ prompt, pollUntilStableMs = 240_000, tickMs = 3000 } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askClaudeMac: prompt required");
  }

  const savedPb = await pbpaste();
  try {
    if (!(await ensureFrontmostClaude())) {
      throw new Error(`Claude Mac activation failed; ${APP_BUNDLE_ID} was not frontmost`);
    }
    const surface = await startFreshSurface();
    await clickComposerForScreen(surface.screen);
    await pbcopy(PROMPT_PREFIX + String(prompt));
    await sleep(150);
    await osa(`tell application id "${APP_BUNDLE_ID}" to activate`).catch(() => {});
    await keystroke("v", ["command down"]);
    await sleep(400);
    await submitForScreen(surface.screen);
    const text = await pollReply({ timeoutMs: pollUntilStableMs, tickMs });
    await emit({
      source: "research-claude-mac",
      type: "claude-mac-completed",
      payload: {
        replyLen: text.length,
        screen: surface.screen,
        model: "claude-mac-app/opus-4.7-adaptive",
        proofToken: SHORT_PROOF_RE.test(text),
      },
    }).catch(() => {});
    return {
      text,
      modelUsed: `claude-mac-app/opus-4.7-adaptive (${surface.screen})`,
      screen: surface.screen,
      transportProofs: transportProofsForClaudeMac(surface),
    };
  } finally {
    if (typeof savedPb === "string") {
      await pbcopy(savedPb).catch(() => {});
    }
  }
}

async function calibrateClaudeMac() {
  const frontmost = await ensureFrontmostClaude();
  const snap = await captureOcr({ keepImage: false, label: "claude-mac-calibrate" });
  const screen = classifyClaudeScreen(snap.ocr.fullText);
  return {
    surface: "claude/mac-app",
    appName: APP_NAME,
    bundleId: APP_BUNDLE_ID,
    frontmost,
    screen,
    ocrLines: snap.ocr.count,
    loadBearing:
      frontmost &&
      (screen === "chat-home" ||
        screen === "code-home" ||
        /New chat|How can I help|Describe a task/i.test(snap.ocr.fullText)),
    caveats: [
      "Claude desktop exposes a shallow AX tree; driver uses exact bundle activation plus local OCR.",
      "Fullscreen is supported through desktop-ratio coordinates and OCR text anchors.",
    ],
  };
}

async function mainCli() {
  const args = process.argv.slice(2);
  let prompt = "";
  let json = false;
  let calibrate = false;
  let pollMs;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--prompt" || arg === "-p") {
      prompt = args[++i] ?? "";
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--calibrate") {
      calibrate = true;
    } else if (arg === "--poll-ms") {
      pollMs = Number.parseInt(args[++i] ?? "", 10);
    } else if (!arg.startsWith("--")) {
      prompt = args.slice(i).join(" ");
      break;
    }
  }

  if (calibrate) {
    const result = await calibrateClaudeMac();
    process.stdout.write(
      json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${result.loadBearing ? "ready" : "coordinate-fallback"}\n`,
    );
    return;
  }

  if (!prompt) {
    console.error(
      "Usage: research-claude-mac.mjs [--calibrate --json] [--poll-ms N] --prompt '<prompt>'",
    );
    process.exit(2);
  }

  const result = await askClaudeMac({
    prompt,
    ...(Number.isFinite(pollMs) ? { pollUntilStableMs: pollMs } : {}),
  });
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.text}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  withWorkstationReturn(() => wrapLifecycle("research-claude-mac", mainCli))
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(`[claude-mac] ${error?.stack ?? error}`);
      process.exit(1);
    });
}
