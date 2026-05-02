// Public API barrel for @openclaw/skill-ollama-runner.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { askOllama, defaultHttpPoster } from "./src/client.js";
export { resolveConfig, type OllamaConfig } from "./src/config.js";
export type { AskOptions, AskResult, HttpJsonPoster, RunDeps } from "./src/types.js";
