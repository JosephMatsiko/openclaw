// Smoke tests for @openclaw/skill-introspect.
//
// Exercises the typed surface (parse, normalize, bundle, fingerprint, status,
// scan/focus orchestration with injected dispatch) without invoking real
// claude-cli. Production live verification: the LaunchAgent's own scan output.

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
import { bundleState, renderStateForPrompt } from "./src/bundle.js";
import { resolveConfig } from "./src/config.js";
import { runFocus } from "./src/focus.js";
import { normalizeObservation, tryParseObservations } from "./src/parse.js";
import { runScan } from "./src/scan.js";
import { applyIntrospection, dismissIntrospection, summarizeStatus } from "./src/status.js";
import { isFingerprintBlocked, loadAllIntrospections } from "./src/store.js";
import type { ClaudeDispatchResult, IntrospectionRecord } from "./src/types.js";
import { fingerprint } from "./src/util.js";

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `skill-introspect-${prefix}-`));
}

function makeDispatch(
  stdout: string,
  opts: Partial<ClaudeDispatchResult> = {},
): (prompt: string) => Promise<ClaudeDispatchResult> {
  return () =>
    Promise.resolve({
      exitCode: opts.exitCode ?? 0,
      signal: opts.signal ?? null,
      timedOut: opts.timedOut ?? false,
      stdout,
      stderr: opts.stderr ?? "",
    });
}

describe("config resolver", () => {
  test("applies defaults", () => {
    const r = resolveConfig({});
    expect(r.enabled).toBe(true);
    expect(r.maxObservationsPerScan).toBe(3);
    expect(r.fingerprintHistoryCap).toBe(50);
    expect(r.dedupWindowDays).toBe(7);
    expect(r.claudeModel).toBe("opus");
  });

  test("clamps invalid bounds", () => {
    const r = resolveConfig({ maxObservationsPerScan: 999 } as unknown as Record<string, unknown>);
    expect(r.maxObservationsPerScan).toBe(3);
  });
});

describe("tryParseObservations", () => {
  test("parses raw JSON array", () => {
    const out = tryParseObservations(
      JSON.stringify([{ category: "x", observation: "y", recommendation: "z" }]),
    );
    expect(out.length).toBe(1);
  });

  test("strips <OBSERVATIONS> wrapper", () => {
    const out = tryParseObservations(
      'Some prose answer.\n<OBSERVATIONS>[{"category":"x","observation":"y","recommendation":"z"}]</OBSERVATIONS>',
    );
    expect(out.length).toBe(1);
  });

  test("strips markdown fences", () => {
    const out = tryParseObservations(
      '```json\n[{"category":"x","observation":"y","recommendation":"z"}]\n```',
    );
    expect(out.length).toBe(1);
  });

  test("recovers JSON array substring from prose", () => {
    const out = tryParseObservations(
      'Here are observations: [{"category":"x","observation":"y","recommendation":"z"}] hope that helps.',
    );
    expect(out.length).toBe(1);
  });

  test("recovers .observations object property", () => {
    const out = tryParseObservations(
      JSON.stringify({ observations: [{ category: "x", observation: "y", recommendation: "z" }] }),
    );
    expect(out.length).toBe(1);
  });

  test("returns empty for malformed input", () => {
    expect(tryParseObservations("totally not json")).toEqual([]);
    expect(tryParseObservations(null)).toEqual([]);
    expect(tryParseObservations(undefined)).toEqual([]);
  });
});

describe("normalizeObservation", () => {
  test("clamps risk_class to allowed set", () => {
    const out = normalizeObservation({
      category: "x",
      observation: "y",
      recommendation: "z",
      risk_class: "extreme",
    });
    expect(out?.riskClass).toBe("low");
  });

  test("preserves valid risk_class", () => {
    const out = normalizeObservation({
      category: "x",
      observation: "y",
      recommendation: "z",
      risk_class: "high",
    });
    expect(out?.riskClass).toBe("high");
  });

  test("rejects when observation or recommendation missing", () => {
    expect(normalizeObservation({ category: "x", observation: "y" })).toBeNull();
    expect(normalizeObservation({ category: "x", recommendation: "z" })).toBeNull();
  });

  test("clamps evidence snippet to 600 chars", () => {
    const huge = "x".repeat(2000);
    const out = normalizeObservation({
      category: "x",
      observation: "y",
      recommendation: "z",
      evidence: [{ source: "src", snippet: huge }],
    });
    expect(out?.evidence[0].snippet.length).toBe(600);
  });

  test("supports both why_novel and whyNovel", () => {
    expect(
      normalizeObservation({
        category: "x",
        observation: "y",
        recommendation: "z",
        whyNovel: "abc",
      })?.whyNovel,
    ).toBe("abc");
    expect(
      normalizeObservation({
        category: "x",
        observation: "y",
        recommendation: "z",
        why_novel: "def",
      })?.whyNovel,
    ).toBe("def");
  });
});

