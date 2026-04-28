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
// Voices driven (in parallel) — 10-voice panel as of 2026-04-28:
//   Anthropic family
//     - claude-cli      : Opus 4.7 via `claude -p --model opus` (Max sub)
//     - claude-ai       : Opus 4.7 Adaptive via claude.ai web chat
//   OpenAI family
//     - chatgpt-web     : GPT-5.5 via chatgpt.com web chat
//     - chatgpt-mac     : GPT-5.5 via ChatGPT.app native macOS app
//     - codex           : codex/gpt-5.5 via Codex CLI (repo-grounded)
//   Google family
//     - gemini-cli      : Gemini 3.1 Pro via `gemini` CLI (AI Pro)
//     - gemini-web      : Gemini 3.1 Pro via gemini.google.com web chat
//     - aistudio-web    : Gemini Pro variants via aistudio.google.com
//   xAI family
//     - grok-web        : Grok via grok.com web chat
//   Perplexity family
//     - perplexity-web  : Perplexity Pro via perplexity.ai web chat
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
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";

import { withWorkstationReturn } from "./chuck-surface-control.mjs";

// -- Session bus integration (apex-fleet-bridge SQLite WAL) -------------
// Mirror the bus emit pattern from apex-fleet-bridge so panel runs land in
// the same hash-chained store as direct ask_X invocations. This makes web
// surfaces (chatgpt-web, claude-ai, gemini-cli) first-class panel members
// even though they can't host MCPs themselves — the wrapper emits on their
// behalf.

let busDb = null;
async function ensureBus() {
  if (busDb) {
    return busDb;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const BUS_PATH = join(homedir(), ".openclaw/workspace/state/chuck-v2/fleet-bus.db");
  mkdirSync(dirname(BUS_PATH), { recursive: true });
  busDb = new DatabaseSync(BUS_PATH);
  busDb.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      voice_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('prompt', 'reply')),
      content TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      prev_receipt_hash TEXT,
      receipt_hash TEXT NOT NULL,
      mode TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER
    );
    PRAGMA journal_mode=WAL;
  `);
  return busDb;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

async function busEmit({ session_id, voice_id, role, content, mode = null }) {
  const db = await ensureBus();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ts = new Date().toISOString();
  const content_sha256 = sha256(content);
  const prev = db.prepare("SELECT receipt_hash FROM turns ORDER BY ts DESC LIMIT 1").get();
  const prev_hash = prev?.receipt_hash ?? null;
  const receipt_hash = sha256([prev_hash ?? "", ts, voice_id, role, content_sha256].join("\n"));
  db.prepare(
    `INSERT INTO turns (id, session_id, ts, voice_id, role, content, content_sha256, prev_receipt_hash, receipt_hash, mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, session_id, ts, voice_id, role, content, content_sha256, prev_hash, receipt_hash, mode);
  return { id, ts, voice_id, role, receipt_hash };
}

function activeSessionId() {
  return process.env.APEX_SESSION_ID ?? `panel-${new Date().toISOString().slice(0, 10)}`;
}

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
  // Codex CLI (OpenAI's code-tuned model family). Added 2026-04-23
  // when Joseph flagged it was missing from the panel. Uses the
  // ~/.openclaw/bin/codex wrapper which locates Codex.app via the
  // macOS AppTranslocation filesystem glob — no PATH dependency.
  // Value-add over chatgpt-web: Codex actually reads the local repo
  // via `rg` / file-exec tools during review, grounds its advice in
  // real code at file:line precision.
  codex: {
    label: "Codex-CLI",
    modelName: "codex/gpt-5.5",
    run: runCodexCli,
  },
  // ChatGPT.app native Mac client. Added 2026-04-28 as part of the
  // web-wrapper bridging that doubled panel coverage from 5→10. The
  // native app is the only path that can attach files / accept image
  // uploads at the OpenAI surface; web tab is text-only via osascript.
  "chatgpt-mac": {
    label: "ChatGPT-Mac",
    modelName: "chatgpt-mac-app/gpt-5.5",
    run: runChatGPTMac,
  },
  // Gemini 3.1 Pro via the gemini.google.com web chat. Distinct from
  // gemini-cli (CLI / quota-bound) — web chat runs unmetered inside
  // the AI Pro subscription. Independent prior from aistudio-web; both
  // are Google but different surfaces with different model variants.
  "gemini-web": {
    label: "Gemini-Web",
    modelName: "gemini.google.com/3.1-pro",
    run: runGeminiWebChat,
  },
  // Google AI Studio (aistudio.google.com). Same Gemini model family
  // but ships variants and reasoning-mode toggles ahead of the public
  // gemini.google.com surface — useful as a separate witness within
  // the Google family.
  "aistudio-web": {
    label: "AIStudio-Web",
    modelName: "aistudio.google.com/gemini-pro",
    run: runAiStudioChat,
  },
  // Grok via grok.com. xAI family — its own prior. Driver lives in
  // research-grok-chat.mjs; CDP-on-main-Chrome path. (Note: prior
  // CDP driver had session-loss issues on Apex Chrome; main Chrome
  // is the working path until rebuild.)
  "grok-web": {
    label: "Grok-Web",
    modelName: "grok.com/grok",
    run: runGrokChat,
  },
  // Perplexity Pro via perplexity.ai web. Distinct from perplexity-mac
  // (native app; therivendellcenter seat). Best-in-class at grounded
  // citations + recency for current-events questions.
  "perplexity-web": {
    label: "Perplexity-Web",
    modelName: "perplexity.ai/pro",
    run: runPerplexityChat,
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
  // Gemini CLI changed -p contract: now requires the prompt as its argument
  // (previously read from stdin). Pass the prompt inline; runCli still
  // forwards stdin but Gemini concatenates -p value + stdin so the duplication
  // is harmless.
  return runCli("gemini", ["-p", prompt], prompt);
}

