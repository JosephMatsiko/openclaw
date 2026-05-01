// Synthesis layer for skill-panel-ask.
//
// Folds a panel of voice replies into ONE coherent answer with cross-family
// discipline. The synthesizer voice MUST NOT share family with the dominant
// contributor — this is the panel-synthesis hard rule from 2026-05-01, and
// it is enforced in code, not as a configuration guideline.
//
// Synthesizer pool: subscription-only CLI voices we can spawn directly
// without the AppleScript / CDP harness (claude-cli, gemini-cli, codex).
// Falls back to ollama-local when the cross-family-eligible CLI voice fails.
//
// Stage 3 follow-on may broaden the synthesizer pool to web-chrome voices
// once those drivers land in TS.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SynthesisResult, VoiceResult } from "./types.js";
import { findVoice, selectSynthesizer } from "./voices.js";

const HOME = homedir();
const DEFAULT_SYNTHESIZER_POOL = ["claude-cli", "gemini-cli", "codex", "ollama-local"];

export interface SynthesizeOptions {
  /** Original panel prompt (so the synthesizer has context). */
  prompt: string;
  /**
   * Voice results to fold in. Each result must include `text` — the
   * subprocess wrapper already passes the file path, so callers should
   * read the file content into `text` before invoking. We keep the field
   * optional so callers can pre-filter to successful voices only.
   */
  voices: Array<VoiceResult & { text?: string; label?: string }>;
  /**
   * Filename stem for the synthesis artifact. Defaults to PANEL.
   */
  labelStem?: string;
  /**
   * Output directory. Defaults to ~/Documents.
   */
  outputDir?: string;
  /**
   * Override the synthesizer pool. The first eligible voice (whose family
   * differs from the contributors' dominant family) wins.
   */
  synthesizerPool?: ReadonlyArray<string>;
  /**
   * Hard timeout for the synthesizer subprocess.
   */
  timeoutMs?: number;
}

