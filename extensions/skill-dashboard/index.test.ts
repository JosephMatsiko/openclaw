// Test suite for @openclaw/skill-dashboard.
//
// HTTP fetcher + launchctl runner are injected; the tests never hit the live
// dashboard or invoke launchctl.

import { describe, expect, it, vi } from "vitest";
import {
  checkDashboardHealth,
  fetchDashboardEndpoint,
  readLaunchAgentStatus,
  resolveConfig,
  type DashboardConfig,
  type DashboardFetcher,
  type LaunchctlRunner,
} from "./api.js";

function makeConfig(overrides: Partial<DashboardConfig> = {}): DashboardConfig {
  return {
    ...resolveConfig({}),
    ...overrides,
  };
}

function makeFetcher(
  responses: Array<{ status?: number; text?: string; throwError?: string }>,
  capture: { urls: string[]; timeouts: number[] } = { urls: [], timeouts: [] },
): DashboardFetcher {
  let i = 0;
  return vi.fn(async ({ url, timeoutMs }) => {
    capture.urls.push(url);
    capture.timeouts.push(timeoutMs);
    const response = responses[i++] ?? { status: 200, text: "{}" };
    if (response.throwError) throw new Error(response.throwError);
    return {
      ok: (response.status ?? 200) >= 200 && (response.status ?? 200) < 300,
      status: response.status ?? 200,
      text: response.text ?? "",
    };
  });
}

function makeLaunchctl(stdout: string, exitOk = true): LaunchctlRunner {
  return vi.fn(async () => ({ ok: exitOk, stdout, stderr: "" }));
}

describe("config", () => {
  it("clamps + defaults", () => {
    const cfg = resolveConfig({ port: -1, queryTimeoutMs: 1, launchAgentLabel: "" });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(7777);
    expect(cfg.queryTimeoutMs).toBe(5000);
    expect(cfg.launchAgentLabel).toBe("com.openclaw.chuck-dashboard");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:7777");
  });

  it("respects custom values within bounds", () => {
    const cfg = resolveConfig({ host: "localhost", port: 8080, queryTimeoutMs: 10_000 });
    expect(cfg.host).toBe("localhost");
    expect(cfg.port).toBe(8080);
    expect(cfg.baseUrl).toBe("http://localhost:8080");
    expect(cfg.queryTimeoutMs).toBe(10_000);
  });
});

