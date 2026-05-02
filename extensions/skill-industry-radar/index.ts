// @openclaw/skill-industry-radar — entrypoint.
//
// Registers the industry_radar agent tool. Programmatic API (runScan,
// summarizeStatus, scoreCommit, fetchRepoCommits, buildDigestMarkdown)
// is exported from ./api.ts.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createIndustryRadarTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-industry-radar",
  name: "Industry Radar",
  description:
    "Per-commit watcher for upstream source repos: heuristic scoring + bus events the daily digest folds in. Salvages chuck-industry-radar.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-industry-radar",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createIndustryRadarTool({ api, config });
      },
      { name: "industry_radar" },
    );
  },
});
