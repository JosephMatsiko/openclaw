// Dispatch layer for skill-panel-ask.
//
// The first iteration of this plugin wraps the existing battle-tested
// `apex-panel-ask.mjs` script (in extensions/memory-graph/scripts/) as a
// subprocess. That keeps the per-voice driver code where it already lives
// (with proven AppleScript / CDP / CLI handlers per voice) while exposing
// a typed in-process API + agent tool here.
//
// Stage 3 follow-on work (separate change) lifts the dispatch loop +
// per-voice drivers into TypeScript and kills the subprocess hop. Until
// then this thin wrapper gives the Cabinet a programmatic seam without
// blocking on the larger refactor.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PanelAskInput, PanelAskOutput, VoiceResult } from "./types.js";

const HOME = homedir();
const DEFAULT_SCRIPT_PATH = join(
  HOME,
  "Projects",
  "openclaw",
  "extensions",
  "memory-graph",
  "scripts",
  "apex-panel-ask.mjs",
);

export interface DispatchOptions {
  /** Override path to the apex-panel-ask.mjs dispatch script. */
  scriptPath?: string;
  /**
   * Total dispatch budget. The wrapper subprocess is killed if it exceeds
   * this. Default = perVoiceTimeoutMs × 2 to allow synthesis + writes.
   */
  totalTimeoutMs?: number;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

function resolveScriptPath(override?: string): string {
  const candidate = override?.trim() ? expandHome(override) : DEFAULT_SCRIPT_PATH;
  if (!existsSync(candidate)) {
    throw new Error(`apex-panel-ask.mjs not found at ${candidate}`);
  }
  if (!statSync(candidate).isFile()) {
    throw new Error(`apex-panel-ask.mjs is not a regular file: ${candidate}`);
  }
  return resolve(candidate);
}

function buildArgs(input: PanelAskInput): string[] {
  const args: string[] = [];
  if (input.prompt) {
    args.push("--prompt", input.prompt);
  } else if (input.file) {
    args.push("--file", expandHome(input.file));
  } else {
    throw new Error("panel_ask requires either `prompt` or `file`");
  }
  if (input.voices && input.voices.length > 0) {
    args.push("--only", input.voices.join(","));
  }
  if (input.mode === "synthesize") {
    args.push("--mode", "synthesize");
  }
  if (input.label) {
    args.push("--label", input.label);
  }
  if (typeof input.suffix === "string") {
    // Empty string disables the dispatcher's default 4-question suffix.
    // JS `??` only falls through on null/undefined, so an empty string
    // passes through correctly.
    args.push("--suffix", input.suffix);
  }
  if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
    args.push("--per-voice-timeout-ms", String(input.timeoutMs));
  }
  if (input.outputDir) {
    args.push("--output-dir", expandHome(input.outputDir));
  }
  if (input.dryRun) {
    args.push("--dry-run");
  }
  // Always request JSON output so we can structure-parse the reply.
  args.push("--json");
  return args;
}

interface RawDispatchPayload {
  ok?: boolean;
  voices?: Array<{
    id?: string;
    label?: string;
    ok?: boolean;
    path?: string | null;
    chars?: number;
    ms?: number;
    error?: string | null;
  }>;
  synthesis?: {
    ok?: boolean;
    path?: string | null;
    chars?: number;
    ms?: number;
    voices?: string[];
    synthesizer?: string;
    error?: string | null;
  };
  receiptHash?: string;
  receipt_hash?: string;
  warnings?: string[];
  plan?: {
    voices?: string[];
    mode?: "raw" | "synthesize";
    label?: string;
  };
}

function parsePayload(stdout: string): RawDispatchPayload | null {
  // The dispatch script may print log lines + a final JSON object. Find the
  // last "\n{" boundary and parse from there.
  const trimmed = stdout.trimEnd();
  const lastBrace = trimmed.lastIndexOf("\n{");
  const candidate = lastBrace >= 0 ? trimmed.slice(lastBrace).trim() : trimmed;
  try {
    return JSON.parse(candidate) as RawDispatchPayload;
  } catch {
    return null;
  }
}

/**
 * Run the panel and resolve a typed result.
 *
 * Subprocess-spawns apex-panel-ask.mjs with the requested voices + mode,
 * captures stdout, parses the final JSON object, and shapes the response.
 * Returns ok=false (rather than throwing) when the dispatch fails — callers
 * can still inspect partial voice results.
 */
export async function runPanelAsk(
  input: PanelAskInput,
  opts: DispatchOptions = {},
): Promise<PanelAskOutput> {
  const scriptPath = resolveScriptPath(opts.scriptPath);
  const args = [scriptPath, ...buildArgs(input)];
  const perVoiceTimeoutMs = input.timeoutMs ?? 300_000;
  const totalTimeoutMs = opts.totalTimeoutMs ?? perVoiceTimeoutMs * 2 + 60_000;

  const result = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolveSpawn) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, totalTimeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolveSpawn({ code, stdout, stderr, timedOut });
    });
  });

  const warnings: string[] = [];
  if (result.timedOut) {
    warnings.push(`dispatch wrapper exceeded ${totalTimeoutMs}ms total budget`);
  }
  if (result.stderr.trim().length > 0) {
    warnings.push(result.stderr.slice(-2000).trim());
  }

  if (result.code !== 0 && !result.timedOut) {
    return {
      ok: false,
      mode: input.mode ?? "raw",
      voices: [],
      warnings: warnings.length > 0 ? warnings : [`dispatch exited ${result.code}`],
    };
  }

  const payload = parsePayload(result.stdout);
  if (!payload) {
    return {
      ok: false,
      mode: input.mode ?? "raw",
      voices: [],
      warnings: [
        ...warnings,
        `dispatch produced no parseable JSON; tail: ${result.stdout.slice(-500)}`,
      ],
    };
  }

  const voices: VoiceResult[] = (payload.voices ?? []).map((v) => ({
    id: v.id ?? "",
    label: v.label ?? "",
    ok: v.ok === true,
    path: v.path ?? null,
    chars: typeof v.chars === "number" ? v.chars : 0,
    ms: typeof v.ms === "number" ? v.ms : 0,
    error: v.error ?? null,
  }));

  const synthesis = payload.synthesis
    ? {
        ok: payload.synthesis.ok === true,
        path: payload.synthesis.path ?? null,
        chars: typeof payload.synthesis.chars === "number" ? payload.synthesis.chars : 0,
        ms: typeof payload.synthesis.ms === "number" ? payload.synthesis.ms : 0,
        voices: payload.synthesis.voices ?? [],
        synthesizer: payload.synthesis.synthesizer,
        error: payload.synthesis.error ?? null,
      }
    : undefined;

  const ok = payload.ok === true && voices.some((v) => v.ok);

  return {
    ok,
    mode: input.mode ?? "raw",
    voices,
    synthesis,
    receiptHash: payload.receiptHash ?? payload.receipt_hash,
    warnings: warnings.length > 0 ? warnings : undefined,
    plan: input.dryRun
      ? {
          voices: payload.plan?.voices ?? voices.map((v) => v.id),
          mode: payload.plan?.mode ?? input.mode ?? "raw",
          label: payload.plan?.label ?? input.label ?? "",
        }
      : undefined,
  };
}
