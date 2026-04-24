#!/usr/bin/env node
// Apex Panel Ask — dispatch one prompt across the full frontier panel and
// save each reply to ~/Documents/ with a timestamped filename.
//
// Purpose: this is the canonical "three-voice assessment" flow. Every time
// Joseph wants an external reaction to an artifact (audit, manifesto, long
// essay, architectural spec), the same four voices should see the same
// prompt through the same channels, and the replies should land in
// consistent filenames so downstream diffing and synthesis are trivial.
//
// Voices driven (in parallel):
//   - claude-cli  : Opus 4.7 via `claude -p --model opus` (Max subscription)
//   - chatgpt-web : GPT-5.5 (Instant/Thinking) via chatgpt.com web chat
//   - claude-ai   : Opus 4.7 Adaptive via claude.ai web chat
//   - gemini-cli  : Gemini 3.1 Pro via `gemini` CLI (AI Plus, optional)
//
// Usage:
//   apex-panel-ask.mjs --file <path>              Prompt-body from file
//   apex-panel-ask.mjs --file <path> --label APEX Custom filename stem
//   apex-panel-ask.mjs --prompt "..."             Inline prompt
//   apex-panel-ask.mjs --only chatgpt,claude-ai   Subset of voices
//   apex-panel-ask.mjs --suffix "Q1 Q2 Q3"        Append question stem
//
// Outputs land in ~/Documents/ as:
//   <Label>-<Voice>-<YYYY-MM-DD>.md
//
// Sovereignty-hardening rules respected: subscriptions-only, no PAYG, real
// Chrome only via apex-chrome-driver, no headless against authenticated
// services. The AppleScript backend against main Chrome is the default for
// web voices because main Chrome is the logged-in profile; Apex Chrome
// fallback is reached when the apex-chrome-cookie-refresh watcher has
// re-sideloaded a fresh session.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const DOCS = join(homedir(), "Documents");
const TODAY = new Date().toISOString().slice(0, 10);

const VOICES = {
  "claude-cli": {
    label: "Opus-47-CLI",
    modelName: "claude-opus-4-7",
    run: runClaudeCli,
  },
  "chatgpt-web": {
    label: "ChatGPT-Web",
    modelName: "chatgpt-plus/web-chat",
    run: runChatGPTChat,
  },
  "claude-ai": {
    label: "Opus-47-Adaptive-ClaudeAi",
    modelName: "claude-ai/web-chat (Opus 4.7 Adaptive)",
    run: runClaudeAiChat,
  },
  "gemini-cli": {
    label: "Gemini-31-Pro-CLI",
    modelName: "gemini-3.1-pro",
    run: runGeminiCli,
  },
};

function parseArgs(argv) {
  const a = argv.slice(2);
  const out = {
    file: null,
    prompt: null,
    label: null,
    suffix: null,
    only: null,
  };
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === "--file") {
      out.file = a[++i];
    } else if (t === "--prompt") {
      out.prompt = a[++i];
    } else if (t === "--label") {
      out.label = a[++i];
    } else if (t === "--suffix") {
      out.suffix = a[++i];
    } else if (t === "--only") {
      out.only = a[++i];
    }
  }
  return out;
}

function buildPrompt(opts) {
  const body = opts.prompt ?? (opts.file ? readFileSync(opts.file, "utf8") : "");
  if (!body.trim()) {
    throw new Error("prompt empty — pass --file or --prompt");
  }
  const suffix =
    opts.suffix ??
    [
      "",
      "---",
      "",
      `That is the full artifact. Give me your sharpest assessment:`,
      "",
      "1. What's genuinely dominant / best-in-class?",
      "2. What's fragile and likely to break first?",
      "3. What's missing (and frontier competitors would ship)?",
      "4. What should I prioritize next?",
      "",
      "Be specific. Don't flatter.",
    ].join("\n");
  return body + "\n" + suffix;
}

async function runClaudeCli(prompt) {
  return runCli("claude", ["-p", "--model", "opus"], prompt);
}

async function runGeminiCli(prompt) {
  return runCli("gemini", ["-p"], prompt);
}

async function runCli(bin, args, prompt) {
  return new Promise((resolve, reject) => {
    const ps = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    ps.stdout.on("data", (d) => (stdout += d.toString()));
    ps.stderr.on("data", (d) => (stderr += d.toString()));
    ps.on("error", reject);
    ps.on("close", (code) => {
      if (code === 0) {
        resolve({ text: stdout.trim() });
      } else {
        reject(new Error(`${bin} exit ${code}: ${stderr.trim()}`));
      }
    });
    ps.stdin.write(prompt);
    ps.stdin.end();
  });
}

async function runChatGPTChat(prompt) {
  const mod = await import("./research-chatgpt-chat.mjs");
  const r = await mod.askChatGPTChat({ prompt });
  return r;
}

async function runClaudeAiChat(prompt) {
  const mod = await import("./research-claude-ai-chat.mjs");
  const r = await mod.askClaudeAiChat({ prompt });
  return r;
}

function filenameFor(labelStem, voiceLabel) {
  return join(DOCS, `${labelStem}-${voiceLabel}-${TODAY}.md`);
}

function pickLabelStem(opts) {
  if (opts.label) {
    return opts.label;
  }
  if (opts.file) {
    return basename(opts.file).replace(/\.[^.]+$/, "");
  }
  return "Apex-Panel";
}

async function main() {
  const opts = parseArgs(process.argv);
  const prompt = buildPrompt(opts);
  const labelStem = pickLabelStem(opts);
  const wantedVoices = opts.only ? opts.only.split(",").map((s) => s.trim()) : Object.keys(VOICES);
  const tasks = wantedVoices.map(async (id) => {
    const voice = VOICES[id];
    if (!voice) {
      return { id, skipped: true, error: "unknown voice" };
    }
    const t0 = Date.now();
    try {
      const r = await voice.run(prompt);
      const text = r.text ?? "";
      const path = filenameFor(labelStem, voice.label);
      const body = [
        `# ${voice.label} — ${labelStem}`,
        ``,
        `Model: ${r.modelUsed ?? voice.modelName}`,
        `Retrieved: ${new Date().toISOString()}`,
        `Prompt size: ${prompt.length} chars`,
        ``,
        `---`,
        ``,
        text,
      ].join("\n");
      writeFileSync(path, body, "utf8");
      return { id, ok: true, path, chars: text.length, ms: Date.now() - t0 };
    } catch (err) {
      return { id, ok: false, error: String(err?.message ?? err), ms: Date.now() - t0 };
    }
  });
  const results = await Promise.all(tasks);
  console.log(JSON.stringify({ labelStem, results }, null, 2));
  const failed = results.filter((r) => !r.ok && !r.skipped);
  if (failed.length === results.length) {
    process.exitCode = 1;
  } else if (failed.length > 0) {
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[apex-panel-ask] fatal: ${e.stack ?? e}`);
    process.exitCode = 1;
  });
}
