// @openclaw/plugin-imessage-osascript — entrypoint.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createSmsBridgeTool } from "./src/tool.js";

export default definePluginEntry({
  id: "imessage-osascript",
  name: "iMessage osascript",
  description:
    "Send-only iMessage / Continuity SMS via Messages.app + osascript. Replaces chuck-sms-bridge.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "imessage-osascript",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createSmsBridgeTool({ api, config });
      },
      { name: "sms_bridge" },
    );
  },
});
