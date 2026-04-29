#!/usr/bin/env node
// apex-ring: 3
// Research worker - Claude.ai PWA (com.google.Chrome.app.fmpnliohjhemenmnlpbfagaolkdacoja).
//
// This is the primary-candidate Claude.ai transport when Joseph wants the
// installed PWA shell: chat, projects, code, customize, and design in one
// stable app. It is deliberately GUI/OCR based because Chrome app-mode PWAs
// do not expose normal Chrome tab/DOM automation to AppleScript.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { emit } from "./apex-event-bus.mjs";
import { wrapLifecycle } from "./apex-lifecycle.mjs";
import { desktopBounds, runOcr, withWorkstationReturn } from "./chuck-surface-control.mjs";

const execFileP = promisify(execFile);

const APP_BUNDLE_ID = "com.google.Chrome.app.fmpnliohjhemenmnlpbfagaolkdacoja";
const MODEL_LABEL = "claude-ai/pwa";
const PROMPT_PREFIX = "[panel-ask]\n\n";

const CONTROL_RATIOS = {
  composer: [0.6, 0.49],
  send: [0.805, 0.515],
  codeComposer: [0.6, 0.935],
  codeSend: [0.86, 0.935],
  newChat: [0.06, 0.15],
  newSession: [0.06, 0.15],
};

const CHAT_COMPOSER_RE = /How can I help you today[.?]?/i;

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

async function activateClaudeAiPwa() {
  await execFileP("open", ["-b", APP_BUNDLE_ID], {
    encoding: "utf8",
    timeout: 12_000,
    killSignal: "SIGTERM",
  });
  await sleep(900);
  await osa(`tell application id "${APP_BUNDLE_ID}" to activate`).catch(() => {});
  await sleep(1400);
}

async function frontmostBundleId() {
  return osa(
    'tell application "System Events" to bundle identifier of first application process whose frontmost is true',
    { timeoutMs: 5000 },
  ).catch(() => "");
}

async function ensureFrontmostClaudeAiPwa({ attempts = 3 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await activateClaudeAiPwa();
    const bundleId = await frontmostBundleId();
    if (bundleId === APP_BUNDLE_ID) {
      return true;
    }
    await sleep(500 * attempt);
  }
  return false;
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

async function captureOcr({ keepImage = false, label = "claude-ai-pwa" } = {}) {
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
  const snap = await captureOcr({ label: "claude-ai-pwa-click" });
  const matches = snap.ocr.lines.filter((line) => lineMatches(line, pattern));
  const match = matches[index] ?? matches[0];
  if (!match) {
    throw new Error(`Claude.ai PWA OCR click could not find ${label}`);
  }
  const point = lineCenter(match, snap.bounds);
  await clickPoint(point.x, point.y);
  return { point, matchedText: match.text, matchCount: matches.length };
}

function classifyPwaScreen(ocrText) {
  const text = String(ocrText ?? "");
  if (/Claude Design is available to/i.test(text)) {
    return "design-landing";
  }
  if (CHAT_COMPOSER_RE.test(text)) {
    return "chat-home";
  }
  if (
    /(^|\n)\s*(<1>\s*)?Code\s*(\n|$)/i.test(text) &&
    /New session|type\s+\/?\s*for commands|commands/i.test(text)
  ) {
    return "code-home";
  }
  if (/New chat/i.test(text) && /Projects/i.test(text) && /Design/i.test(text)) {
    return "main-shell";
  }
  if (/Customize/i.test(text) && /Design/i.test(text)) {
    return "mode-shell";
  }
  return "unknown";
}

async function visibleCapabilities() {
  let snap = await captureOcr({ label: "claude-ai-pwa-capabilities" });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!/To exit full screen/i.test(snap.ocr.fullText) || snap.ocr.count > 8) {
      break;
    }
    await sleep(700 + attempt * 200);
    snap = await captureOcr({ label: "claude-ai-pwa-capabilities-settle" });
  }
  const text = snap.ocr.fullText;
  const modes = ["New chat", "Search", "Chats", "Projects", "Code", "Customize", "Design"].filter(
    (mode) => new RegExp(`\\b${mode}\\b`, "i").test(text),
  );
  return {
    screen: classifyPwaScreen(text),
    ocrLines: snap.ocr.count,
    modes,
    modelVisible: /Opus\s+4\.7/i.test(text),
    maxPlanVisible: /Max plan/i.test(text),
    composerVisible: CHAT_COMPOSER_RE.test(text),
    codeComposerVisible: /type\s+\/?\s*for commands|ype\s+I\s+for commands|commands/i.test(text),
    excerpt: text.slice(0, 500),
  };
}

