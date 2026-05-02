// @openclaw/skill-ollama-runner — entrypoint.
//
// Salvages chuck-ollama-runner.mjs (325 LOC) into a typed plugin. The .mjs
// stays canonical because apex-runtime-chooser.mjs subprocess-spawns it as
// `node chuck-ollama-runner.mjs -p "..."`. Vanilla Node ESM cannot import .ts
// at runtime, so the chooser's spawn path keeps the .mjs alive until the
// chooser itself is salvaged.
//
// In-process callers (background watchers like skill-introspect, skill-
// decision-engine, skill-morning-digest) get the typed `ollama_ask` tool +
// programmatic `askOllama(config, options, deps)` API. HTTP fetcher is
// injectable so tests don't hit a live ollama.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createOllamaAskTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-ollama-runner",
  name: "Ollama Runner",
  description:
    "Direct local-LLM HTTP runner. Salvages chuck-ollama-runner.mjs typed surface; .mjs stays canonical (apex-runtime-chooser subprocess-spawns it).",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-ollama-runner",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };
    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createOllamaAskTool({ api, config });
      },
      { name: "ollama_ask" },
    );
  },
});
