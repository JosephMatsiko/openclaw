// Test suite for @openclaw/skill-health-steward.
//
// Avoids real subprocess invocation by injecting SelfHealRunner + SystemProbes.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAction,
  buildApprovalActions,
  buildAutomaticActions,
  buildHandoffActions,
  buildHealthSnapshot,
  buildStatus,
  formatBytes,
  latestVerifiedLocalArchiveCandidate,
  readExecutorControl,
  resolveConfig,
  stabilize,
  summarizeDocket,
  writeApprovalCapsules,
  writeExecutorControl,
  type HealthStewardConfig,
  type SelfHealPlan,
  type SelfHealRunner,
  type SystemProbes,
} from "./api.js";

const GIB = 1024 ** 3;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "skill-health-steward-"));
}

function makeConfig(
  root: string,
  overrides: Partial<HealthStewardConfig> = {},
): HealthStewardConfig {
  const stewardDir = join(root, "health-steward");
  const macSelfHealDir = join(root, "mac-self-heal");
  const base = resolveConfig({
    stewardDir,
    approvalsDir: join(root, "approvals"),
    executorControlPath: join(root, "executor-control.json"),
    docketDir: join(root, "docket"),
    macSelfHealScript: join(root, "chuck-mac-self-heal.mjs"),
    macSelfHealDir,
    eventsPath: join(root, "apex-events.jsonl"),
  });
  return {
    ...base,
    receiptsDir: join(stewardDir, "receipts"),
    macSelfHealReceiptsDir: join(macSelfHealDir, "receipts"),
    macSelfHealArchivesDir: join(macSelfHealDir, "archives"),
    ...overrides,
  };
}

function makeProbes(overrides: Partial<SystemProbes> = {}): SystemProbes {
  return {
    disk: () => ({
      available: true,
      totalBytes: 500 * GIB,
      freeBytes: 200 * GIB,
      freePercent: 0.4,
    }),
    swap: () => ({
      available: true,
      totalBytes: 4 * GIB,
      usedBytes: 0,
      freeBytes: 4 * GIB,
      usedPercent: 0,
      raw: "",
    }),
    memoryPressure: () => ({ available: true, freePercentReported: 0.5, sample: "" }),
    load: () => ({ one: 1.2, five: 1.4, fifteen: 1.6 }),
    totalMemoryBytes: () => 32 * GIB,
    freeMemoryBytes: () => 8 * GIB,
    processGroups: () => [],
    ...overrides,
  };
}

function makeSelfHeal(overrides: Partial<SelfHealRunner> = {}): SelfHealRunner {
  const noopPlan: SelfHealPlan = {
    actionCount: 0,
    reclaimableBytes: 0,
    blockedCount: 0,
    blockedBytes: 0,
  };
  return {
    plan: vi.fn(async () => ({ ok: true as const, parsed: noopPlan })),
    status: vi.fn(async () => ({ ok: true as const, parsed: { cloud: { available: false } } })),
    apply: vi.fn(async () => ({ ok: true as const, parsed: { receiptId: "self-heal-test" } })),
    ...overrides,
  };
}

describe("config", () => {
  it("clamps out-of-range thresholds back to defaults", () => {
    const cfg = resolveConfig({
      diskMinFreeBytes: -1,
      diskMinFreePercent: 99,
      swapMaxUsedBytes: 0.5,
      loadOneWatchThreshold: 999,
      freeMemoryWatchPercent: -0.5,
      stabilizeMaxSafeActions: -1,
      applyMaxActions: 9999,
      selfHealPlanTimeoutMs: 1,
      selfHealApplyTimeoutMs: 1,
    });
    expect(cfg.diskMinFreeBytes).toBe(25 * GIB);
    expect(cfg.diskMinFreePercent).toBe(0.1);
    expect(cfg.swapMaxUsedBytes).toBe(10 * GIB);
    expect(cfg.loadOneWatchThreshold).toBe(10);
    expect(cfg.freeMemoryWatchPercent).toBeCloseTo(0.02);
    expect(cfg.stabilizeMaxSafeActions).toBe(24);
    expect(cfg.applyMaxActions).toBe(60);
    expect(cfg.selfHealPlanTimeoutMs).toBe(120_000);
    expect(cfg.selfHealApplyTimeoutMs).toBe(1_200_000);
  });

  it("expands ~/ and respects custom values within bounds", () => {
    const cfg = resolveConfig({
      stewardDir: "~/custom/health",
      diskMinFreeBytes: 5 * GIB,
      diskMinFreePercent: 0.15,
      stabilizeMaxSafeActions: 42,
    });
    expect(cfg.stewardDir).toMatch(/\/custom\/health$/);
    expect(cfg.diskMinFreeBytes).toBe(5 * GIB);
    expect(cfg.diskMinFreePercent).toBe(0.15);
    expect(cfg.stabilizeMaxSafeActions).toBe(42);
  });
});

