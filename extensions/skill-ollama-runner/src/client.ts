// Direct ollama HTTP client. Calls /api/generate with non-streaming JSON.

import { request as httpRequest } from "node:http";
import type { OllamaConfig } from "./config.js";
import type { AskOptions, AskResult, HttpJsonPoster, RunDeps } from "./types.js";

export function defaultHttpPoster(): HttpJsonPoster {
  return async ({ url, body, timeoutMs }) => {
    return new Promise((resolvePromise, rejectPromise) => {
      const u = new URL(url);
      const data = JSON.stringify(body);
      const req = httpRequest(
        {
          method: "POST",
          host: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data).toString(),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () => {
            resolvePromise({
              ok:
                typeof res.statusCode === "number" && res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode ?? 0,
              text,
            });
          });
        },
      );
      const timer = setTimeout(() => {
        try {
          req.destroy(new Error(`ollama HTTP timed out after ${timeoutMs}ms`));
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      req.on("error", (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      });
      req.on("close", () => clearTimeout(timer));
      req.write(data);
      req.end();
    });
  };
}

export async function askOllama(
  config: OllamaConfig,
  options: AskOptions,
  deps: RunDeps = {},
): Promise<AskResult> {
  if (!options.prompt || typeof options.prompt !== "string") {
    throw new Error("askOllama: prompt is required and must be a string");
  }
  const model = options.model ?? config.defaultModel;
  const system = options.system;
  const maxTokens = options.maxTokens ?? config.defaultMaxTokens;
  const temp = options.temp ?? config.defaultTemp;
  const keepAlive = options.keepAlive ?? config.defaultKeepAlive;
  const url = `${config.baseUrl.replace(/\/$/, "")}/api/generate`;
  const body: Record<string, unknown> = {
    model,
    prompt: options.prompt,
    stream: false,
    keep_alive: keepAlive,
    options: {
      num_predict: maxTokens,
      temperature: temp,
    },
  };
  if (system) body.system = system;
  const poster = deps.httpPost ?? defaultHttpPoster();
  try {
    const res = await poster({ url, body, timeoutMs: config.generateTimeoutMs });
    if (!res.ok) {
      return {
        ok: false,
        reply: "",
        model,
        reason: `ollama HTTP status ${res.status}: ${res.text.slice(0, 500)}`,
      };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(res.text) as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        reply: "",
        model,
        reason: `failed to parse ollama JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const reply = typeof parsed.response === "string" ? parsed.response : "";
    return {
      ok: reply.length > 0,
      reply,
      model: typeof parsed.model === "string" ? parsed.model : model,
      promptEvalCount:
        typeof parsed.prompt_eval_count === "number" ? parsed.prompt_eval_count : undefined,
      evalCount: typeof parsed.eval_count === "number" ? parsed.eval_count : undefined,
      evalDurationMs:
        typeof parsed.eval_duration === "number"
          ? Math.round(parsed.eval_duration / 1_000_000)
          : undefined,
      totalDurationMs:
        typeof parsed.total_duration === "number"
          ? Math.round(parsed.total_duration / 1_000_000)
          : undefined,
      reason: reply.length === 0 ? "ollama returned empty response field" : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      reply: "",
      model,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
