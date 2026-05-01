// @openclaw/skill-panel-ask — entrypoint.
//
// Registers a single agent tool (`panel_ask`) that broadcasts a prompt across
// the configured voice catalog in parallel and (optionally) folds the replies
// into a single answer with cross-family discipline.
//
// The first iteration delegates dispatch to the existing battle-tested
// extensions/memory-graph/scripts/apex-panel-ask.mjs subprocess. Stage 3
// follow-on work moves dispatch into TypeScript and removes that hop;
// callers see no contract change because PanelAskInput / PanelAskOutput
// are stable.
//
// Programmatic API: import { runPanelAsk } from "@openclaw/skill-panel-ask";

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createPanelAskTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-panel-ask",
  name: "Skill — Panel Ask",
  description:
    "Broadcast a single intent across multiple AI voices in parallel and synthesize replies with cross-family discipline.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-panel-ask",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) {
          return null;
        }
        return createPanelAskTool({ api, config });
      },
      {
        name: "panel_ask",
      },
    );
  },
});
