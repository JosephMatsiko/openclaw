// @openclaw/skill-prior-compaction — entrypoint.
//
// Salvages chuck-prior-compaction.mjs (862 LOC). The .mjs survives as a
// TRANSITIONAL DUPLICATE because chuck-dashboard.mjs subprocess-spawns it
// (line 933, runPriorCompaction → spawnSync(node, [CHUCK_PRIOR_COMPACTION,
// ...args])). When the dashboard migrates to importing this plugin's tool
// surface directly, the .mjs retires.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createPriorCompactionTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-prior-compaction",
  name: "Prior Compaction",
  description:
    "Joseph-gated compaction gate for chuck-v3 priors. status / preview / approve. Mechanical claim promotion across schema-validated posterior deltas; approve refreshes the compact prior capsule via subprocess. Salvages chuck-prior-compaction.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-prior-compaction",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createPriorCompactionTool({ api, config });
      },
      { name: "prior_compaction" },
    );
  },
});
