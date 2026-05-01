// Smoke tests for @openclaw/skill-decision-engine.
//
// Each detector verified with synthesized fixtures; runScan integration
// tested in dry-run so no real Telegram fires. Live notify path is verified
// by skill-reach-cascade's own suite.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import { detectChannelDrift } from "./src/detectors/channel-drift.js";
import { detectFailedTaskCluster } from "./src/detectors/failed-task-cluster.js";
import { detectScannerTune } from "./src/detectors/scanner-tune.js";
import { detectStaleMacHeal } from "./src/detectors/stale-mac-heal.js";
import { detectZombieCluster } from "./src/detectors/zombie-cluster.js";
import { shouldAutoApply } from "./src/policy.js";
import { runScan } from "./src/scan.js";
import type { DocketTask, Proposal } from "./src/types.js";

const NOW = new Date("2026-05-01T20:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

function fakeTask(overrides: Partial<DocketTask>): DocketTask {
  return {
    id: "task-x",
    status: "completed",
    commandKind: "claude-cli-build",
    updatedAt: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString(),
    ...overrides,
  };
}

describe("config resolver", () => {
  test("applies defaults", () => {
    const r = resolveConfig({});
    expect(r.enabled).toBe(true);
    expect(r.maxProposalsPerScan).toBe(3);
    expect(r.fingerprintDedupHours).toBe(12);
  });

  test("clamps invalid values", () => {
    const r = resolveConfig({
      maxProposalsPerScan: 999,
      fingerprintDedupHours: -5,
    } as unknown as Record<string, unknown>);
    expect(r.maxProposalsPerScan).toBe(3);
    expect(r.fingerprintDedupHours).toBe(12);
  });
});

describe("detectFailedTaskCluster", () => {
  test("emits when >=3 failed share commandKind in 6h", () => {
    const cfg = resolveConfig({});
    const tasks = [
      fakeTask({ id: "t1", status: "failed", commandKind: "fleet-dispatch" }),
      fakeTask({ id: "t2", status: "failed", commandKind: "fleet-dispatch" }),
      fakeTask({ id: "t3", status: "failed", commandKind: "fleet-dispatch" }),
      fakeTask({ id: "t4", status: "completed", commandKind: "fleet-dispatch" }),
    ];
    const hit = detectFailedTaskCluster({ tasks, events: [], config: cfg, now: NOW });
    expect(hit).not.toBeNull();
    expect(hit?.category).toBe("failed-task-cluster");
    expect(hit?.evidence.commandKind).toBe("fleet-dispatch");
    expect(hit?.evidence.count).toBe(3);
    expect(hit?.riskClass).toBe("medium");
  });

  test("returns null with <3 failures", () => {
    const cfg = resolveConfig({});
    const tasks = [
      fakeTask({ id: "t1", status: "failed", commandKind: "x" }),
      fakeTask({ id: "t2", status: "failed", commandKind: "y" }),
    ];
    const hit = detectFailedTaskCluster({ tasks, events: [], config: cfg, now: NOW });
    expect(hit).toBeNull();
  });

  test("ignores failures outside 6h window", () => {
    const cfg = resolveConfig({});
    const old = new Date(NOW.getTime() - 12 * HOUR_MS).toISOString();
    const tasks = [
      fakeTask({ id: "t1", status: "failed", commandKind: "x", updatedAt: old }),
      fakeTask({ id: "t2", status: "failed", commandKind: "x", updatedAt: old }),
      fakeTask({ id: "t3", status: "failed", commandKind: "x", updatedAt: old }),
    ];
    const hit = detectFailedTaskCluster({ tasks, events: [], config: cfg, now: NOW });
    expect(hit).toBeNull();
  });
});

describe("detectZombieCluster", () => {
  test("emits when >=3 chuck.zombie_recovered in 24h", () => {
    const cfg = resolveConfig({});
    const recent = new Date(NOW.getTime() - 2 * HOUR_MS).toISOString();
    const events = [
      { ts: recent, type: "chuck.zombie_recovered", payload: { lane: "build" } },
      { ts: recent, type: "chuck.zombie_recovered", payload: { lane: "build" } },
      { ts: recent, type: "chuck.zombie_recovered", payload: { lane: "scout" } },
    ];
    const hit = detectZombieCluster({ tasks: [], events, config: cfg, now: NOW });
    expect(hit).not.toBeNull();
    expect(hit?.evidence.totalZombies).toBe(3);
    expect(hit?.evidence.dominantLane).toBe("build");
  });

  test("returns null with 2 events", () => {
    const cfg = resolveConfig({});
    const recent = new Date(NOW.getTime() - 1 * HOUR_MS).toISOString();
    const events = [
      { ts: recent, type: "chuck.zombie_recovered", payload: {} },
      { ts: recent, type: "chuck.zombie_recovered", payload: {} },
    ];
    expect(detectZombieCluster({ tasks: [], events, config: cfg, now: NOW })).toBeNull();
  });
});

describe("detectScannerTune", () => {
  test("emits when >50% of >=5 scanner tasks failed", () => {
    const cfg = resolveConfig({});
    const recent = new Date(NOW.getTime() - 24 * HOUR_MS).toISOString();
    const tasks: DocketTask[] = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      status: i < 4 ? "failed" : "completed",
      source: { kind: "chuck-self-improvement-scanner" },
      updatedAt: recent,
    }));
    const hit = detectScannerTune({ tasks, events: [], config: cfg, now: NOW });
    expect(hit).not.toBeNull();
    expect(hit?.evidence.totalPromoted).toBe(6);
    expect(hit?.evidence.failed).toBe(4);
  });

  test("returns null with <5 scanner tasks", () => {
    const cfg = resolveConfig({});
    const recent = new Date().toISOString();
    const tasks: DocketTask[] = [
      {
        id: "t1",
        status: "failed",
        source: { kind: "chuck-self-improvement-scanner" },
        updatedAt: recent,
      },
    ];
    expect(detectScannerTune({ tasks, events: [], config: cfg, now: NOW })).toBeNull();
  });
});

