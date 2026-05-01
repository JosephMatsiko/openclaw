// @openclaw/plugin-web-voices — entrypoint.
//
// v0.1 ships the typed catalog + workstation lease primitive + selector
// registry + tool stub. The DOM-fragile harness implementations land in
// v0.2 (per-voice AppleScript / CDP drivers ported from
// extensions/memory-graph/scripts/research-*-chat.mjs). Callers can
// already depend on the catalog + lease + selector contract today;
// dispatch goes through @openclaw/skill-panel-ask in the meantime.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createWebVoiceTool } from "./src/tool.js";

export default definePluginEntry({
  id: "web-voices",
  name: "Web Voices — subscription-driven Chrome voices",
  description:
    "First-class provider plugin for subscription-driven web voices. v0.1 = catalog + lease + selector registry; v0.2 = harness implementations.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "web-voices",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createWebVoiceTool({ api, config });
      },
      { name: "web_voice" },
    );
  },
});
