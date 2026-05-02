// @openclaw/skill-posterior-delta — entrypoint.
//
// Salvages chuck-posterior-delta.mjs (616 LOC). The .mjs survives as a
// TRANSITIONAL DUPLICATE because chuck-docket-executor.mjs subprocess-invokes
// it. When the executor migrates to importing this plugin's `runFromExecution`
// directly, the .mjs retires.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createPosteriorDeltaTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-posterior-delta",
  name: "Posterior Delta",
  description:
    "Append-only posterior delta writer for chuck-v2/v3 family runner receipts. Mechanical mapping (CLAIMS / RISKS / MISSING_EVIDENCE / DEEPEN_NEEDED + Recommendations) with Ajv schema validation. Pairs with chuck-prior-capsule (Unit 14 candidate) and the compaction gate. Salvages chuck-posterior-delta.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-posterior-delta",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createPosteriorDeltaTool({ api, config });
      },
      { name: "posterior_delta" },
    );
  },
});
