// Test suite for @openclaw/skill-prior-capsule.
//
// Subprocess runner is injected; the tests never spawn the real .mjs.

import { describe, expect, it, vi } from "vitest";
import {
  resolveConfig,
  runBuildPriorCapsule,
  type PriorCapsuleConfig,
  type SubprocessRunner,
} from "./api.js";

function makeConfig(overrides: Partial<PriorCapsuleConfig> = {}): PriorCapsuleConfig {
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
      buildTimeoutMs: 100,
      defaultLimit: 9999,
      scriptPath: "~/custom/script.mjs",
      priorsDir: "~/custom/priors",
    });
    expect(cfg.buildTimeoutMs).toBe(60_000);
    expect(cfg.defaultLimit).toBe(10);
    expect(cfg.scriptPath).toMatch(/\/custom\/script\.mjs$/);
    expect(cfg.priorsDir).toMatch(/\/custom\/priors$/);
    expect(cfg.latestPriorPath).toMatch(/\/custom\/priors\/latest\.json$/);
  });
});

describe("runBuildPriorCapsule", () => {
  const sampleReceipt = {
    priorId: "prior-20260501T000000Z-abcdef012345",
    sourceHash: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-05-01T00:00:00.000Z",
    path: "/tmp/priors/prior-test.json",
    markdownPath: null,
    latestPath: "/tmp/priors/latest.json",
  };

  const sampleCapsule = {
    schemaVersion: "chuck.prior-capsule.v1",
    priorId: "prior-20260501T000000Z-abcdef012345",
    createdAt: "2026-05-01T00:00:00.000Z",
    sourceHash: `sha256:${"a".repeat(64)}`,
    operatorIntent: { mode: "test" },
    activeTasks: [],
  };

  it("with write=true returns the parsed receipt", async () => {
    const cfg = makeConfig();
    const capture: { args?: string[] } = {};
    const runner = makeRunner(JSON.stringify(sampleReceipt), capture);
    const result = await runBuildPriorCapsule(cfg, { write: true }, { runSubprocess: runner });
    expect(result.ok).toBe(true);
    expect(result.receipt.priorId).toBe(sampleReceipt.priorId);
    expect(result.receipt.path).toBe(sampleReceipt.path);
    expect(result.capsule).toBeUndefined();
    expect(capture.args).toContain("--write");
    expect(capture.args).toContain("--json");
  });

  it("with write=true + markdown=true forwards both flags", async () => {
    const cfg = makeConfig();
    const capture: { args?: string[] } = {};
    const runner = makeRunner(JSON.stringify(sampleReceipt), capture);
    await runBuildPriorCapsule(cfg, { write: true, markdown: true }, { runSubprocess: runner });
    expect(capture.args).toContain("--write");
    expect(capture.args).toContain("--markdown");
  });

  it("without write returns the full capsule body + a derived receipt", async () => {
    const cfg = makeConfig();
    const runner = makeRunner(JSON.stringify(sampleCapsule));
    const result = await runBuildPriorCapsule(cfg, {}, { runSubprocess: runner });
    expect(result.capsule).toBeDefined();
    expect(result.capsule?.schemaVersion).toBe("chuck.prior-capsule.v1");
    expect(result.receipt.priorId).toBe(sampleCapsule.priorId);
    expect(result.receipt.path).toBeNull();
  });

  it("forwards sourceTaskPath", async () => {
    const cfg = makeConfig();
    const capture: { args?: string[] } = {};
    const runner = makeRunner(JSON.stringify(sampleReceipt), capture);
    await runBuildPriorCapsule(
      cfg,
      { write: true, sourceTaskPath: "/x/y/task.json" },
      { runSubprocess: runner },
    );
    expect(capture.args).toContain("--source-task");
    expect(capture.args).toContain("/x/y/task.json");
  });

  it("forwards limit when it differs from default", async () => {
    const cfg = makeConfig();
    const capture: { args?: string[] } = {};
    const runner = makeRunner(JSON.stringify(sampleReceipt), capture);
    await runBuildPriorCapsule(cfg, { write: true, limit: 25 }, { runSubprocess: runner });
    expect(capture.args).toContain("--limit");
    expect(capture.args).toContain("25");
  });

  it("does NOT forward limit when it matches the default", async () => {
    const cfg = makeConfig();
    const capture: { args?: string[] } = {};
    const runner = makeRunner(JSON.stringify(sampleReceipt), capture);
    await runBuildPriorCapsule(
      cfg,
      { write: true, limit: cfg.defaultLimit },
      { runSubprocess: runner },
    );
    expect(capture.args).not.toContain("--limit");
  });

  it("throws if write=true but stdout is not a receipt shape", async () => {
    const cfg = makeConfig();
    const runner = makeRunner(JSON.stringify({ schemaVersion: "chuck.prior-capsule.v1" }));
    await expect(
      runBuildPriorCapsule(cfg, { write: true }, { runSubprocess: runner }),
    ).rejects.toThrow(/receipt-shaped/);
  });

  it("throws if write=false but stdout is not a capsule", async () => {
    const cfg = makeConfig();
    const runner = makeRunner(JSON.stringify({ unrelated: true }));
    await expect(runBuildPriorCapsule(cfg, {}, { runSubprocess: runner })).rejects.toThrow(
      /non-capsule JSON/,
    );
  });

  it("throws on empty stdout", async () => {
    const cfg = makeConfig();
    const runner = makeRunner("");
    await expect(
      runBuildPriorCapsule(cfg, { write: true }, { runSubprocess: runner }),
    ).rejects.toThrow(/empty stdout/);
  });

  it("throws on invalid JSON in stdout", async () => {
    const cfg = makeConfig();
    const runner = makeRunner("not-json");
    await expect(
      runBuildPriorCapsule(cfg, { write: true }, { runSubprocess: runner }),
    ).rejects.toThrow(/failed to parse/);
  });

  it("propagates subprocess rejection", async () => {
    const cfg = makeConfig();
    const runner = vi.fn(async () => {
      throw new Error("subprocess exited 1: boom");
    });
    await expect(
      runBuildPriorCapsule(cfg, { write: true }, { runSubprocess: runner }),
    ).rejects.toThrow(/boom/);
  });
});
