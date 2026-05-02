// @openclaw/skill-cascade-watcher — entrypoint.
//
// Registers the cascade_watcher agent tool. Programmatic API (handleEvent,
// runTest, summarizeStatus, trigger table, anti-flood + promote helpers)
// is exported from ./api.ts for sibling plugins to consume directly.
//
// The polling daemon itself stays in chuck-cascade-watcher.mjs (invoked
// by ~/Library/LaunchAgents/com.openclaw.chuck-cascade-watcher.plist).
// When openclaw cron supports long-running plugin daemons, the watcher's
// polling loop will move into this plugin.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createCascadeWatcherTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-cascade-watcher",
  name: "Cascade Watcher",
  description:
    "Bus-tail comms-cascade trigger. Trigger table + anti-recursion + anti-flood + auto-promote-to-docket. Salvages chuck-cascade-watcher.mjs (handle + status + test paths; daemon polling stays in .mjs until openclaw cron supports it).",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-cascade-watcher",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createCascadeWatcherTool({ api, config });
      },
      { name: "cascade_watcher" },
    );
  },
});
