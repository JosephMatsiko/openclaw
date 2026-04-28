#!/usr/bin/env node
// apex-ring: 3
// Research worker — ChatGPT Mac app (com.openai.chat).
//
// Mac-app replacement for web-driven research-chatgpt-chat.mjs for the
// `chatgpt-web` panel voice. Same GPT-5.5 model, native surface, no
// Cloudflare/Turnstile/CDP fragility. Mirrors research-claude-mac.mjs.
//
// IMPORTANT: COORDS below are INITIAL ESTIMATES — first live invocation
// will likely require nudging. Keyboard shortcuts (Cmd+N, Cmd+V, Return)
// are macOS-standard and should hold; coordinate clicks are the fragile axis.

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

const COORDS = {
  sidebarToggle: [70, 65],
  composerCenter: [670, 750],
  newChatButton: [385, 65],
  modelPill: [200, 100],
  thinkingToggle: [330, 770],
  replyCrop: [130, 140, 940, 570],
};

const PROMPT_PREFIX = "[panel-ask]\n\n";

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

async function screenshot(path, { timeoutMs = 10_000 } = {}) {
  await execFileP("/usr/sbin/screencapture", ["-x", path], {
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
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

async function standardizeWindow() {
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
  await clickAt(COORDS.newChatButton);
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
    await clickAt(COORDS.thinkingToggle);
    await sleep(250);
  } catch (e) {
    process.stderr.write(`[chatgpt-mac] toggleThinkingMode warning: ${e?.message ?? e}\n`);
  }
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
    await standardizeWindow();
    await reloadHome();
    await standardizeWindow();
    await newConversation();
    threadOpened = true;
    await standardizeWindow();
    if (thinkingMode) {
      await toggleThinkingMode();
    }
    await clickAt(COORDS.composerCenter);
    const fullPrompt =
      PROMPT_PREFIX +
      (thinkingMode ? "Please use thinking/reasoning mode for the best quality answer.\n\n" : "") +
      String(prompt);
    await pbcopy(fullPrompt);
    await sleep(150);
    await osa('tell application "System Events" to keystroke "v" using command down');
    await sleep(450);
    await cliclick("kp:return");
    await sleep(initialWaitMs);

    const t0 = Date.now();
    let lastReply = "";
    let stableTicks = 0;
    const tmp = tmpdir();
    while (Date.now() - t0 < pollUntilStableMs) {
      const shot = join(tmp, `chatgpt-mac-${Date.now()}.png`);
      let state;
      try {
        await screenshot(shot);
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
      if (
        !state.streaming &&
        state.reply &&
        state.reply === lastReply &&
        state.reply.length >= 60
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
    pollMs;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--prompt" || a === "-p") {
      prompt = args[++i] ?? "";
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
  if (!prompt) {
    console.error(
      "Usage: research-chatgpt-mac.mjs [--delete-thread] [--thinking] [--poll-ms N] '<prompt>'",
    );
    process.exit(2);
  }
  const r = await askChatGPTMac({
    prompt,
    deleteThread,
    thinkingMode,
    ...(Number.isFinite(pollMs) ? { pollUntilStableMs: pollMs } : {}),
  });
  process.stdout.write(r.text + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  withWorkstationReturn(() => wrapLifecycle("research-chatgpt-mac", mainCli)).catch((err) => {
    console.error(`[chatgpt-mac] ${err?.stack ?? err}`);
    process.exit(1);
  });
}
