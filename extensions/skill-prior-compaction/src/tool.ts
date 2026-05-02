// `prior_compaction` agent tool — actions: status | preview | approve.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import { approveDecision } from "./approve.js";
import type { PriorCompactionConfig } from "./config.js";
import { previewDecision } from "./preview.js";
import { buildStatus } from "./status.js";

interface RawParams {
  action: "status" | "preview" | "approve";
  write?: boolean;
  limit?: number;
  decision?: string;
  confirm?: string;
  approvedBy?: string;
}

export function createPriorCompactionTool(_params: {
  api: OpenClawPluginApi;
  config: PriorCompactionConfig;
}) {
  const config = _params.config;
  return {
    name: "prior_compaction",
    label: "Prior Compaction",
    description:
      "Joseph-gated compaction gate for chuck-v3 priors. 'status' returns latest applied + draft + an in-memory preview summary. 'preview' produces a deterministic draft compaction (writes only with write:true). 'approve' transitions a draft → approved → applying → applied with confirm: APPROVE_PRIOR_COMPACTION; the applied step refreshes the compact prior capsule via chuck-prior-capsule subprocess.",
    parameters: Type.Object({
      action: Type.String({ enum: ["status", "preview", "approve"] }),
      write: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 10, maximum: 10_000 })),
      decision: Type.Optional(Type.String()),
      confirm: Type.Optional(Type.String()),
      approvedBy: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "status") {
        return jsonResult(buildStatus(config, raw.limit ? { limit: raw.limit } : {}));
      }
      if (raw.action === "preview") {
        return jsonResult(
          await previewDecision(config, {
            write: raw.write === true,
            limit: raw.limit,
          }),
        );
      }
      if (raw.action === "approve") {
        if (!raw.decision) throw new Error("approve: decision is required");
        if (!raw.confirm) throw new Error("approve: confirm is required");
        return jsonResult(
          await approveDecision(config, {
            decision: raw.decision,
            confirm: raw.confirm,
            approvedBy: raw.approvedBy,
          }),
        );
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
