// @openclaw/plugin-reach-ledger — entrypoint.
//
// Registers the reach_ledger agent tool. Programmatic API
// (recordSuccess, recordFailure, getStatus, rankChannels) is exported
// from ./api.ts for sibling plugins (cascade, comms-cascade, etc.) to
// import directly without going through the tool layer.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createReachLedgerTool } from "./src/tool.js";

export default definePluginEntry({
  id: "reach-ledger",
  name: "Reach Ledger",
  description:
    "Per-channel last_proven_at ledger for outage-resilient reach cascades. Salvages chuck-reach-ledger.mjs into a typed plugin.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "reach-ledger",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createReachLedgerTool({ api, config });
      },
      { name: "reach_ledger" },
    );
  },
});