describe("util", () => {
  it("formatBytes formats GiB and MiB", () => {
    expect(formatBytes(2 * GIB)).toBe("2.0 GiB");
    expect(formatBytes(512 * 1024 * 1024)).toBe("512 MiB");
    expect(formatBytes(0)).toBe("0 MiB");
    expect(formatBytes(null)).toBe("0 MiB");
  });
});

describe("buildHealthSnapshot", () => {
  let root: string;
  let cfg: HealthStewardConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns 'clear' when all probes pass", () => {
    const snapshot = buildHealthSnapshot(makeProbes(), cfg);
    expect(snapshot.state).toBe("clear");
    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
  });

  it("returns 'blocked' when disk is below the floor", () => {
    const snapshot = buildHealthSnapshot(
      makeProbes({
        disk: () => ({
          available: true,
          totalBytes: 500 * GIB,
          freeBytes: 5 * GIB,
          freePercent: 0.01,
        }),
      }),
      cfg,
    );
    expect(snapshot.state).toBe("blocked");
    expect(snapshot.blockers[0]).toMatch(/disk gate/);
  });

  it("returns 'blocked' when swap exceeds the cap", () => {
    const snapshot = buildHealthSnapshot(
      makeProbes({
        swap: () => ({
          available: true,
          totalBytes: 32 * GIB,
          usedBytes: 20 * GIB,
          freeBytes: 12 * GIB,
          usedPercent: 0.625,
          raw: "",
        }),
      }),
      cfg,
    );
    expect(snapshot.state).toBe("blocked");
    expect(snapshot.blockers[0]).toMatch(/swap gate/);
  });

  it("returns 'watch' when load exceeds threshold but no blockers", () => {
    const snapshot = buildHealthSnapshot(
      makeProbes({ load: () => ({ one: 15, five: 12, fifteen: 8 }) }),
      cfg,
    );
    expect(snapshot.state).toBe("watch");
    expect(snapshot.warnings[0]).toMatch(/load watch/);
  });
});

describe("summarizeDocket", () => {
  let root: string;
  let cfg: HealthStewardConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
    mkdirSync(cfg.docketDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns zeros for empty docket", () => {
    const summary = summarizeDocket(cfg);
    expect(summary).toMatchObject({ total: 0, pending: 0, running: 0, staleRunning: 0 });
  });

  it("counts statuses + flags stale running", () => {
    writeFileSync(
      join(cfg.docketDir, "a.json"),
      JSON.stringify({ taskId: "a", status: "pending" }),
    );
    writeFileSync(
      join(cfg.docketDir, "b.json"),
      JSON.stringify({
        taskId: "b",
        status: "running",
        startedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      }),
    );
    writeFileSync(
      join(cfg.docketDir, "c.json"),
      JSON.stringify({ taskId: "c", status: "running", startedAt: new Date().toISOString() }),
    );
    writeFileSync(
      join(cfg.docketDir, "d.json"),
      JSON.stringify({ taskId: "d", status: "completed" }),
    );
    const summary = summarizeDocket(cfg);
    expect(summary.total).toBe(4);
    expect(summary.pending).toBe(1);
    expect(summary.running).toBe(2);
    expect(summary.staleRunning).toBe(1);
    expect(summary.staleRunningTaskIds).toEqual(["b"]);
    expect(summary.counts).toEqual({ pending: 1, running: 2, completed: 1 });
  });
});

describe("executor control", () => {
  let root: string;
  let cfg: HealthStewardConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("defaults to active when no control file", () => {
    const ctrl = readExecutorControl(cfg);
    expect(ctrl.mode).toBe("active");
    expect(ctrl.paused).toBe(false);
  });

  it("writes paused, then reads paused back", () => {
    writeExecutorControl(cfg, { mode: "paused", reason: "test pause" });
    const ctrl = readExecutorControl(cfg);
    expect(ctrl.mode).toBe("paused");
    expect(ctrl.paused).toBe(true);
    expect(ctrl.reason).toBe("test pause");
    expect(ctrl.updatedBy).toBe("health-steward");
  });
});

