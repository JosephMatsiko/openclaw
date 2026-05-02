// `prior_capsule` agent tool — single action `build`.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { PriorCapsuleConfig } from "./config.js";
import { runBuildPriorCapsule } from "./runner.js";

interface RawParams {
  action: "build";
  write?: boolean;
  markdown?: boolean;
  sourceTaskPath?: string;
  limit?: number;
}

export function createPriorCapsuleTool(_params: {
  api: OpenClawPluginApi;
  config: PriorCapsuleConfig;
}) {
  const config = _params.config;
  return {
    name: "prior_capsule",
    label: "Prior Capsule",
    description:
      "Build the chuck-v3 prior capsule by invoking chuck-prior-capsule.mjs as a subprocess. action 'build' takes write (default false), markdown (only with write), sourceTaskPath (optional docket task that triggered the refresh), limit (default 10 most-recent items). Returns BuildResult with receipt {priorId, sourceHash, createdAt, path, markdownPath, latestPath}; when write=false also returns the full capsule body parsed from stdout.",
    parameters: Type.Object({
      action: Type.String({ enum: ["build"] }),
      write: Type.Optional(Type.Boolean()),
      markdown: Type.Optional(Type.Boolean()),
      sourceTaskPath: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action !== "build") {
        throw new Error(`unknown action: ${(raw as { action: string }).action}`);
      }
      const result = await runBuildPriorCapsule(config, {
        write: raw.write === true,
        markdown: raw.markdown === true,
        sourceTaskPath: raw.sourceTaskPath,
        limit: raw.limit,
      });
      return jsonResult(result);
    },
  };
}
