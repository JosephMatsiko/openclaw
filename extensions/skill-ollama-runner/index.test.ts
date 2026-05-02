// Test suite for @openclaw/skill-ollama-runner.
//
// HTTP poster injected; the tests never hit a live ollama.

import { describe, expect, it, vi } from "vitest";
import { askOllama, resolveConfig, type HttpJsonPoster, type OllamaConfig } from "./api.js";

function makeConfig(overrides: Partial<OllamaConfig> = {}): OllamaConfig {
  return { ...resolveConfig({}), ...overrides };
}

function makePoster(
  responses: Array<{ status?: number; text?: string; throwError?: string }>,
  capture: { url?: string; body?: Record<string, unknown> } = {},
): HttpJsonPoster {
  let i = 0;
  return vi.fn(async ({ url, body }) => {
    capture.url = url;
    capture.body = body;
    const response = responses[i++] ?? { status: 200, text: "{}" };
    if (response.throwError) throw new Error(response.throwError);
    return {
      ok: (response.status ?? 200) >= 200 && (response.status ?? 200) < 300,
      status: response.status ?? 200,
      text: response.text ?? "",
    };
  });
}

describe("config", () => {
  it("clamps + accepts custom values", () => {
    const cfg = resolveConfig({
      baseUrl: "http://10.0.0.1:11434",
      defaultModel: "qwen2.5:7b",
      defaultMaxTokens: 0,
      defaultTemp: -1,
      generateTimeoutMs: 1,
    });
    expect(cfg.baseUrl).toBe("http://10.0.0.1:11434");
    expect(cfg.defaultModel).toBe("qwen2.5:7b");
    expect(cfg.defaultMaxTokens).toBe(512);
    expect(cfg.defaultTemp).toBe(0.2);
    expect(cfg.generateTimeoutMs).toBe(60_000);
  });
});

describe("askOllama", () => {
  it("posts to /api/generate with stream=false and parses response", async () => {
    const cfg = makeConfig();
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    const httpPost = makePoster(
      [
        {
          status: 200,
          text: JSON.stringify({
            model: "llama3.1:8b",
            response: "hello world",
            prompt_eval_count: 12,
            eval_count: 8,
            eval_duration: 250_000_000,
            total_duration: 500_000_000,
          }),
        },
      ],
      capture,
    );
    const result = await askOllama(cfg, { prompt: "say hi" }, { httpPost });
    expect(result.ok).toBe(true);
    expect(result.reply).toBe("hello world");
    expect(result.model).toBe("llama3.1:8b");
    expect(result.promptEvalCount).toBe(12);
    expect(result.evalCount).toBe(8);
    expect(result.evalDurationMs).toBe(250);
    expect(result.totalDurationMs).toBe(500);
    expect(capture.url).toBe("http://localhost:11434/api/generate");
    expect(capture.body).toMatchObject({
      model: "llama3.1:8b",
      prompt: "say hi",
      stream: false,
      keep_alive: "10m",
    });
  });

  it("forwards model + system + maxTokens + temp + keepAlive overrides", async () => {
    const cfg = makeConfig();
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    const httpPost = makePoster(
      [{ status: 200, text: JSON.stringify({ response: "x" }) }],
      capture,
    );
    await askOllama(
      cfg,
      {
        prompt: "p",
        model: "qwen2.5:7b",
        system: "you are an agent",
        maxTokens: 100,
        temp: 0.7,
        keepAlive: "30m",
      },
      { httpPost },
    );
    expect(capture.body?.model).toBe("qwen2.5:7b");
    expect(capture.body?.system).toBe("you are an agent");
    expect(capture.body?.keep_alive).toBe("30m");
    const opts = capture.body?.options as Record<string, unknown>;
    expect(opts?.num_predict).toBe(100);
    expect(opts?.temperature).toBe(0.7);
  });

  it("returns ok=false on non-OK HTTP status", async () => {
    const cfg = makeConfig();
    const httpPost = makePoster([{ status: 500, text: "internal error" }]);
    const result = await askOllama(cfg, { prompt: "p" }, { httpPost });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/status 500/);
  });

  it("returns ok=false when response field is empty", async () => {
    const cfg = makeConfig();
    const httpPost = makePoster([{ status: 200, text: JSON.stringify({ response: "" }) }]);
    const result = await askOllama(cfg, { prompt: "p" }, { httpPost });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/empty response field/);
  });

  it("returns ok=false on non-JSON body", async () => {
    const cfg = makeConfig();
    const httpPost = makePoster([{ status: 200, text: "not json" }]);
    const result = await askOllama(cfg, { prompt: "p" }, { httpPost });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/failed to parse ollama JSON/);
  });

  it("propagates HTTP poster errors as ok=false reason", async () => {
    const cfg = makeConfig();
    const httpPost = makePoster([{ throwError: "ECONNREFUSED" }]);
    const result = await askOllama(cfg, { prompt: "p" }, { httpPost });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  it("throws on missing prompt", async () => {
    const cfg = makeConfig();
    await expect(askOllama(cfg, { prompt: "" })).rejects.toThrow(/prompt is required/);
  });
});