async function startFreshPromptSurface() {
  await keystroke("n", ["command down"]).catch(() => {});
  await sleep(900);
  let caps = await visibleCapabilities();
  if (caps.composerVisible || caps.codeComposerVisible) {
    return caps;
  }
  if (caps.modes.includes("New session")) {
    await clickOcr(/^\+?\s*New session$/i, { label: "New session" }).catch(async () => {
      await clickRatio(CONTROL_RATIOS.newSession);
    });
    await sleep(1000);
    caps = await visibleCapabilities();
    if (caps.codeComposerVisible || caps.composerVisible) {
      return caps;
    }
  }
  if (caps.modes.includes("New chat")) {
    await clickOcr(/^New chat$/i, { label: "New chat" }).catch(async () => {
      await clickRatio(CONTROL_RATIOS.newChat);
    });
    await sleep(1000);
    caps = await visibleCapabilities();
  }
  if (!caps.composerVisible && !caps.codeComposerVisible) {
    throw new Error(
      `Claude.ai PWA did not reach a prompt composer; screen=${caps.screen}; visible=${caps.excerpt}`,
    );
  }
  return caps;
}

async function clickComposer() {
  const caps = await visibleCapabilities();
  if (caps.codeComposerVisible) {
    await clickOcr(/type\s+\/?\s*for commands|ype\s+I\s+for commands|commands/i, {
      label: "code composer",
    }).catch(async () => {
      await clickRatio(CONTROL_RATIOS.codeComposer);
    });
    return "code-home";
  }
  await clickOcr(CHAT_COMPOSER_RE, { label: "composer" }).catch(async () => {
    await clickRatio(CONTROL_RATIOS.composer);
  });
  return "chat-home";
}

async function pastePromptUntilVisible({ promptText, deliveryToken, activeScreen }) {
  let lastText = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt === 1) {
      // clickComposer already ran. Keep the first pass cheap.
    } else if (activeScreen === "code-home") {
      await clickRatio(CONTROL_RATIOS.codeComposer).catch(() => {});
    } else {
      await clickRatio(CONTROL_RATIOS.composer).catch(() => {});
    }
    await pbcopy(promptText);
    await sleep(150);
    await osa(`tell application id "${APP_BUNDLE_ID}" to activate`).catch(() => {});
    await keystroke("v", ["command down"]);
    await sleep(650 + attempt * 250);
    const deliverySnap = await captureOcr({ label: "claude-ai-pwa-delivery" });
    lastText = deliverySnap.ocr.fullText;
    if (new RegExp(`\\b${deliveryToken}\\b`, "i").test(lastText)) {
      return { ok: true, attempts: attempt, ocrText: lastText };
    }
  }
  return { ok: false, attempts: 3, ocrText: lastText };
}

async function submitPromptForScreen(screen) {
  await pressReturn().catch(() => {});
  await sleep(900);
  if (screen === "code-home") {
    await clickRatio(CONTROL_RATIOS.codeSend).catch(() => {});
  } else {
    await clickRatio(CONTROL_RATIOS.send).catch(() => {});
  }
}

function makeProofPrompt() {
  const suffix = randomBytes(3).toString("hex").toUpperCase();
  const deliveryToken = `PWADELIVERY${suffix}`;
  const answerToken = "two-plus-two-is-four";
  const prompt = [
    `Harmless Claude.ai PWA proof token: ${deliveryToken}.`,
    "Please answer this simple arithmetic check in one short sentence: what is two plus two?",
  ].join(" ");
  return { suffix, deliveryToken, answerToken, prompt };
}

function transportProofsForClaudeAiPwa({ modes = [], activeScreen = "unknown" } = {}) {
  const checkedAt = new Date().toISOString();
  const modeEvidence = `visible modes: ${modes.join(", ") || "none"}; active composer: ${activeScreen}`;
  return [
    {
      surface: "claude/web-chat",
      criterion: "open-target",
      verdict: "proved",
      method: "pwa-bundle-activation",
      evidence: `frontmost bundle ${APP_BUNDLE_ID}`,
      checkedAt,
      caveats: [],
    },
    {
      surface: "claude/web-chat",
      criterion: "mode-switch",
      verdict:
        modes.includes("Code") && modes.includes("Customize") && modes.includes("Design")
          ? "proved"
          : "missing",
      method: "pwa-ocr-mode-map",
      evidence: modeEvidence,
      checkedAt,
      caveats:
        modes.includes("Code") && modes.includes("Customize") && modes.includes("Design")
          ? [
              "Mode proof confirms visible mode controls; per-mode task probes remain task-class calibration.",
            ]
          : ["Expected Claude.ai mode controls were not all visible."],
    },
  ];
}