async function runCodexCli(prompt) {
  // Stable wrapper at ~/.openclaw/bin/codex handles the ephemeral
  // AppTranslocation path. Codex's `exec` subcommand is the
  // non-interactive equivalent of `claude -p` / `gemini -p`.
  // Parse the raw stdout to extract the assistant's final answer from
  // Codex's verbose session trace (session metadata header + multiple
  // codex/exec turns + final answer + `tokens used` footer).
  const homeDir = process.env.HOME ?? "";
  const bin = `${homeDir}/.openclaw/bin/codex`;
  const r = await runCli(bin, ["exec"], prompt);
  // Extract the final `codex` block — the agent's last message before
  // `tokens used`. Codex emits multiple codex-turns if it runs exec
  // steps; only the last is the final answer.
  const blocks = [...r.text.matchAll(/\ncodex\n([\s\S]*?)(?=\n(?:exec|tokens used|user)\n|$)/g)];
  const finalText = blocks.length > 0 ? (blocks[blocks.length - 1][1] ?? "").trim() : r.text.trim();
  return { text: finalText };
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

async function runChatGPTMac(prompt) {
  const mod = await import("./research-chatgpt-mac.mjs");
  const r = await mod.askChatGPTMac({ prompt });
  return r;
}

async function runGeminiWebChat(prompt) {
  const mod = await import("./research-gemini-chat.mjs");
  const r = await mod.askGeminiChat({ prompt });
  return r;
}

async function runAiStudioChat(prompt) {
  const mod = await import("./research-aistudio-chat.mjs");
  const r = await mod.askAiStudioChat({ prompt });
  return r;
}

async function runGrokChat(prompt) {
  const mod = await import("./research-grok-chat.mjs");
  const r = await mod.askGrokChat({ prompt });
  return r;
}

async function runPerplexityChat(prompt) {
  const mod = await import("./research-perplexity-chat.mjs");
  const r = await mod.askPerplexityChat({ prompt });
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
  const session_id = activeSessionId();
  const wantedVoices = opts.only ? opts.only.split(",").map((s) => s.trim()) : Object.keys(VOICES);

  // Emit the panel prompt to the fleet bus (operator turn)
  try {
    await busEmit({ session_id, voice_id: "operator", role: "prompt", content: prompt, mode: "panel" });
  } catch (err) {
    process.stderr.write(`[panel-ask] bus emit (prompt) failed: ${err?.message ?? err}\n`);
  }

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
      // Emit reply to bus on this voice's behalf — even web/PWA voices
      // become first-class participants in the fleet bus this way.
      try {
        await busEmit({ session_id, voice_id: id, role: "reply", content: text, mode: "panel" });
      } catch (busErr) {
        process.stderr.write(`[panel-ask] bus emit (${id} reply) failed: ${busErr?.message ?? busErr}\n`);
      }
      return { id, ok: true, path, chars: text.length, ms: Date.now() - t0 };
    } catch (err) {
      const errMsg = String(err?.message ?? err);
      // Emit failure as a bus event too — degraded turns are forensics-relevant
      try {
        await busEmit({ session_id, voice_id: id, role: "reply", content: `[error] ${errMsg}`, mode: "panel-error" });
      } catch { /* ignore */ }
      return { id, ok: false, error: errMsg, ms: Date.now() - t0 };
    }
  });
  const results = await Promise.all(tasks);
  console.log(JSON.stringify({ labelStem, session_id, results }, null, 2));
  const failed = results.filter((r) => !r.ok && !r.skipped);
  if (failed.length === results.length) {
    process.exitCode = 1;
  } else if (failed.length > 0) {
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Wrap in withWorkstationReturn so the user's workspace (frontmost app
  // + Chrome tab) is auto-restored after the panel finishes. Disable with
  // CHUCK_RETURN_WORKSTATION=0 if you're already inside a wrapping flow.
  withWorkstationReturn(main).catch((e) => {
    console.error(`[apex-panel-ask] fatal: ${e.stack ?? e}`);
    process.exitCode = 1;
  });
}
