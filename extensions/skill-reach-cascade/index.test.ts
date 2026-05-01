// Smoke tests for @openclaw/skill-reach-cascade.
//
// Exercises the typed surface (config resolution, cascade resolution, quiet-
// hours filter, antispam) without firing real channels. The live-cascade
// behavior is verified by the chuck-comms-cascade.mjs end-to-end harness
// (which the transitional duplicate of this plugin keeps wire-compatible).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { antispamHash, createAntispamCache } from "./src/antispam.js";
import {
  DEFAULT_CASCADE,
  applyQuietHoursFilter,
  ensureDigestTerminus,
  resolveCascadeOrder,
} from "./src/cascade.js";
import { resolveConfig } from "./src/config.js";
import { hourInZone, isQuietHour } from "./src/time.js";
import type { NotifyPayload } from "./src/types.js";

describe("config resolver", () => {
  test("applies defaults for empty config", () => {
    const r = resolveConfig({});
    expect(r.enabled).toBe(true);
    expect(r.telegramChatId).toBe("8630163522");
    expect(r.imessageBuddy).toBe("+14044517063");
    expect(r.openclawNativeTimeoutMs).toBe(30_000);
    expect(r.antispamWindowMs).toBe(30_000);
    expect(r.quietHoursStart).toBe(23);
    expect(r.quietHoursEnd).toBe(8);
  });

  test("clamps invalid values back to defaults", () => {
    const r = resolveConfig({
      openclawNativeTimeoutMs: "nope",
      antispamWindowMs: -10,
      quietHoursStart: 99,
    } as unknown as Record<string, unknown>);
    expect(r.openclawNativeTimeoutMs).toBe(30_000);
    expect(r.antispamWindowMs).toBe(30_000);
    expect(r.quietHoursStart).toBe(23);
  });

  test("preserves valid overrides + expands ~ paths", () => {
    const r = resolveConfig({
      telegramChatId: "999",
      ledgerDir: "~/custom-dir",
      antispamWindowMs: 60_000,
    });
    expect(r.telegramChatId).toBe("999");
    expect(r.ledgerDir.endsWith("/custom-dir")).toBe(true);
    expect(r.ledgerDir.startsWith("/")).toBe(true);
    expect(r.antispamWindowMs).toBe(60_000);
  });
});

describe("quiet-hours", () => {
  test("isQuietHour wraps midnight (23-8)", () => {
    expect(isQuietHour(23, 23, 8)).toBe(true);
    expect(isQuietHour(0, 23, 8)).toBe(true);
    expect(isQuietHour(7, 23, 8)).toBe(true);
    expect(isQuietHour(8, 23, 8)).toBe(false);
    expect(isQuietHour(15, 23, 8)).toBe(false);
    expect(isQuietHour(22, 23, 8)).toBe(false);
  });

  test("isQuietHour same-day window (1-5)", () => {
    expect(isQuietHour(0, 1, 5)).toBe(false);
    expect(isQuietHour(1, 1, 5)).toBe(true);
    expect(isQuietHour(4, 1, 5)).toBe(true);
    expect(isQuietHour(5, 1, 5)).toBe(false);
  });

  test("hourInZone returns 0-23", () => {
    const h = hourInZone("America/Chicago", new Date());
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(23);
  });
});

describe("cascade resolution", () => {
  test("DEFAULT_CASCADE has the three tiers", () => {
    expect(DEFAULT_CASCADE.immediate.length).toBeGreaterThan(0);
    expect(DEFAULT_CASCADE["immediate-low-friction"].length).toBeGreaterThan(0);
    expect(DEFAULT_CASCADE.digest).toEqual(["digest"]);
  });

  test("immediate tier puts web-push first and digest last", () => {
    const order = DEFAULT_CASCADE.immediate;
    expect(order[0]).toBe("web-push");
    expect(order[order.length - 1]).toBe("digest");
  });

  test("resolveCascadeOrder falls back to defaults when no policy file", () => {
    const config = resolveConfig({ policyPath: "/tmp/nonexistent-policy-file.json" });
    expect(resolveCascadeOrder("immediate", config)).toEqual(DEFAULT_CASCADE.immediate);
  });

  test("resolveCascadeOrder reads structured policy override", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-reach-cascade-"));
    const policyPath = join(dir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        tiers: { immediate: { cascadeOrder: ["telegram", "voice", "digest"] } },
      }),
    );
    try {
      const config = resolveConfig({ policyPath });
      expect(resolveCascadeOrder("immediate", config)).toEqual(["telegram", "voice", "digest"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ensureDigestTerminus appends digest when missing", () => {
    expect(ensureDigestTerminus(["telegram"])).toEqual(["telegram", "digest"]);
  });

  test("ensureDigestTerminus is no-op when already present", () => {
    const order = ["telegram", "digest"] as const;
    expect(ensureDigestTerminus([...order])).toEqual(["telegram", "digest"]);
  });

  test("applyQuietHoursFilter drops audible/visible channels for non-critical", () => {
    // quietHoursStart=0, quietHoursEnd=23 covers hours [0, 23) — always quiet
    // for any hour 0..22 inclusive (covers any hour except 23). Pinned `now`
    // to 12:00 UTC so this passes regardless of when CI runs.
    const config = resolveConfig({
      quietHoursStart: 0,
      quietHoursEnd: 23,
      quietHoursTimezone: "UTC",
    });
    const noon = new Date("2026-05-01T12:00:00Z");
    const filtered = applyQuietHoursFilter(
      ["web-push", "apex-apple-bridge", "telegram", "voice", "digest"],
      "info",
      config,
      noon,
    );
    expect(filtered).toEqual(["web-push", "telegram", "digest"]);
  });

  test("applyQuietHoursFilter passes through for critical", () => {
    const config = resolveConfig({
      quietHoursStart: 0,
      quietHoursEnd: 23,
      quietHoursTimezone: "UTC",
    });
    const noon = new Date("2026-05-01T12:00:00Z");
    const input = ["web-push", "apex-apple-bridge", "telegram", "voice", "digest"] as const;
    const filtered = applyQuietHoursFilter([...input], "critical", config, noon);
    expect(filtered).toEqual([...input]);
  });
});

describe("antispam", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-reach-cascade-antispam-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("antispamHash is stable for same payload", () => {
    const payload: NotifyPayload = { subject: "hi", body: "world", severity: "info" };
    expect(antispamHash(payload)).toBe(antispamHash(payload));
  });

  test("antispamHash differs across severity", () => {
    const a: NotifyPayload = { subject: "hi", body: "world", severity: "info" };
    const b: NotifyPayload = { subject: "hi", body: "world", severity: "critical" };
    expect(antispamHash(a)).not.toBe(antispamHash(b));
  });

  test("cache squelches on repeat within window", () => {
    const cache = createAntispamCache({ ledgerDir: dir, windowMs: 1000 });
    expect(cache.check("abc", 1000)).toBe(false);
    expect(cache.check("abc", 1500)).toBe(true);
    // After window expiry, no longer squelched.
    expect(cache.check("abc", 3000)).toBe(false);
  });
});