describe("buildAutomaticActions", () => {
  it("emits pause when blocked + executor active", () => {
    const actions = buildAutomaticActions({
      health: { state: "blocked", blockers: ["disk gate"], warnings: [] } as never,
      executor: { mode: "active", paused: false, reason: "", path: "" },
      planSafe: { actionCount: 0 },
    });
    expect(actions.find((a) => a.action === "pause-executor-intake")).toBeDefined();
  });

  it("does NOT emit pause when already paused", () => {
    const actions = buildAutomaticActions({
      health: { state: "blocked", blockers: ["disk gate"], warnings: [] } as never,
      executor: { mode: "paused", paused: true, reason: "", path: "" },
      planSafe: { actionCount: 0 },
    });
    expect(actions.find((a) => a.action === "pause-executor-intake")).toBeUndefined();
  });

  it("emits run-safe-self-heal when planSafe has actions", () => {
    const actions = buildAutomaticActions({
      health: { state: "clear", blockers: [], warnings: [] } as never,
      executor: { mode: "active", paused: false, reason: "", path: "" },
      planSafe: { actionCount: 5, reclaimableBytes: 1024 },
    });
    const safe = actions.find((a) => a.action === "run-safe-self-heal");
    expect(safe).toMatchObject({ count: 5, bytes: 1024 });
  });
});

describe("buildApprovalActions", () => {
  it("emits cloud-offload when cloud-only delta is positive", () => {
    const actions = buildApprovalActions({
      planSafe: { actionCount: 1, reclaimableBytes: 100 },
      planCloud: {
        actionCount: 5,
        reclaimableBytes: 500,
        cloud: { available: true, archivePath: "/x/y" },
      },
      localArchive: { available: false },
      groups: [],
    });
    const cloud = actions.find((a) => a.action === "cloud-offload");
    expect(cloud).toMatchObject({
      bytes: 400,
      count: 4,
      destination: "/x/y",
      confirm: "RUN_APPROVED_CLOUD_OFFLOAD",
    });
  });

  it("emits purge-local-archive when candidate is available", () => {
    const actions = buildApprovalActions({
      planSafe: { actionCount: 0 },
      planCloud: { actionCount: 0 },
      localArchive: {
        available: true,
        receiptId: "abc",
        archiveRoot: "/tmp/a",
        fileCount: 3,
        bytes: 9999,
        cloudCopiesVerified: 3,
      },
      groups: [],
    });
    const purge = actions.find((a) => a.action === "purge-local-archive");
    expect(purge).toMatchObject({
      bytes: 9999,
      count: 3,
      sourceReceiptId: "abc",
      path: "/tmp/a",
      confirm: "PURGE_VERIFIED_LOCAL_ARCHIVE",
    });
  });

  it("emits quit-heavy-gui-apps when an allowlisted group exceeds threshold", () => {
    const actions = buildApprovalActions({
      planSafe: { actionCount: 0 },
      planCloud: { actionCount: 0 },
      localArchive: { available: false },
      groups: [
        { group: "Google Chrome", rssBytes: 800 * 1024 * 1024, processCount: 12, top: [] },
        { group: "Other", rssBytes: 4 * GIB, processCount: 5, top: [] },
      ],
    });
    const quit = actions.find((a) => a.action === "quit-heavy-gui-apps");
    expect(quit).toMatchObject({ confirm: "QUIT_HEAVY_GUI_APPS" });
    expect(quit?.apps).toEqual([
      { app: "Google Chrome", rssBytes: 800 * 1024 * 1024, processCount: 12 },
    ]);
  });
});

describe("buildHandoffActions", () => {
  let root: string;
  let cfg: HealthStewardConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("emits restart-mac when swap is over the cap", () => {
    const handoffs = buildHandoffActions(
      {
        state: "blocked",
        blockers: [],
        warnings: [],
        generatedAt: "",
        load: { one: 1, five: 1, fifteen: 1 },
        memory: {
          totalBytes: 0,
          freeBytes: 0,
          freePercent: 0,
          pressure: { available: false, freePercentReported: null, sample: "" },
        },
        disk: { available: true },
        swap: { available: true, usedBytes: 100 * GIB },
        thresholds: { diskMinFreeBytes: 0, diskMinFreePercent: 0, swapMaxUsedBytes: 0 },
      },
      cfg,
    );
    expect(handoffs.find((h) => h.action === "restart-mac-after-saving-work")).toBeDefined();
  });
});

