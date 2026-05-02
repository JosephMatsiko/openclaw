// `introspect` agent tool — exposes scan/focus/status/apply/dismiss through
// openclaw's tool surface. The LaunchAgent invokes the .mjs every 2h for
// the heavy LLM scan; the tool here is for in-conversation probes.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { IntrospectConfig } from "./config.js";
import { runFocus } from "./focus.js";
import { runScan } from "./scan.js";
import { applyIntrospection, dismissIntrospection, summarizeStatus } from "./status.js";

interface RawParams {
  action: "scan" | "focus" | "status" | "apply" | "dismiss";
  topic?: string;
  introspectId?: string;
  reason?: string;
  dryRun?: boolean;
}

export function createIntrospectTool(_params: {
  api: OpenClawPluginApi;
  config: IntrospectConfig;
}) {
  const config = _params.config;
  return {
    name: "introspect",
    label: "Introspect",
    description:
      "LLM-driven novel-situation reasoning. 'scan' bundles recent state and asks claude-cli for observations the rule-based decision-engine would miss; 'focus <topic>' asks a targeted question with optional observations attached. 'status' lists open introspections; 'apply <id>' marks one as actioned; 'dismiss <id> [reason]' marks one as rejected.",
    parameters: Type.Object({
      action: Type.String({ enum: ["scan", "focus", "status", "apply", "dismiss"] }),
      topic: Type.Optional(Type.String()),
      introspectId: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "scan") {
        return jsonResult(await runScan({ dryRun: raw.dryRun === true }, config));
      }
      if (raw.action === "focus") {
        if (!raw.topic) throw new Error("focus: topic is required");
        return jsonResult(await runFocus(raw.topic, {}, config));
      }
      if (raw.action === "status") {
        return jsonResult(summarizeStatus(config));
      }
      if (raw.action === "apply") {
        if (!raw.introspectId) throw new Error("apply: introspectId is required");
        return jsonResult(applyIntrospection(raw.introspectId, config));
      }
      if (raw.action === "dismiss") {
        if (!raw.introspectId) throw new Error("dismiss: introspectId is required");
        return jsonResult(dismissIntrospection(raw.introspectId, raw.reason ?? null, config));
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
