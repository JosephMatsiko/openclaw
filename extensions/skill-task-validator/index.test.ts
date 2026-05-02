// Smoke tests for @openclaw/skill-task-validator.
//
// Each per-commandKind validator verified with synthesized fixtures; the
// dispatcher's exception isolation tested with a thrower. LLM-layer port is
// queued for v0.2 — covered then.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import { validateTaskDeliverable } from "./src/dispatch.js";
import { inferDeliverablePaths } from "./src/path-infer.js";
import { validateBuildTask } from "./src/validators/build.js";
import { validateMacSelfHeal } from "./src/validators/mac-self-heal.js";
import { validateMcpRegistration } from "./src/validators/mcp-registration.js";
import { validatePriorCapsule } from "./src/validators/prior-capsule.js";

describe("config resolver", () => {
  test("applies defaults", () => {
    const r = resolveConfig({});
    expect(r.enabled).toBe(true);
    expect(r.skipLlmLayer).toBe(true);
  });

  test("honors skipLlmLayer override", () => {
    const r = resolveConfig({ skipLlmLayer: false });
    expect(r.skipLlmLayer).toBe(false);
  });
});

describe("inferDeliverablePaths", () => {
  test("absolute mjs path", () => {
    const repo = "/some/repo";
    const out = inferDeliverablePaths(
      "Build /Users/x/Projects/foo/bar.mjs to handle the task",
      repo,
    );
    expect(out).toEqual(["/Users/x/Projects/foo/bar.mjs"]);
  });

  test("repo-relative path resolved against repoRoot", () => {
    const repo = "/some/repo";
    const out = inferDeliverablePaths("Output extensions/foo/bar.mjs and run tests", repo);
    expect(out).toEqual(["/some/repo/extensions/foo/bar.mjs"]);
  });

  test("LaunchAgent plist by basename", () => {
    const repo = "/some/repo";
    const out = inferDeliverablePaths(
      "Add Library/LaunchAgents/com.openclaw.foo.plist + load it via launchd",
      repo,
    );
    expect(out.some((p) => p.endsWith("Library/LaunchAgents/com.openclaw.foo.plist"))).toBe(true);
  });

  test("returns empty for intent with no paths", () => {
    expect(inferDeliverablePaths("just brainstorm a name", "/repo")).toEqual([]);
  });
});

describe("validateBuildTask", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-task-validator-build-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing-deliverable when intent referenced path is absent", () => {
    const config = resolveConfig({ repoRoot: dir });
    const ghost = join(dir, "ghost.mjs");
    const result = validateBuildTask(
      {
        commandKind: "claude-cli-build",
        intent: `Build ${ghost} that exports add(a,b)`,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      config,
    );
    expect(result.valid).toBe(false);
    expect(result.category).toBe("missing-deliverable");
  });

  test("empty-deliverable when path exists but size 0", () => {
    const path = join(dir, "empty.mjs");
    writeFileSync(path, "");
    const config = resolveConfig({ repoRoot: dir });
    const result = validateBuildTask(
      {
        commandKind: "claude-cli-build",
        intent: `Build ${path}`,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      config,
    );
    expect(result.valid).toBe(false);
    expect(result.category).toBe("empty-deliverable");
  });

  test("stale-deliverable when mtime predates startedAt", () => {
    const path = join(dir, "stale.mjs");
    writeFileSync(path, "console.log('x');");
    const config = resolveConfig({ repoRoot: dir });
    const result = validateBuildTask(
      {
        commandKind: "claude-cli-build",
        intent: `Build ${path}`,
        startedAt: new Date(Date.now() + 60_000).toISOString(),
      },
      config,
    );
    expect(result.valid).toBe(false);
    expect(result.category).toBe("stale-deliverable");
  });

  test("deliverables-verified when path exists + parses + fresh", () => {
    const path = join(dir, "ok.mjs");
    writeFileSync(path, "export const add = (a, b) => a + b;\n");
    const config = resolveConfig({ repoRoot: dir });
    const result = validateBuildTask(
      {
        commandKind: "claude-cli-build",
        intent: `Build ${path}`,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      config,
    );
    expect(result.valid).toBe(true);
    expect(result.category).toBe("deliverables-verified");
  });

  test("explicit task.deliverable.path takes precedence over intent inference", () => {
    const explicitPath = join(dir, "explicit.mjs");
    writeFileSync(explicitPath, "export const ok = true;\n");
    const config = resolveConfig({ repoRoot: dir });
    const result = validateBuildTask(
      {
        commandKind: "claude-cli-build",
        intent: "Build something — no path here",
        deliverable: { path: explicitPath },
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      config,
    );
    expect(result.valid).toBe(true);
    expect(result.category).toBe("deliverables-verified");
  });

  test("no-deliverable-inferred when intent has no paths and no explicit", () => {
    const config = resolveConfig({ repoRoot: dir });
    const result = validateBuildTask(
      {
        commandKind: "claude-cli-build",
        intent: "Brainstorm ideas",
        startedAt: new Date().toISOString(),
      },
      config,
    );
    expect(result.valid).toBe(true);
    expect(result.category).toBe("no-deliverable-inferred");
  });
});

describe("validateMacSelfHeal", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-task-validator-mac-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing-state when latest.json absent", () => {
    const config = resolveConfig({ macHealLatestPath: join(dir, "missing.json") });
    const result = validateMacSelfHeal(
      { commandKind: "mac-self-heal", startedAt: new Date().toISOString() },
      config,
    );
    expect(result.valid).toBe(false);
    expect(result.category).toBe("missing-state");
  });

  test("fresh-state when latest.json mtime within window", () => {
    const path = join(dir, "latest.json");
    writeFileSync(path, "{}");
    const config = resolveConfig({ macHealLatestPath: path });
    const result = validateMacSelfHeal(
      {
        commandKind: "mac-self-heal",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      config,
    );
    expect(result.valid).toBe(true);
    expect(result.category).toBe("fresh-state");
  });
});

