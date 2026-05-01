// `sms_bridge` agent tool — Messages.app send.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { ImessageOsascriptConfig } from "./config.js";
import { sendImessage } from "./send.js";

interface RawParams {
  buddy?: string;
  text?: string;
  recordToLedger?: boolean;
}

export function createSmsBridgeTool(_params: {
  api: OpenClawPluginApi;
  config: ImessageOsascriptConfig;
}) {
  const config = _params.config;
  return {
    name: "sms_bridge",
    label: "iMessage / SMS Bridge",
    description:
      "Send a message via Apple Messages.app (iMessage when recipient is reachable, SMS-over-LTE via iPhone Continuity otherwise). Bypasses openclaw's bundled imessage channel — independent of Wi-Fi + gateway health.",
    parameters: Type.Object({
      buddy: Type.Optional(
        Type.String({
          description:
            "Recipient (E.164 or Apple ID). Falls back to the plugin's defaultBuddy config when omitted.",
        }),
      ),
      text: Type.String({ description: "Message body." }),
      recordToLedger: Type.Optional(
        Type.Boolean({
          description:
            "When false, skip the reach-ledger write (used by cascade orchestrators that record on their own).",
        }),
      ),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      const buddy = raw.buddy?.trim() || config.defaultBuddy;
      if (!buddy) {
        throw new Error(
          "buddy required (no `buddy` argument and plugin config has no defaultBuddy)",
        );
      }
      if (!raw.text?.trim()) {
        throw new Error("text required");
      }
      const result = sendImessage({
        buddy,
        text: raw.text,
        recordToLedger: raw.recordToLedger ?? config.recordToLedger,
        timeoutMs: config.timeoutMs,
      });
      return jsonResult(result);
    },
  };
}
