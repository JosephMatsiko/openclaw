// @openclaw/skill-morning-digest — entrypoint.
//
// Registers the morning_digest agent tool. Programmatic API (runDigest,
// computeDigest, formatAll, postDigestToTelegram) is exported from
// ./api.ts for the LaunchAgent + future openclaw cron entrypoints to
// import directly.
//
// Cron registration (StartCalendarInterval at 08:05 CDT) lives outside the
// plugin in ~/Library/LaunchAgents/com.openclaw.chuck-morning-digest.plist
// today; that LaunchAgent invokes the .mjs transitional duplicate which
// in turn writes the same receipt format. When openclaw cron supports
// timezone-aware StartCalendarInterval semantics, the plugin will register
// itself directly.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createMorningDigestTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-morning-digest",
  name: "Morning Digest",
  description:
    "Daily one-screen digest at 08:05 CDT — shipped / blockers / decisions / awaiting-Joseph. Salvages chuck-morning-digest.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-morning-digest",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createMorningDigestTool({ api, config });
      },
      { name: "morning_digest" },
    );
  },
});