describe("fetchDashboardEndpoint", () => {
  it("GETs the configured base URL + path and parses JSON body", async () => {
    const cfg = makeConfig();
    const capture = { urls: [] as string[], timeouts: [] as number[] };
    const fetch = makeFetcher(
      [{ status: 200, text: JSON.stringify({ ok: true, fleet: ["claude", "gemini"] }) }],
      capture,
    );
    const result = await fetchDashboardEndpoint(cfg, { path: "/api/fleet" }, { fetch });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.url).toBe("http://127.0.0.1:7777/api/fleet");
    expect(result.body).toEqual({ ok: true, fleet: ["claude", "gemini"] });
    expect(capture.urls[0]).toBe("http://127.0.0.1:7777/api/fleet");
    expect(capture.timeouts[0]).toBe(cfg.queryTimeoutMs);
  });

  it("forwards search params as query string", async () => {
    const cfg = makeConfig();
    const capture = { urls: [] as string[], timeouts: [] as number[] };
    const fetch = makeFetcher([{ status: 200, text: "{}" }], capture);
    await fetchDashboardEndpoint(
      cfg,
      { path: "/api/snapshot", search: { since: "2026-05-01", limit: 5 } },
      { fetch },
    );
    expect(capture.urls[0]).toMatch(/\/api\/snapshot\?/);
    expect(capture.urls[0]).toContain("since=2026-05-01");
    expect(capture.urls[0]).toContain("limit=5");
  });

  it("honors timeoutMs override", async () => {
    const cfg = makeConfig();
    const capture = { urls: [] as string[], timeouts: [] as number[] };
    const fetch = makeFetcher([{ status: 200, text: "{}" }], capture);
    await fetchDashboardEndpoint(cfg, { path: "/api/fleet", timeoutMs: 1500 }, { fetch });
    expect(capture.timeouts[0]).toBe(1500);
  });

  it("normalizes path to start with /", async () => {
    const cfg = makeConfig();
    const capture = { urls: [] as string[], timeouts: [] as number[] };
    const fetch = makeFetcher([{ status: 200, text: "{}" }], capture);
    await fetchDashboardEndpoint(cfg, { path: "api/principles" }, { fetch });
    expect(capture.urls[0]).toBe("http://127.0.0.1:7777/api/principles");
  });

  it("returns {raw: text} for non-JSON bodies (404 HTML, etc.)", async () => {
    const cfg = makeConfig();
    const fetch = makeFetcher([{ status: 404, text: "<html>not found</html>" }]);
    const result = await fetchDashboardEndpoint(cfg, { path: "/api/missing" }, { fetch });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ raw: "<html>not found</html>" });
  });

  it("throws on missing path", async () => {
    const cfg = makeConfig();
    await expect(
      fetchDashboardEndpoint(cfg, { path: "" }, { fetch: makeFetcher([]) }),
    ).rejects.toThrow(/path is required/);
  });

  it("propagates fetcher errors", async () => {
    const cfg = makeConfig();
    const fetch = makeFetcher([{ throwError: "ECONNREFUSED" }]);
    await expect(fetchDashboardEndpoint(cfg, { path: "/api/fleet" }, { fetch })).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});

describe("checkDashboardHealth", () => {
  it("reports reachable + ok when /api/snapshot returns 200", async () => {
    const cfg = makeConfig();
    const fetch = makeFetcher([{ status: 200, text: "{}" }]);
    const result = await checkDashboardHealth(cfg, { fetch });
    expect(result.reachable).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.url).toBe("http://127.0.0.1:7777/api/snapshot");
  });

  it("reports reachable + not-ok on 5xx", async () => {
    const cfg = makeConfig();
    const fetch = makeFetcher([{ status: 503, text: "" }]);
    const result = await checkDashboardHealth(cfg, { fetch });
    expect(result.reachable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("reports unreachable + reason on connection error", async () => {
    const cfg = makeConfig();
    const fetch = makeFetcher([{ throwError: "ECONNREFUSED 127.0.0.1:7777" }]);
    const result = await checkDashboardHealth(cfg, { fetch });
    expect(result.reachable).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });
});

describe("readLaunchAgentStatus", () => {
  it("parses 'launchctl list' loaded + running output", async () => {
    const cfg = makeConfig();
    const launchctl = makeLaunchctl("12345\t0\tcom.openclaw.chuck-dashboard\n");
    const result = await readLaunchAgentStatus(cfg, { launchctl });
    expect(result.label).toBe("com.openclaw.chuck-dashboard");
    expect(result.loaded).toBe(true);
    expect(result.pid).toBe(12345);
    expect(result.lastExitCode).toBe(0);
  });

  it("reports loaded:true with pid:null when service is loaded but not running", async () => {
    const cfg = makeConfig();
    const launchctl = makeLaunchctl("-\t0\tcom.openclaw.chuck-dashboard\n");
    const result = await readLaunchAgentStatus(cfg, { launchctl });
    expect(result.loaded).toBe(true);
    expect(result.pid).toBeNull();
    expect(result.lastExitCode).toBe(0);
  });

  it("reports loaded:false when service is not registered", async () => {
    const cfg = makeConfig();
    const launchctl = makeLaunchctl(
      'Could not find service "com.openclaw.chuck-dashboard" in domain for port',
      false,
    );
    const result = await readLaunchAgentStatus(cfg, { launchctl });
    expect(result.loaded).toBe(false);
    expect(result.pid).toBeNull();
  });
});
