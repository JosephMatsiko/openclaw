// `ollama_ask` agent tool — single action.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import { askOllama } from "./client.js";
import type { OllamaConfig } from "./config.js";

interface RawParams {
  prompt: string;
  model?: string;
  system?: string;
  maxTokens?: number;
  temp?: number;
  keepAlive?: string;
}

export function createOllamaAskTool(_params: { api: OpenClawPluginApi; config: OllamaConfig }) {
  const config = _params.config;
  return {
    name: "ollama_ask",
    label: "Ollama Ask",
    description:
      "Direct, non-blocking call to localhost ollama (via HTTP /api/generate, stream=false). Defaults: llama3.1:8b, 512 max tokens, temp 0.2, keep_alive 10m. Returns {ok, reply, model, eval timings}. Use for background watcher work that shouldn't block the gateway event loop.",
    parameters: Type.Object({
      prompt: Type.String(),
      model: Type.Optional(Type.String()),
      system: Type.Optional(Type.String()),
      maxTokens: Type.Optional(Type.Integer({ minimum: 16, maximum: 8192 })),
      temp: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
      keepAlive: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      return jsonResult(await askOllama(config, raw));
    },
  };
}
