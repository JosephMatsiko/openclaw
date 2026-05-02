// Smoke tests for @openclaw/skill-self-improvement-scanner.
//
// Each detector verified with synthesized fixtures; runScan integration
// covered with dry-run + real-write paths against tmp dirs.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import { detectBusDiversity } from "./src/detectors/busdiversity.js";
import { detectDocketHealth } from "./src/detectors/dockethealth.js";
import { detectMcpGap } from "./src/detectors/mcpgap.js";
import { detectPlistGap } from "./src/detectors/plistgap.js";
import { detectSkillGap, EXECUTOR_COMMAND_KINDS } from "./src/detectors/skillgap.js";
import { detectStuckPending } from "./src/detectors/stuckpending.js";
import { runScan } from "./src/scan.js";
import { buildTask } from "./src/task.js";
import type { DocketTask } from "./src/types.js";
import { existingFingerprints } from "./src/util.js";

const NOW = Date.parse("2026-05-01T20:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

function freshTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `skill-self-improvement-scanner-${prefix}-`));
}

describe("config resolver", () => {
  test("applies defaults", () => {
    const r = resolveConfig({});
    expect(r.enabled).toBe(true);
    expect(r.maxDropsPerScan).toBe(5);
  });

  test("clamps invalid values", () => {
    const r = resolveConfig({ maxDropsPerScan: 999 } as unknown as Record<string, unknown>);
    expect(r.maxDropsPerScan).toBe(5);
  });
});

describe("existingFingerprints", () => {
  test("collects only same-kind same-category pending|running tasks", () => {
    const tasks: DocketTask[] = [
      {
        id: "t1",
        status: "pending",
        source: {
          kind: "chuck-self-improvement-scanner",
          category: "mcpgap",
          fingerprint: "abc",
        },
      },
      {
        id: "t2",
        status: "completed",
        source: {
          kind: "chuck-self-improvement-scanner",
          category: "mcpgap",
          fingerprint: "skipme",
        },
      },
      {
        id: "t3",
        status: "running",
        source: {
          kind: "different-scanner",
          category: "mcpgap",
          fingerprint: "wrongkind",
        },
      },
    ];
    const fps = existingFingerprints(tasks, "mcpgap");
    expect(fps.has("abc")).toBe(true);
    expect(fps.has("skipme")).toBe(false);
    expect(fps.has("wrongkind")).toBe(false);
  });
});

describe("detectDocketHealth", () => {
  test("emits when >5 failed in 24h", () => {
    const tasks: DocketTask[] = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      status: "failed",
      finishedAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
    }));
    const config = resolveConfig({});
    const hit = detectDocketHealth({
      tasks,
      openFps: new Set(),
      config,
      now: NOW,
    });
    expect(hit).not.toBeNull();
    expect(hit?.category).toBe("dockethealth");
  });

  test("returns null with <=5 failed", () => {
    const tasks: DocketTask[] = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      status: "failed",
      finishedAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
    }));
    const config = resolveConfig({});
    expect(detectDocketHealth({ tasks, openFps: new Set(), config, now: NOW })).toBeNull();
  });
});

describe("detectStuckPending", () => {
  test("emits for pending older than 6h", () => {
    const tasks: DocketTask[] = [
      {
        id: "t-old",
        status: "pending",
        commandKind: "doctor",
        createdAt: new Date(NOW - 12 * HOUR_MS).toISOString(),
      },
      {
        id: "t-new",
        status: "pending",
        createdAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
      },
    ];
    const config = resolveConfig({});
    const hits = detectStuckPending({ tasks, openFps: new Set(), config, now: NOW });
    expect(hits.length).toBe(1);
    expect(hits[0].title).toContain("t-old");
  });
});

