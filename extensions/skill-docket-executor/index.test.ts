// Smoke tests for @openclaw/skill-docket-executor.
//
// Exercises the typed surface (commands, lanes, mac-gate, eligibility,
// timeout policy, executor control) without spawning real subprocesses.
// The long-running daemon lives in chuck-docket-executor.mjs and is verified
// in production via the LaunchAgent's own ledger; v0.2 will add daemon tests
// when the daemon is folded into the plugin.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  COMMANDS,
  commandHasRequiredFields,
  commandLane,
  listCommandKinds,
} from "./src/commands.js";
import { resolveConfig } from "./src/config.js";
import { executorIntakePaused, readExecutorControl } from "./src/control.js";
import { checkEligibility, eligibilityBlockers } from "./src/eligibility.js";
import { buildExecutorEnv } from "./src/env.js";
import {
  EXECUTOR_LANE_POLICY,
  LANE_TIMEOUT_POLICY,
  laneRunPolicy,
  laneTimeoutPolicy,
} from "./src/lanes.js";
import { clearMacGateCache, macHealthGateBlockers, macHealthGateStatus } from "./src/mac-gate.js";
import { timeoutPolicyForTask } from "./src/timeout.js";
import type { Task } from "./src/types.js";

describe("config resolver", () => {
  test("applies defaults", () => {
    const r = resolveConfig({});
    expect(r.enabled).toBe(true);
    expect(r.globalRunningCap).toBe(6);
    expect(r.diskWarnFreePercent).toBeCloseTo(0.1);
  });

  test("clamps invalid values", () => {
    const r = resolveConfig({ globalRunningCap: 999 } as unknown as Record<string, unknown>);
    expect(r.globalRunningCap).toBe(6);
  });
});

describe("COMMANDS registry", () => {
  test("has all 9 expected commandKinds", () => {
    const kinds = listCommandKinds();
    expect(kinds.length).toBe(9);
    expect(kinds).toContain("bootstrap");
    expect(kinds).toContain("doctor");
    expect(kinds).toContain("capability-ledger");
    expect(kinds).toContain("docket-list");
    expect(kinds).toContain("prior-capsule");
    expect(kinds).toContain("live-scout");
    expect(kinds).toContain("codex-build");
    expect(kinds).toContain("claude-cli-build");
    expect(kinds).toContain("mac-self-heal");
  });

  test("commandLane resolves all commands to a lane", () => {
    expect(commandLane("bootstrap")).toBe("diagnostic");
    expect(commandLane("doctor")).toBe("diagnostic");
    expect(commandLane("prior-capsule")).toBe("memory");
    expect(commandLane("live-scout")).toBe("scout");
    expect(commandLane("codex-build")).toBe("build");
    expect(commandLane("claude-cli-build")).toBe("build");
    expect(commandLane("mac-self-heal")).toBe("maintenance");
    expect(commandLane("nonexistent")).toBeNull();
  });

  test("commandHasRequiredFields enforces intent on build", () => {
    expect(commandHasRequiredFields({ commandKind: "claude-cli-build", intent: "do x" })).toBe(
      true,
    );
    expect(commandHasRequiredFields({ commandKind: "claude-cli-build" })).toBe(false);
    expect(commandHasRequiredFields({ commandKind: "claude-cli-build", intent: "" })).toBe(false);
    expect(commandHasRequiredFields({ commandKind: "doctor" })).toBe(true);
  });

  test("each command builds a {executable, args} spec", () => {
    for (const [kind, descriptor] of COMMANDS) {
      const spec = descriptor.build({ commandKind: kind, intent: "test intent" });
      expect(typeof spec.executable).toBe("string");
      expect(spec.executable.length).toBeGreaterThan(0);
      expect(Array.isArray(spec.args)).toBe(true);
    }
  });
});

