// `mac_self_heal` agent tool — actions: status | plan | apply.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { MacSelfHealConfig } from "./config.js";
import { runApply, runPlan, runStatus } from "./runner.js";

interface RawParams {
  action: "status" | "plan" | "apply";
  allowCloudOffload?: boolean;
  maxActions?: number;
  cloudTarget?: string;
  onlyUnderPressure?: boolean;
  dryRun?: boolean;
}

export function createMacSelfHealTool(_params: {
  api: OpenClawPluginApi;
  config: MacSelfHealConfig;
}) {
  const config = _params.config;
  return {
    name: "mac_self_heal",
    label: "Mac Self-Heal",
    description:
      "Reversible local-machine stewardship via chuck-mac-self-heal.mjs subprocess. Actions: 'status' returns disk/swap/load/uptime + last-receipt summary; 'plan' enumerates reversible actions (allowCloudOffload widens to evidence offload candidates); 'apply' executes up to maxActions (default 24), with onlyUnderPressure / cloudTarget / allowCloudOffload gating. dryRun forces apply to downgrade to plan.",
    parameters: Type.Object({
      action: Type.String({ enum: ["status", "plan", "apply"] }),
      allowCloudOffload: Type.Optional(Type.Boolean()),
      maxActions: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      cloudTarget: Type.Optional(Type.String()),
      onlyUnderPressure: Type.Optional(Type.Boolean()),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "status") {
        return jsonResult(await runStatus(config));
      }
      if (raw.action === "plan") {
        return jsonResult(
          await runPlan(config, { allowCloudOffload: raw.allowCloudOffload === true }),
        );
      }
      if (raw.action === "apply") {
        return jsonResult(
          await runApply(config, {
            maxActions: raw.maxActions,
            cloudTarget: raw.cloudTarget,
            onlyUnderPressure: raw.onlyUnderPressure === true,
            allowCloudOffload: raw.allowCloudOffload === true,
            dryRun: raw.dryRun === true,
          }),
        );
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
