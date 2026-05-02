// @openclaw/skill-health-steward — entrypoint.
//
// Salvages chuck-health-steward.mjs (735 LOC, no LaunchAgent) into a typed
// plugin. The .mjs has been retired in this commit — this is the canonical
// surface. Manual operator use goes through the gateway/openclaw tool surface
// (`health_steward`).

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createHealthStewardTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-health-steward",
  name: "Health Steward",
  description:
    "Durable Mac/openclaw stewardship: receipt-first probes (disk/swap/memory/load + executor + docket + process groups), automatic vs approval-gated action plans, stabilize for safe-only application, apply for confirmed approval actions (cloud-offload, purge-verified-local-archive, write-approval-capsules). Salvages chuck-health-steward.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-health-steward",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createHealthStewardTool({ api, config });
      },
      { name: "health_steward" },
    );
  },
});
