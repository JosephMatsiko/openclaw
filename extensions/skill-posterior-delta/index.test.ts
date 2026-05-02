// Test suite for @openclaw/skill-posterior-delta.
//
// Uses real Ajv validators so the schema files are exercised end-to-end.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDelta,
  buildReadMarker,
  confidenceForExecution,
  createValidators,
  extractRecommendations,
  parseScoutSections,
  resolveConfig,
  runFromExecution,
  type PosteriorDeltaConfig,
} from "./api.js";

const REPO_DESIGN_DIR = resolve(__dirname, "..", "memory-graph", "data", "chuck-v2-design");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "skill-posterior-delta-"));
}

function makeConfig(
  root: string,
  overrides: Partial<PosteriorDeltaConfig> = {},
): PosteriorDeltaConfig {
  const base = resolveConfig({
    deltasDir: join(root, "posterior-deltas"),
    readMarkersDir: join(root, "read-markers"),
    priorsDir: join(root, "priors"),
    runsDir: join(root, "runs"),
    designDir: REPO_DESIGN_DIR,
  });
  return { ...base, ...overrides };
}

describe("config", () => {
  it("clamps out-of-range values to defaults", () => {
    const cfg = resolveConfig({
      maxClaimsPerDelta: -1,
      maxOpenQuestions: 9999,
      maxRecommendations: 0,
    });
    expect(cfg.maxClaimsPerDelta).toBe(12);
    expect(cfg.maxOpenQuestions).toBe(12);
    expect(cfg.maxRecommendations).toBe(8);
  });

  it("derives latest prior path from priorsDir", () => {
    const cfg = resolveConfig({ priorsDir: "/x/y" });
    expect(cfg.latestPriorPath).toBe("/x/y/latest.json");
  });
});

describe("parseScoutSections", () => {
  it("splits CLAIMS / RISKS / MISSING_EVIDENCE / DEEPEN_NEEDED", () => {
    const text = `CLAIMS:
- claim alpha
- claim beta
RISKS:
- watch the lock
MISSING_EVIDENCE:
- need more transcripts
DEEPEN_NEEDED:
yes`;
    const sections = parseScoutSections(text);
    expect(sections.claims).toEqual(["claim alpha", "claim beta"]);
    expect(sections.risks).toEqual(["watch the lock"]);
    expect(sections.missingEvidence).toEqual(["need more transcripts"]);
    expect(sections.deepenNeeded).toBe("yes");
  });

  it("supports inline label content (LABEL: value on same line)", () => {
    const sections = parseScoutSections("CLAIMS: alpha\nDEEPEN_NEEDED: no\n");
    expect(sections.claims).toEqual(["alpha"]);
    expect(sections.deepenNeeded).toBe("no");
  });

  it("breaks section on Verdict / Strongest Insight headers", () => {
    const text = `CLAIMS:
- alpha
Verdict:
something else
RISKS:
- ought to be standalone`;
    const sections = parseScoutSections(text);
    expect(sections.claims).toEqual(["alpha"]);
    expect(sections.risks).toEqual(["ought to be standalone"]);
  });
});

describe("extractRecommendations", () => {
  it("collects recommendations under the header until a section break", () => {
    const text = `Recommendation:
- ship the wrapper
- audit the bus
CLAIMS:
- something else`;
    const sections = parseScoutSections(text);
    const recs = extractRecommendations(text, sections, 8);
    expect(recs).toEqual(["ship the wrapper", "audit the bus"]);
  });

  it("falls back to whole text for short / structureless input", () => {
    const text = "just a short reason string";
    const sections = parseScoutSections(text);
    const recs = extractRecommendations(text, sections, 8);
    expect(recs).toEqual(["just a short reason string"]);
  });

  it("respects the cap parameter", () => {
    const text = `Recommendation:
- a
- b
- c
- d
- e`;
    const sections = parseScoutSections(text);
    const recs = extractRecommendations(text, sections, 3);
    expect(recs).toEqual(["a", "b", "c"]);
  });
});

describe("confidenceForExecution", () => {
  it("low for non-completed", () => {
    expect(confidenceForExecution({ status: "failed" })).toBe("low");
  });
  it("high for counting-eligible + usable", () => {
    expect(
      confidenceForExecution({
        status: "completed",
        countingEligible: true,
        calibration: { verdict: "usable" },
      }),
    ).toBe("high");
  });
  it("medium for counting-eligible without usable verdict", () => {
    expect(confidenceForExecution({ status: "completed", countingEligible: true })).toBe("medium");
  });
  it("low for completed but not counting-eligible", () => {
    expect(confidenceForExecution({ status: "completed", countingEligible: false })).toBe("low");
  });
});

