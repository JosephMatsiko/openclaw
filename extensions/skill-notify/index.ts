// @openclaw/skill-notify — entrypoint.
//
// Salvages chuck-notify.mjs (375 LOC ledger-only CLI). The .mjs only WRITES
// chuck-v3.notification-ledger/1 entries — it never sends. Senders are
// supposed to be downstream consumers (cascade-watcher / reach-cascade), but
// if the gateway is unhealthy or the consumer chain is broken, ledger-only
// writes silently never deliver.
//
// This plugin fixes the silent-failure mode: when the caller passes
// dispatch=true, the plugin ALSO sends through the openclaw-bound channel
// directly:
//   - telegram → HTTP POST to api.telegram.org/bot<token>/sendMessage as the
//     openclaw bot, to every chatId in openclaw.json#channels.telegram.allowFrom.
//     Returns the Telegram message_id receipt — verifiable delivery.
//   - apple-bridge → osascript display notification (real macOS banner).
//   - all → both, in parallel, returns combined receipts.
//
// The HTTP poster + osascript runner are injectable so tests never make real
// API calls or pop real banners.
//
// Wire-compatible with chuck-notify.mjs:
//   - Same ledger root (~/.openclaw/workspace/state/chuck-v3/notification-ledger)
//   - Same notif_id pattern (notif_<YYYYMMDDTHHMMSSZ>_<rand6>)
//   - Same chuck-v3.notification-ledger/1 schema
//   - Same atomic-write protocol (tmp + rename)
// Existing readers (cascade-watcher, dashboard panels) keep working.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "./api.js";
import { resolveConfig } from "./src/config.js";
import { createNotifyTool } from "./src/tool.js";

export default definePluginEntry({
  id: "skill-notify",
  name: "Notify",
  description:
    "Verified-delivery notification surface. Wire-compatible with chuck-notify.mjs ledger; opt-in dispatch via openclaw-bound Telegram (returns message_id) + apple-bridge desktop. Salvages chuck-notify.mjs.",
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "skill-notify",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveConfig(runtimePluginConfig);
    };

    api.registerTool(
      () => {
        const config = resolveCurrentConfig();
        if (!config.enabled) return null;
        return createNotifyTool({ api, config });
      },
      { name: "notify" },
    );
  },
});
