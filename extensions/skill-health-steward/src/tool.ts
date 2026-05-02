// `health_steward` agent tool — exposes status / stabilize / apply.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import { applyAction } from "./apply.js";
import type { HealthStewardConfig } from "./config.js";
import { stabilize } from "./stabilize.js";
import { buildStatus } from "./status.js";

interface RawParams {
  action: "status" | "stabilize" | "apply";
  applyAction?: string;
  confirm?: string;
  maxActions?: number;
  writeApprovals?: boolean;
}

export function createHealthStewardTool(_params: {
  api: OpenClawPluginApi;
  config: HealthStewardConfig;
}) {
  const config = _params.config;
  return {
    name: "health_steward",
    label: "Health Steward",
    description:
      "Receipt-first stewardship for Mac/openclaw resource pressure. 'status' returns the canonical health-steward payload (disk/swap/memory/load + executor + docket + process groups + safe vs cloud-allowed self-heal previews + automatic vs approval-gated action lists). 'stabilize' applies safe automatic actions only (pause executor on blocked, run safe self-heal). 'apply' executes a confirmed approval action: cloud-offload (RUN_APPROVED_CLOUD_OFFLOAD) | purge-local-archive (PURGE_VERIFIED_LOCAL_ARCHIVE) | write-approval-capsules.",
    parameters: Type.Object({
      action: Type.String({ enum: ["status", "stabilize", "apply"] }),
      applyAction: Type.Optional(Type.String()),
      confirm: Type.Optional(Type.String()),
      maxActions: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      writeApprovals: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "status") {
        return jsonResult(
          await buildStatus(config, { writeApprovals: raw.writeApprovals === true }),
        );
      }
      if (raw.action === "stabilize") {
        return jsonResult(
          await stabilize(config, raw.maxActions ? { maxActions: raw.maxActions } : {}),
        );
      }
      if (raw.action === "apply") {
        if (!raw.applyAction) throw new Error("apply: applyAction is required");
        return jsonResult(
          await applyAction(config, {
            action: raw.applyAction,
            confirm: raw.confirm,
            maxActions: raw.maxActions,
          }),
        );
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
