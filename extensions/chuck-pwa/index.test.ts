// Smoke tests for @openclaw/plugin-chuck-pwa.
//
// Pure-logic checks: voice catalog integrity, config resolver edge cases,
// persona builder behavior with toggles. Live HTTP verification (the
// route handlers) happens via build + curl, not vitest, since the
// handlers depend on the openclaw gateway HTTP surface.

import { describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import { buildChuckPreamble } from "./src/persona.js";
import { findVoice, PWA_VOICES } from "./src/voices.js";

describe("voice catalog", () => {
  test("includes 8 voices across 6 families with at least one outage-resilient", () => {
    expect(PWA_VOICES.length).toBe(8);
    const families = new Set(PWA_VOICES.map((v) => v.family));
    expect(families.size).toBeGreaterThanOrEqual(5);
    expect(PWA_VOICES.some((v) => v.outageResilient)).toBe(true);
  });

  test("voice ids are unique", () => {
    const ids = PWA_VOICES.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("findVoice returns metadata", () => {
    expect(findVoice("gemini-web")?.family).toBe("google");
    expect(findVoice("ollama-local")?.surface).toBe("local-runtime");
    expect(findVoice("nope")).toBeUndefined();
  });

  test("default outage-resilient voice (gemini-web) ships", () => {
    const v = findVoice("gemini-web");
    expect(v).toBeDefined();
    expect(v?.outageResilient).toBe(true);
  });
});

describe("config resolver", () => {
  test("defaults", () => {
    const c = resolveConfig({});
    expect(c.enabled).toBe(true);
    expect(c.routePrefix).toBe("/chuck-v3");
    expect(c.defaultVoice).toBe("gemini-web");
    expect(c.askTimeoutMs).toBe(180_000);
    expect(c.personaInjectsIdentity).toBe(true);
    expect(c.personaInjectsRecentMemory).toBe(true);
    expect(c.personaRecentNodes).toBe(8);
  });

  test("strips trailing slash from routePrefix", () => {
    const c = resolveConfig({ routePrefix: "/chuck-v3/" });
    expect(c.routePrefix).toBe("/chuck-v3");
  });

  test("rejects invalid types, falls back to defaults", () => {
    const c = resolveConfig({
      askTimeoutMs: "not-a-number",
      personaRecentNodes: "no",
      enabled: "yes",
    } as unknown as Record<string, unknown>);
    expect(c.askTimeoutMs).toBe(180_000);
    expect(c.personaRecentNodes).toBe(8);
    expect(c.enabled).toBe(true);
  });

  test("preserves valid overrides", () => {
    const c = resolveConfig({
      defaultVoice: "ollama-local",
      askTimeoutMs: 60_000,
      personaInjectsIdentity: false,
      personaRecentNodes: 0,
    });
    expect(c.defaultVoice).toBe("ollama-local");
    expect(c.askTimeoutMs).toBe(60_000);
    expect(c.personaInjectsIdentity).toBe(false);
    expect(c.personaRecentNodes).toBe(0);
  });
});

describe("buildChuckPreamble", () => {
  test("respects identity injection toggle", async () => {
    const off = await buildChuckPreamble({
      enabled: true,
      routePrefix: "/chuck-v3",
      defaultVoice: "gemini-web",
      askTimeoutMs: 180_000,
      personaInjectsIdentity: false,
      personaInjectsRecentMemory: false,
      personaRecentNodes: 0,
    });
    expect(off).toContain("USER MESSAGE FOLLOWS");
    expect(off).not.toContain("--- IDENTITY.md");
    expect(off).not.toContain("--- recent memory-graph nodes");
  });

  test("includes operating frame regardless of toggles", async () => {
    const out = await buildChuckPreamble({
      enabled: true,
      routePrefix: "/chuck-v3",
      defaultVoice: "gemini-web",
      askTimeoutMs: 180_000,
      personaInjectsIdentity: false,
      personaInjectsRecentMemory: false,
      personaRecentNodes: 0,
    });
    expect(out).toContain("You are CHUCK");
    expect(out).toContain("Joseph's named agent");
    expect(out).toContain("editor, not coach");
  });

  test("respects personaRecentNodes=0 (no memory injection)", async () => {
    const out = await buildChuckPreamble({
      enabled: true,
      routePrefix: "/chuck-v3",
      defaultVoice: "gemini-web",
      askTimeoutMs: 180_000,
      personaInjectsIdentity: false,
      personaInjectsRecentMemory: true,
      personaRecentNodes: 0,
    });
    expect(out).not.toContain("recent memory-graph");
  });
});