describe("fingerprint + isFingerprintBlocked", () => {
  test("fingerprint is stable for same category+recommendation", () => {
    expect(fingerprint("docket-drift", "investigate root cause")).toBe(
      fingerprint("docket-drift", "investigate root cause"),
    );
  });

  test("different inputs → different fingerprints", () => {
    expect(fingerprint("a", "b")).not.toBe(fingerprint("a", "c"));
  });

  test("blocks when fp in lastScan.fingerprints", () => {
    const config = resolveConfig({});
    expect(isFingerprintBlocked("abc123", { fingerprints: ["abc123"] }, [], config)).toBe(true);
  });

  test("blocks when undismissed record in dedup window has fp", () => {
    const config = resolveConfig({ dedupWindowDays: 7 });
    const recent = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const records: IntrospectionRecord[] = [
      {
        id: "introspect-1",
        ts: recent,
        scanRunId: "x",
        mode: "scan",
        category: "x",
        observation: "y",
        whyNovel: "",
        recommendation: "z",
        riskClass: "low",
        rationale: "",
        evidence: [],
        fingerprint: "abc123",
        proposedId: null,
        applied: false,
        appliedAt: null,
        dismissed: false,
        dismissedAt: null,
        dismissedReason: null,
      },
    ];
    expect(isFingerprintBlocked("abc123", { fingerprints: [] }, records, config)).toBe(true);
  });

  test("does NOT block when matching record was dismissed", () => {
    const config = resolveConfig({});
    const records: IntrospectionRecord[] = [
      {
        id: "introspect-2",
        ts: new Date().toISOString(),
        scanRunId: "x",
        mode: "scan",
        category: "x",
        observation: "y",
        whyNovel: "",
        recommendation: "z",
        riskClass: "low",
        rationale: "",
        evidence: [],
        fingerprint: "abc123",
        proposedId: null,
        applied: false,
        appliedAt: null,
        dismissed: true,
        dismissedAt: new Date().toISOString(),
        dismissedReason: "no longer relevant",
      },
    ];
    expect(isFingerprintBlocked("abc123", { fingerprints: [] }, records, config)).toBe(false);
  });
});

describe("bundleState + renderStateForPrompt", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir("bundle");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns empty bundle for missing state", () => {
    const config = resolveConfig({
      introspectionsDir: join(dir, "introspections"),
      eventsPath: join(dir, "events.jsonl"),
      docketDir: join(dir, "docket"),
      decisionsDir: join(dir, "decisions"),
      macHealReceiptsDir: join(dir, "mac-heal"),
      notificationLedgerDir: join(dir, "notif"),
      selfImprovementLastScanPath: join(dir, "self-improv.json"),
      healthSnapshotPath: join(dir, "health.json"),
      priorsLatestPath: join(dir, "priors.json"),
      dissentDir: join(dir, "dissent"),
    });
    const bundle = bundleState(config);
    expect(bundle.recentEvents).toBe("");
    expect(bundle.docket).toEqual([]);
    expect(bundle.healthSnapshot).toBeNull();
    expect(bundle.priorsLatestHead).toBeNull();
    const rendered = renderStateForPrompt(bundle);
    expect(rendered).toContain("Recent apex-events");
    expect(rendered).toContain("Docket tasks");
  });

  test("renders synthesized state", () => {
    const docketDir = join(dir, "docket");
    mkdirSync(docketDir, { recursive: true });
    writeFileSync(
      join(docketDir, "task-x.json"),
      JSON.stringify({
        id: "task-x",
        title: "test task",
        status: "pending",
        commandKind: "doctor",
        risk: "low",
      }),
    );
    const config = resolveConfig({
      introspectionsDir: join(dir, "introspections"),
      eventsPath: join(dir, "events.jsonl"),
      docketDir,
      decisionsDir: join(dir, "decisions"),
      macHealReceiptsDir: join(dir, "mac-heal"),
      notificationLedgerDir: join(dir, "notif"),
      selfImprovementLastScanPath: join(dir, "self-improv.json"),
      healthSnapshotPath: join(dir, "health.json"),
      priorsLatestPath: join(dir, "priors.json"),
      dissentDir: join(dir, "dissent"),
    });
    const bundle = bundleState(config);
    expect(bundle.docket.length).toBe(1);
    expect((bundle.docket[0] as { title?: string }).title).toBe("test task");
  });
});

