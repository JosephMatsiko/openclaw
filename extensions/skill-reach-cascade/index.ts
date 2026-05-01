// @openclaw/skill-reach-cascade — entrypoint.
//
// Registers the reach_cascade agent tool. Programmatic API (notify,
// broadcast, summarizeStatus, replay, etc.) is exported from ./api.ts for
// sibling plugins (chuck-cascade-watcher, chuck-decision-engine) to import
// directly without going through the tool layer.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createReachCascadeTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-reach-cascade",
  name: "Reach Cascade",
  description:
    "Outage-resilient comms cascade across web-push -> apple-bridge -> telegram -> discord -> imessage -> sms-bridge -> voice -> digest. Per-channel reach-ledger writes; quiet-hours + anti-spam aware. Salvages chuck-comms-cascade.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-reach-cascade",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createReachCascadeTool({ api, config });
      },
      { name: "reach_cascade" },
    );
  },
});
