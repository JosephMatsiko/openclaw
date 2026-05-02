// @openclaw/skill-gateway-watchdog — entrypoint.
//
// Registers the gateway_watchdog agent tool. Programmatic API (probe, tick,
// summarizeStatus, restartGateway, individual probe primitives, state IO)
// is exported from ./api.ts for sibling plugins (cascade-watcher /
// introspect / cockpit) to consume directly.
//
// The polling daemon (60s tick + signal handling) stays in
// chuck-gateway-watchdog.mjs invoked by
// ~/Library/LaunchAgents/com.openclaw.chuck-gateway-watchdog.plist. v0.2
// will fold the daemon in once openclaw cron supports long-running
// plugin daemons.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createGatewayWatchdogTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-gateway-watchdog",
  name: "Gateway Watchdog",
  description:
    "Probe gateway event-loop health and auto-restart via launchctl when pinned. Anti-flap backoff + daily cap. Salvages chuck-gateway-watchdog.mjs (probe/tick/status; daemon stays in .mjs until v0.2).",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-gateway-watchdog",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createGatewayWatchdogTool({ api, config });
      },
      { name: "gateway_watchdog" },
    );
  },
});