describe("runScan with injected dispatch", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir("scan");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function freshConfig() {
    return resolveConfig({
      introspectionsDir: join(dir, "introspections"),
      eventsPath: join(dir, "events.jsonl"),
      docketDir: join(dir, "docket"),
      decisionsDir: join(dir, "decisions"),
      macHealReceiptsDir: join(dir, "mac-heal"),
      notificationLedgerDir: join(dir, "notif"),
      selfImprovementLastScanPath: join(dir, "self-improv.json"),
      healthSnapshotPath: join(dir, "health.json"),
      priorsLatestPath: join(dir, "priors.json"),
      dissentDir: join(dir, "dissent"),
    });
  }

  test("dryRun returns bundle stats without dispatching", async () => {
    const result = await runScan({ dryRun: true, dispatch: makeDispatch("[]") }, freshConfig());
    expect(result.dryRun).toBe(true);
    expect(result.promptHead).toBeTruthy();
    expect(result.bundleStats?.docketCount).toBe(0);
  });

  test("dispatch returning [] emits no observations", async () => {
    const result = await runScan({ dispatch: makeDispatch("[]") }, freshConfig());
    expect(result.emitted?.length).toBe(0);
    expect(result.parsedCount).toBe(0);
    expect(existsSync(join(dir, "introspections"))).toBe(true);
  });

  test("dispatch returning observations writes records + emits events", async () => {
    const stdout = JSON.stringify([
      {
        category: "drift",
        observation: "an observed thing",
        recommendation: "do the action",
        risk_class: "medium",
        rationale: "because it matters",
      },
    ]);
    const config = freshConfig();
    const result = await runScan({ dispatch: makeDispatch(stdout) }, config);
    expect(result.emitted?.length).toBe(1);
    const records = loadAllIntrospections(config);
    expect(records.length).toBe(1);
    expect(records[0].category).toBe("drift");
    expect(records[0].riskClass).toBe("medium");
    const events = readFileSync(join(dir, "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "chuck.introspect.observed")).toBe(true);
  });

  test("dispatch returning timeout returns error result", async () => {
    const result = await runScan(
      { dispatch: makeDispatch("", { timedOut: true, exitCode: null }) },
      freshConfig(),
    );
    expect(result.error).toBe("timeout");
    expect(result.emitted).toBeUndefined();
  });

  test("respects maxObservationsPerScan cap", async () => {
    const stdout = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({
        category: `cat-${i}`,
        observation: `obs ${i}`,
        recommendation: `rec ${i}`,
      })),
    );
    const config = resolveConfig({
      introspectionsDir: join(dir, "introspections"),
      eventsPath: join(dir, "events.jsonl"),
      docketDir: join(dir, "docket"),
      decisionsDir: join(dir, "decisions"),
      macHealReceiptsDir: join(dir, "mac-heal"),
      notificationLedgerDir: join(dir, "notif"),
      selfImprovementLastScanPath: join(dir, "self-improv.json"),
      healthSnapshotPath: join(dir, "health.json"),
      priorsLatestPath: join(dir, "priors.json"),
      dissentDir: join(dir, "dissent"),
      maxObservationsPerScan: 2,
    });
    const result = await runScan({ dispatch: makeDispatch(stdout) }, config);
    expect(result.emitted?.length).toBe(2);
    expect(result.parsedCount).toBe(10);
  });
});