describe("lane policies", () => {
  test("LANE_TIMEOUT_POLICY has all 5 lanes", () => {
    expect(LANE_TIMEOUT_POLICY.size).toBe(5);
    expect(LANE_TIMEOUT_POLICY.has("diagnostic")).toBe(true);
    expect(LANE_TIMEOUT_POLICY.has("scout")).toBe(true);
    expect(LANE_TIMEOUT_POLICY.has("build")).toBe(true);
    expect(LANE_TIMEOUT_POLICY.has("memory")).toBe(true);
    expect(LANE_TIMEOUT_POLICY.has("maintenance")).toBe(true);
  });

  test("EXECUTOR_LANE_POLICY has running cap per lane", () => {
    expect(EXECUTOR_LANE_POLICY.get("build")?.maxRunning).toBe(2);
    expect(EXECUTOR_LANE_POLICY.get("scout")?.maxRunning).toBe(2);
  });

  test("laneTimeoutPolicy returns DEFAULT_TIMEOUT_MS for unknown", () => {
    const p = laneTimeoutPolicy("nope");
    expect(p.defaultMs).toBe(30 * 60 * 1000);
  });

  test("laneRunPolicy returns null for unknown lane", () => {
    expect(laneRunPolicy("nope")).toBeNull();
  });
});

describe("timeoutPolicyForTask", () => {
  test("uses lane default", () => {
    const p = timeoutPolicyForTask({ commandKind: "doctor" });
    expect(p.lane).toBe("diagnostic");
    expect(p.source).toBe("lane-default");
    expect(p.timeoutMs).toBe(5 * 60 * 1000);
  });

  test("respects task-requested under cap", () => {
    const p = timeoutPolicyForTask({
      commandKind: "claude-cli-build",
      timeoutMs: 60 * 60 * 1000,
    });
    expect(p.source).toBe("task-requested");
    expect(p.timeoutMs).toBeLessThanOrEqual(p.maxMs);
  });

  test("caps task-requested at lane max", () => {
    const p = timeoutPolicyForTask({
      commandKind: "doctor",
      timeoutMs: 999 * 60 * 1000,
    });
    expect(p.source).toBe("task-requested");
    expect(p.capped).toBe(true);
    expect(p.timeoutMs).toBe(p.maxMs);
  });

  test("longRunning flag picks the lane longMs", () => {
    const p = timeoutPolicyForTask({ commandKind: "claude-cli-build", longRunning: true });
    expect(p.source).toBe("task-long-running");
    // build lane longMs = 2 hours = 7200000ms (gt the default 45min/2700000ms)
    expect(p.requestedMs).toBeGreaterThan(45 * 60 * 1000);
  });

  test("CLI override wins", () => {
    const p = timeoutPolicyForTask({ commandKind: "doctor" }, { timeoutMs: 60_000 });
    expect(p.source).toBe("cli-override");
    expect(p.timeoutMs).toBe(60_000);
  });
});

describe("buildExecutorEnv", () => {
  test("augments PATH with chuck/nvm/homebrew bin", () => {
    const env = buildExecutorEnv({ HOME: "/Users/test", PATH: "/usr/bin" });
    const parts = (env.PATH ?? "").split(":");
    expect(parts).toContain("/Users/test/.openclaw/bin");
    expect(parts).toContain("/Users/test/.nvm/versions/node/v24.14.1/bin");
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts).toContain("/usr/bin");
  });

  test("defaults HOME via os.homedir() when unset", () => {
    const env = buildExecutorEnv({});
    expect(env.HOME?.length).toBeGreaterThan(0);
  });
});

describe("macHealthGateBlockers", () => {
  test("commandKind in exempt list bypasses gate", () => {
    const config = resolveConfig({});
    expect(macHealthGateBlockers({ commandKind: "doctor" }, config)).toEqual([]);
    expect(macHealthGateBlockers({ commandKind: "bootstrap" }, config)).toEqual([]);
  });

  test("non-exempt commandKind consults the live mac gate", () => {
    clearMacGateCache();
    const config = resolveConfig({
      diskMinFreeBytes: 1, // 1 byte → unlikely to block
      diskWarnFreePercent: 0.0001,
      swapWarnUsedBytes: 9_999_999_999_999, // ~9TB → won't block
    });
    const out = macHealthGateBlockers({ commandKind: "claude-cli-build" }, config);
    expect(Array.isArray(out)).toBe(true);
  });
});

describe("macHealthGateStatus", () => {
  test("populates state + signals", () => {
    clearMacGateCache();
    const config = resolveConfig({});
    const status = macHealthGateStatus(config);
    expect(["clear", "blocked"]).toContain(status.state);
    expect(status.signals.length).toBeGreaterThan(0);
    expect(status.signals.some((s) => s.category === "mac.disk")).toBe(true);
    expect(status.signals.some((s) => s.category === "mac.load")).toBe(true);
    expect(status.signals.some((s) => s.category === "mac.memory")).toBe(true);
  });
});

