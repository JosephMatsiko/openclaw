// @openclaw/plugin-chuck-pwa — entrypoint.
//
// Replaces the standalone chuck-pwa-server.mjs (port 8093) by registering
// HTTP routes on the openclaw gateway via api.registerHttpRoute. Tailscale
// serve config flips from :8443 → http://localhost:8093 to
// :8443 → http://localhost:18789/<routePrefix> once this plugin is loaded
// and verified. The chuck-pwa-server.mjs + its launchd plist retire in the
// same commit as that flip.
//
// Programmatic dispatch: /ask calls runPanelAsk() from
// @openclaw/skill-panel-ask directly (no subprocess hop). Persona preamble
// reads ~/.openclaw/workspace/IDENTITY.md + recent memory-graph nodes
// fresh on every request — no gateway WS dependency, survives the warmup
// window flagged in our internal observation log.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import {
  makeDecisionsHandler,
  makeDocketHandler,
  makeStatusStripHandler,
  makeSubscribeHandler,
  makeSubscriptionsListHandler,
  makeUnsubscribeHandler,
  makeVapidPublicHandler,
} from "./src/legacy-routes.js";
import {
  makeAskHandler,
  makeHealthHandler,
  makeStaticHandler,
  makeVoicesHandler,
  type RouteContext,
} from "./src/routes.js";

const HOME = homedir();
const PWA_DIR = join(HOME, ".openclaw", "workspace", "state", "chuck-v3", "pwa");

export default definePluginEntry({
  id: "chuck-pwa",
  name: "Chuck PWA — operator chat surface",
  description:
    "Tailscale-served chat surface on the openclaw gateway. Replaces standalone chuck-pwa-server.mjs.",
  register(api) {
    const config = (() => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "chuck-pwa",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    })();

    if (!config.enabled) {
      return;
    }

    if (!existsSync(PWA_DIR)) {
      mkdirSync(PWA_DIR, { recursive: true });
    }

    const ctx: RouteContext = { config, pwaDir: PWA_DIR };
    const apiPrefix = `/api${config.routePrefix}`;
    const staticPrefix = config.routePrefix;

    // API routes — exact match per endpoint.
    api.registerHttpRoute({
      path: `${apiPrefix}/health`,
      auth: "plugin",
      match: "exact",
      handler: makeHealthHandler(ctx),
    });
    api.registerHttpRoute({
      path: `${apiPrefix}/voices`,
      auth: "plugin",
      match: "exact",
      handler: makeVoicesHandler(ctx),
    });
    api.registerHttpRoute({
      path: `${apiPrefix}/ask`,
      auth: "plugin",
      match: "exact",
      handler: makeAskHandler(ctx),
    });

    // Push subscriptions (web-push VAPID + iPad/iPhone subscribe/unsubscribe).
    // Salvaged from chuck-pwa-server.mjs. Backed by chuck-web-push.mjs.
    api.registerHttpRoute({
      path: `${apiPrefix}/push/vapid-public`,
      auth: "plugin",
      match: "exact",
      handler: makeVapidPublicHandler(),
    });
    api.registerHttpRoute({
      path: `${apiPrefix}/push/subscribe`,
      auth: "plugin",
      match: "exact",
      handler: makeSubscribeHandler(),
    });
    api.registerHttpRoute({
      path: `${apiPrefix}/push/unsubscribe`,
      auth: "plugin",
      match: "exact",
      handler: makeUnsubscribeHandler(),
    });
    api.registerHttpRoute({
      path: `${apiPrefix}/push/subscriptions`,
      auth: "plugin",
      match: "exact",
      handler: makeSubscriptionsListHandler(),
    });

    // Cockpit data endpoints — read-only views into chuck-v3 state.
    // Salvaged from chuck-pwa-server.mjs. Each is a thin wrapper around
    // file reads under ~/.openclaw/workspace/state/chuck-v3/.
    api.registerHttpRoute({
      path: `${apiPrefix}/docket`,
      auth: "plugin",
      match: "exact",
      handler: makeDocketHandler(),
    });
    api.registerHttpRoute({
      path: `${apiPrefix}/status-strip`,
      auth: "plugin",
      match: "exact",
      handler: makeStatusStripHandler(),
    });
    api.registerHttpRoute({
      path: `${apiPrefix}/decisions`,
      auth: "plugin",
      match: "exact",
      handler: makeDecisionsHandler(),
    });

    // Static assets — prefix match. Catches /chuck-v3/, /chuck-v3/chat.html,
    // /chuck-v3/<any-file>. The handler does its own path-traversal check.
    api.registerHttpRoute({
      path: staticPrefix,
      auth: "plugin",
      match: "prefix",
      handler: makeStaticHandler(ctx, staticPrefix),
    });

    // Legacy compatibility — Joseph's iPad + iPhone PWA bookmarks point at
    // /chat.html (no prefix), the URL chuck-pwa-server.mjs served from :8093
    // before this plugin took over the gateway routes. Register an explicit
    // alias so the existing Add-to-Home-Screen installs keep working without
    // re-adding. The handler reuses the static handler with an empty prefix
    // so it resolves /chat.html → ${PWA_DIR}/chat.html.
    api.registerHttpRoute({
      path: "/chat.html",
      auth: "plugin",
      match: "exact",
      handler: makeStaticHandler(ctx, ""),
    });
  },
});
