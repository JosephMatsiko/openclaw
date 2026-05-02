// @openclaw/skill-self-improvement-scanner — entrypoint.
//
// Registers the self_improvement_scanner agent tool. Programmatic API
// (runScan, summarizeStatus, individual detectors, buildTask, writeTask)
// is exported from ./api.ts for sibling plugins to consume directly.
//
// The LaunchAgent at
// ~/Library/LaunchAgents/com.openclaw.chuck-self-improvement-scanner.plist
// invokes the .mjs every 6h. v0.2 will fold the scheduled invocation into
// openclaw cron when long-running plugin daemons land.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createSelfImprovementScannerTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-self-improvement-scanner",
  name: "Self-Improvement Scanner",
  description:
    "Recursive autonomy primitive: 6 gap detectors (dockethealth, stuckpending, mcpgap, plistgap, skillgap, busdiversity); idempotent task drops; anti-flood cap. Salvages chuck-self-improvement-scanner.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-self-improvement-scanner",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createSelfImprovementScannerTool({ api, config });
      },
      { name: "self_improvement_scanner" },
    );
  },
});
