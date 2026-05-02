// Dispatch orchestrator — picks attempters by channel name + fans out.

import { attemptAppleBridge, attemptTelegram } from "./channels.js";
import type { NotifyConfig } from "./config.js";
import type { ChannelDispatchResult, RunDeps } from "./types.js";

export interface DispatchInput {
  channel: string;
  title: string;
  text: string;
  severity?: "info" | "warn" | "critical";
}

export async function dispatchNotification(
  config: NotifyConfig,
  input: DispatchInput,
  deps: RunDeps = {},
): Promise<ChannelDispatchResult[]> {
  const channel = input.channel.toLowerCase();
  const sev = input.severity ?? "info";
  const attemptInput = { config, title: input.title, text: input.text, severity: sev };
  if (channel === "telegram") {
    return attemptTelegram(attemptInput, deps);
  }
  if (channel === "apple-bridge" || channel === "desktop" || channel === "macos") {
    return [await attemptAppleBridge(attemptInput, deps)];
  }
  if (channel === "all") {
    const tg = await attemptTelegram(attemptInput, deps);
    const ab = await attemptAppleBridge(attemptInput, deps);
    return [...tg, ab];
  }
  return [
    {
      channel,
      ok: false,
      reason: `unknown channel '${channel}' (supported: telegram, apple-bridge, all)`,
    },
  ];
}
