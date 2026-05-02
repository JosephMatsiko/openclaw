// @openclaw/skill-introspect — entrypoint.
//
// Registers the introspect agent tool. Programmatic API (runScan, runFocus,
// summarizeStatus, applyIntrospection, dismissIntrospection, bundle/parse/
// dispatch primitives) is exported from ./api.ts.
//
// The LaunchAgent
// ~/Library/LaunchAgents/com.openclaw.chuck-introspect.plist invokes the
// .mjs every 2h for the heavy LLM scan. v0.2 will fold the scheduled
// invocation into openclaw cron when long-running plugin daemons land.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createIntrospectTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-introspect",
  name: "Introspect",
  description:
    "LLM-driven novel-situation reasoning. Bundles recent state, asks claude-cli (Opus 4.7) for observations the rule-based decision-engine would miss; idempotency via fingerprint dedupe; observations are PROPOSALS, never auto-applied. Salvages chuck-introspect.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-introspect",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createIntrospectTool({ api, config });
      },
      { name: "introspect" },
    );
  },
});
