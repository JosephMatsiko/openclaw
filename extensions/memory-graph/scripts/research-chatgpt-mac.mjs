#!/usr/bin/env node
// apex-ring: 3
// Research worker — ChatGPT Mac app (com.openai.chat).
//
// Mac-app replacement for web-driven research-chatgpt-chat.mjs for the
// `chatgpt-web` panel voice. Same GPT-5.5 model, native surface, no
// Cloudflare/Turnstile/CDP fragility. Mirrors research-claude-mac.mjs.
//
// COORDS below are fallback coordinates only. The load-bearing path now
// probes the ChatGPT accessibility tree for real anchors before clicking.
// Keyboard shortcuts (Cmd+N, Cmd+V, Return) are macOS-standard and should
// hold; coordinate clicks are the last resort.

import { execFile, spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { emit } from "./apex-event-bus.mjs";
import { wrapLifecycle } from "./apex-lifecycle.mjs";
import { withWorkstationReturn } from "./chuck-surface-control.mjs";

const execFileP = promisify(execFile);

const APP_NAME = "ChatGPT";
const APP_BUNDLE_ID = "com.openai.chat";

const WINDOW_POS = [120, 40];
const WINDOW_SIZE = [1100, 800];

// Composer Y bias: ChatGPT.app input field sits ~50px above the window's
// bottom edge. Earlier fixed value (750) was 40px too high and clicks
// missed the input element under WebKit, leaving Cmd+V to paste into
// no-active-field (caught 2026-04-28 panel smoke). Computed dynamically
// from WINDOW_POS + WINDOW_SIZE so resizing the window relocates the
// fallback automatically.
// In fullscreen, the real composer sits above the bottom toolbar row.
// Live AX proof on 2026-04-28: main window y=33,h=923; composer scroll
// area y=858.5,h=34, center ~=876. The old 50px offset clicked y=906,
// below the input. Keep this as a fallback only; AX geometry below wins.
const COMPOSER_Y_OFFSET_FROM_BOTTOM = 80;

function dynamicComposerCenter() {
  const [px, py] = WINDOW_POS;
  const [sx, sy] = WINDOW_SIZE;
  return [px + Math.round(sx / 2), py + sy - COMPOSER_Y_OFFSET_FROM_BOTTOM];
}

const COORDS = {
  sidebarToggle: [70, 65],
  composerCenter: dynamicComposerCenter(),
  newChatButton: [73, 59],
  modelPill: [200, 100],
  thinkingToggle: [330, 770],
  replyCrop: [130, 140, 940, 570],
};

const PROMPT_PREFIX = "[panel-ask]\n\n";
const SHORT_PROOF_RE = /\b(?:SURFACE_PROOF_OK|APEXOK[A-Z0-9]+)\b/;
const CHATGPT_TARGET_WINDOW_AS = `
      set targetWin to missing value
      set winCount to count of windows
      repeat with i from 1 to winCount
        try
          if (role description of window i) is "standard window" then
            set targetWin to window i
            exit repeat
          end if
        end try
      end repeat
      if targetWin is missing value then
        repeat with i from 1 to winCount
          try
            if (count of (entire contents of window i)) > 0 then
              set targetWin to window i
              exit repeat
            end if
          end try
        end repeat
      end if
      if targetWin is missing value and winCount > 0 then
        set targetWin to window 1
      end if
`;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Per-call timeouts — see research-claude-mac.mjs for full rationale.
// Without these the Mac driver wedges for the entire 8-min outer
// Promise.race window when any single AppleScript or cliclick call
// hangs (stuck Mac-app state, accessibility prompt, minimised window).
async function osa(script, { timeoutMs = 12_000 } = {}) {
  const r = await execFileP("osascript", ["-e", script], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  return r.stdout.trim();
}

async function cliclick(cmd, { timeoutMs = 5000 } = {}) {
  await execFileP("/opt/homebrew/bin/cliclick", [cmd], {
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
}

async function clickAt([x, y]) {
  await cliclick(`c:${x},${y}`);
  await sleep(150);
}

function parseUiAnchor(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }
  const parts = text.split("\t");
  if (parts.length < 5) {
    return null;
  }
  const score = Number.parseInt(parts[0] ?? "", 10);
  const purpose = parts[1] ?? "";
  const [xRaw, yRaw] = (parts[2] ?? "").split(",");
  const x = Number.parseInt(xRaw ?? "", 10);
  const y = Number.parseInt(yRaw ?? "", 10);
  if (!Number.isFinite(score) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return {
    purpose,
    score,
    point: [x, y],
    bounds: parts[3] ?? "",
    role: parts[4] ?? "",
    label: parts.slice(5).join(" ").trim(),
  };
}

async function findUiAnchor(purpose) {
  const safePurpose = String(purpose).replaceAll('"', "");
  const script = `
    on candidateScore(purposeName, roleText, labelText, x, y, w, h)
      if w < 8 or h < 8 then return -9999
      set score to 0
      ignoring case
        if purposeName is "composer" then
          if labelText contains "search" then return -9999
          set hasComposerLabel to false
          if labelText contains "message" then set hasComposerLabel to true
          if labelText contains "ask" then set hasComposerLabel to true
          if labelText contains "prompt" then set hasComposerLabel to true
          set isBottomInputShape to false
          if w > 500 and h > 20 and h < 140 and y > 700 then set isBottomInputShape to true
          if hasComposerLabel is false and isBottomInputShape is false then return -9999
          if roleText contains "text" then set score to score + 45
          if roleText contains "edit" then set score to score + 25
          if roleText contains "scroll" and isBottomInputShape then set score to score + 42
          if labelText contains "message" then set score to score + 35
          if labelText contains "ask" then set score to score + 35
          if labelText contains "prompt" then set score to score + 30
          if labelText contains "chatgpt" then set score to score + 10
          if w > 250 then set score to score + 12
          if h > 25 then set score to score + 8
          if y > 350 then set score to score + 14
          if y > 820 then set score to score + 18
          if isBottomInputShape then set score to score + 20
        else if purposeName is "new-chat" then
          set hasNewChatLabel to false
          if labelText contains "new chat" then set hasNewChatLabel to true
          if labelText contains "new conversation" then set hasNewChatLabel to true
          if labelText contains "compose" then set hasNewChatLabel to true
          if hasNewChatLabel is false then return -9999
          if roleText contains "button" then set score to score + 30
          if roleText contains "menu" then set score to score + 12
          if labelText contains "new chat" then set score to score + 55
          if labelText contains "new conversation" then set score to score + 55
          if labelText contains "compose" then set score to score + 20
          if y < 180 then set score to score + 8
        else if purposeName is "thinking-toggle" then
          set hasThinkingLabel to false
          if labelText contains "think" then set hasThinkingLabel to true
          if labelText contains "reason" then set hasThinkingLabel to true
          if labelText contains "deep" then set hasThinkingLabel to true
          if hasThinkingLabel is false then return -9999
          if roleText contains "button" then set score to score + 25
          if labelText contains "think" then set score to score + 55
          if labelText contains "reason" then set score to score + 35
          if labelText contains "deep" then set score to score + 15
          if y > 550 then set score to score + 8
        end if
      end ignoring
      return score
    end candidateScore

    tell application "System Events" to tell process "${APP_NAME}"
      ${CHATGPT_TARGET_WINDOW_AS}
      if winCount is 0 then return ""
      if targetWin is missing value then return ""
      set bestScore to -9999
      set bestX to 0
      set bestY to 0
      set bestBounds to ""
      set bestRole to ""
      set bestLabel to ""
      set elems to entire contents of targetWin
      repeat with e in elems
        try
          set roleText to ""
          set descText to ""
          set titleText to ""
          set valueText to ""
          set helpText to ""
          try
            set roleText to role of e as text
          end try
          try
            set roleText to roleText & " " & (role description of e as text)
          end try
          try
            set descText to description of e as text
          end try
          try
            set titleText to title of e as text
          end try
          try
            set valueText to value of e as text
          end try
          try
            set helpText to help of e as text
          end try
          set labelText to roleText & " " & descText & " " & titleText & " " & valueText & " " & helpText
          set p to position of e
          set s to size of e
          set x to item 1 of p
          set y to item 2 of p
          set w to item 1 of s
          set h to item 2 of s
          set score to my candidateScore("${safePurpose}", roleText, labelText, x, y, w, h)
          if score > bestScore then
            set bestScore to score
            set bestX to x + (w / 2)
            set bestY to y + (h / 2)
            set bestBounds to (x as integer as text) & "," & (y as integer as text) & "," & (w as integer as text) & "," & (h as integer as text)
            set bestRole to roleText
            set bestLabel to labelText
          end if
        end try
      end repeat
      if bestScore < 20 then return ""
      return (bestScore as integer as text) & tab & "${safePurpose}" & tab & (bestX as integer as text) & "," & (bestY as integer as text) & tab & bestBounds & tab & bestRole & tab & bestLabel
    end tell
  `;
  try {
    const raw = await osa(script, { timeoutMs: 12_000 });
    return parseUiAnchor(raw);
  } catch (e) {
    const detail = String(e?.stderr || e?.code || "failed").trim();
    process.stderr.write(`[chatgpt-mac] findUiAnchor(${purpose}) warning: ${detail}\n`);
    return null;
  }
}

async function chatPaneA11yChildCount({ timeoutMs = 2500 } = {}) {
  const raw = await osa(
    `tell application "System Events" to tell process "${APP_NAME}"
      ${CHATGPT_TARGET_WINDOW_AS}
      if winCount is 0 or targetWin is missing value then return "0"
      return (count of (entire contents of targetWin) as text)
    end tell`,
    { timeoutMs },
  ).catch(() => "unknown");
  const count = Number.parseInt(raw, 10);
  return { raw, count: Number.isFinite(count) ? count : 0 };
}

async function clickAnchorOrFallback(purpose, fallback) {
  const childCount = await chatPaneA11yChildCount();
  if (childCount.count < 1) {
    process.stderr.write(
      `[chatgpt-mac] ${purpose} AX tree unavailable (children=${childCount.raw}); using fallback ${fallback.join(",")}\n`,
    );
    await clickAt(fallback);
    return null;
  }
  const anchor = await findUiAnchor(purpose);
  if (anchor?.point) {
    process.stderr.write(
      `[chatgpt-mac] ${purpose} anchor score=${anchor.score} point=${anchor.point.join(",")} role=${anchor.role.slice(0, 80)}\n`,
    );
    await clickAt(anchor.point);
    return anchor;
  }
  process.stderr.write(
    `[chatgpt-mac] ${purpose} anchor unavailable; using fallback ${fallback.join(",")}\n`,
  );
  await clickAt(fallback);
  return null;
}

async function pbpaste({ timeoutMs = 5000 } = {}) {
  const { stdout } = await execFileP("pbpaste", [], {
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  return stdout;
}

async function pbcopy(text, { timeoutMs = 5000 } = {}) {
  await writeToCommandStdin("pbcopy", [], String(text), { timeoutMs });
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

async function screenshot(path, { timeoutMs = 10_000, region } = {}) {
  let lastError;
  const args = ["-x"];
  if (Array.isArray(region) && region.length === 4) {
    const cleanRegion = region.map((n) => Math.max(1, Math.round(Number(n) || 1)));
    args.push("-R", cleanRegion.join(","));
  }
  args.push(path);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await execFileP("/usr/sbin/screencapture", args, {
        timeout: timeoutMs,
        killSignal: "SIGTERM",
      });
      return;
    } catch (e) {
      lastError = e;
      await sleep(300 * attempt);
    }
  }
  const detail = String(lastError?.stderr || lastError?.message || lastError || "").trim();
  throw new Error(
    `macOS screenshot capture unavailable for ChatGPT answer extraction (${detail || "unknown screencapture failure"}). Grant Screen Recording to the launching terminal/Codex process or use a non-screenshot extraction path.`,
    { cause: lastError },
  );
}

async function activateApp() {
  try {
    await execFileP("open", ["-b", APP_BUNDLE_ID]);
  } catch (e) {
    throw new Error(`ChatGPT Mac app not installed (bundle ${APP_BUNDLE_ID}): ${e?.message ?? e}`, {
      cause: e,
    });
  }
  await sleep(1200);
  await osa(`tell application id "${APP_BUNDLE_ID}" to activate`).catch(() => {});
  await sleep(500);
}

async function countChatGptWindows() {
  const raw = await osa(
    `tell application "System Events" to tell process "${APP_NAME}" to get (count of windows as text)`,
    { timeoutMs: 5000 },
  ).catch(() => "0");
  const count = Number.parseInt(raw, 10);
  return Number.isFinite(count) ? count : 0;
}

async function ensureConversationWindow() {
  if ((await countChatGptWindows()) > 0) {
    return;
  }
  try {
    await osa(
      `tell application "System Events" to tell process "${APP_NAME}" to click menu item "New Chat" of menu "File" of menu bar 1`,
      { timeoutMs: 5000 },
    );
    await sleep(900);
  } catch {
    await cliclick("kd:cmd").catch(() => {});
    await cliclick("kp:n").catch(() => {});
    await cliclick("ku:cmd").catch(() => {});
    await sleep(900);
  }
}

// Detect ChatGPT.app's standard chat window — and whether it's in
// fullscreen Space (Joseph's setup). If fullscreen, the driver can't
// resize to WINDOW_SIZE, so we leave geometry alone and let
// dynamicComposerCenter / replyCrop adapt at runtime.
async function detectMainWindow() {
  const script = `
    tell application "System Events" to tell process "${APP_NAME}"
      set targetWin to missing value
      set winCount to count of windows
      repeat with i from 1 to winCount
        try
          if (role description of window i) is "standard window" then
            set targetWin to window i
            exit repeat
          end if
        end try
      end repeat
      if targetWin is missing value and winCount > 0 then
        set targetWin to window 1
      end if
      if targetWin is missing value then return ""
      set p to position of targetWin
      set s to size of targetWin
      set isFs to "false"
      try
        set isFs to (value of attribute "AXFullScreen" of targetWin) as string
      end try
      return (item 1 of p as string) & "," & (item 2 of p as string) & "," & (item 1 of s as string) & "," & (item 2 of s as string) & "," & isFs
    end tell
  `;
  const out = await osa(script).catch(() => "");
  if (!out) {
    return null;
  }
  const [px, py, sx, sy, isFs] = out.split(",");
  return {
    pos: [Number(px), Number(py)],
    size: [Number(sx), Number(sy)],
    fullscreen: isFs === "true",
  };
}

let _runtimeWindow = null;

function runtimeComposerCenter() {
  const w = _runtimeWindow;
  if (!w || !w.size?.[0]) {
    return COORDS.composerCenter;
  }
  const [px, py] = w.pos;
  const [sx, sy] = w.size;
  return [px + Math.round(sx / 2), py + sy - COMPOSER_Y_OFFSET_FROM_BOTTOM];
}

function runtimeReplyCrop() {
  const w = _runtimeWindow;
  if (!w || !w.size?.[0]) {
    return COORDS.replyCrop;
  }
  const [px, py] = w.pos;
  const [sx, sy] = w.size;
  // Inset 20px from sides, 100px from top (header), 200px from bottom
  // (composer + tools row) to capture chat history.
  return [px + 20, py + 100, sx - 40, sy - 300];
}

function runtimeNewChatButton() {
  const w = _runtimeWindow;
  if (!w || !w.size?.[0]) {
    return COORDS.newChatButton;
  }
  const [px, py] = w.pos;
  return [px + 73, py + 26];
}

function runtimeSendButtonCenter() {
  const w = _runtimeWindow;
  if (!w || !w.size?.[0]) {
    return [COORDS.composerCenter[0] + 460, COORDS.composerCenter[1] + 160];
  }
  const [px, py] = w.pos;
  const [sx, sy] = w.size;
  // ChatGPT fullscreen layout keeps the send button in the lower-right
  // composer cluster. Live proof 2026-04-28: x = windowRight - 142,
  // y = windowBottom - 35.
  return [px + sx - 142, py + sy - 35];
}

async function standardizeWindow() {
  const w = await detectMainWindow();
  if (w) {
    _runtimeWindow = w;
    if (w.fullscreen) {
      // Can't resize a fullscreen window; leave it. Composer + crop
      // will recompute from the runtime window dimensions. Just raise.
      await osa(
        `tell application "System Events" to tell process "${APP_NAME}"
          ${CHATGPT_TARGET_WINDOW_AS}
          if targetWin is not missing value then perform action "AXRaise" of targetWin
        end tell`,
      ).catch(() => {});
      await sleep(200);
      return;
    }
  }
  const [px, py] = WINDOW_POS;
  const [sx, sy] = WINDOW_SIZE;
  const script = `
    tell application "System Events" to tell process "${APP_NAME}"
      set targetWin to missing value
      set winCount to count of windows
      repeat with i from 1 to winCount
        try
          if (role description of window i) is "standard window" then
            set targetWin to window i
            exit repeat
          end if
        end try
      end repeat
      if targetWin is missing value and winCount > 0 then
        set targetWin to window 1
      end if
      if targetWin is not missing value then
        try
          set position of targetWin to {${px}, ${py}}
          set size of targetWin to {${sx}, ${sy}}
          perform action "AXRaise" of targetWin
        end try
      end if
    end tell
  `;
  try {
    await osa(script);
    await sleep(350);
  } catch (e) {
    process.stderr.write(`[chatgpt-mac] standardizeWindow warning: ${e?.message ?? e}\n`);
  }
}

async function newConversation() {
  try {
    await cliclick("kd:cmd");
    await cliclick("kp:n");
    await cliclick("ku:cmd");
    await sleep(500);
  } catch {
    /* continue to explicit UI click */
  }
  // Cmd+N can leave fullscreen ChatGPT.app on the prior thread while
  // only focusing the composer. Click the visible toolbar New Chat
  // control as the canonical fullscreen path.
  try {
    await clickAt(runtimeNewChatButton());
    await sleep(900);
    return;
  } catch {
    /* fall through */
  }
  for (const label of ["New Chat", "New Conversation", "New Window"]) {
    try {
      await osa(
        `tell application "System Events" to tell process "${APP_NAME}" to click menu item "${label}" of menu "File" of menu bar 1`,
      );
      await sleep(900);
      return;
    } catch {
      /* try next */
    }
  }
  await clickAnchorOrFallback("new-chat", COORDS.newChatButton);
  await sleep(700);
}

async function reloadHome() {
  try {
    await cliclick("kd:cmd");
    await cliclick("kp:r");
    await cliclick("ku:cmd");
    await sleep(1500);
  } catch {
    /* best effort */
  }
}

async function toggleThinkingMode() {
  try {
    await clickAnchorOrFallback("thinking-toggle", COORDS.thinkingToggle);
    await sleep(250);
  } catch (e) {
    process.stderr.write(`[chatgpt-mac] toggleThinkingMode warning: ${e?.message ?? e}\n`);
  }
}

async function calibrateChatGPTMac() {
  await activateApp();
  await ensureConversationWindow();
  await standardizeWindow();
  const chatPaneChildCount = await chatPaneA11yChildCount({ timeoutMs: 8000 });
  const tmpShot = join(tmpdir(), `chatgpt-mac-calibrate-${Date.now()}.png`);
  let screenCapture = { ok: false, error: "" };
  try {
    await screenshot(tmpShot, { timeoutMs: 5000 });
    screenCapture = { ok: true, error: "" };
  } catch (e) {
    screenCapture = { ok: false, error: e?.message ?? String(e) };
  } finally {
    try {
      unlinkSync(tmpShot);
    } catch {
      /* best effort */
    }
  }
  const [composer, newChat, thinkingToggle] =
    chatPaneChildCount.count > 0
      ? await Promise.all([
          findUiAnchor("composer"),
          findUiAnchor("new-chat"),
          findUiAnchor("thinking-toggle"),
        ])
      : [null, null, null];
  return {
    surface: "chatgpt/mac-app",
    appName: APP_NAME,
    bundleId: APP_BUNDLE_ID,
    window: { position: WINDOW_POS, size: WINDOW_SIZE },
    windows: await countChatGptWindows(),
    chatPaneA11yChildCount: chatPaneChildCount.raw,
    screenCapture,
    anchors: { composer, newChat, thinkingToggle },
    fallbackCoords: COORDS,
    loadBearing: Boolean(composer || screenCapture.ok) && screenCapture.ok,
    caveats: [
      composer
        ? "Composer anchor found through macOS Accessibility."
        : "Composer anchor was not found; driver will fall back to standardized-window coordinates.",
      screenCapture.ok
        ? "Screen capture available for answer attribution."
        : "Screen capture unavailable; answer attribution cannot be proven by this Mac-app driver.",
    ],
  };
}

async function visionAsk({ imagePath, prompt, timeoutMs = 90_000 }) {
  const fullPrompt = `@${imagePath}\n\n${prompt}`;
  return new Promise((resolve, reject) => {
    const args = ["-p", fullPrompt, "--model", "opus", "--output-format", "text"];
    let stdout = "";
    let stderr = "";
    const child = execFile("claude", args, { maxBuffer: 20 * 1024 * 1024 });
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

async function readReplyState(imagePath) {
  const prompt = [
    "You are inspecting a screenshot of the ChatGPT Mac desktop app's chat view.",
    "The user has sent a single prompt and is waiting for the assistant's reply.",
    "Answer strictly as JSON on a single line, no prose, no code fences:",
    "",
    '{ "reply": "<the assistant\'s full reply text verbatim, or empty string if no reply yet>",',
    '  "streaming": <true if a stop-button/spinner/typing-cursor/"Stop generating" UI indicates generation is in progress, else false> }',
    "",
    `IMPORTANT: ignore any text inside a user-message bubble (it begins with our sentinel "${PROMPT_PREFIX.trim()}"). Only return the assistant's reply text.`,
    'Do NOT include "Sources", "Suggestions", "Related questions", or follow-up chip text in "reply" — only the assistant\'s main answer body.',
    'If the app is in an error/empty/settings/loading/login state with no assistant turn, set reply to "" and streaming to false.',
  ].join("\n");
  const raw = await visionAsk({ imagePath, prompt });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    return { reply: "", streaming: false, raw };
  }
  try {
    const parsed = JSON.parse(m[0]);
    return { reply: String(parsed.reply ?? "").trim(), streaming: !!parsed.streaming };
  } catch {
    return { reply: "", streaming: false, raw };
  }
}

async function closeThread() {
  try {
    await cliclick("kd:cmd");
    await cliclick("kp:w");
    await cliclick("ku:cmd");
    await sleep(400);
  } catch {
    /* best effort */
  }
}

export async function askChatGPTMac({
  prompt,
  model = "gpt-5.5",
  initialWaitMs = 8000,
  pollUntilStableMs = 180_000,
  tickMs = 3000,
  stableTicksRequired = 3,
  deleteThread = false,
  thinkingMode = false,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askChatGPTMac: prompt required");
  }

  const savedPb = await pbpaste();
  let threadOpened = false;

  try {
    await activateApp();
    await ensureConversationWindow();
    await standardizeWindow();
    await reloadHome();
    await standardizeWindow();
    await newConversation();
    threadOpened = true;
    await standardizeWindow();
    if (thinkingMode) {
      await toggleThinkingMode();
    }
    // After newConversation() (Cmd+N) the composer is auto-focused.
    // Earlier the explicit clickAnchorOrFallback at COORDS.composerCenter
    // moved focus to wherever the (fallback-coord) click landed —
    // typically NOT inside the input element under WebKit, so Cmd+V
    // pasted into nothing and Return sent nothing. Skip the click and
    // trust the Cmd+N focus. If empirically the focus is lost (e.g., a
    // standardizeWindow raise pulls it), a real AX anchor point below
    // re-asserts it without falling back to a guessed coordinate.
    const composerAnchor = await findUiAnchor("composer").catch(() => null);
    if (composerAnchor?.point) {
      process.stderr.write(
        `[chatgpt-mac] composer anchor score=${composerAnchor.score} point=${composerAnchor.point.join(",")} role=${composerAnchor.role.slice(0, 80)}\n`,
      );
      await clickAt(composerAnchor.point);
    } else if (_runtimeWindow?.fullscreen) {
      // Fullscreen ChatGPT.app: the AX tree often hides the composer
      // anchor. Click the runtime-computed bottom-center as a focus
      // assist. Computed from actual window geometry, not the
      // 1100x800 calibration.
      const rcc = runtimeComposerCenter();
      process.stderr.write(`[chatgpt-mac] fullscreen: composer click @ ${rcc.join(",")}\n`);
      await clickAt(rcc);
    }
    const fullPrompt =
      PROMPT_PREFIX +
      (thinkingMode ? "Please use thinking/reasoning mode for the best quality answer.\n\n" : "") +
      String(prompt);
    await pbcopy(fullPrompt);
    await sleep(150);
    // Ensure ChatGPT.app is frontmost right before the paste so the
    // keystroke routes to it. Without this, sibling Mac-app activity
    // can steal frontmost between standardizeWindow and the keystroke.
    await osa(`tell application id "${APP_BUNDLE_ID}" to activate`).catch(() => {});
    await sleep(200);
    await osa('tell application "System Events" to keystroke "v" using command down');
    await sleep(450);
    await clickAt(runtimeSendButtonCenter());
    await sleep(initialWaitMs);

    const t0 = Date.now();
    let lastReply = "";
    let stableTicks = 0;
    const tmp = tmpdir();
    while (Date.now() - t0 < pollUntilStableMs) {
      const shot = join(tmp, `chatgpt-mac-${Date.now()}.png`);
      let state;
      try {
        await screenshot(shot, { region: runtimeReplyCrop() });
        state = await readReplyState(shot);
      } finally {
        try {
          unlinkSync(shot);
        } catch {
          /* */
        }
      }
      process.stderr.write(
        `[chatgpt-mac] tick: len=${state.reply.length} streaming=${state.streaming}\n`,
      );
      const shortProofToken = SHORT_PROOF_RE.test(state.reply);
      if (!state.streaming && shortProofToken) {
        try {
          await emit({
            source: "research-chatgpt-mac",
            type: "chatgpt-mac-completed",
            payload: {
              model,
              replyLen: state.reply.length,
              latencyMs: Date.now() - t0,
              thinkingMode,
              proofToken: true,
            },
          });
        } catch {
          /* */
        }
        return {
          text: state.reply,
          modelUsed: `chatgpt-mac-app/${model}${thinkingMode ? " (thinking)" : ""}`,
          threadDeleted: false,
        };
      }
      if (
        !state.streaming &&
        state.reply &&
        state.reply === lastReply &&
        (state.reply.length >= 60 || shortProofToken)
      ) {
        stableTicks += 1;
        if (stableTicks >= stableTicksRequired) {
          try {
            await emit({
              source: "research-chatgpt-mac",
              type: "chatgpt-mac-completed",
              payload: {
                model,
                replyLen: state.reply.length,
                latencyMs: Date.now() - t0,
                thinkingMode,
              },
            });
          } catch {
            /* */
          }
          return {
            text: state.reply,
            modelUsed: `chatgpt-mac-app/${model}${thinkingMode ? " (thinking)" : ""}`,
            threadDeleted: false,
          };
        }
      } else {
        stableTicks = 0;
      }
      lastReply = state.reply;
      await sleep(tickMs);
    }
    throw new Error(`askChatGPTMac: reply never stabilized (lastLen=${lastReply.length})`);
  } finally {
    if (deleteThread && threadOpened) {
      try {
        await closeThread();
      } catch (e) {
        process.stderr.write(`[chatgpt-mac] closeThread failed: ${e?.message ?? e}\n`);
      }
    }
    if (typeof savedPb === "string") {
      await pbcopy(savedPb).catch(() => {});
    }
  }
}

async function mainCli() {
  const args = process.argv.slice(2);
  let prompt = "",
    deleteThread = false,
    thinkingMode = false,
    pollMs,
    calibrate = false,
    json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--prompt" || a === "-p") {
      prompt = args[++i] ?? "";
    } else if (a === "--calibrate") {
      calibrate = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--delete-thread") {
      deleteThread = true;
    } else if (a === "--thinking") {
      thinkingMode = true;
    } else if (a === "--poll-ms") {
      pollMs = Number.parseInt(args[++i] ?? "", 10);
    } else if (!a.startsWith("--")) {
      prompt = args.slice(i).join(" ");
      break;
    }
  }
  if (calibrate) {
    const r = await calibrateChatGPTMac();
    process.stdout.write(
      json
        ? `${JSON.stringify(r, null, 2)}\n`
        : `${r.loadBearing ? "ready" : "coordinate-fallback"}\n`,
    );
    return;
  }
  if (!prompt) {
    console.error(
      "Usage: research-chatgpt-mac.mjs [--calibrate --json] [--delete-thread] [--thinking] [--poll-ms N] '<prompt>'",
    );
    process.exit(2);
  }
  const r = await askChatGPTMac({
    prompt,
    deleteThread,
    thinkingMode,
    ...(Number.isFinite(pollMs) ? { pollUntilStableMs: pollMs } : {}),
  });
  process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : `${r.text}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  withWorkstationReturn(() => wrapLifecycle("research-chatgpt-mac", mainCli)).catch((err) => {
    console.error(`[chatgpt-mac] ${err?.stack ?? err}`);
    process.exit(1);
  });
}
