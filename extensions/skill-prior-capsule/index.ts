// @openclaw/skill-prior-capsule — entrypoint.
//
// v0.1 plugin pattern: typed wrapper around chuck-prior-capsule.mjs (1253 LOC
// source-reader + renderer). The .mjs stays canonical because:
//   1. It's the source of truth for the prior-capsule format and is
//      battle-tested
//   2. chuck-docket-executor.mjs (Unit 6c daemon, still .mjs) +
//      skill-docket-executor (Unit 6c plugin) + skill-prior-compaction (Unit 14
//      plugin's approve action) all subprocess-spawn it
//   3. A 1253-LOC port would risk silent wire-format drift at every probe
//      rewrite — receipt JSON shape, sourceHash determinism, capsule body
//      structure are all consumed downstream
//
// What this plugin gives callers: a typed `prior_capsule` tool + programmatic
// `runBuildPriorCapsule(config, options, deps)` import that calls the .mjs and
// parses the result. Tests inject a synthetic `runSubprocess` so they never
// spawn the real binary.
//
// Full TS source-port deferred until openclaw cron / long-running plugin
// daemons land; at that point, port the source readers + summarizers + renderer
// + ID generation into ./src/* and retire the .mjs entirely.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createPriorCapsuleTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-prior-capsule",
  name: "Prior Capsule",
  description:
    "Typed surface for chuck-prior-capsule.mjs (1253 LOC source-reader + renderer). Tool 'prior_capsule' action 'build' invokes the .mjs as a subprocess and returns the parsed receipt; programmatic API runBuildPriorCapsule() for in-process callers (skill-prior-compaction, skill-docket-executor). Full source-port deferred to v0.2.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-prior-capsule",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createPriorCapsuleTool({ api, config });
      },
      { name: "prior_capsule" },
    );
  },
});
