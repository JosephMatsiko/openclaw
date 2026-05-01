// `reach_ledger` agent tool — exposes the store + ranking via openclaw's
// tool surface so agents can read/write the ledger in-conversation.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { ReachLedgerConfig } from "./config.js";
import { rankChannels } from "./ranking.js";
import { getStatus, recordFailure, recordSuccess, resetLedger } from "./store.js";

interface RawParams {
  action: "status" | "ranking" | "record-success" | "record-failure" | "reset";
  channel?: string;
  detail?: { messageId?: string | null; transport?: string | null };
  reason?: string;
  defaultOrder?: string[];
  force?: boolean;
}

export function createReachLedgerTool(_params: {
  api: OpenClawPluginApi;
  config: ReachLedgerConfig;
}) {
  const config = _params.config;
  const storeOpts = { ledgerPath: config.ledgerPath };
  return {
    name: "reach_ledger",
    label: "Reach Ledger",
    description:
      "Per-channel last_proven_at ledger. Use 'status' for the full ledger, 'ranking' for cascade order (with default order), 'record-success'/'record-failure' to update from a dispatch, 'reset' to wipe (force required).",
    parameters: Type.Object({
      action: Type.String({
        enum: ["status", "ranking", "record-success", "record-failure", "reset"],
      }),
      channel: Type.Optional(Type.String()),
      detail: Type.Optional(
        Type.Object({
          messageId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          transport: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
      ),
      reason: Type.Optional(Type.String()),
      defaultOrder: Type.Optional(Type.Array(Type.String())),
      force: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "status") {
        return jsonResult(getStatus(storeOpts));
      }
      if (raw.action === "ranking") {
        const defaultOrder = Array.isArray(raw.defaultOrder) ? raw.defaultOrder : [];
        const ranked = rankChannels(defaultOrder, {
          ...storeOpts,
          freshnessMs: config.freshnessWindowMinutes * 60_000,
          circuitBreakerThreshold: config.circuitBreakerThreshold,
        });
        return jsonResult({ defaultOrder, ranked });
      }
      if (raw.action === "record-success") {
        if (!raw.channel) throw new Error("channel required");
        return jsonResult(recordSuccess(raw.channel, raw.detail ?? {}, storeOpts));
      }
      if (raw.action === "record-failure") {
        if (!raw.channel) throw new Error("channel required");
        return jsonResult(recordFailure(raw.channel, raw.reason, storeOpts));
      }
      if (raw.action === "reset") {
        if (raw.force !== true) {
          throw new Error("reset requires force=true");
        }
        resetLedger(storeOpts);
        return jsonResult({ ok: true, reset: true });
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