describe("detectPlistGap", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshTmp("plist");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("emits when daemon-shape mjs has no plist", () => {
    const scriptsDir = join(dir, "scripts");
    const launchAgents = join(dir, "agents");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(scriptsDir, "chuck-foo-scanner.mjs"), "");
    const config = resolveConfig({ scriptsDir, launchAgentsDir: launchAgents });
    const hits = detectPlistGap({ tasks: [], openFps: new Set(), config, now: NOW });
    expect(hits.length).toBe(1);
    expect(hits[0].title).toContain("chuck-foo-scanner");
  });

  test("returns empty when plist exists", () => {
    const scriptsDir = join(dir, "scripts");
    const launchAgents = join(dir, "agents");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(scriptsDir, "chuck-foo-executor.mjs"), "");
    writeFileSync(join(launchAgents, "com.openclaw.chuck-foo-executor.plist"), "");
    const config = resolveConfig({ scriptsDir, launchAgentsDir: launchAgents });
    expect(detectPlistGap({ tasks: [], openFps: new Set(), config, now: NOW })).toEqual([]);
  });
});

describe("detectSkillGap", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshTmp("skill");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("emits one Gap per executor commandKind without a matching skill", () => {
    const skillsDir = join(dir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    // Create a directory matching just one of the executor kinds.
    mkdirSync(join(skillsDir, "claude-cli-build-helper"));
    const config = resolveConfig({ skillsDir });
    const hits = detectSkillGap({ tasks: [], openFps: new Set(), config, now: NOW });
    expect(hits.length).toBe(EXECUTOR_COMMAND_KINDS.length - 1);
  });

  test("returns empty when skillsDir missing", () => {
    const config = resolveConfig({ skillsDir: join(dir, "missing") });
    expect(detectSkillGap({ tasks: [], openFps: new Set(), config, now: NOW })).toEqual([]);
  });
});

describe("detectBusDiversity", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshTmp("bus");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("emits when fewer than 10 distinct types", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(
      path,
      Array.from({ length: 50 }, () =>
        JSON.stringify({ ts: new Date().toISOString(), type: "chuck.test.one" }),
      ).join("\n"),
    );
    const config = resolveConfig({ eventsPath: path });
    const hit = detectBusDiversity({ tasks: [], openFps: new Set(), config, now: NOW });
    expect(hit).not.toBeNull();
  });

  test("returns null with >=10 distinct types", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(
      path,
      Array.from({ length: 30 }, (_, i) =>
        JSON.stringify({ ts: new Date().toISOString(), type: `chuck.test.${i % 12}` }),
      ).join("\n"),
    );
    const config = resolveConfig({ eventsPath: path });
    expect(detectBusDiversity({ tasks: [], openFps: new Set(), config, now: NOW })).toBeNull();
  });
});

describe("detectMcpGap", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshTmp("mcp");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("emits when MCP-shape script not in registries", () => {
    const scriptsDir = join(dir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "apex-fictional-toolkit.mjs"),
      "import { McpServer } from 'somewhere';\nconst s = new McpServer({});\n",
    );
    const codex = join(dir, "codex.toml");
    const openclaw = join(dir, "openclaw.json");
    const claude = join(dir, "claude.json");
    writeFileSync(codex, "");
    writeFileSync(openclaw, JSON.stringify({ mcpServers: {} }));
    writeFileSync(claude, JSON.stringify({ mcpServers: {} }));
    const config = resolveConfig({
      scriptsDir,
      codexConfigPath: codex,
      openclawConfigPath: openclaw,
      claudeConfigPath: claude,
    });
    const hits = detectMcpGap({ tasks: [], openFps: new Set(), config, now: NOW });
    expect(hits.length).toBe(1);
    expect(hits[0].title).toContain("apex-fictional-toolkit");
    expect(hits[0].deliverable?.paths?.length).toBe(3);
  });
});

describe("buildTask", () => {
  test("produces well-formed pending claude-cli-build task", () => {
    const task = buildTask(
      {
        category: "stuckpending",
        fingerprint: "abc",
        title: "test",
        intent: "diagnose stuckpending",
      },
      NOW,
    );
    expect(task.status).toBe("pending");
    expect(task.risk).toBe("low");
    expect(task.commandKind).toBe("claude-cli-build");
    expect(task.source?.kind).toBe("chuck-self-improvement-scanner");
    expect(task.source?.category).toBe("stuckpending");
    expect(task.source?.fingerprint).toBe("abc");
  });

  test("attaches explicit deliverable when supplied", () => {
    const task = buildTask(
      {
        category: "mcpgap",
        fingerprint: "xyz",
        title: "register",
        intent: "register MCP",
        deliverable: { paths: ["/a", "/b"] },
      },
      NOW,
    );
    expect(task.deliverable).toEqual({ paths: ["/a", "/b"] });
  });
});

