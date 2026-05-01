// Smoke tests for @openclaw/skill-panel-ask.
//
// These exercise the typed surface (voice catalog, cross-family selection)
// without spawning the dispatch subprocess. Live dispatch verification
// happens via `pnpm openclaw:run-skill-panel-ask` (Stage 3c) or directly
// invoking apex-panel-ask.mjs — that surface is owned by the underlying
// .mjs script and is already battle-tested in production.

import { describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import { synthesizePanel } from "./src/synthesis.js";
import type { VoiceResult } from "./src/types.js";
import { findVoice, listVoices, selectSynthesizer } from "./src/voices.js";

describe("voice catalog", () => {
  test("includes at least one voice from each panel-essential family", () => {
    const families = new Set(listVoices().map((v) => v.family));
    expect(families.has("anthropic")).toBe(true);
    expect(families.has("openai")).toBe(true);
    expect(families.has("google")).toBe(true);
    expect(families.has("xai")).toBe(true);
    expect(families.has("perplexity")).toBe(true);
    expect(families.has("local")).toBe(true);
  });

  test("voice ids are unique", () => {
    const ids = listVoices().map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("findVoice returns the matching catalog entry", () => {
    const voice = findVoice("claude-cli");
    expect(voice?.family).toBe("anthropic");
    expect(voice?.surface).toBe("cli");
  });

  test("findVoice returns undefined for unknown ids", () => {
    expect(findVoice("nope")).toBeUndefined();
  });
});

describe("cross-family discipline", () => {
  test("synthesizer for an anthropic-dominated panel comes from a different family", () => {
    const contributors = ["claude-cli", "claude-ai", "chatgpt-web"];
    const synthesizer = selectSynthesizer(contributors);
    expect(synthesizer).not.toBeNull();
    const family = findVoice(synthesizer ?? "")?.family;
    expect(family).not.toBe("anthropic");
  });

  test("synthesizer for a google-dominated panel comes from a different family", () => {
    const contributors = ["gemini-cli", "gemini-web", "aistudio-web"];
    const synthesizer = selectSynthesizer(contributors);
    expect(synthesizer).not.toBeNull();
    const family = findVoice(synthesizer ?? "")?.family;
    expect(family).not.toBe("google");
  });

  test("returns null when there are no contributors", () => {
    expect(selectSynthesizer([])).toBeNull();
  });

  test("returns null when every candidate shares the dominant family", () => {
    const contributors = ["claude-cli"];
    const result = selectSynthesizer(contributors, ["claude-ai", "claude-cli-web-styled"]);
    expect(result).toBeNull();
  });
});

describe("config resolver", () => {
  test("applies defaults for an empty config", () => {
    const resolved = resolveConfig({});
    expect(resolved.enabled).toBe(true);
    expect(resolved.defaultMode).toBe("synthesize");
    expect(resolved.defaultVoices).toEqual([]);
    expect(resolved.perVoiceTimeoutMs).toBe(300_000);
  });

  test("clamps invalid values back to defaults", () => {
    const resolved = resolveConfig({
      defaultMode: "not-a-mode",
      defaultVoices: ["claude-cli", 42, null],
      perVoiceTimeoutMs: "definitely-not-a-number",
    } as unknown as Record<string, unknown>);
    expect(resolved.defaultMode).toBe("synthesize");
    // Mixed-type arrays fall back to defaults rather than partially passing.
    expect(resolved.defaultVoices).toEqual([]);
    expect(resolved.perVoiceTimeoutMs).toBe(300_000);
  });

  test("preserves valid overrides", () => {
    const resolved = resolveConfig({
      defaultMode: "raw",
      defaultVoices: ["claude-cli", "gemini-web"],
      perVoiceTimeoutMs: 60_000,
      outputDir: "/tmp/panel",
      scriptPath: "/abs/path/to/apex-panel-ask.mjs",
    });
    expect(resolved.defaultMode).toBe("raw");
    expect(resolved.defaultVoices).toEqual(["claude-cli", "gemini-web"]);
    expect(resolved.perVoiceTimeoutMs).toBe(60_000);
    expect(resolved.outputDir).toBe("/tmp/panel");
    expect(resolved.scriptPath).toBe("/abs/path/to/apex-panel-ask.mjs");
  });
});

describe("synthesis", () => {
  function fakeVoice(
    id: string,
    label: string,
    text: string,
  ): VoiceResult & { text: string; label: string } {
    return {
      id,
      label,
      text,
      ok: true,
      path: null,
      chars: text.length,
      ms: 1234,
      error: null,
    };
  }

  test("skips when fewer than 2 voices succeeded", async () => {
    const result = await synthesizePanel({
      prompt: "test",
      voices: [fakeVoice("claude-cli", "Opus-47-CLI", "only one")],
    });
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("only 1 voice");
  });

  test("rejects synthesizer pool that shares family with all contributors", async () => {
    // claude-cli + claude-ai dominant family = anthropic. Pool only contains
    // anthropic voices, so cross-family discipline rules them all out.
    const result = await synthesizePanel({
      prompt: "test",
      voices: [
        fakeVoice("claude-cli", "Opus-47-CLI", "reply A"),
        fakeVoice("claude-ai", "Opus-47-Adaptive-ClaudeAi", "reply B"),
      ],
      synthesizerPool: ["claude-cli", "claude-ai"],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no cross-family-eligible synthesizer");
  });

  test("returns no-runner reason when synthesizer pool selects unknown voice", async () => {
    // claude-cli dominant -> ought to pick a non-anthropic voice. We make
    // the only candidate a voice id without a registered runner.
    const result = await synthesizePanel({
      prompt: "test",
      voices: [
        fakeVoice("claude-cli", "Opus-47-CLI", "reply A"),
        fakeVoice("claude-ai", "Opus-47-Adaptive-ClaudeAi", "reply B"),
      ],
      synthesizerPool: ["chatgpt-web"], // valid voice id, no runner registered yet
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no runner registered");
    expect(result.synthesizer).toBe("chatgpt-web");
  });
});
