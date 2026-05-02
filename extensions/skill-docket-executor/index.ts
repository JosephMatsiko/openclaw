// @openclaw/skill-docket-executor — entrypoint.
//
// Registers the docket_executor agent tool. Programmatic API (COMMANDS,
// commandLane, eligibilityBlockers, checkEligibility, timeoutPolicyForTask,
// macHealthGateStatus, readExecutorControl, summarizeStatus, buildExecutorEnv,
// lane policies) is exported from ./api.ts for sibling plugins to consume
// directly.
//
// The long-running daemon (tick/claim/runTask/spawnBounded/zombie sweep/
// heartbeat/posterior-delta/prior-refresh) lives in chuck-docket-executor.mjs
// invoked by ~/Library/LaunchAgents/com.openclaw.chuck-docket-executor.plist.
// When openclaw cron grows long-running plugin-daemon support, the daemon
// will move into this plugin. v0.1 ships the read-only typed surface; v0.2
// will fold in the daemon.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createDocketExecutorTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-docket-executor",
  name: "Docket Executor",
  description:
    "Typed canonical for chuck-v3 docket executor: command registry, lane policies, mac gate, eligibility checks, executor control. Long-running daemon stays in chuck-docket-executor.mjs (v0.2 will fold it in).",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-docket-executor",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createDocketExecutorTool({ api, config });
      },
      { name: "docket_executor" },
    );
  },
});