describe("buildDelta", () => {
  let root: string;
  let cfg: PosteriorDeltaConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("produces a schema-valid delta from a counting-eligible item", () => {
    const validators = createValidators(cfg);
    const delta = buildDelta(cfg, {
      execution: { runId: "run-1", dispatchId: "disp-1" },
      run: null,
      task: null,
      prior: null,
      item: {
        surface: "claude-cli",
        family: "Claude",
        status: "completed",
        countingEligible: true,
        calibration: { verdict: "usable" },
        text: "CLAIMS:\n- alpha\n- beta\nRecommendation:\n- ship now",
        receipt: { startedAt: "2026-05-01T00:00:00.000Z", endedAt: "2026-05-01T00:00:30.000Z" },
      },
      executionPath: "/tmp/exec-x.json",
    });
    expect(delta.schemaVersion).toBe("chuck.posterior-delta.v1");
    expect(delta.deltaId).toMatch(/^delta-[0-9TZ-]+-[a-f0-9]{12}$/);
    expect(delta.confidence).toBe("high");
    expect(delta.authorityImpact).toBe("proposal");
    expect(delta.claims.map((c) => c.text)).toEqual(["alpha", "beta"]);
    expect(delta.recommendedNextActions).toContain("ship now");
    expect(validators.validateDelta(delta)).toBe(true);
  });

  it("falls back to a single status claim when sections are empty (failed)", () => {
    const delta = buildDelta(cfg, {
      execution: { runId: "run-2" },
      run: null,
      task: null,
      prior: null,
      item: {
        surface: "grok-web",
        family: "Grok",
        status: "failed",
        reason: "rate-limited 429",
        text: "",
        receipt: {},
      },
      executionPath: "/tmp/exec-y.json",
    });
    expect(delta.claims).toHaveLength(1);
    expect(delta.claims[0]?.status).toBe("contested");
    expect(delta.authorityImpact).toBe("blocked");
    expect(delta.openQuestions[0]).toMatch(/Investigate grok-web failure/);
  });

  it("uses task.id over run.runId for taskId resolution", () => {
    const delta = buildDelta(cfg, {
      execution: { runId: "run-3" },
      run: { runId: "run-3", createdAt: "2026-05-01T00:00:00.000Z" },
      task: { id: "task-explicit-id" },
      prior: null,
      item: { surface: "x", family: "y", status: "completed", countingEligible: true, text: "" },
      executionPath: "/tmp/exec-z.json",
    });
    expect(delta.taskId).toBe("task-explicit-id");
  });

  it("respects maxClaimsPerDelta cap", () => {
    const cfgCap = makeConfig(root, { maxClaimsPerDelta: 2 } as Partial<PosteriorDeltaConfig>);
    const text = "CLAIMS:\n- a\n- b\n- c\n- d";
    const delta = buildDelta(cfgCap, {
      execution: { runId: "run-cap" },
      run: null,
      task: null,
      prior: null,
      item: { surface: "x", family: "y", status: "completed", countingEligible: true, text },
      executionPath: "/tmp/cap.json",
    });
    expect(delta.claims).toHaveLength(2);
    expect(delta.claims.map((c) => c.text)).toEqual(["a", "b"]);
  });
});

describe("buildReadMarker", () => {
  it("returns null when prior was NOT injected", () => {
    const marker = buildReadMarker({
      task: {},
      prior: null,
      item: { status: "completed" },
      delta: {
        createdAt: "2026-05-01T00:00:00.000Z",
        priorId: "p1",
        deltaId: "d1",
        producer: {
          family: "f",
          surface: "s",
          voice: null,
          modelClaimed: null,
          modelVerified: null,
        },
      } as never,
    });
    expect(marker).toBeNull();
  });

  it("returns null when item is not completed", () => {
    const marker = buildReadMarker({
      task: { priorCapsuleBefore: { injectedIntoPrompt: true, scope: "summary" } },
      prior: null,
      item: { status: "failed" },
      delta: {
        createdAt: "2026-05-01T00:00:00.000Z",
        priorId: "p1",
        deltaId: "d1",
        producer: {
          family: "f",
          surface: "s",
          voice: null,
          modelClaimed: null,
          modelVerified: null,
        },
      } as never,
    });
    expect(marker).toBeNull();
  });

  it("emits a schema-valid marker when prior was injected and item completed", () => {
    const marker = buildReadMarker({
      task: {
        priorCapsuleBefore: { injectedIntoPrompt: true, scope: "summary", priorId: "prior-x" },
      },
      prior: { priorId: "prior-x" },
      item: {
        status: "completed",
        countingEligible: true,
        receipt: { startedAt: "2026-05-01T00:00:00.000Z" },
      },
      delta: {
        createdAt: "2026-05-01T00:00:00.000Z",
        priorId: "prior-x",
        deltaId: "delta-20260501-abcdef012345",
        producer: {
          family: "Claude",
          surface: "claude-cli",
          voice: null,
          modelClaimed: null,
          modelVerified: null,
        },
      } as never,
    });
    expect(marker).not.toBeNull();
    expect(marker!.markerId).toMatch(/^read-[0-9TZ-]+-[a-f0-9]{12}$/);
    expect(marker!.result).toBe("accepted");
    expect(marker!.scope).toBe("summary");
    expect(marker!.deltaIds).toEqual(["delta-20260501-abcdef012345"]);
  });
});

