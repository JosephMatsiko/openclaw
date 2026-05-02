// chuck-mac-self-heal subprocess invocation — injectable for tests.
//
// The healthy plan/status/apply commands of chuck-mac-self-heal.mjs are wrapped
// here so the steward can be tested without spawning the real script. When
// tests want to assert the steward's reaction to specific plans, they pass a
// synthetic SelfHealRunner; production uses defaultSelfHealRunner().

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { HealthStewardConfig } from "./config.js";
import type {
  SelfHealPlan,
  SelfHealRunFailure,
  SelfHealRunResult,
  SelfHealRunner,
  SelfHealStatusResult,
} from "./types.js";

function runJsonScript<T>(script: string, args: string[], timeoutMs: number): SelfHealRunResult<T> {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: resolve(script, "..", "..", "..", ".."),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const failure: SelfHealRunFailure = {
      ok: false,
      exitCode: result.status,
      signal: result.signal,
      stdout: String(result.stdout ?? "").slice(-4000),
      stderr: String(result.stderr ?? "").slice(-4000),
    };
    return failure;
  }
  try {
    return { ok: true, parsed: JSON.parse(result.stdout) as T };
  } catch (error) {
    const failure: SelfHealRunFailure = {
      ok: false,
      exitCode: result.status,
      parseError: error instanceof Error ? error.message : String(error),
      stdout: String(result.stdout ?? "").slice(-4000),
    };
    return failure;
  }
}

export function defaultSelfHealRunner(config: HealthStewardConfig): SelfHealRunner {
  return {
    async plan({ allowCloudOffload }) {
      const args = ["plan", "--json"];
      if (allowCloudOffload) args.push("--allow-cloud-offload");
      return runJsonScript<SelfHealPlan>(
        config.macSelfHealScript,
        args,
        config.selfHealPlanTimeoutMs,
      );
    },
    async status() {
      return runJsonScript<SelfHealStatusResult>(
        config.macSelfHealScript,
        ["status", "--json"],
        config.selfHealPlanTimeoutMs,
      );
    },
    async apply({ onlyUnderPressure, allowCloudOffload, maxActions }) {
      const args = ["apply", "--json"];
      if (onlyUnderPressure) args.push("--only-under-pressure");
      if (allowCloudOffload) args.push("--allow-cloud-offload");
      if (typeof maxActions === "number" && maxActions > 0) {
        args.push("--max-actions", String(maxActions));
      }
      return runJsonScript<{ receiptId?: string }>(
        config.macSelfHealScript,
        args,
        config.selfHealApplyTimeoutMs,
      );
    },
  };
}

export function planResultOrFallback(result: SelfHealRunResult<SelfHealPlan>): SelfHealPlan {
  if (result.ok) return result.parsed;
  return { available: false, error: result };
}

export function statusResultOrFallback(
  result: SelfHealRunResult<SelfHealStatusResult>,
): SelfHealStatusResult {
  if (result.ok) return result.parsed;
  return { available: false, error: result };
}