describe("detectStaleMacHeal", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-decision-engine-staleheal-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing latest.json emits a verify-launchd proposal", () => {
    const cfg = resolveConfig({ macHealLatestPath: join(dir, "missing.json") });
    const hit = detectStaleMacHeal({ tasks: [], events: [], config: cfg, now: NOW });
    expect(hit).not.toBeNull();
    expect(hit?.recommendation).toBe("verify-launchd");
  });

  test("fresh latest.json (<12h) returns null", () => {
    const path = join(dir, "latest.json");
    const recent = new Date(NOW.getTime() - 1 * HOUR_MS).toISOString();
    writeFileSync(path, JSON.stringify({ updatedAt: recent }));
    const cfg = resolveConfig({ macHealLatestPath: path });
    expect(detectStaleMacHeal({ tasks: [], events: [], config: cfg, now: NOW })).toBeNull();
  });

  test("stale latest.json (>12h) emits", () => {
    const path = join(dir, "latest.json");
    const old = new Date(NOW.getTime() - 24 * HOUR_MS).toISOString();
    writeFileSync(path, JSON.stringify({ updatedAt: old }));
    const cfg = resolveConfig({ macHealLatestPath: path });
    const hit = detectStaleMacHeal({ tasks: [], events: [], config: cfg, now: NOW });
    expect(hit).not.toBeNull();
    expect(hit?.evidence.ageHours).toBeGreaterThanOrEqual(24);
  });
});

describe("detectChannelDrift", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-decision-engine-drift-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("emits when enabled channel has zero events in 7d", () => {
    const path = join(dir, "openclaw.json");
    writeFileSync(path, JSON.stringify({ channels: { ghostchan: { enabled: true } } }));
    const cfg = resolveConfig({ openclawConfigPath: path });
    const hit = detectChannelDrift({ tasks: [], events: [], config: cfg, now: NOW });
    expect(hit).not.toBeNull();
    expect(hit?.evidence.channel).toBe("ghostchan");
    expect(hit?.riskClass).toBe("low");
  });

  test("returns null when channel has recent traffic", () => {
    const path = join(dir, "openclaw.json");
    writeFileSync(path, JSON.stringify({ channels: { livechan: { enabled: true } } }));
    const cfg = resolveConfig({ openclawConfigPath: path });
    const ts = new Date(NOW.getTime() - 1 * HOUR_MS).toISOString();
    const events = [
      { ts, type: "chat.received", source: "livechan", payload: { channel: "livechan" } },
    ];
    expect(detectChannelDrift({ tasks: [], events, config: cfg, now: NOW })).toBeNull();
  });
});

