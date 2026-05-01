// `panel_ask` agent tool definition.
//
// Exposes runPanelAsk() as a typed agent tool. Schema mirrors PanelAskInput
// (in ./types.ts) using TypeBox. The returned tool object is what
// definePluginEntry's registerTool callback expects.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import { runPanelAsk } from "./dispatch.js";
import type { PanelAskInput, PanelAskMode } from "./types.js";
import { listVoices } from "./voices.js";

export interface PanelAskToolConfig {
  enabled?: boolean;
  defaultMode?: PanelAskMode;
  defaultVoices?: string[];
  perVoiceTimeoutMs?: number;
  outputDir?: string;
  scriptPath?: string;
}

interface RawParams {
  prompt?: string;
  file?: string;
  voices?: string[];
  mode?: PanelAskMode;
  label?: string;
  suffix?: string;
  timeoutMs?: number;
  outputDir?: string;
  dryRun?: boolean;
  /** "list" returns the voice catalog without dispatching. */
  action?: "ask" | "list";
}

export function createPanelAskTool(params: { api: OpenClawPluginApi; config: PanelAskToolConfig }) {
  const { config } = params;
  return {
    name: "panel_ask",
    label: "Panel Ask",
    description:
      "Broadcast a single intent across multiple AI voices in parallel. Each voice writes a reply artifact to disk; if mode=synthesize the panel is folded into a single consolidated answer with cross-family discipline (the synthesizer voice cannot share family with the dominant contributor). Use action=list to inspect the voice catalog without dispatching.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          enum: ["ask", "list"],
          description: "ask = run the panel (default). list = return the voice catalog only.",
        }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "Inline prompt body. Mutually exclusive with file." }),
      ),
      file: Type.Optional(
        Type.String({ description: "Absolute path (or ~/-relative) to a prompt file." }),
      ),
      voices: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Subset of voice ids. Empty/undefined uses the configured defaultVoices, else all healthy voices in the catalog.",
        }),
      ),
      mode: Type.Optional(
        Type.String({
          enum: ["raw", "synthesize"],
          description:
            "raw = collect per-voice replies. synthesize = also fold into one answer via cross-family-disciplined synthesizer.",
        }),
      ),
      label: Type.Optional(
        Type.String({ description: "Filename stem for per-voice artifact files." }),
      ),
      suffix: Type.Optional(
        Type.String({
          description:
            'Appended to every voice prompt. Pass "" to disable the dispatcher\'s default 4-question suffix.',
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 5000,
          maximum: 1800000,
          description: "Per-voice timeout in ms.",
        }),
      ),
      outputDir: Type.Optional(
        Type.String({
          description: "Where to write per-voice artifacts. Defaults to ~/Documents.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description: "Preview the dispatch plan without calling any voice.",
        }),
      ),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as RawParams;
      const action = raw.action ?? "ask";

      if (action === "list") {
        return jsonResult({
          voices: listVoices(),
          defaultVoices: config.defaultVoices ?? [],
          defaultMode: config.defaultMode ?? "raw",
        });
      }

      if (!raw.prompt && !raw.file) {
        throw new Error("panel_ask: either `prompt` or `file` is required");
      }

      const requestedVoices =
        raw.voices && raw.voices.length > 0 ? raw.voices : (config.defaultVoices ?? []);

      const input: PanelAskInput = {
        prompt: raw.prompt,
        file: raw.file,
        voices: requestedVoices.length > 0 ? requestedVoices : undefined,
        mode: raw.mode ?? config.defaultMode ?? "raw",
        label: raw.label,
        suffix: raw.suffix,
        timeoutMs: raw.timeoutMs ?? config.perVoiceTimeoutMs,
        outputDir: raw.outputDir ?? config.outputDir,
        dryRun: raw.dryRun === true,
      };

      const result = await runPanelAsk(input, { scriptPath: config.scriptPath });
      return jsonResult(result);
    },
  };
}