describe("writeApprovalCapsules", () => {
  let root: string;
  let cfg: HealthStewardConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes one capsule per approval action", () => {
    const paths = writeApprovalCapsules(cfg, [
      {
        approvalId: "approval-test",
        action: "cloud-offload",
        title: "T",
        risk: "R",
        confirm: "RUN_APPROVED_CLOUD_OFFLOAD",
        why: "W",
      },
    ]);
    expect(paths).toHaveLength(1);
    const capsule = JSON.parse(readFileSync(paths[0]!, "utf8"));
    expect(capsule).toMatchObject({
      schema: "chuck-v3.approval-capsule/1",
      approvalId: "approval-test",
      domain: "health-steward",
      status: "pending",
      action: "cloud-offload",
    });
  });
});

describe("latestVerifiedLocalArchiveCandidate", () => {
  let root: string;
  let cfg: HealthStewardConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
    mkdirSync(cfg.macSelfHealReceiptsDir, { recursive: true });
    mkdirSync(cfg.macSelfHealArchivesDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns unavailable when no receipts", () => {
    const candidate = latestVerifiedLocalArchiveCandidate(cfg);
    expect(candidate).toMatchObject({ available: false, blocked: false });
  });

  it("blocks when cloud copies are missing", () => {
    const archiveRoot = join(cfg.macSelfHealArchivesDir, "rec-1");
    mkdirSync(archiveRoot, { recursive: true });
    writeFileSync(join(archiveRoot, "f.bin"), "x");
    writeFileSync(
      join(cfg.macSelfHealReceiptsDir, "r1.json"),
      JSON.stringify({
        receiptId: "rec-1",
        appliedBytes: 1,
        results: [
          {
            status: "applied",
            action: "copied-to-cloud-and-moved-local-archive",
            cloudPath: "/this/cloud/path/does/not/exist",
            localArchivePath: join(archiveRoot, "f.bin"),
            bytes: 1,
          },
        ],
      }),
    );
    const candidate = latestVerifiedLocalArchiveCandidate(cfg);
    expect(candidate).toMatchObject({ available: false, blocked: true, missingCloudCount: 1 });
  });

  it("returns available when cloud copy exists and local archive is present", () => {
    const archiveRoot = join(cfg.macSelfHealArchivesDir, "rec-2");
    mkdirSync(archiveRoot, { recursive: true });
    const localFile = join(archiveRoot, "f.bin");
    writeFileSync(localFile, "x");
    const cloudFile = join(root, "cloud", "f.bin");
    mkdirSync(join(root, "cloud"), { recursive: true });
    writeFileSync(cloudFile, "x");
    writeFileSync(
      join(cfg.macSelfHealReceiptsDir, "r2.json"),
      JSON.stringify({
        receiptId: "rec-2",
        appliedBytes: 1024,
        results: [
          {
            status: "applied",
            action: "copied-to-cloud-and-moved-local-archive",
            cloudPath: cloudFile,
            localArchivePath: localFile,
            bytes: 1024,
          },
        ],
      }),
    );
    const candidate = latestVerifiedLocalArchiveCandidate(cfg);
    expect(candidate).toMatchObject({
      available: true,
      receiptId: "rec-2",
      bytes: 1024,
      fileCount: 1,
      cloudCopiesVerified: 1,
    });
  });
});

describe("buildStatus", () => {
  let root: string;
  let cfg: HealthStewardConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("composes a full status payload with injected probes + selfHeal", async () => {
    const status = await buildStatus(cfg, {
      probes: makeProbes(),
      selfHeal: makeSelfHeal(),
    });
    expect(status.schema).toBe("chuck-v3.health-steward/1");
    expect(status.state).toBe("clear");
    expect(status.executor.paused).toBe(false);
    expect(status.docket.total).toBe(0);
    expect(status.automaticActions).toEqual([]);
    expect(status.approvalCapsulePaths).toEqual([]);
    expect(status.phoneReady.approvalCapsules).toBe(true);
  });

  it("writes approval capsules when writeApprovals=true", async () => {
    // Inject a state with cloud-offload candidate so an approval capsule is generated.
    const selfHeal = makeSelfHeal({
      plan: vi.fn(async (opts: { allowCloudOffload?: boolean }) => ({
        ok: true as const,
        parsed: opts.allowCloudOffload
          ? {
              actionCount: 5,
              reclaimableBytes: 5000,
              cloud: { available: true, archivePath: "/x" },
            }
          : { actionCount: 1, reclaimableBytes: 100 },
      })),
    });
    const status = await buildStatus(cfg, {
      probes: makeProbes(),
      selfHeal,
      writeApprovals: true,
    });
    expect(status.approvalActions.find((a) => a.action === "cloud-offload")).toBeDefined();
    expect(status.approvalCapsulePaths.length).toBeGreaterThan(0);
  });
});

