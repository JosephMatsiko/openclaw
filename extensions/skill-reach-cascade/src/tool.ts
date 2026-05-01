// `reach_cascade` agent tool — exposes notify/status/replay through openclaw's
// tool surface so agents can drive the cascade in-conversation.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { ReachCascadeConfig } from "./config.js";
import { notify } from "./notify.js";
import { replay, summarizeStatus } from "./status.js";
import type { NotifyPayload, Severity, Tier } from "./types.js";

interface RawParams {
  action: "notify" | "status" | "replay";
  subject?: string;
  body?: string | null;
  severity?: Severity;
  tier?: Tier;
  origin?: { kind?: string; id?: string; [key: string]: unknown } | null;
  dryRun?: boolean;
  skipAppleBridge?: boolean;
  ledgerEntryId?: string;
}

export function createReachCascadeTool(_params: {
  api: OpenClawPluginApi;
  config: ReachCascadeConfig;
}) {
  const config = _params.config;
  return {
    name: "reach_cascade",
    label: "Reach Cascade",
    description:
      "Outage-resilient comms cascade. Use 'notify' with subject + body + severity to walk the cascade (web-push -> apple-bridge -> telegram -> discord -> imessage -> sms-bridge -> voice -> digest). 'status' returns the recent ledger summary. 'replay <ledgerEntryId>' re-runs a prior cascade with antispam bypassed.",
    parameters: Type.Object({
      action: Type.String({ enum: ["notify", "status", "replay"] }),
      subject: Type.Optional(Type.String()),
      body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      severity: Type.Optional(Type.String({ enum: ["info", "warn", "critical"] })),
      tier: Type.Optional(Type.String({ enum: ["immediate", "immediate-low-friction", "digest"] })),
      origin: Type.Optional(
        Type.Union([
          Type.Object(
            {
              kind: Type.Optional(Type.String()),
              id: Type.Optional(Type.String()),
            },
            { additionalProperties: true },
          ),
          Type.Null(),
        ]),
      ),
      dryRun: Type.Optional(Type.Boolean()),
      skipAppleBridge: Type.Optional(Type.Boolean()),
      ledgerEntryId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "notify") {
        if (!raw.subject) throw new Error("notify: subject is required");
        const payload: NotifyPayload = {
          subject: raw.subject,
          body: raw.body ?? null,
          severity: raw.severity,
          tier: raw.tier,
          origin: raw.origin ?? null,
          dryRun: raw.dryRun === true,
          skipAppleBridge: raw.skipAppleBridge === true,
        };
        const result = await notify(payload, {}, config);
        return jsonResult(result);
      }
      if (raw.action === "status") {
        return jsonResult(summarizeStatus(config));
      }
      if (raw.action === "replay") {
        if (!raw.ledgerEntryId) throw new Error("replay: ledgerEntryId is required");
        const result = await replay(raw.ledgerEntryId, config);
        return jsonResult(result);
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