export interface SynthesisDispatchResult extends SynthesisResult {
  /** True when synthesis was skipped due to <2 successful voices. */
  skipped?: boolean;
  reason?: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildSynthesisPrompt(
  prompt: string,
  voices: Array<VoiceResult & { text?: string; label?: string }>,
): string {
  return [
    "You are synthesizing a multi-model panel assessment.",
    "",
    "Below is the original prompt, then verbatim replies from different frontier AI models. Your job is to produce ONE coherent answer that preserves attribution — when the panel converges, say so; when it diverges, surface the divergence and flag whose call you trust and why.",
    "",
    "Format:",
    "1. Headline take (1-3 sentences).",
    "2. What the panel agrees on, with which voices agreed.",
    "3. Where they diverge, with each voice's distinct claim attributed.",
    "4. Your recommendation — pick a side or steelman both, but commit.",
    "",
    'Don\'t flatter; don\'t repeat boilerplate; cite voices by their label (e.g., "Gemini-Web said", "Codex-CLI argued").',
    "",
    "<original_prompt>",
    prompt,
    "</original_prompt>",
    "",
    "<panel_replies>",
    ...voices.map((r) =>
      [
        `<voice id="${r.id}" label="${r.label ?? r.id}" chars="${r.chars}">`,
        r.text ?? "",
        "</voice>",
      ].join("\n"),
    ),
    "</panel_replies>",
  ].join("\n");
}

interface SpawnResult {
  ok: boolean;
  text: string;
  error?: string;
}

async function runClaudeCli(prompt: string, timeoutMs: number): Promise<SpawnResult> {
  return runCli("claude", ["-p", "--model", "opus"], prompt, timeoutMs);
}

async function runGeminiCli(prompt: string, timeoutMs: number): Promise<SpawnResult> {
  // gemini CLI reads from stdin when invoked without `chat`. The actual
  // contract may evolve; if the CLI rejects this shape, the spawn returns
  // ok=false and the caller can fall back to ollama-local.
  return runCli("gemini", ["--prompt", "-"], prompt, timeoutMs);
}

async function runCodexCli(prompt: string, timeoutMs: number): Promise<SpawnResult> {
  return runCli("codex", ["chat"], prompt, timeoutMs);
}

async function runOllamaLocal(prompt: string, timeoutMs: number): Promise<SpawnResult> {
  const model = process.env.CHUCK_OLLAMA_MODEL ?? "qwen3:8b";
  return runCli("ollama", ["run", model], prompt, timeoutMs);
}

async function runCli(
  bin: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return await new Promise((resolveSpawn) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolveSpawn({
        ok: false,
        text: stdout,
        error: `${bin} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolveSpawn({
        ok: false,
        text: stdout,
        error: `${bin} spawn error: ${err.message}`,
      });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolveSpawn({
          ok: false,
          text: stdout,
          error: `${bin} exit ${code}: ${stderr.slice(-300).trim()}`,
        });
        return;
      }
      resolveSpawn({ ok: true, text: stdout.trim() });
    });
    if (proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

const SYNTHESIZER_RUNNERS: Record<string, (prompt: string, ms: number) => Promise<SpawnResult>> = {
  "claude-cli": runClaudeCli,
  "gemini-cli": runGeminiCli,
  codex: runCodexCli,
  "ollama-local": runOllamaLocal,
};

/**
 * Synthesize a panel of voice replies into ONE consolidated answer.
 *
 * Picks a synthesizer voice whose family does NOT match the dominant
 * contributor's family. Returns ok=false (rather than throwing) on subprocess
 * failure so the caller can still surface the panel's raw replies to the user.
 */
export async function synthesizePanel(opts: SynthesizeOptions): Promise<SynthesisDispatchResult> {
  const t0 = Date.now();
  const successes = opts.voices.filter((v) => v.ok && (v.text ?? "").trim().length > 0);
  if (successes.length < 2) {
    return {
      ok: false,
      skipped: true,
      reason: `only ${successes.length} voice(s) had text; synthesis needs >=2`,
      voices: successes.map((v) => v.id),
      ms: Date.now() - t0,
      path: null,
      chars: 0,
    };
  }

  const pool = opts.synthesizerPool ?? DEFAULT_SYNTHESIZER_POOL;
  const synthesizerId = selectSynthesizer(
    successes.map((v) => v.id),
    pool,
  );

  if (!synthesizerId) {
    return {
      ok: false,
      reason: "no cross-family-eligible synthesizer in pool",
      voices: successes.map((v) => v.id),
      ms: Date.now() - t0,
      path: null,
      chars: 0,
    };
  }

  const runner = SYNTHESIZER_RUNNERS[synthesizerId];
  if (!runner) {
    return {
      ok: false,
      reason: `no runner registered for synthesizer voice ${synthesizerId}`,
      synthesizer: synthesizerId,
      voices: successes.map((v) => v.id),
      ms: Date.now() - t0,
      path: null,
      chars: 0,
    };
  }

  const synthPrompt = buildSynthesisPrompt(opts.prompt, successes);
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const result = await runner(synthPrompt, timeoutMs);
  const ms = Date.now() - t0;

  if (!result.ok) {
    return {
      ok: false,
      synthesizer: synthesizerId,
      voices: successes.map((v) => v.id),
      ms,
      path: null,
      chars: 0,
      error: result.error ?? "synthesizer subprocess failed",
    };
  }

  const labelStem = opts.labelStem ?? "PANEL";
  const outputDir = opts.outputDir ? expandHome(opts.outputDir) : join(HOME, "Documents");
  const path = join(outputDir, `${labelStem}-SYNTHESIS-${todayYmd()}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const synthesizerVoice = findVoice(synthesizerId);
  const body = [
    `# SYNTHESIS — ${labelStem}`,
    ``,
    `Synthesizer: ${synthesizerVoice?.label ?? synthesizerId} (${synthesizerVoice?.family ?? "unknown"})`,
    `Voices folded in: ${successes.map((s) => s.label ?? s.id).join(", ")}`,
    `Cross-family discipline: synthesizer family (${synthesizerVoice?.family ?? "?"}) ≠ dominant contributor family`,
    `Retrieved: ${new Date().toISOString()}`,
    `Latency: ${ms}ms`,
    ``,
    `---`,
    ``,
    result.text,
  ].join("\n");
  writeFileSync(path, body, "utf8");

  return {
    ok: true,
    synthesizer: synthesizerId,
    voices: successes.map((v) => v.id),
    ms,
    path,
    chars: result.text.length,
  };
}
