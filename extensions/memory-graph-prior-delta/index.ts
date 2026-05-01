// @openclaw/plugin-memory-graph-prior-delta — entrypoint.
//
// Registers the `prior_delta` agent tool. First iteration exposes only the
// validators + content-address helpers; persistence lands in v0.2 once the
// memory-graph plugin's runtime hook surface is wired.
//
// Programmatic API:
//   import {
//     validateCompaction, validateAppendOnly,
//     priorCapsuleId, posteriorDeltaId,
//   } from "@openclaw/plugin-memory-graph-prior-delta";

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createPriorDeltaTool } from "./src/tool.js";

export default definePluginEntry({
  id: "memory-graph-prior-delta",
  name: "Memory Graph — Universal Prior + Posterior Delta",
  description:
    "Typed dissent-preserving prior contract for multi-agent OpenClaw, with append-only and cross-family discipline invariants enforced as schema validators.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "memory-graph-prior-delta",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) {
          return null;
        }
        return createPriorDeltaTool({ api, config });
      },
      {
        name: "prior_delta",
      },
    );
  },
});