describe("runFromExecution end-to-end", () => {
  let root: string;
  let cfg: PosteriorDeltaConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeExecution(execution: object): string {
    const path = join(root, "execution.json");
    writeFileSync(path, JSON.stringify(execution, null, 2));
    return path;
  }

  it("writes deltas + receipt for a multi-item execution", async () => {
    const executionPath = writeExecution({
      runId: "run-end2end",
      dispatchId: "disp-1",
      executions: [
        {
          surface: "claude-cli",
          family: "Claude",
          status: "completed",
          countingEligible: true,
          calibration: { verdict: "usable" },
          text: "CLAIMS:\n- runs end-to-end\nRecommendation:\n- ship",
          receipt: { startedAt: "2026-05-01T00:00:00.000Z", endedAt: "2026-05-01T00:00:30.000Z" },
        },
        {
          surface: "grok-web",
          family: "Grok",
          status: "failed",
          reason: "auth missing",
          text: "",
          receipt: {},
        },
      ],
    });
    const result = await runFromExecution(cfg, { executionPath, write: true });
    expect(result.receipt.deltaCount).toBe(2);
    expect(result.writtenDeltas).toHaveLength(2);
    expect(result.writtenDeltas[0]?.path).toMatch(/posterior-deltas\/delta-/);
    const written = JSON.parse(readFileSync(result.writtenDeltas[0]!.path, "utf8"));
    expect(written.schemaVersion).toBe("chuck.posterior-delta.v1");
  });

  it("writes a read marker when task injected a prior + item completed", async () => {
    const taskPath = join(root, "task.json");
    writeFileSync(
      taskPath,
      JSON.stringify({
        id: "task-1",
        priorCapsuleBefore: { injectedIntoPrompt: true, priorId: "prior-x", scope: "summary" },
      }),
    );
    const executionPath = writeExecution({
      runId: "run-marker",
      executions: [
        {
          surface: "claude-cli",
          family: "Claude",
          status: "completed",
          countingEligible: true,
          calibration: { verdict: "usable" },
          text: "CLAIMS:\n- something",
          receipt: { startedAt: "2026-05-01T00:00:00.000Z" },
        },
      ],
    });
    const result = await runFromExecution(cfg, { executionPath, taskPath, write: true });
    expect(result.receipt.readMarkerCount).toBe(1);
    expect(result.writtenReadMarkers).toHaveLength(1);
    expect(result.writtenReadMarkers[0]?.path).toMatch(/read-markers\/read-/);
  });

  it("respects writeReadMarkers=false", async () => {
    const taskPath = join(root, "task.json");
    writeFileSync(
      taskPath,
      JSON.stringify({
        id: "task-1",
        priorCapsuleBefore: { injectedIntoPrompt: true, priorId: "prior-x", scope: "summary" },
      }),
    );
    const executionPath = writeExecution({
      runId: "r",
      executions: [
        {
          surface: "x",
          family: "y",
          status: "completed",
          countingEligible: true,
          text: "CLAIMS:\n- y",
          receipt: { startedAt: "2026-05-01T00:00:00.000Z" },
        },
      ],
    });
    const result = await runFromExecution(cfg, {
      executionPath,
      taskPath,
      write: true,
      writeReadMarkers: false,
    });
    expect(result.writtenReadMarkers).toHaveLength(0);
    expect(result.receipt.readMarkerCount).toBe(0);
  });

  it("respects includeNonCounting=false", async () => {
    const executionPath = writeExecution({
      runId: "r",
      executions: [
        {
          surface: "good",
          family: "g",
          status: "completed",
          countingEligible: true,
          text: "CLAIMS:\n- ok",
          receipt: { startedAt: "2026-05-01T00:00:00.000Z" },
        },
        {
          surface: "weak",
          family: "w",
          status: "completed",
          countingEligible: false,
          text: "",
          receipt: {},
        },
      ],
    });
    const result = await runFromExecution(cfg, {
      executionPath,
      write: false,
      includeNonCounting: false,
    });
    expect(result.deltas).toHaveLength(1);
    expect(result.deltas[0]?.producer.surface).toBe("good");
  });

  it("returns deltaCount=0 when execution has no items", async () => {
    const executionPath = writeExecution({ runId: "r", executions: [] });
    const result = await runFromExecution(cfg, { executionPath, write: true });
    expect(result.receipt.deltaCount).toBe(0);
    expect(result.writtenDeltas).toHaveLength(0);
  });
});
