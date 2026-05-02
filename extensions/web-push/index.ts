// @openclaw/plugin-web-push — entrypoint.
//
// Registers the web_push agent tool. Programmatic API (sendWebPush,
// listSubscriptions, saveSubscription, removeSubscription, loadVapidKeys,
// loadVapidPublic, sanitizeEndpoint) is exported from ./api.ts for sibling
// plugins (chuck-pwa, skill-reach-cascade) to consume directly without
// going through the tool layer.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createWebPushTool } from "./src/tool.js";

export default definePluginEntry({
  id: "web-push",
  name: "Web Push",
  description:
    "VAPID + ECDH-ES + AES-128-GCM web push sender + subscription store. Salvages chuck-web-push.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "web-push",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createWebPushTool({ api, config });
      },
      { name: "web_push" },
    );
  },
});
