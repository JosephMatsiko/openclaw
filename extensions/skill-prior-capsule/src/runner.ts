// runBuildPriorCapsule — subprocess wrapper around chuck-prior-capsule.mjs.
//
// The .mjs is the source of truth for a 1253-LOC source-reader + capsule
// renderer that walks 15+ chuck-v3 state files. Re-implementing it inline
// here would risk wire-format drift at every probe rewrite. v0.1 of this
// plugin wraps it as a subprocess so callers (skill-prior-compaction's
// approve action; skill-docket-executor's prior-refresh hook) get a
// type-safe in-process call site without giving up the battle-tested .mjs.
//
// Full TS source-port is queued for the openclaw cron / daemon-plugin phase,
// when the .mjs duplicates retire entirely.

import { spawn } from "node:child_process";
import type { PriorCapsuleConfig } from "./config.js";
import type {
  BuildOptions,
  BuildResult,
  PriorCapsuleReceipt,
  PriorCapsuleSummary,
  RunDeps,
  SubprocessResult,
  SubprocessRunner,
} from "./types.js";

export function defaultSubprocessRunner(): SubprocessRunner {
  return async ({ scriptPath, args, timeoutMs }) => {
    return new Promise<SubprocessResult>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [scriptPath, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          rejectPromise(new Error(`prior-capsule subprocess timed out after ${timeoutMs}ms`));
          return;
        }
        if (code !== 0) {
          rejectPromise(
            new Error(
              `prior-capsule subprocess exited ${code}: ${stderr.slice(-1000) || stdout.slice(-1000)}`,
            ),
          );
          return;
        }
        resolvePromise({ ok: true, stdout, stderr, exitCode: code });
      });
    });
  };
}

function buildArgs(options: BuildOptions, defaultLimit: number): string[] {
  const args: string[] = [];
  if (options.write) args.push("--write");
  if (options.markdown) args.push("--markdown");
  // Always request JSON so we can parse the result. With --write it's a
  // receipt; without --write it's the full capsule. Use --full-json when
  // both write + capsule body are wanted.
  args.push("--json");
  if (options.write && options.markdown) {
    // No special flag needed; receipt covers paths.
  }
  if (options.sourceTaskPath) args.push("--source-task", options.sourceTaskPath);
  const limit = options.limit ?? defaultLimit;
  if (limit !== defaultLimit) args.push("--limit", String(limit));
  return args;
}

function parseStdout(stdout: string): unknown {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("prior-capsule subprocess returned empty stdout");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `failed to parse prior-capsule stdout as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isReceipt(value: unknown): value is PriorCapsuleReceipt {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.priorId === "string" &&
    typeof v.sourceHash === "string" &&
    typeof v.createdAt === "string"
  );
}

function isCapsule(value: unknown): value is PriorCapsuleSummary & Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.schemaVersion === "chuck.prior-capsule.v1" && typeof v.priorId === "string";
}

export async function runBuildPriorCapsule(
  config: PriorCapsuleConfig,
  options: BuildOptions = {},
  deps: RunDeps = {},
): Promise<BuildResult> {
  const runner = deps.runSubprocess ?? defaultSubprocessRunner();
  const args = buildArgs(options, config.defaultLimit);
  const result = await runner({
    scriptPath: config.scriptPath,
    args,
    timeoutMs: config.buildTimeoutMs,
  });
  const parsed = parseStdout(result.stdout);
  if (options.write) {
    if (!isReceipt(parsed)) {
      throw new Error(
        "prior-capsule write subprocess did not return a receipt-shaped JSON (priorId/sourceHash/createdAt)",
      );
    }
    return { ok: true, receipt: parsed };
  }
  if (!isCapsule(parsed)) {
    throw new Error("prior-capsule subprocess returned non-capsule JSON without --write");
  }
  return {
    ok: true,
    receipt: {
      priorId: parsed.priorId,
      sourceHash: String(parsed.sourceHash ?? ""),
      createdAt: String(parsed.createdAt ?? ""),
      path: null,
      markdownPath: null,
      latestPath: null,
    },
    capsule: parsed,
  };
}
