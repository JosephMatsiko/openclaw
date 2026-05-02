// @openclaw/skill-watchers-status — entrypoint.
//
// Salvages chuck-watchers-status.mjs (228 LOC). The .mjs survives only as
// the manual operator CLI (`node chuck-watchers-status.mjs`); no other
// subsystem subprocess-spawns it. Once openclaw exposes a CLI shim that
// invokes this plugin's `watchers_status` tool, the .mjs retires.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createWatchersStatusTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-watchers-status",
  name: "Watchers Status",
  description:
    "Single-command health view across the chuck/apex LaunchAgent surface (gateway + 12 chuck/apex watchers). Salvages chuck-watchers-status.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-watchers-status",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };
    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createWatchersStatusTool({ api, config });
      },
      { name: "watchers_status" },
    );
  },
});
