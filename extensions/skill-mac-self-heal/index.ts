// @openclaw/skill-mac-self-heal — entrypoint.
//
// v0.1 plugin pattern (matches Unit 15 / skill-prior-capsule): typed wrapper
// around chuck-mac-self-heal.mjs (1272 LOC reversible local-machine
// stewardship). The .mjs stays canonical because:
//   1. It's the source of truth for receipt format (chuck-v3.mac-self-heal/1
//      schema) and the cache/evidence allowlist heuristics; battle-tested
//      across the chuck-v2/v3 health loop
//   2. It runs on a 2h LaunchAgent already (com.openclaw.chuck-mac-self-
//      heal.plist) — the daemon path stays in .mjs until openclaw cron
//      supports long-running plugin daemons
//   3. Three subsystems already subprocess-spawn it: skill-health-steward
//      (Unit 12 plugin's stabilize + apply paths via SelfHealRunner),
//      skill-docket-executor (Unit 6c plugin's recovery hooks),
//      skill-self-improvement-scanner (Unit 9 plugin's gap detection)
//   4. A 1272-LOC TS port would risk silent wire-format drift in receipts
//      that downstream readers (health-steward archive purge gate,
//      compaction cursor) depend on
//
// What this plugin gives callers: a typed `mac_self_heal` tool + programmatic
// `runStatus(config)` / `runPlan(config, options)` / `runApply(config,
// options)` imports. Tests inject a synthetic `runSubprocess` so they never
// spawn the real binary.
//
// Full TS source-port deferred until openclaw cron / long-running plugin
// daemons land; at that point, port the cache enumeration, evidence
// preservation rules, cloud-offload detection, allowlist gating, and receipt
// writing into ./src/* and retire the .mjs entirely.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createMacSelfHealTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-mac-self-heal",
  name: "Mac Self-Heal",
  description:
    "Typed surface for chuck-mac-self-heal.mjs (1272 LOC reversible local-machine stewardship). Tool 'mac_self_heal' actions: status / plan / apply. Programmatic API runStatus / runPlan / runApply for in-process callers (skill-health-steward, skill-docket-executor, skill-self-improvement-scanner). Full source-port deferred to v0.2.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-mac-self-heal",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createMacSelfHealTool({ api, config });
      },
      { name: "mac_self_heal" },
    );
  },
});