describe("runFocus with injected dispatch", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir("focus");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns answer prose + emits observations from <OBSERVATIONS> tag", async () => {
    const config = resolveConfig({
      introspectionsDir: join(dir, "introspections"),
      eventsPath: join(dir, "events.jsonl"),
      docketDir: join(dir, "docket"),
      decisionsDir: join(dir, "decisions"),
      macHealReceiptsDir: join(dir, "mac-heal"),
      notificationLedgerDir: join(dir, "notif"),
      selfImprovementLastScanPath: join(dir, "self-improv.json"),
      healthSnapshotPath: join(dir, "health.json"),
      priorsLatestPath: join(dir, "priors.json"),
      dissentDir: join(dir, "dissent"),
    });
    const stdout = `Here is the answer prose.\n\n<OBSERVATIONS>[{"category":"x","observation":"y","recommendation":"z","risk_class":"low"}]</OBSERVATIONS>`;
    const result = await runFocus("test topic", { dispatch: makeDispatch(stdout) }, config);
    expect(result.topic).toBe("test topic");
    expect(result.answer).toContain("answer prose");
    expect(result.emitted?.length).toBe(1);
  });
});

describe("status / apply / dismiss", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir("status");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function freshConfig() {
    return resolveConfig({
      introspectionsDir: join(dir, "introspections"),
      eventsPath: join(dir, "events.jsonl"),
    });
  }

  function plant(record: Partial<IntrospectionRecord>): string {
    const config = freshConfig();
    mkdirSync(config.introspectionsDir, { recursive: true });
    const id = record.id ?? `introspect-test-${Math.random().toString(36).slice(2, 8)}`;
    const full: IntrospectionRecord = {
      id,
      ts: new Date().toISOString(),
      scanRunId: "x",
      mode: "scan",
      category: "test",
      observation: "y",
      whyNovel: "",
      recommendation: "z",
      riskClass: "low",
      rationale: "",
      evidence: [],
      fingerprint: "abc",
      proposedId: null,
      applied: false,
      appliedAt: null,
      dismissed: false,
      dismissedAt: null,
      dismissedReason: null,
      ...record,
    };
    writeFileSync(join(config.introspectionsDir, `${id}.json`), JSON.stringify(full, null, 2));
    return id;
  }

  test("summarizeStatus returns counts + open list", () => {
    plant({ id: "introspect-open-1" });
    plant({ id: "introspect-applied-1", applied: true, appliedAt: new Date().toISOString() });
    plant({ id: "introspect-dismissed-1", dismissed: true, dismissedAt: new Date().toISOString() });
    const status = summarizeStatus(freshConfig());
    expect(status.counts.total).toBe(3);
    expect(status.counts.open).toBe(1);
    expect(status.counts.applied).toBe(1);
    expect(status.counts.dismissed).toBe(1);
    expect(status.open[0].id).toBe("introspect-open-1");
  });

  test("applyIntrospection sets applied + emits event", () => {
    const id = plant({ id: "introspect-app-1" });
    const config = freshConfig();
    const result = applyIntrospection(id, config);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("applied");
    const events = readFileSync(config.eventsPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "chuck.introspect.applied")).toBe(true);
  });

  test("applyIntrospection rejects already-applied as already-applied (ok)", () => {
    const id = plant({
      id: "introspect-app-2",
      applied: true,
      appliedAt: new Date().toISOString(),
    });
    const result = applyIntrospection(id, freshConfig());
    expect(result.status).toBe("already-applied");
  });

  test("applyIntrospection rejects dismissed", () => {
    const id = plant({
      id: "introspect-app-3",
      dismissed: true,
      dismissedAt: new Date().toISOString(),
    });
    const result = applyIntrospection(id, freshConfig());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("dismissed");
  });

  test("dismissIntrospection sets dismissed + reason", () => {
    const id = plant({ id: "introspect-dis-1" });
    const result = dismissIntrospection(id, "no longer relevant", freshConfig());
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("no longer relevant");
  });

  test("dismissIntrospection on missing returns error", () => {
    const result = dismissIntrospection("introspect-missing", null, freshConfig());
    expect(result.ok).toBe(false);
  });
});
