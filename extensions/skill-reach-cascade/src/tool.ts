// `reach_cascade` agent tool — exposes notify/broadcast/status/replay through
// openclaw's tool surface so agents can drive both the first-success-wins
// cascade and the fan-out broadcast in-conversation.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import { broadcast } from "./broadcast.js";
import type { ReachCascadeConfig } from "./config.js";
import { notify } from "./notify.js";
import { replay, summarizeStatus } from "./status.js";
import type { ChannelName, NotifyPayload, Severity, Tier } from "./types.js";

interface RawParams {
  action: "notify" | "broadcast" | "status" | "replay";
  subject?: string;
  body?: string | null;
  severity?: Severity;
  tier?: Tier;
  origin?: { kind?: string; id?: string; [key: string]: unknown } | null;
  dryRun?: boolean;
  skipAppleBridge?: boolean;
  ledgerEntryId?: string;
  /** broadcast: include voice in the fan-out (default: omit). */
  includeVoice?: boolean;
  /** broadcast: skip these channels. */
  exclude?: ChannelName[];
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
      "Outage-resilient comms. Use 'notify' to walk the first-success-wins cascade (web-push -> apple-bridge -> telegram -> discord -> imessage -> sms-bridge -> voice -> digest); 'broadcast' to fan-out the same payload to every enabled channel in parallel (no first-success short-circuit); 'status' for the recent cascade ledger; 'replay <ledgerEntryId>' to re-run a prior cascade with antispam bypassed.",
    parameters: Type.Object({
      action: Type.String({ enum: ["notify", "broadcast", "status", "replay"] }),
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
      includeVoice: Type.Optional(Type.Boolean()),
      exclude: Type.Optional(Type.Array(Type.String())),
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
      if (raw.action === "broadcast") {
        if (!raw.subject) throw new Error("broadcast: subject is required");
        const payload: NotifyPayload = {
          subject: raw.subject,
          body: raw.body ?? null,
          severity: raw.severity,
          origin: raw.origin ?? null,
        };
        const result = await broadcast(
          payload,
          {
            includeVoice: raw.includeVoice === true,
            dryRun: raw.dryRun === true,
            exclude: raw.exclude,
          },
          config,
        );
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
