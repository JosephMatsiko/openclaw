// Smoke tests for @openclaw/skill-cascade-watcher.
//
// Trigger table + anti-recursion + anti-flood + handleEvent integration
// all verified against synthesized events. Live-cascade fire is exercised
// via dryRun (the cascade plugin's own suite covers the live path).

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { antifloodKey, checkAndRecordFlood, pruneFloodCounters } from "./src/antiflood.js";
import { resolveConfig } from "./src/config.js";
import { handleEvent } from "./src/handle.js";
import {
  alreadyPromoted,
  promoteObservationToDocket,
  shouldPromoteToDocket,
} from "./src/promote.js";
import { runTest, summarizeStatus } from "./src/run.js";
import { ensureWatcherDir, loadState } from "./src/state.js";
import { CASCADE_TRIGGERS, findTrigger, isOwnEcho } from "./src/triggers.js";
import type { BusEvent, WatcherState } from "./src/types.js";

function emptyState(): WatcherState {
  return {
    startedAt: null,
    pid: null,
    matches: [],
    fires: [],
    suppressions: [],
    promotions: [],
    floodCounters: {},
  };
}

describe("config resolver", () => {
  test("applies defaults", () => {
    const r = resolveConfig({});
    expect(r.enabled).toBe(true);
    expect(r.pollIntervalMs).toBe(500);
    expect(r.antifloodMaxFires).toBe(3);
    expect(r.antifloodWindowMs).toBe(300_000);
  });

  test("clamps invalid bounds", () => {
    const r = resolveConfig({ pollIntervalMs: 99 } as unknown as Record<string, unknown>);
    expect(r.pollIntervalMs).toBe(500);
  });
});

describe("isOwnEcho / findTrigger", () => {
  test("isOwnEcho rejects same-source events", () => {
    expect(isOwnEcho({ source: "skill-cascade-watcher", type: "chuck.docket.failed" })).toBe(true);
    expect(isOwnEcho({ source: "chuck-cascade-watcher", type: "chuck.docket.failed" })).toBe(true);
  });

  test("isOwnEcho rejects chuck.notify.* and chuck.cascade.watcher.*", () => {
    expect(isOwnEcho({ source: "x", type: "chuck.notify.delivered" })).toBe(true);
    expect(isOwnEcho({ source: "x", type: "chuck.cascade.watcher.matched" })).toBe(true);
  });

  test("isOwnEcho passes through unrelated events", () => {
    expect(isOwnEcho({ source: "chuck-docket-executor", type: "chuck.docket.failed" })).toBe(false);
  });

  test("findTrigger matches docket failures", () => {
    const t = findTrigger({ type: "chuck.docket.failed", payload: {} });
    expect(t).not.toBeNull();
    expect(t?.severity).toBe("warn");
    expect(t?.tier).toBe("immediate-low-friction");
  });

  test("findTrigger respects predicates (zombie cluster requires batch.length>=3)", () => {
    expect(findTrigger({ type: "chuck.zombie_recovered", payload: { batch: ["x"] } })).toBeNull();
    expect(
      findTrigger({ type: "chuck.zombie_recovered", payload: { batch: ["x", "y", "z"] } }),
    ).not.toBeNull();
  });

  test("findTrigger respects predicates (decision proposed requires riskClass=high)", () => {
    expect(
      findTrigger({ type: "chuck.decision.proposed", payload: { riskClass: "low" } }),
    ).toBeNull();
    expect(
      findTrigger({ type: "chuck.decision.proposed", payload: { riskClass: "high" } }),
    ).not.toBeNull();
  });

  test("findTrigger returns null for unmatched types", () => {
    expect(findTrigger({ type: "some.random.event", payload: {} })).toBeNull();
  });
});

describe("anti-flood", () => {
  test("first 3 fires pass; 4th suppresses", () => {
    const config = resolveConfig({ antifloodMaxFires: 3 });
    const state = emptyState();
    const now = Date.now();
    const k1 = checkAndRecordFlood(state, "x", "y", now, config);
    expect(k1.suppressed).toBe(false);
    expect(k1.count).toBe(1);
    checkAndRecordFlood(state, "x", "y", now + 1, config);
    checkAndRecordFlood(state, "x", "y", now + 2, config);
    const k4 = checkAndRecordFlood(state, "x", "y", now + 3, config);
    expect(k4.suppressed).toBe(true);
  });

  test("pruneFloodCounters removes stale entries", () => {
    const state = emptyState();
    const config = resolveConfig({ antifloodWindowMs: 1000 });
    state.floodCounters[antifloodKey("x", "y")] = { fires: [100, 200] };
    pruneFloodCounters(state, 5000, config.antifloodWindowMs);
    expect(state.floodCounters[antifloodKey("x", "y")]).toBeUndefined();
  });
});