describe("runScan integration (dryRun)", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshTmp("scan");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs every detector and emits no tasks when no gaps", async () => {
    const config = resolveConfig({
      scriptsDir: join(dir, "scripts"),
      docketDir: join(dir, "docket"),
      selfImprovDir: join(dir, "selfimprov"),
      eventsPath: join(dir, "events.jsonl"),
      launchAgentsDir: join(dir, "agents"),
      skillsDir: join(dir, "skills"),
      codexConfigPath: join(dir, "codex.toml"),
      openclawConfigPath: join(dir, "openclaw.json"),
      claudeConfigPath: join(dir, "claude.json"),
    });
    const summary = await runScan({ dryRun: true, now: NOW }, config);
    expect(summary.dryRun).toBe(true);
    expect(summary.gapsFound).toBe(0);
    expect(summary.dropped).toEqual([]);
  });

  test("respects maxDropsPerScan flood cap", async () => {
    const docket = join(dir, "docket");
    mkdirSync(docket, { recursive: true });
    // Plant 8 stuck-pending tasks (each will produce a stuckpending gap).
    for (let i = 0; i < 8; i++) {
      writeFileSync(
        join(docket, `task-stuck-${i}.json`),
        JSON.stringify({
          id: `task-stuck-${i}`,
          status: "pending",
          commandKind: "doctor",
          createdAt: new Date(NOW - 12 * HOUR_MS).toISOString(),
          title: "test stuck",
        }),
      );
    }
    const config = resolveConfig({
      scriptsDir: join(dir, "scripts"),
      docketDir: docket,
      selfImprovDir: join(dir, "selfimprov"),
      eventsPath: join(dir, "events.jsonl"),
      launchAgentsDir: join(dir, "agents"),
      skillsDir: join(dir, "skills"),
      codexConfigPath: join(dir, "codex.toml"),
      openclawConfigPath: join(dir, "openclaw.json"),
      claudeConfigPath: join(dir, "claude.json"),
      maxDropsPerScan: 3,
    });
    const summary = await runScan({ dryRun: true, now: NOW }, config);
    expect(summary.gapsFound).toBe(8);
    expect(summary.dropped.length).toBe(3);
    expect(summary.floodSkipped).toBe(5);
  });

  test("non-dryRun writes task files + last-scan.json", async () => {
    const docket = join(dir, "docket");
    mkdirSync(docket, { recursive: true });
    writeFileSync(
      join(docket, "task-stuck-x.json"),
      JSON.stringify({
        id: "task-stuck-x",
        status: "pending",
        commandKind: "doctor",
        createdAt: new Date(NOW - 12 * HOUR_MS).toISOString(),
        title: "test",
      }),
    );
    const config = resolveConfig({
      scriptsDir: join(dir, "scripts"),
      docketDir: docket,
      selfImprovDir: join(dir, "selfimprov"),
      eventsPath: join(dir, "events.jsonl"),
      launchAgentsDir: join(dir, "agents"),
      skillsDir: join(dir, "skills"),
      codexConfigPath: join(dir, "codex.toml"),
      openclawConfigPath: join(dir, "openclaw.json"),
      claudeConfigPath: join(dir, "claude.json"),
    });
    const summary = await runScan({ dryRun: false, now: NOW }, config);
    expect(summary.dropped.length).toBe(1);
    expect(summary.dropped[0].path).toBeTruthy();
    const newTaskFiles = readdirSync(docket).filter((n) => n.startsWith("task-selfimprov-"));
    expect(newTaskFiles.length).toBe(1);
    const lastScan = JSON.parse(readFileSync(join(dir, "selfimprov", "last-scan.json"), "utf8"));
    expect(lastScan.openTaskIdsByCategory.stuckpending.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "selfimprov", "last-scan.json"))).toBe(true);
  });
});
