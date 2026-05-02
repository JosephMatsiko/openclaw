// @openclaw/skill-dashboard — entrypoint.
//
// v0.1 plugin pattern: typed HTTP client around chuck-dashboard.mjs (9454 LOC
// long-running cockpit on localhost:7777). The .mjs stays canonical because:
//   1. It's a long-running HTTP daemon (KeepAlive=true under
//      ~/Library/LaunchAgents/com.openclaw.chuck-dashboard.plist), not a
//      one-shot script — wrapping as a subprocess like Units 15/16 doesn't
//      apply
//   2. 9454 LOC of state aggregation across ~50 /api/* endpoints (chuck-v3
//      perichoresis / compaction / docket-drafts / executor / authority gates
//      / self-improvement-lab / push; chuck-v2 build / work-ledger / live-
//      build / doctor / family-registry / latest-fleet-run / surface-control
//      / surface-atlas / capability-ledger / transport-audit; top-level
//      snapshot / fleet / principles / processes / mac-health / mac-self-heal
//      / repo-hygiene / github-hygiene / upstream-sync / panels / curator /
//      scorer / router) — full TS port is a multi-week unit, not a single
//      plugin commit
//   3. The cockpit is the operator surface; restart-on-port-bind would
//      disrupt the live page Joseph reads. v0.1 is read-only by design
//
// What this plugin gives callers: a typed `dashboard` tool with `query` /
// `health` / `status` actions + programmatic API. Callers (cross-plugin
// status surfaces, the introspect/morning-digest pipelines) get the same
// data the live cockpit shows without scraping HTML.
//
// Full TS source-port deferred until openclaw daemon-plugin support lands;
// at that point, the cockpit could be re-implemented as a long-running
// plugin that exposes the same /api/* surface plus a typed in-process call
// site.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createDashboardTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-dashboard",
  name: "Dashboard",
  description:
    "Typed HTTP client for chuck-dashboard.mjs cockpit (9454 LOC long-running server on localhost:7777). Tool 'dashboard' actions: query / health / status. Read-only — never restarts the daemon. Programmatic API fetchDashboardEndpoint / checkDashboardHealth / readLaunchAgentStatus for in-process callers. Full source-port deferred to v0.2.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-dashboard",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createDashboardTool({ api, config });
      },
      { name: "dashboard" },
    );
  },
});