describe("auto-promote", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-cascade-watcher-promote-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("shouldPromoteToDocket only fires for medium/high introspect", () => {
    expect(
      shouldPromoteToDocket({ type: "chuck.introspect.observed", payload: { riskClass: "low" } }),
    ).toBe(false);
    expect(
      shouldPromoteToDocket({
        type: "chuck.introspect.observed",
        payload: { riskClass: "medium" },
      }),
    ).toBe(true);
    expect(
      shouldPromoteToDocket({ type: "chuck.introspect.observed", payload: { riskClass: "high" } }),
    ).toBe(true);
    expect(shouldPromoteToDocket({ type: "chuck.docket.failed", payload: {} })).toBe(false);
  });

  test("promoteObservationToDocket writes a task and is idempotent", () => {
    const config = resolveConfig({ docketDir: dir });
    const state = emptyState();
    const ev: BusEvent = {
      id: "e-test",
      ts: new Date().toISOString(),
      type: "chuck.introspect.observed",
      payload: {
        introspectId: "introspect-abc",
        riskClass: "medium",
        category: "scanner-tune",
        recommendation: "tighten the scanner fingerprint dedup",
      },
    };
    const first = promoteObservationToDocket(ev, state, config);
    expect(first.promoted).toBe(true);
    expect(first.taskId).toBeTruthy();

    const second = promoteObservationToDocket(ev, state, config);
    expect(second.promoted).toBe(false);
    expect(second.reason).toBe("already-promoted");
    expect(alreadyPromoted(state, "introspect-abc")).toBe(true);

    const tasks = readdirSync(dir).filter((n) => n.startsWith("task-"));
    expect(tasks.length).toBe(1);
    const task = JSON.parse(readFileSync(join(dir, tasks[0]), "utf8"));
    expect(task.status).toBe("pending");
    expect(task.risk).toBe("low"); // medium → low after docketRisk cap
    expect(task.commandKind).toBe("claude-cli-build");
  });

  test("high-risk caps docketRisk at medium", () => {
    const config = resolveConfig({ docketDir: dir });
    const state = emptyState();
    const ev: BusEvent = {
      id: "e-high",
      type: "chuck.introspect.observed",
      payload: {
        introspectId: "intro-high",
        riskClass: "high",
        recommendation: "do something high-risk",
      },
    };
    promoteObservationToDocket(ev, state, config);
    const tasks = readdirSync(dir).filter((n) => n.startsWith("task-"));
    const task = JSON.parse(readFileSync(join(dir, tasks[0]), "utf8"));
    expect(task.risk).toBe("medium");
  });
});

describe("handleEvent integration", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-cascade-watcher-handle-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("ignores own-echo events", async () => {
    const config = resolveConfig({
      eventsPath: join(dir, "events.jsonl"),
      watcherStateDir: join(dir, "state"),
      docketDir: join(dir, "docket"),
    });
    ensureWatcherDir(config);
    const state = loadState(config);
    const result = await handleEvent(
      { type: "chuck.notify.delivered", source: "skill-reach-cascade" },
      state,
      config,
    );
    expect(result.ignored?.reason).toBe("own-echo");
    expect(result.matched).toBeUndefined();
    expect(result.fired).toBeUndefined();
  });

  test("matches a docket failure but cascade may not deliver in test env", async () => {
    const config = resolveConfig({
      eventsPath: join(dir, "events.jsonl"),
      watcherStateDir: join(dir, "state"),
      docketDir: join(dir, "docket"),
      // Sandbox the cascade ledger paths to this temp dir as well via env-overrides
      // — the cascade's own resolveConfig() defaults to ~/.openclaw paths, which is
      // fine for this smoke test (we just verify match + fire happens).
    });
    ensureWatcherDir(config);
    const state = loadState(config);
    const result = await handleEvent(
      {
        id: "e-fail-1",
        ts: new Date().toISOString(),
        type: "chuck.docket.failed",
        source: "chuck-docket-executor",
        payload: { task: { id: "t1", title: "test failure" } },
      },
      state,
      config,
    );
    expect(result.matched?.triggerType).toBe("^chuck\\.docket\\.(failed|validation_failed)$");
    expect(result.matched?.severity).toBe("warn");
    // fired may be either delivered or not depending on cascade env; just
    // verify the `fired` block was populated.
    expect(result.fired).toBeDefined();
    expect(state.matches.length).toBe(1);
  });
});

describe("trigger table coverage", () => {
  test("CASCADE_TRIGGERS exposes all 7 patterns", () => {
    expect(CASCADE_TRIGGERS.length).toBe(7);
    const patterns = CASCADE_TRIGGERS.map((t) => t.typeMatch.source);
    expect(patterns).toContain("^chuck\\.docket\\.(failed|validation_failed)$");
    expect(patterns).toContain("^chuck\\.(gateway|executor)\\.crashed$");
    expect(patterns).toContain("^chuck\\.zombie_recovered$");
    expect(patterns).toContain("^chuck\\.introspect\\.observed$");
  });
});

describe("status + test commands", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-cascade-watcher-cmds-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("summarizeStatus returns trigger table + autoPromote info", () => {
    const config = resolveConfig({
      eventsPath: join(dir, "events.jsonl"),
      watcherStateDir: join(dir, "state"),
      docketDir: join(dir, "docket"),
    });
    const summary = summarizeStatus(config);
    expect(summary.triggerTable.length).toBe(7);
    expect(summary.autoPromote.enabled).toBe(true);
    expect(summary.autoPromote.eventType).toBe("chuck.introspect.observed");
    expect(summary.counts.matches).toBe(0);
  });

  test("runTest dry-run returns matched + subject without firing cascade", async () => {
    const config = resolveConfig({
      eventsPath: join(dir, "events.jsonl"),
      watcherStateDir: join(dir, "state"),
      docketDir: join(dir, "docket"),
    });
    const r = await runTest("chuck.docket.failed", { dryRun: true, riskClass: "low" }, config);
    expect(r.ok).toBe(true);
    expect(r.matched).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.subject).toContain("Task failed");
  });

  test("runTest with unknown event type returns matched=false", async () => {
    const config = resolveConfig({
      eventsPath: join(dir, "events.jsonl"),
      watcherStateDir: join(dir, "state"),
      docketDir: join(dir, "docket"),
    });
    const r = await runTest("never.matches.anything", { dryRun: true }, config);
    expect(r.ok).toBe(false);
    expect(r.matched).toBe(false);
  });
});
