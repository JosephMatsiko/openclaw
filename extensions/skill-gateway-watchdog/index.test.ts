// Smoke tests for @openclaw/skill-gateway-watchdog.
//
// Tests the typed surface (probe parsing, state IO, day-bucket roll,
// tick decisions) without invoking real launchctl/pgrep/ps. The daemon
// poll loop lives in chuck-gateway-watchdog.mjs and is verified in
// production via the LaunchAgent's own state.json.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import { recentEventLoopBlocks } from "./src/probes.js";
import { ensureWatchdogDir, loadState, rollDayBucket, saveState } from "./src/state.js";
import { tick } from "./src/tick.js";
import type { WatchdogState } from "./src/types.js";

describe("config resolver", () => {
  test("applies defaults", () => {
    const r = resolveConfig({});
    expect(r.enabled).toBe(true);
    expect(r.pollIntervalMs).toBe(60_000);
    expect(r.pinDetectionWindowMs).toBe(240_000);
    expect(r.maxRestartsPerDay).toBe(12);
    expect(r.gatewayLaunchdTarget).toBe("gui/501/ai.openclaw.gateway");
  });

  test("clamps invalid bounds", () => {
    const r = resolveConfig({ pollIntervalMs: 100 } as unknown as Record<string, unknown>);
    expect(r.pollIntervalMs).toBe(60_000);
  });

  test("preserves valid overrides", () => {
    const r = resolveConfig({
      pollIntervalMs: 30_000,
      maxRestartsPerDay: 24,
      gatewayLaunchdTarget: "gui/123/test.target",
    });
    expect(r.pollIntervalMs).toBe(30_000);
    expect(r.maxRestartsPerDay).toBe(24);
    expect(r.gatewayLaunchdTarget).toBe("gui/123/test.target");
  });
});

describe("recentEventLoopBlocks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-gateway-watchdog-log-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns zeroes when log file is missing", () => {
    const config = resolveConfig({ gatewayErrLogPath: join(dir, "missing.log") });
    const out = recentEventLoopBlocks(60_000, config);
    expect(out).toEqual({ count: 0, maxBlockMs: 0, lastTs: null });
  });

  test("parses liveness warning lines within window", () => {
    const path = join(dir, "gateway.err.log");
    const ts = new Date().toISOString();
    // Format: matches the prod gateway log line shape.
    // The .mjs uses a tsRe that requires a TZ offset; new Date().toISOString()
    // produces "Z", so build a fake offset-suffixed timestamp manually.
    const offsetTs = ts.replace(/Z$/, "-05:00");
    writeFileSync(
      path,
      [
        `${offsetTs} liveness warning eventLoopDelayMaxMs=120000.5 eventLoopUtilization=0.99`,
        `${offsetTs} unrelated line — does not match`,
        `${offsetTs} liveness warning eventLoopDelayMaxMs=8500.0`,
      ].join("\n"),
    );
    const config = resolveConfig({ gatewayErrLogPath: path });
    const out = recentEventLoopBlocks(5 * 60_000, config);
    expect(out.count).toBe(2);
    expect(out.maxBlockMs).toBeCloseTo(120_000.5, 1);
    expect(out.lastTs).toBe(offsetTs);
  });

  test("ignores entries older than window", () => {
    const path = join(dir, "gateway.err.log");
    const oldTs = "2020-01-01T00:00:00.000-05:00";
    writeFileSync(path, `${oldTs} liveness warning eventLoopDelayMaxMs=180000`);
    const config = resolveConfig({ gatewayErrLogPath: path });
    const out = recentEventLoopBlocks(60_000, config);
    expect(out.count).toBe(0);
  });
});

describe("state IO + day-bucket", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-gateway-watchdog-state-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadState returns empty defaults when file missing", () => {
    const config = resolveConfig({ watchdogStateDir: dir });
    const s = loadState(config);
    expect(s.restartCount).toBe(0);
    expect(s.restartCountToday).toBe(0);
    expect(s.history).toEqual([]);
  });

  test("save then load roundtrips", () => {
    const config = resolveConfig({ watchdogStateDir: dir });
    ensureWatchdogDir(config);
    const s = loadState(config);
    s.restartCount = 5;
    s.restartCountToday = 2;
    saveState(s, config);
    const reloaded = loadState(config);
    expect(reloaded.restartCount).toBe(5);
    expect(reloaded.restartCountToday).toBe(2);
  });

  test("rollDayBucket resets restartCountToday on date change", () => {
    const state: WatchdogState = {
      ...loadState(resolveConfig({ watchdogStateDir: dir })),
      restartCount: 7,
      restartCountToday: 4,
      todayKey: "2020-01-01",
    };
    rollDayBucket(state, new Date("2026-05-02T12:00:00Z"));
    expect(state.todayKey).toBe("2026-05-02");
    expect(state.restartCountToday).toBe(0);
    expect(state.restartCount).toBe(7);
  });

  test("history is trimmed to historyLimit on save", () => {
    const config = resolveConfig({ watchdogStateDir: dir, historyLimit: 10 });
    const s = loadState(config);
    for (let i = 0; i < 100; i++) {
      s.history.push({
        ts: new Date().toISOString(),
        pid: i,
        cpu: 1,
        eventLoopBlocks: { count: 0, maxBlockMs: 0, lastTs: null },
        healthy: true,
        reason: "ok",
        action: null,
      });
    }
    saveState(s, config);
    const reloaded = loadState(config);
    expect(reloaded.history.length).toBe(10);
  });
});

describe("tick", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-gateway-watchdog-tick-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function freshConfig() {
    return resolveConfig({
      watchdogStateDir: dir,
      eventsPath: join(dir, "events.jsonl"),
      gatewayErrLogPath: join(dir, "gateway.err.log"),
      // Use a pgrep pattern that won't match anything → probe returns
      // healthy=false, reason="gateway process not found".
      gatewayPgrepPattern: "this-pattern-never-matches-anything-real-12345",
    });
  }

  test("tick records probe in state.json", async () => {
    const config = freshConfig();
    await tick({ dryRun: true }, config);
    const state = loadState(config);
    expect(state.history.length).toBe(1);
    expect(state.lastProbe.healthy).toBe(false);
  });

  test("tick respects daily-cap", async () => {
    const config = freshConfig();
    const state = loadState(config);
    state.restartCountToday = config.maxRestartsPerDay;
    state.todayKey = new Date().toISOString().slice(0, 10);
    saveState(state, config);
    const result = await tick({ dryRun: true }, config);
    expect(result.action).toBe("daily-cap-hit");
  });

  test("tick respects cooldown", async () => {
    const config = freshConfig();
    const state = loadState(config);
    state.nextRestartAllowedMs = Date.now() + 60_000;
    saveState(state, config);
    const result = await tick({ dryRun: true }, config);
    expect(result.action).toBe("deferred-cooldown");
    expect(result.nextAllowedAt).toBeTruthy();
  });

  test("tick dryRun does not bump restartCount", async () => {
    const config = freshConfig();
    const before = loadState(config).restartCount;
    const result = await tick({ dryRun: true }, config);
    expect(result.action).toBe("restarted");
    const after = loadState(config).restartCount;
    expect(after).toBe(before + 1);
  });
});