describe("eligibilityBlockers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-docket-executor-elig-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function freshConfig() {
    return resolveConfig({
      docketDir: dir,
      executorControlPath: join(dir, "executor-control.json"),
      diskMinFreeBytes: 1,
      diskWarnFreePercent: 0.0001,
      swapWarnUsedBytes: 9_999_999_999_999,
    });
  }

  test("rejects status != pending", () => {
    const blockers = eligibilityBlockers(
      { status: "running", risk: "low", commandKind: "doctor" },
      { config: freshConfig() },
    );
    expect(blockers).toContain("status is not pending");
  });

  test("rejects risk != low", () => {
    const blockers = eligibilityBlockers(
      { status: "pending", risk: "high", commandKind: "doctor" },
      { config: freshConfig() },
    );
    expect(blockers).toContain("risk is not low");
  });

  test("rejects unknown commandKind", () => {
    const blockers = eligibilityBlockers(
      { status: "pending", risk: "low", commandKind: "made-up-kind" },
      { config: freshConfig() },
    );
    expect(blockers).toContain("commandKind is not executor-allowlisted");
  });

  test("rejects build without intent", () => {
    const blockers = eligibilityBlockers(
      { status: "pending", risk: "low", commandKind: "claude-cli-build" },
      { config: freshConfig() },
    );
    expect(blockers).toContain("claude-cli-build is missing required fields");
  });

  test("accepts well-formed pending low-risk doctor task", () => {
    const blockers = eligibilityBlockers(
      { status: "pending", risk: "low", commandKind: "doctor" },
      { config: freshConfig() },
    );
    expect(blockers).toEqual([]);
  });

  test("rejects when global running cap reached", () => {
    const config = resolveConfig({
      docketDir: dir,
      globalRunningCap: 2,
      diskMinFreeBytes: 1,
      diskWarnFreePercent: 0.0001,
      swapWarnUsedBytes: 9_999_999_999_999,
    });
    const activeTasks: Task[] = [
      { status: "running", commandKind: "doctor" },
      { status: "running", commandKind: "doctor" },
    ];
    const blockers = eligibilityBlockers(
      { status: "pending", risk: "low", commandKind: "doctor" },
      { config, activeTasks },
    );
    expect(blockers.some((b) => b.includes("global running cap"))).toBe(true);
  });

  test("rejects when lane running cap reached", () => {
    const config = freshConfig();
    const activeTasks: Task[] = [
      { status: "running", commandKind: "doctor" },
      { status: "running", commandKind: "doctor" },
    ];
    const blockers = eligibilityBlockers(
      { status: "pending", risk: "low", commandKind: "doctor" },
      { config, activeTasks },
    );
    expect(blockers.some((b) => b.includes("lane diagnostic running cap"))).toBe(true);
  });

  test("checkEligibility returns wrapped result", () => {
    const result = checkEligibility(
      { status: "pending", risk: "low", commandKind: "doctor" },
      { config: freshConfig() },
    );
    expect(result.eligible).toBe(true);
    expect(result.blockers).toEqual([]);
  });
});

describe("readExecutorControl", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-docket-executor-control-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file = active", async () => {
    const config = resolveConfig({ executorControlPath: join(dir, "missing.json") });
    const c = await readExecutorControl(config);
    expect(c.mode).toBe("active");
    expect(c.paused).toBe(false);
    expect(executorIntakePaused(c)).toBe(false);
  });

  test("paused file = paused", async () => {
    const path = join(dir, "control.json");
    writeFileSync(path, JSON.stringify({ mode: "paused", reason: "operator pause" }));
    const config = resolveConfig({ executorControlPath: path });
    const c = await readExecutorControl(config);
    expect(c.mode).toBe("paused");
    expect(c.paused).toBe(true);
    expect(c.reason).toBe("operator pause");
    expect(executorIntakePaused(c)).toBe(true);
  });

  test("malformed file = fail-closed (paused)", async () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "this isn't JSON {{{");
    const config = resolveConfig({ executorControlPath: path });
    const c = await readExecutorControl(config);
    expect(c.paused).toBe(true);
    expect(c.failClosed).toBe(true);
  });
});
