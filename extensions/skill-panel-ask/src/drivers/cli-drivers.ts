// Per-voice CLI drivers — TypeScript ports of the spawn contracts in
// extensions/memory-graph/scripts/apex-panel-ask.mjs.
//
// Each driver is a thin wrapper around runCli that supplies the right
// binary + args + stdin shape for one voice. Adding a new CLI voice means
// adding a new entry here; the dispatcher consults CLI_DRIVERS at runtime.
//
// The web voices (chatgpt-web, gemini-web, etc.) require AppleScript /
// CDP harnesses and live in @openclaw/plugin-web-voices v0.2; those land
// behind the same VoiceDriver contract so this file stays focused on the
// pure-spawn cases.

import { runCli, type RunCliResult } from "../cli-runner.js";

export interface VoiceDriverInput {
  prompt: string;
  /** Hard SIGKILL timeout. */
  timeoutMs: number;
  /** Per-driver overrides (model name, system prompt, etc.). */
  options?: Record<string, unknown>;
}

export type VoiceDriver = (input: VoiceDriverInput) => Promise<RunCliResult>;

// ─── claude-cli ─────────────────────────────────────────────────────────
//
// `claude -p --model opus` reads the prompt on stdin and prints the reply
// on stdout. Runs unmetered under Anthropic Max.
async function runClaudeCli(input: VoiceDriverInput): Promise<RunCliResult> {
  const model = typeof input.options?.model === "string" ? (input.options.model as string) : "opus";
  return runCli({
    bin: "claude",
    args: ["-p", "--model", model],
    stdin: input.prompt,
    timeoutMs: input.timeoutMs,
  });
}

// ─── codex (OpenAI) ─────────────────────────────────────────────────────
//
// `codex chat` reads stdin, prints reply on stdout. Wrapper at
// ~/.openclaw/bin/codex resolves Codex.app via macOS app-translocation
// glob — keeping our PATH-independent contract.
async function runCodexCli(input: VoiceDriverInput): Promise<RunCliResult> {
  const bin =
    typeof input.options?.bin === "string"
      ? (input.options.bin as string)
      : `${process.env.HOME}/.openclaw/bin/codex`;
  return runCli({
    bin,
    args: ["chat"],
    stdin: input.prompt,
    timeoutMs: input.timeoutMs,
  });
}

// ─── gemini-cli ─────────────────────────────────────────────────────────
//
// `gemini --prompt -` reads stdin. Quota-bound on the Pro tier; expect
// occasional 429s — the dispatcher catches those and surfaces ok=false.
async function runGeminiCli(input: VoiceDriverInput): Promise<RunCliResult> {
  return runCli({
    bin: "gemini",
    args: ["--prompt", "-"],
    stdin: input.prompt,
    timeoutMs: input.timeoutMs,
  });
}

// ─── ollama-local ───────────────────────────────────────────────────────
//
// `ollama run <model>` reads stdin, prints reply on stdout. CPU/GPU-bound
// on the local Mac; slowest of the panel but always available.
async function runOllamaLocal(input: VoiceDriverInput): Promise<RunCliResult> {
  const model =
    typeof input.options?.model === "string"
      ? (input.options.model as string)
      : (process.env.CHUCK_OLLAMA_MODEL ?? "qwen3:8b");
  return runCli({
    bin: "ollama",
    args: ["run", model],
    stdin: input.prompt,
    timeoutMs: input.timeoutMs,
  });
}

/**
 * Voice id → driver. The dispatcher uses this map to decide whether a
 * voice can be handled in TS (fast, parallel, no subprocess hop) vs needs
 * to fall through to apex-panel-ask.mjs.
 */
export const CLI_DRIVERS: Record<string, VoiceDriver> = {
  "claude-cli": runClaudeCli,
  codex: runCodexCli,
  "gemini-cli": runGeminiCli,
  "ollama-local": runOllamaLocal,
};

export function isCliVoice(voiceId: string): boolean {
  return Object.prototype.hasOwnProperty.call(CLI_DRIVERS, voiceId);
}

export function listCliVoices(): string[] {
  return Object.keys(CLI_DRIVERS);
}