describe("shouldAutoApply", () => {
  function fakeProposal(overrides: Partial<Proposal>): Proposal {
    return {
      id: "decision-test",
      ts: new Date().toISOString(),
      category: "channel-drift",
      situation: "x",
      options: [{ label: "drop-task", action: "drop a docket task to investigate" }],
      recommendation: "drop-task",
      rationale: "x",
      riskClass: "low",
      evidence: {},
      rollback: "x",
      autoApply: false,
      applied: false,
      appliedAt: null,
      appliedAction: null,
      approvalNeeded: false,
      approvalChannel: "telegram",
      approvalChatId: "0",
      fingerprint: "x",
      status: "open",
      ...overrides,
    };
  }

  test("auto-applies low-risk drop-a-docket-task", () => {
    expect(shouldAutoApply(fakeProposal({}))).toBe(true);
  });

  test("never auto-applies medium-risk", () => {
    expect(shouldAutoApply(fakeProposal({ riskClass: "medium" }))).toBe(false);
  });

  test("never auto-applies config edits", () => {
    expect(
      shouldAutoApply(
        fakeProposal({
          options: [{ label: "edit", action: "modify openclaw.json channel setting" }],
          recommendation: "edit",
        }),
      ),
    ).toBe(false);
  });
});

describe("runScan dryRun integration", () => {
  let dir: string;
  let docketDir: string;
  let decisionsDir: string;
  let eventsPath: string;
  let openclawConfigPath: string;
  let macHealLatestPath: string;
  let scriptsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-decision-engine-scan-"));
    docketDir = join(dir, "docket");
    decisionsDir = join(dir, "decisions");
    eventsPath = join(dir, "events.jsonl");
    openclawConfigPath = join(dir, "openclaw.json");
    macHealLatestPath = join(dir, "mac-self-heal-latest.json");
    scriptsDir = join(dir, "scripts");
    mkdirSync(docketDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    // Empty configs so detectors return cleanly.
    writeFileSync(openclawConfigPath, JSON.stringify({ channels: {} }));
    writeFileSync(
      macHealLatestPath,
      JSON.stringify({ updatedAt: new Date(NOW.getTime() - HOUR_MS).toISOString() }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs every detector and writes nothing in dry-run", async () => {
    const config = resolveConfig({
      docketDir,
      decisionsDir,
      eventsPath,
      openclawConfigPath,
      macHealLatestPath,
      scriptsDir,
      codexConfigPath: join(dir, "missing-codex.toml"),
      claudeConfigPath: join(dir, "missing-claude.json"),
    });
    const summary = await runScan({ dryRun: true, now: NOW }, config);
    expect(summary.dryRun).toBe(true);
    expect(summary.detectorsRun).toBe(6);
    expect(summary.hits).toBe(0); // no fixtures hit
    expect(summary.emitted).toBe(0);
  });

  test("respects maxProposalsPerScan flood cap", async () => {
    // Plant fixtures that trigger 2 detectors (failed-task-cluster + zombie-cluster).
    for (let i = 0; i < 3; i++) {
      writeFileSync(
        join(docketDir, `task-fail-${i}.json`),
        JSON.stringify(fakeTask({ id: `f${i}`, status: "failed", commandKind: "build-x" })),
      );
    }
    const recent = new Date(NOW.getTime() - 2 * HOUR_MS).toISOString();
    writeFileSync(
      eventsPath,
      Array.from({ length: 4 }, () =>
        JSON.stringify({ ts: recent, type: "chuck.zombie_recovered", payload: { lane: "x" } }),
      ).join("\n"),
    );
    const config = resolveConfig({
      docketDir,
      decisionsDir,
      eventsPath,
      openclawConfigPath,
      macHealLatestPath,
      scriptsDir,
      codexConfigPath: join(dir, "missing-codex.toml"),
      claudeConfigPath: join(dir, "missing-claude.json"),
      maxProposalsPerScan: 1,
    });
    const summary = await runScan({ dryRun: true, now: NOW }, config);
    expect(summary.hits).toBeGreaterThanOrEqual(2);
    expect(summary.emitted).toBe(1);
    expect(summary.floodSkipped).toBeGreaterThanOrEqual(1);
  });
});
