// Test suite for @openclaw/skill-watchers-status.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reportWatchers,
  resolveConfig,
  type LaunchctlRunner,
  type PsRunner,
  type WatcherEntry,
  type WatchersConfig,
} from "./api.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "skill-watchers-status-"));
}

function makeConfig(root: string, overrides: Partial<WatchersConfig> = {}): WatchersConfig {
  return {
    ...resolveConfig({
      logsDir: join(root, "logs"),
      eventsPath: join(root, "events.jsonl"),
    }),
    ...overrides,
  };
}

describe("reportWatchers", () => {
  let root: string;
  let cfg: WatchersConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
    mkdirSync(cfg.logsDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports a running watcher with pid + cpu + uptime", async () => {
    const watchers: WatcherEntry[] = [
      { label: "com.example.test", log: "test.err.log", busSource: "test-watcher" },
    ];
    const launchctl: LaunchctlRunner = vi.fn(async () => ({
      ok: true,
      stdout: "12345\t0\tcom.example.test\n",
      stderr: "",
    }));
    const ps: PsRunner = vi.fn(async () => ({ ok: true, cpu: 1.7, uptimeSec: 3661 }));
    writeFileSync(join(cfg.logsDir, "test.err.log"), "older line\nlatest log line\n");
    writeFileSync(
      cfg.eventsPath,
      JSON.stringify({ type: "tick", ts: new Date().toISOString(), source: "test-watcher" }) + "\n",
    );
    const reports = await reportWatchers(cfg, {}, { launchctl, ps, watchers });
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r?.label).toBe("com.example.test");
    expect(r?.loaded).toBe(true);
    expect(r?.pid).toBe(12345);
    expect(r?.lastExitCode).toBe(0);
    expect(r?.cpuPercent).toBe(1.7);
    expect(r?.uptimeMs).toBe(3661 * 1000);
    expect(r?.lastLogLine).toBe("latest log line");
    expect(r?.lastBusEvent?.type).toBe("tick");
  });

  it("reports a loaded-but-not-running watcher with pid:null", async () => {
    const watchers: WatcherEntry[] = [{ label: "com.example.idle" }];
    const launchctl: LaunchctlRunner = vi.fn(async () => ({
      ok: true,
      stdout: "-\t0\tcom.example.idle\n",
      stderr: "",
    }));
    const ps: PsRunner = vi.fn();
    const reports = await reportWatchers(cfg, {}, { launchctl, ps, watchers });
    expect(reports[0]?.loaded).toBe(true);
    expect(reports[0]?.pid).toBeNull();
    expect(reports[0]?.cpuPercent).toBeNull();
    expect(ps).not.toHaveBeenCalled();
  });

  it("reports an unloaded watcher with loaded:false", async () => {
    const watchers: WatcherEntry[] = [{ label: "com.example.gone" }];
    const launchctl: LaunchctlRunner = vi.fn(async () => ({
      ok: false,
      stdout: 'Could not find service "com.example.gone" in domain for port',
      stderr: "",
    }));
    const ps: PsRunner = vi.fn();
    const reports = await reportWatchers(cfg, {}, { launchctl, ps, watchers });
    expect(reports[0]?.loaded).toBe(false);
    expect(reports[0]?.pid).toBeNull();
  });

  it("filters by label when options.label is set", async () => {
    const watchers: WatcherEntry[] = [{ label: "com.example.a" }, { label: "com.example.b" }];
    const launchctl: LaunchctlRunner = vi.fn(async ({ label }) => ({
      ok: true,
      stdout: `-\t0\t${label}\n`,
      stderr: "",
    }));
    const ps: PsRunner = vi.fn();
    const reports = await reportWatchers(
      cfg,
      { label: "com.example.b" },
      { launchctl, ps, watchers },
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.label).toBe("com.example.b");
  });

  it("excludes bus events older than the window", async () => {
    const watchers: WatcherEntry[] = [{ label: "com.example.test", busSource: "test-watcher" }];
    const launchctl: LaunchctlRunner = vi.fn(async () => ({
      ok: true,
      stdout: "12345\t0\tcom.example.test\n",
      stderr: "",
    }));
    const ps: PsRunner = vi.fn(async () => ({ ok: true, cpu: 0, uptimeSec: 0 }));
    const oldTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      cfg.eventsPath,
      JSON.stringify({ type: "old", ts: oldTs, source: "test-watcher" }) + "\n",
    );
    const reports = await reportWatchers(cfg, { busWindowHours: 1 }, { launchctl, ps, watchers });
    expect(reports[0]?.lastBusEvent).toBeNull();
  });

  it("reports stateOk=true when state file parses, false when malformed", async () => {
    mkdirSync(join(root, "state"), { recursive: true });
    const goodPath = join(root, "state", "good.json");
    const badPath = join(root, "state", "bad.json");
    writeFileSync(goodPath, '{"ok": true}');
    writeFileSync(badPath, "not valid json");
    const watchers: WatcherEntry[] = [
      { label: "com.example.good", stateFile: goodPath },
      { label: "com.example.bad", stateFile: badPath },
    ];
    const launchctl: LaunchctlRunner = vi.fn(async ({ label }) => ({
      ok: true,
      stdout: `-\t0\t${label}\n`,
      stderr: "",
    }));
    const reports = await reportWatchers(cfg, {}, { launchctl, watchers });
    expect(reports[0]?.stateOk).toBe(true);
    expect(reports[1]?.stateOk).toBe(false);
  });
});

describe("config", () => {
  it("clamps + path expand", () => {
    const cfg = resolveConfig({
      logsDir: "~/x/logs",
      eventsPath: "~/x/events.jsonl",
      busWindowHours: -1,
      launchctlTimeoutMs: 999_999,
    });
    expect(cfg.logsDir).toMatch(/\/x\/logs$/);
    expect(cfg.eventsPath).toMatch(/\/x\/events\.jsonl$/);
    expect(cfg.busWindowHours).toBe(6);
    expect(cfg.launchctlTimeoutMs).toBe(5000);
  });
});