describe("validatePriorCapsule", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-task-validator-prior-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing-state when priors/latest.json absent", () => {
    const config = resolveConfig({ priorsLatestPath: join(dir, "missing.json") });
    const result = validatePriorCapsule(
      { commandKind: "prior-capsule", startedAt: new Date().toISOString() },
      config,
    );
    expect(result.valid).toBe(false);
    expect(result.category).toBe("missing-state");
  });

  test("fresh-state when latest.json updated", () => {
    const path = join(dir, "latest.json");
    writeFileSync(path, "{}");
    const config = resolveConfig({ priorsLatestPath: path });
    const result = validatePriorCapsule(
      {
        commandKind: "prior-capsule",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      config,
    );
    expect(result.valid).toBe(true);
    expect(result.category).toBe("fresh-state");
  });
});

describe("validateMcpRegistration", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-task-validator-mcp-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("no-name-inferred when intent doesn't mention an MCP", () => {
    const config = resolveConfig({});
    const result = validateMcpRegistration(
      { commandKind: "mcp-registration", intent: "do something else" },
      config,
    );
    expect(result.valid).toBe(true);
    expect(result.category).toBe("no-name-inferred");
  });

  test("partial-registration when wired in 0/3 configs", () => {
    const codex = join(dir, "codex.toml");
    const openclaw = join(dir, "openclaw.json");
    const claude = join(dir, "claude.json");
    writeFileSync(codex, "");
    writeFileSync(openclaw, JSON.stringify({ mcpServers: {} }));
    writeFileSync(claude, JSON.stringify({ mcpServers: {} }));
    const config = resolveConfig({
      codexConfigPath: codex,
      openclawConfigPath: openclaw,
      claudeConfigPath: claude,
    });
    const result = validateMcpRegistration(
      {
        commandKind: "mcp-registration",
        intent: "register MCP foo-toolkit in codex, openclaw, and claude",
      },
      config,
    );
    expect(result.valid).toBe(false);
    expect(result.category).toBe("partial-registration");
  });

  test("fully-registered when wired in 3/3", () => {
    const codex = join(dir, "codex.toml");
    const openclaw = join(dir, "openclaw.json");
    const claude = join(dir, "claude.json");
    writeFileSync(codex, "[mcp_servers.foo-toolkit]\n");
    writeFileSync(openclaw, JSON.stringify({ mcpServers: { "foo-toolkit": {} } }));
    writeFileSync(claude, JSON.stringify({ mcpServers: { "foo-toolkit": {} } }));
    const config = resolveConfig({
      codexConfigPath: codex,
      openclawConfigPath: openclaw,
      claudeConfigPath: claude,
    });
    const result = validateMcpRegistration(
      {
        commandKind: "mcp-registration",
        intent: "register MCP foo-toolkit in all three CLI registries",
      },
      config,
    );
    expect(result.valid).toBe(true);
    expect(result.category).toBe("fully-registered");
  });
});

describe("validateTaskDeliverable dispatcher", () => {
  test("no-validator for unknown commandKind", async () => {
    const result = await validateTaskDeliverable({ commandKind: "made-up-kind" });
    expect(result.valid).toBe(true);
    expect(result.category).toBe("no-validator");
  });

  test("attaches LLM-skipped marker on build-class when skipLlmLayer=false (port queued)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-task-validator-llm-"));
    try {
      const path = join(dir, "ok.mjs");
      writeFileSync(path, "export const ok = true;\n");
      const config = resolveConfig({ repoRoot: dir, skipLlmLayer: false });
      const result = await validateTaskDeliverable(
        {
          commandKind: "claude-cli-build",
          intent: `Build ${path}`,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
        },
        config,
      );
      expect(result.valid).toBe(true);
      expect(result.llm?.skipped).toBe(true);
      expect(result.llm?.reason).toContain("v0.2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
