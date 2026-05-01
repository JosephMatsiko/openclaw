// Smoke tests for @openclaw/plugin-web-voices v0.1.
//
// Exercises catalog integrity + capability filter + lease atomicity +
// selector-registry round-trip. The harness layer (per-voice
// AppleScript / CDP) lands in v0.2 and gets its own tests there.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import {
  acquireWithRetry,
  inspect as inspectLease,
  release as releaseLease,
  tryAcquire as tryAcquireLease,
} from "./src/lease.js";
import {
  getSelectorProfile,
  inspectRegistry,
  upsertSelectorProfile,
} from "./src/selector-registry.js";
import { findWebVoice, listWebVoices, voicesSupporting } from "./src/voices.js";

describe("web-voice catalog", () => {
  test("ships 8 voices across 5 vendors", () => {
    const voices = listWebVoices();
    expect(voices.length).toBe(8);
    const vendors = new Set(voices.map((v) => v.vendor));
    expect(vendors).toEqual(new Set(["openai", "anthropic", "google", "xai", "perplexity"]));
  });

  test("voice ids are unique + stable", () => {
    const ids = listWebVoices().map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Stability check: ensure the canonical 8 ids are present.
    const expected = [
      "chatgpt-web",
      "claude-ai-web",
      "gemini-web",
      "aistudio-web",
      "grok-web",
      "perplexity-web",
      "comet-web",
      "notebooklm-web",
    ];
    expect(ids.sort()).toEqual(expected.sort());
  });

  test("findWebVoice returns metadata", () => {
    expect(findWebVoice("gemini-web")?.vendor).toBe("google");
    expect(findWebVoice("ghost")).toBeUndefined();
  });

  test("voicesSupporting filters by capability", () => {
    const grounded = voicesSupporting(["grounding"]);
    expect(grounded.every((v) => v.capabilities.grounding === true)).toBe(true);
    expect(grounded.length).toBeGreaterThan(0);
    const audioCapable = voicesSupporting(["audio"]);
    expect(audioCapable.map((v) => v.id)).toEqual(["notebooklm-web"]);
  });

  test("at least one outage-resilient voice per non-Anthropic non-OpenAI family", () => {
    const resilient = listWebVoices().filter((v) => v.outageResilient);
    const families = new Set(resilient.map((v) => v.vendor));
    expect(families.has("google")).toBe(true);
    expect(families.has("xai")).toBe(true);
    expect(families.has("perplexity")).toBe(true);
  });
});

describe("workstation lease", () => {
  function tmpLease(): string {
    const dir = mkdtempSync(join(tmpdir(), "web-voices-lease-"));
    return join(dir, "lease.json");
  }

  test("acquire then release", () => {
    const path = tmpLease();
    const acq = tryAcquireLease({ reason: "test", leasePath: path });
    expect(acq).not.toBeNull();
    expect(acq!.status).toBe("held");
    expect(releaseLease(acq!.leaseId, path)).toBe(true);
    rmSync(path, { force: true });
  });

  test("second acquire blocked while first held", () => {
    const path = tmpLease();
    const a = tryAcquireLease({ reason: "first", leasePath: path });
    expect(a).not.toBeNull();
    const b = tryAcquireLease({ reason: "second", leasePath: path });
    expect(b).toBeNull();
    releaseLease(a!.leaseId, path);
    rmSync(path, { force: true });
  });

  test("expired lease can be stolen", async () => {
    const path = tmpLease();
    const a = tryAcquireLease({ reason: "first", leasePath: path, holdMs: 10 });
    expect(a).not.toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    const b = tryAcquireLease({ reason: "second", leasePath: path });
    expect(b).not.toBeNull();
    expect(b!.leaseId).not.toBe(a!.leaseId);
    rmSync(path, { force: true });
  });

  test("acquireWithRetry waits then succeeds", async () => {
    const path = tmpLease();
    const a = tryAcquireLease({ reason: "first", leasePath: path, holdMs: 50 });
    expect(a).not.toBeNull();
    const start = Date.now();
    const b = await acquireWithRetry({
      reason: "second",
      leasePath: path,
      timeoutMs: 500,
      pollMs: 50,
    });
    const elapsed = Date.now() - start;
    expect(b).not.toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(40);
    rmSync(path, { force: true });
  });

  test("inspect returns null for missing lease file", () => {
    const path = join(tmpdir(), "nope-" + Date.now() + ".json");
    expect(inspectLease(path)).toBeNull();
  });
});

describe("selector registry", () => {
  function tmpRegistry(): string {
    const dir = mkdtempSync(join(tmpdir(), "web-voices-sel-"));
    return join(dir, "selectors.json");
  }

  test("upsert + read round-trip", () => {
    const path = tmpRegistry();
    upsertSelectorProfile(
      {
        voiceId: "gemini-web",
        version: "2026-04-01",
        selectors: { composer: "[contenteditable]" },
      },
      path,
    );
    const profile = getSelectorProfile("gemini-web", path);
    expect(profile?.version).toBe("2026-04-01");
    expect(profile?.selectors.composer).toBe("[contenteditable]");
    rmSync(path, { force: true });
  });

  test("freshest version wins", () => {
    const path = tmpRegistry();
    upsertSelectorProfile(
      { voiceId: "grok-web", version: "2026-03-01", selectors: { send: ".btn" } },
      path,
    );
    upsertSelectorProfile(
      { voiceId: "grok-web", version: "2026-05-01", selectors: { send: ".send-btn" } },
      path,
    );
    expect(getSelectorProfile("grok-web", path)?.selectors.send).toBe(".send-btn");
    rmSync(path, { force: true });
  });

  test("inspectRegistry returns empty for missing file", () => {
    // Use mkdtempSync so the path is guaranteed unique across parallel
    // test workers (Date.now() suffix can collide under vitest's
    // concurrent execution and pick up another test's writes).
    const dir = mkdtempSync(join(tmpdir(), "web-voices-empty-"));
    const path = join(dir, "missing.json");
    expect(inspectRegistry(path).profiles).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("config resolver", () => {
  test("defaults", () => {
    const c = resolveConfig({});
    expect(c.enabled).toBe(true);
    expect(c.perVoiceTimeoutMs).toBe(300_000);
    expect(c.defaultProfilePort).toBe(9222);
  });

  test("preserves valid overrides", () => {
    const c = resolveConfig({ perVoiceTimeoutMs: 60_000, defaultProfilePort: 9333 });
    expect(c.perVoiceTimeoutMs).toBe(60_000);
    expect(c.defaultProfilePort).toBe(9333);
  });

  test("rejects invalid types", () => {
    const c = resolveConfig({
      perVoiceTimeoutMs: "no",
      enabled: "yes",
    } as unknown as Record<string, unknown>);
    expect(c.perVoiceTimeoutMs).toBe(300_000);
    expect(c.enabled).toBe(true);
  });
});