describe("stabilize", () => {
  let root: string;
  let cfg: HealthStewardConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("on clear health emits no actions and writes a receipt", async () => {
    const result = await stabilize(cfg, {
      probes: makeProbes(),
      selfHeal: makeSelfHeal(),
      receiptIdGen: () => "fixed-id-1",
    });
    expect(result.ok).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.path).toMatch(/fixed-id-1\.json$/);
    const receipt = JSON.parse(readFileSync(result.path, "utf8"));
    expect(receipt).toMatchObject({
      schema: "chuck-v3.health-steward/1",
      receiptId: "fixed-id-1",
      mode: "stabilize",
    });
  });

  it("on blocked health pauses executor + runs safe self-heal", async () => {
    const planSafe: SelfHealPlan = { actionCount: 3, reclaimableBytes: 300 };
    const probes = makeProbes({
      disk: () => ({
        available: true,
        totalBytes: 100 * GIB,
        freeBytes: 1 * GIB,
        freePercent: 0.01,
      }),
    });
    const applyMock = vi.fn(async () => ({
      ok: true as const,
      parsed: { receiptId: "self-heal-x" },
    }));
    const selfHeal = makeSelfHeal({
      plan: vi.fn(async () => ({ ok: true as const, parsed: planSafe })),
      apply: applyMock,
    });
    const result = await stabilize(cfg, { probes, selfHeal, receiptIdGen: () => "rec-blocked" });
    expect(result.results.find((r) => r.action === "pause-executor-intake")).toBeDefined();
    expect(result.results.find((r) => r.action === "run-safe-self-heal")).toBeDefined();
    expect(applyMock).toHaveBeenCalledWith(expect.objectContaining({ onlyUnderPressure: true }));
    const ctrl = readExecutorControl(cfg);
    expect(ctrl.paused).toBe(true);
  });
});

describe("applyAction", () => {
  let root: string;
  let cfg: HealthStewardConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects cloud-offload without correct confirm", async () => {
    await expect(
      applyAction(cfg, { action: "cloud-offload", confirm: "WRONG" }, { selfHeal: makeSelfHeal() }),
    ).rejects.toThrow(/RUN_APPROVED_CLOUD_OFFLOAD/);
  });

  it("runs cloud-offload with valid confirm", async () => {
    const applyMock = vi.fn(async () => ({
      ok: true as const,
      parsed: { receiptId: "self-heal-z" },
    }));
    const result = await applyAction(
      cfg,
      { action: "cloud-offload", confirm: "RUN_APPROVED_CLOUD_OFFLOAD" },
      { selfHeal: makeSelfHeal({ apply: applyMock }) },
    );
    expect(result.ok).toBe(true);
    expect(applyMock).toHaveBeenCalledWith(expect.objectContaining({ allowCloudOffload: true }));
  });

  it("rejects purge-local-archive without correct confirm", async () => {
    await expect(
      applyAction(cfg, { action: "purge-local-archive", confirm: "no" }, {}),
    ).rejects.toThrow(/PURGE_VERIFIED_LOCAL_ARCHIVE/);
  });

  it("returns unavailable when there is no purgeable candidate", async () => {
    mkdirSync(cfg.macSelfHealReceiptsDir, { recursive: true });
    const result = await applyAction(
      cfg,
      { action: "purge-local-archive", confirm: "PURGE_VERIFIED_LOCAL_ARCHIVE" },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.available).toBe(false);
  });

  it("write-approval-capsules writes the current approval set to disk", async () => {
    const selfHeal = makeSelfHeal({
      plan: vi.fn(async (opts: { allowCloudOffload?: boolean }) => ({
        ok: true as const,
        parsed: opts.allowCloudOffload
          ? {
              actionCount: 5,
              reclaimableBytes: 5000,
              cloud: { available: true, archivePath: "/x" },
            }
          : { actionCount: 1, reclaimableBytes: 100 },
      })),
    });
    const result = await applyAction(
      cfg,
      { action: "write-approval-capsules" },
      { selfHeal, probes: makeProbes() },
    );
    expect(result.ok).toBe(true);
    expect(result.approvalCapsulePaths?.length).toBeGreaterThan(0);
  });

  it("throws on unknown action", async () => {
    await expect(applyAction(cfg, { action: "no-such" }, {})).rejects.toThrow(
      /unknown health steward action/,
    );
  });
});
