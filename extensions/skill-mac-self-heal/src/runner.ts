// runStatus / runPlan / runApply — subprocess wrappers around chuck-mac-self-
// heal.mjs.
//
// The .mjs is the source of truth for 1272 LOC of reversible local-machine
// stewardship: cache enumeration, evidence preservation, cloud-offload
// candidate detection, allowlist gating, receipt writing. v0.1 of this plugin
// wraps it as a subprocess so callers (skill-health-steward, skill-docket-
// executor, skill-self-improvement-scanner) get a type-safe in-process call
// site without giving up the battle-tested .mjs.

import { spawn } from "node:child_process";
import type { MacSelfHealConfig } from "./config.js";
import type {
  ApplyOptions,
  PlanOptions,
  RunDeps,
  RunResult,
  SelfHealReceipt,
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
          rejectPromise(new Error(`mac-self-heal subprocess timed out after ${timeoutMs}ms`));
          return;
        }
        if (code !== 0) {
          rejectPromise(
            new Error(
              `mac-self-heal subprocess exited ${code}: ${stderr.slice(-1000) || stdout.slice(-1000)}`,
            ),
          );
          return;
        }
        resolvePromise({ ok: true, stdout, stderr, exitCode: code });
      });
    });
  };
}

function parseStdout(stdout: string): SelfHealReceipt {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("mac-self-heal subprocess returned empty stdout");
  try {
    return JSON.parse(text) as SelfHealReceipt;
  } catch (err) {
    throw new Error(
      `failed to parse mac-self-heal stdout as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runCommand(
  config: MacSelfHealConfig,
  command: "status" | "plan" | "apply",
  args: string[],
  timeoutMs: number,
  deps: RunDeps,
): Promise<RunResult> {
  const runner = deps.runSubprocess ?? defaultSubprocessRunner();
  const cliArgs = [command, ...args, "--json"];
  const result = await runner({
    scriptPath: config.scriptPath,
    args: cliArgs,
    timeoutMs,
  });
  const parsed = parseStdout(result.stdout);
  return { ok: true, command, result: parsed };
}

export async function runStatus(config: MacSelfHealConfig, deps: RunDeps = {}): Promise<RunResult> {
  return runCommand(config, "status", [], config.statusTimeoutMs, deps);
}

export async function runPlan(
  config: MacSelfHealConfig,
  options: PlanOptions = {},
  deps: RunDeps = {},
): Promise<RunResult> {
  const args: string[] = [];
  if (options.allowCloudOffload) args.push("--allow-cloud-offload");
  return runCommand(config, "plan", args, config.planTimeoutMs, deps);
}

export async function runApply(
  config: MacSelfHealConfig,
  options: ApplyOptions = {},
  deps: RunDeps = {},
): Promise<RunResult> {
  // --dry-run forces the .mjs to downgrade `apply` → `plan`; we still call
  // the apply command path for clarity but request the dry-run gate.
  const args: string[] = [];
  if (options.dryRun) args.push("--dry-run");
  const maxActions = options.maxActions ?? config.defaultMaxActions;
  if (maxActions !== config.defaultMaxActions || options.maxActions !== undefined) {
    args.push("--max-actions", String(maxActions));
  }
  if (options.cloudTarget) args.push("--cloud-target", options.cloudTarget);
  if (options.onlyUnderPressure) args.push("--only-under-pressure");
  if (options.allowCloudOffload) args.push("--allow-cloud-offload");
  return runCommand(config, "apply", args, config.applyTimeoutMs, deps);
}
