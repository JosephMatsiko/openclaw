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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLI_DRIVERS, isCliVoice, listCliVoices } from "./drivers/cli-drivers.js";
import { synthesizePanel } from "./synthesis.js";
import type { PanelAskInput, PanelAskOutput, VoiceResult } from "./types.js";
import { findVoice } from "./voices.js";

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

// ─── TS-native dispatch (CLI voices only, parallel, no subprocess hop) ────
//
// When every requested voice is in CLI_DRIVERS, dispatch in-process via
// Promise.all instead of subprocess-spawning apex-panel-ask.mjs. This kills
// the 20-25s cold-start tax — a CLI-only panel completes in the time of
// the slowest voice, not slowest-voice + plugin warmup overhead.
//
// Replies are written to disk in the same <Label>-<Voice>-<Date>.md shape
// the .mjs script produces, so downstream tooling (synthesis, fleet bus)
// keeps working without changes. Synthesis runs through ./synthesis.ts
// (already TS-native).

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function expandHomeAbs(p: string | undefined, fallback: string): string {
  if (!p) return fallback;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

function writeReplyArtifact(params: {
  voiceId: string;
  voiceLabel: string;
  labelStem: string;
  outputDir: string;
  text: string;
  ms: number;
}): string {
  const path = join(params.outputDir, `${params.labelStem}-${params.voiceLabel}-${todayYmd()}.md`);
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const body = [
    `# ${params.voiceLabel} — ${params.labelStem}`,
    ``,
    `Voice: ${params.voiceId}`,
    `Retrieved: ${new Date().toISOString()}`,
    `Latency: ${params.ms}ms`,
    `Source: skill-panel-ask/ts-cli-dispatch`,
    ``,
    `---`,
    ``,
    params.text,
  ].join("\n");
  writeFileSync(path, body, "utf8");
  return path;
}

/**
 * Try to dispatch entirely in TypeScript when every requested voice is a
 * CLI voice with a registered driver. Returns null when at least one voice
 * needs the legacy subprocess path (web-chrome / native-app) — caller
 * falls through to runPanelAskViaSubprocess.
 */
async function tryTsDispatch(input: PanelAskInput): Promise<PanelAskOutput | null> {
  const requested = input.voices ?? listCliVoices();
  if (requested.length === 0) return null;
  if (!requested.every(isCliVoice)) return null;

  const labelStem = input.label ?? "PANEL";
  const outputDir = expandHomeAbs(input.outputDir, join(HOME, "Documents"));
  const perVoiceTimeoutMs = input.timeoutMs ?? 300_000;

  if (input.dryRun) {
    return {
      ok: true,
      mode: input.mode ?? "raw",
      voices: requested.map((id) => ({
        id,
        label: findVoice(id)?.label ?? id,
        ok: true,
        path: null,
        chars: 0,
        ms: 0,
        error: null,
      })),
      plan: {
        voices: [...requested],
        mode: input.mode ?? "raw",
        label: labelStem,
      },
    };
  }

  const prompt = input.prompt ?? (input.file ? readFileSync(input.file, "utf8") : "");
  if (!prompt) {
    return {
      ok: false,
      mode: input.mode ?? "raw",
      voices: [],
      warnings: ["panel_ask: prompt or file required"],
    };
  }

  // Parallel dispatch — Promise.all, not Promise.allSettled, because each
  // driver itself never throws (returns ok:false on failure).
  const results = await Promise.all(
    requested.map(async (voiceId): Promise<VoiceResult & { _text?: string }> => {
      const driver = CLI_DRIVERS[voiceId];
      const voiceMeta = findVoice(voiceId);
      const label = voiceMeta?.label ?? voiceId;
      try {
        const r = await driver({ prompt, timeoutMs: perVoiceTimeoutMs });
        if (!r.ok) {
          return {
            id: voiceId,
            label,
            ok: false,
            path: null,
            chars: 0,
            ms: r.ms,
            error: r.error ?? "unknown",
          };
        }
        const path = writeReplyArtifact({
          voiceId,
          voiceLabel: label,
          labelStem,
          outputDir,
          text: r.text,
          ms: r.ms,
        });
        return {
          id: voiceId,
          label,
          ok: true,
          path,
          chars: r.text.length,
          ms: r.ms,
          error: null,
          _text: r.text,
        };
      } catch (err) {
        return {
          id: voiceId,
          label,
          ok: false,
          path: null,
          chars: 0,
          ms: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  // Strip the carried _text before exporting; only synthesis needs it.
  const voiceResults: VoiceResult[] = results.map(({ _text: _, ...rest }) => rest);
  const ok = voiceResults.some((v) => v.ok);

  let synthesis: PanelAskOutput["synthesis"];
  if (input.mode === "synthesize" && ok) {
    const synthInput = results
      .filter((r) => r.ok && r._text)
      .map((r) => ({ ...r, text: r._text!, label: r.label }));
    if (synthInput.length >= 2) {
      const s = await synthesizePanel({
        prompt,
        voices: synthInput,
        labelStem,
        outputDir,
        timeoutMs: perVoiceTimeoutMs,
      });
      synthesis = {
        ok: s.ok,
        path: s.path,
        chars: s.chars,
        ms: s.ms,
        voices: s.voices,
        synthesizer: s.synthesizer,
        error: s.error ?? null,
      };
    }
  }

  return {
    ok,
    mode: input.mode ?? "raw",
    voices: voiceResults,
    synthesis,
  };
}

/**
 * Run the panel and resolve a typed result.
 *
 * Fast path: when every requested voice is CLI-resident, dispatch in-process
 * via Promise.all (no subprocess hop, parallel, ~5s instead of ~20-25s
 * cold-start). Otherwise fall through to apex-panel-ask.mjs subprocess.
 *
 * Returns ok=false (rather than throwing) when the dispatch fails — callers
 * can still inspect partial voice results.
 */
export async function runPanelAsk(
  input: PanelAskInput,
  opts: DispatchOptions = {},
): Promise<PanelAskOutput> {
  // CLI fast path — only when scriptPath is empty (caller didn't pin to
  // legacy script) and every requested voice is a CLI voice.
  if (!opts.scriptPath) {
    const ts = await tryTsDispatch(input);
    if (ts) return ts;
  }
  return runPanelAskViaSubprocess(input, opts);
}

async function runPanelAskViaSubprocess(
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
