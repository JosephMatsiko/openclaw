// `validate_task` agent tool — exposes validateTaskDeliverable through
// openclaw's tool surface so the docket-executor (and agents) can verify
// deliverables in-conversation.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { TaskValidatorConfig } from "./config.js";
import { validateTaskDeliverable } from "./dispatch.js";
import type { DocketTask } from "./types.js";

interface RawParams {
  task: Record<string, unknown>;
}

export function createValidateTaskTool(_params: {
  api: OpenClawPluginApi;
  config: TaskValidatorConfig;
}) {
  const config = _params.config;
  return {
    name: "validate_task",
    label: "Validate Task",
    description:
      "Post-spawn deliverable validator. Pass a docket task object; returns {valid, reason, category, evidence}. Catches the failure mode where a task records exit=0 but the deliverable was never written, is empty, has a stale mtime, or fails its syntactic check (node --check / plutil -lint / JSON.parse).",
    parameters: Type.Object({
      task: Type.Object(
        {
          id: Type.Optional(Type.String()),
          commandKind: Type.Optional(Type.String()),
          intent: Type.Optional(Type.String()),
          startedAt: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (!raw.task || typeof raw.task !== "object") {
        throw new Error("validate_task: 'task' object is required");
      }
      const result = await validateTaskDeliverable(raw.task as DocketTask, config);
      return jsonResult(result);
    },
  };
}
