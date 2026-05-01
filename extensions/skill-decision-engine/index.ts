// @openclaw/skill-decision-engine — entrypoint.
//
// Registers the decision_engine agent tool. Programmatic API (runScan,
// summarizeStatus, applyDecision, rejectDecision, individual detectors)
// is exported from ./api.ts for sibling plugins (chuck-cascade-watcher,
// chuck-introspect, chuck-watchers-status) to consume directly.
//
// Cron registration (StartInterval=1800 every 30 min) lives outside the
// plugin in ~/Library/LaunchAgents/com.openclaw.chuck-decision-engine.plist
// today; that LaunchAgent invokes the .mjs transitional duplicate. When
// openclaw cron supports auto-registered plugin scans, this plugin will
// register itself directly.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createDecisionEngineTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-decision-engine",
  name: "Decision Engine",
  description:
    "Autonomy primitive: 6 detectors over docket + events + MCP registries; auto-applies low-risk docket promotions; stages med/high proposals for Joseph via skill-reach-cascade. Salvages chuck-decision-engine.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-decision-engine",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createDecisionEngineTool({ api, config });
      },
      { name: "decision_engine" },
    );
  },
});
