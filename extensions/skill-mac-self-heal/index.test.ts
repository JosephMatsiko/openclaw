// Test suite for @openclaw/skill-mac-self-heal.
//
// Subprocess runner is injected; the tests never spawn the real .mjs.

import { describe, expect, it, vi } from "vitest";
import {
  resolveConfig,
  runApply,
  runPlan,
  runStatus,
  type MacSelfHealConfig,
  type SubprocessRunner,
} from "./api.js";

function makeConfig(overrides: Partial<MacSelfHealConfig> = {}): MacSelfHealConfig {
  return {
    ...resolveConfig({}),
    ...overrides,
  };
}

function makeRunner(stdout: string, capture: { args?: string[] } = {}): SubprocessRunner {
  return vi.fn(async ({ args }) => {
    capture.args = args;
    return { ok: true as const, stdout, stderr: "", exitCode: 0 };
  });
}

describe("config", () => {
  it("clamps out-of-range values + expands ~/", () => {
    const cfg = resolveConfig({
      statusTimeoutMs: 100,
      planTimeoutMs: 999,
      applyTimeoutMs: 100,
      defaultMaxActions: 0,
      scriptPath: "~/custom/script.mjs",
      stateDir: "~/custom/state",
    });
    expect(cfg.statusTimeoutMs).toBe(30_000);
    expect(cfg.planTimeoutMs).toBe(120_000);
    expect(cfg.applyTimeoutMs).toBe(1_200_000);
    expect(cfg.defaultMaxActions).toBe(24);
    expect(cfg.scriptPath).toMatch(/\/custom\/script\.mjs$/);
    expect(cfg.stateDir).toMatch(/\/custom\/state$/);
    expect(cfg.receiptsDir).toMatch(/\/custom\/state\/receipts$/);
    expect(cfg.archivesDir).toMatch(/\/custom\/state\/archives$/);
  });
});

describe("runStatus", () => {
  it("invokes status with --json and parses the result", async () => {
    const cfg = makeConfig();
    const capture: { args?: string[] } = {};
    const runner = makeRunner(
      JSON.stringify({ schema: "chuck-v3.mac-self-heal/1", state: "clear" }),
      capture,
    );
    const result = await runStatus(cfg, { runSubprocess: runner });
    expect(result.command).toBe("status");
    expect(capture.args?.[0]).toBe("status");
    expect(capture.args).toContain("--json");
    expect(result.result.schema).toBe("chuck-v3.mac-self-heal/1");
  });
});

describe("runPlan", () => {
  it("invokes plan with --json (no extra flags by default)", async () => {
    const cfg = makeConfig();
    const capture: { args?: string[] } = {};
    const runner = makeRunner(JSON.stringify({ actionCount: 5, reclaimableBytes: 1024 }), capture);
    const result = await runPlan(cfg, {}, { runSubprocess: runner });
    expect(result.command).toBe("plan");
    expect(capture.args?.[0]).toBe("plan");
    expect(capture.args).not.toContain("--allow-cloud-offload");
    expect(result.result.actionCount).toBe(5);
  });

  it("forwards --allow-cloud-offload when option is set", async () => {
    const cfg = makeConfig();
    const capture: { args?: string[] } = {};
    const runner = makeRunner(JSON.stringify({ actionCount: 12 }), capture);
    await runPlan(cfg, { allowCloudOffload: true }, { runSubprocess: runner });
    expect(capture.args).toContain("--allow-cloud-offload");
  });
});

describe("runApply", () => {
  it("invokes apply with --json and default options forward only --json", async () => {
    const cfg = makeConfig();
    const capture: { args?: string[] } = {};
    const runner = makeRunner(JSON.stringify({ receiptId: "r-1" }), capture);
    await runApply(cfg, {}, { runSubprocess: runner });
    expect(capture.args?.[0]).toBe("apply");
    expect(capture.args).toContain("--json");
    expect(capture.args).not.toContain("--max-actions");
    expect(capture.args).not.toContain("--only-under-pressure");
    expect(capture.args).not.toContain("--allow-cloud-offload");
  });

  it("forwards maxActions when explicitly provided (even if equal to default)", async () => {
    const cfg = makeConfig();
    const capture: { args?: string[] } = {};
    const runner = makeRunner(JSON.stringify({}), capture);
    await runApply(cfg, { maxActions: cfg.defaultMaxActions }, { runSubprocess: runner });
    expect(capture.args).toContain("--max-actions");
    expect(capture.args).toContain(String(cfg.defaultMaxActions));
  });

  it("forwards onlyUnderPressure + allowCloudOffload + cloudTarget", async () => {
    const cfg = makeConfig();
    const capture: { args?: string[] } = {};
    const runner = makeRunner(JSON.stringify({}), capture);
    await runApply(
      cfg,
      {
        onlyUnderPressure: true,
        allowCloudOffload: true,
        cloudTarget: "/Volumes/Cloud/Archive",
        maxActions: 60,
      },
      { runSubprocess: runner },
    );
    expect(capture.args).toContain("--only-under-pressure");
    expect(capture.args).toContain("--allow-cloud-offload");
    expect(capture.args).toContain("--cloud-target");
    expect(capture.args).toContain("/Volumes/Cloud/Archive");
    expect(capture.args).toContain("--max-actions");
    expect(capture.args).toContain("60");
  });

  it("forwards --dry-run when set (the .mjs downgrades apply→plan)", async () => {
    const cfg = makeConfig();
    const capture: { args?: string[] } = {};
    const runner = makeRunner(JSON.stringify({}), capture);
    await runApply(cfg, { dryRun: true }, { runSubprocess: runner });
    expect(capture.args).toContain("--dry-run");
  });

  it("propagates subprocess rejection", async () => {
    const cfg = makeConfig();
    const runner = vi.fn(async () => {
      throw new Error("subprocess exited 1: boom");
    });
    await expect(runApply(cfg, {}, { runSubprocess: runner })).rejects.toThrow(/boom/);
  });
});

describe("error handling", () => {
  it("throws on empty stdout", async () => {
    const cfg = makeConfig();
    const runner = makeRunner("");
    await expect(runStatus(cfg, { runSubprocess: runner })).rejects.toThrow(/empty stdout/);
  });

  it("throws on invalid JSON", async () => {
    const cfg = makeConfig();
    const runner = makeRunner("not-json");
    await expect(runStatus(cfg, { runSubprocess: runner })).rejects.toThrow(/failed to parse/);
  });
});