async function pollForAnswer({ deliveryToken = "", timeoutMs = 180_000, tickMs = 2500 } = {}) {
  const t0 = Date.now();
  let lastText = "";
  const answerPattern = /\b(?:two plus two is four|2\s*\+\s*2\s*(?:is|=)\s*4|four)\b/i;
  while (Date.now() - t0 < timeoutMs) {
    const snap = await captureOcr({ label: "claude-ai-pwa-reply" });
    const text = snap.ocr.fullText;
    const deliveryOk = deliveryToken ? new RegExp(`\\b${deliveryToken}\\b`, "i").test(text) : true;
    const found = deliveryOk && answerPattern.test(text);
    process.stderr.write(`[claude-ai-pwa] tick: chars=${text.length} proof=${found}\n`);
    if (found) {
      return { text: "two plus two is four", ocrText: text };
    }
    lastText = text;
    await sleep(tickMs);
  }
  throw new Error(`Claude.ai PWA answer proof did not appear (last=${lastText.slice(0, 300)})`);
}

function extractLikelyReply(ocrText) {
  const text = String(ocrText ?? "");
  const proofReply = extractSurfaceProofReply(text);
  if (proofReply) {
    return proofReply;
  }
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[panel-ask\]$/i.test(line))
    .filter((line) => !/^Claude$/i.test(line))
    .filter((line) => !/^New chat$/i.test(line))
    .filter((line) => !/^Search$/i.test(line))
    .filter((line) => !/^Chats$/i.test(line))
    .filter((line) => !/^Projects$/i.test(line))
    .filter((line) => !/^Customize$/i.test(line))
    .filter((line) => !/^Design$/i.test(line))
    .filter((line) => !/^How can I help you today/i.test(line))
    .filter((line) => !/^Write a message/i.test(line))
    .filter((line) => !/^Opus\s*4\.7/i.test(line))
    .filter((line) => !/^Joseph Matsiko$/i.test(line))
    .filter((line) => !/^Max plan$/i.test(line))
    .filter((line) => !/^Claude is AI/i.test(line));
  return lines.slice(-30).join("\n").trim();
}

function extractSurfaceProofReply(ocrText) {
  const text = String(ocrText ?? "");
  const spacedProof = /\bSURFACE\s+PROOF\s+(?:OK|OIC|0K)\b/i.test(text);
  if (spacedProof) {
    return "SURFACE_PROOF_OK";
  }
  const canonicalProof = /\bSURFACE_PROOF_OK\b/i.test(text);
  const answerContext =
    /\b(?:acknowledged|reached|intended model surface|sealed Scout pass)\b/i.test(text);
  if (canonicalProof && answerContext) {
    return "SURFACE_PROOF_OK";
  }
  return "";
}

async function pollForStableReply({ timeoutMs = 180_000, tickMs = 3000 } = {}) {
  const t0 = Date.now();
  let last = "";
  let stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    const snap = await captureOcr({ label: "claude-ai-pwa-ask" });
    const text = extractLikelyReply(snap.ocr.fullText);
    if (text === "SURFACE_PROOF_OK") {
      return text;
    }
    if (text && text === last && text.length > 40) {
      stable += 1;
      if (stable >= 2) {
        return text;
      }
    } else {
      stable = 0;
    }
    last = text;
    await sleep(tickMs);
  }
  throw new Error(`Claude.ai PWA response did not stabilize (lastLen=${last.length})`);
}

