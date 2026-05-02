// @openclaw/skill-task-validator — entrypoint.
//
// Registers the validate_task agent tool. Programmatic API
// (validateTaskDeliverable, individual validators, helpers) is exported
// from ./api.ts for sibling plugins (chuck-docket-executor) to consume
// directly.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createValidateTaskTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-task-validator",
  name: "Task Validator",
  description:
    "Post-spawn deliverable validator: heuristic checks per commandKind; LLM-introspection layer queued for v0.2. Salvages chuck-task-validator.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-task-validator",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createValidateTaskTool({ api, config });
      },
      { name: "validate_task" },
    );
  },
});
