// `posterior_delta` agent tool — single action `from-runner-execution`.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { PosteriorDeltaConfig } from "./config.js";
import { runFromExecution } from "./runner.js";

interface RawParams {
  action: "from-runner-execution";
  executionPath: string;
  runPath?: string;
  taskPath?: string;
  priorPath?: string;
  write?: boolean;
  includeNonCounting?: boolean;
  writeReadMarkers?: boolean;
}

export function createPosteriorDeltaTool(_params: {
  api: OpenClawPluginApi;
  config: PosteriorDeltaConfig;
}) {
  const config = _params.config;
  return {
    name: "posterior_delta",
    label: "Posterior Delta",
    description:
      "Convert a chuck-v2/v3 family runner-execution receipt JSON into schema-validated posterior deltas (chuck.posterior-delta.v1) plus read markers (chuck.read-marker.v1) when a prior capsule was injected. Mechanical mapping; never asks a model. Action: 'from-runner-execution' takes executionPath (required), optional runPath / taskPath / priorPath / write / includeNonCounting / writeReadMarkers flags. Returns a RunReceipt with deltaCount, readMarkerCount, and per-delta summary.",
    parameters: Type.Object({
      action: Type.String({ enum: ["from-runner-execution"] }),
      executionPath: Type.String(),
      runPath: Type.Optional(Type.String()),
      taskPath: Type.Optional(Type.String()),
      priorPath: Type.Optional(Type.String()),
      write: Type.Optional(Type.Boolean()),
      includeNonCounting: Type.Optional(Type.Boolean()),
      writeReadMarkers: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action !== "from-runner-execution") {
        throw new Error(`unknown action: ${(raw as { action: string }).action}`);
      }
      const { receipt } = await runFromExecution(config, {
        executionPath: raw.executionPath,
        runPath: raw.runPath,
        taskPath: raw.taskPath,
        priorPath: raw.priorPath,
        write: raw.write === true,
        includeNonCounting: raw.includeNonCounting !== false,
        writeReadMarkers: raw.writeReadMarkers !== false,
      });
      return jsonResult(receipt);
    },
  };
}