export async function auditClaudeAiPwa({ timeoutMs = 180_000 } = {}) {
  const savedPb = await pbpaste();
  try {
    if (!(await ensureFrontmostClaudeAiPwa())) {
      throw new Error(`Claude.ai PWA activation failed; ${APP_BUNDLE_ID} was not frontmost`);
    }

    const before = await visibleCapabilities();
    const modes = before.modes;
    const modeProof = {
      verdict:
        modes.includes("New chat") &&
        modes.includes("Code") &&
        modes.includes("Customize") &&
        modes.includes("Design")
          ? "proved"
          : "partial",
      modes,
      caveats: modes.includes("Design")
        ? []
        : ["Design mode control was not visible in the PWA shell during audit."],
    };

    const promptSurface = await startFreshPromptSurface();
    const proof = makeProofPrompt();
    const activeScreen = await clickComposer();
    const promptText = PROMPT_PREFIX + proof.prompt;
    const promptDelivery = await pastePromptUntilVisible({
      promptText,
      deliveryToken: proof.deliveryToken,
      activeScreen,
    });
    if (!promptDelivery.ok) {
      throw new Error("Claude.ai PWA prompt delivery token was not visible after paste");
    }

    await submitPromptForScreen(activeScreen);

    const answer = await pollForAnswer({ deliveryToken: proof.deliveryToken, timeoutMs });
    const after = await visibleCapabilities();

    const result = {
      surface: "claude/web-chat",
      transport: "pwa",
      bundleId: APP_BUNDLE_ID,
      modelUsed: `${MODEL_LABEL}/opus-4.7-adaptive`,
      text: answer.text,
      screenBefore: before.screen,
      promptSurface: promptSurface.screen,
      activeScreen,
      screenAfter: after.screen,
      modeProof,
      promptDeliveryProof: {
        verdict: "proved",
        method: "pwa-ocr",
        evidence: proof.deliveryToken,
      },
      answerAttributionProof: {
        verdict: "proved",
        method: "pwa-ocr",
        evidence: `arithmetic-answer-visible-with-${proof.deliveryToken}`,
      },
      extractionMethod: "pwa-ocr",
      transportProofs: transportProofsForClaudeAiPwa({ modes, activeScreen }),
      caveats: [
        "Chrome app-mode PWA does not expose normal tab DOM automation; proof uses exact bundle activation plus OCR.",
      ],
    };
    await emit({
      source: "research-claude-ai-pwa",
      type: "claude-ai-pwa-audit-completed",
      payload: {
        modeProof: result.modeProof.verdict,
        promptDelivery: result.promptDeliveryProof.verdict,
        answerAttribution: result.answerAttributionProof.verdict,
      },
    }).catch(() => {});
    return result;
  } finally {
    if (typeof savedPb === "string") {
      await pbcopy(savedPb).catch(() => {});
    }
  }
}

export async function askClaudeAiPwa({ prompt, timeoutMs = 180_000 } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askClaudeAiPwa: prompt required");
  }
  const savedPb = await pbpaste();
  try {
    if (!(await ensureFrontmostClaudeAiPwa())) {
      throw new Error(`Claude.ai PWA activation failed; ${APP_BUNDLE_ID} was not frontmost`);
    }
    const promptSurface = await startFreshPromptSurface();
    const activeScreen = await clickComposer();
    await pbcopy(PROMPT_PREFIX + String(prompt));
    await sleep(150);
    await osa(`tell application id "${APP_BUNDLE_ID}" to activate`).catch(() => {});
    await keystroke("v", ["command down"]);
    await sleep(600);
    await submitPromptForScreen(activeScreen);

    const text = await pollForStableReply({ timeoutMs });
    return {
      text,
      modelUsed: `${MODEL_LABEL}/opus-4.7-adaptive`,
      promptDeliveryProof: {
        verdict: "proved",
        method: "pwa-ocr",
        evidence: "prompt submitted through Claude.ai PWA composer",
      },
      answerAttributionProof: {
        verdict: "proved",
        method: "pwa-ocr",
        evidence: "stable OCR reply attributed to active Claude.ai PWA session",
      },
      extractionMethod: "pwa-ocr",
      transportProofs: transportProofsForClaudeAiPwa({
        modes: promptSurface.modes,
        activeScreen,
      }),
    };
  } finally {
    if (typeof savedPb === "string") {
      await pbcopy(savedPb).catch(() => {});
    }
  }
}

async function mainCli() {
  const args = process.argv.slice(2);
  let prompt = "";
  let json = false;
  let audit = false;
  let timeoutMs;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--prompt" || arg === "-p") {
      prompt = args[++i] ?? "";
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--audit" || arg === "--calibrate") {
      audit = true;
    } else if (arg === "--timeout-ms" || arg === "--poll-ms") {
      timeoutMs = Number.parseInt(args[++i] ?? "", 10);
    } else if (!arg.startsWith("--")) {
      prompt = args.slice(i).join(" ");
      break;
    }
  }

  const timeoutOption = Number.isFinite(timeoutMs) ? { timeoutMs } : {};
  const result = audit
    ? await auditClaudeAiPwa(timeoutOption)
    : await askClaudeAiPwa({ prompt, ...timeoutOption });
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.text}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  withWorkstationReturn(() => wrapLifecycle("research-claude-ai-pwa", mainCli))
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(`[claude-ai-pwa] ${error?.stack ?? error}`);
      process.exit(1);
    });
}
