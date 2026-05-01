// `web_voice` agent tool. v0.1 stub — exposes the catalog and a dryRun
// dispatch path. The harness implementations land in v0.2 (per-voice
// AppleScript / CDP drivers) so the contract is publishable today.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { WebVoicesConfig } from "./config.js";
import { inspect as inspectLease } from "./lease.js";
import { inspectRegistry } from "./selector-registry.js";
import type { WebVoiceAskInput, WebVoiceAskResult } from "./types.js";
import { findWebVoice, listWebVoices, voicesSupporting } from "./voices.js";

interface RawParams {
  action: "list" | "ask" | "filter" | "lease" | "selectors";
  ask?: WebVoiceAskInput;
  filter?: { needs: Array<keyof import("./types.js").WebVoiceCapabilityMatrix> };
}

export function createWebVoiceTool(_params: { api: OpenClawPluginApi; config: WebVoicesConfig }) {
  return {
    name: "web_voice",
    label: "Web Voices",
    description:
      "Subscription-driven web voices catalog + dispatch. action=list returns the 8-voice catalog. action=filter returns voices supporting requested capabilities. action=ask dispatches a prompt to a single web voice (v0.2 — currently dryRun-only). action=lease/selectors inspect the workstation lease + selector registry.",
    parameters: Type.Object({
      action: Type.String({
        enum: ["list", "ask", "filter", "lease", "selectors"],
        description: "Catalog query / dispatch action.",
      }),
      ask: Type.Optional(
        Type.Object(
          {
            voiceId: Type.String(),
            prompt: Type.String(),
            attachments: Type.Optional(Type.Array(Type.String())),
            timeoutMs: Type.Optional(Type.Integer()),
            label: Type.Optional(Type.String()),
            outputDir: Type.Optional(Type.String()),
            dryRun: Type.Optional(Type.Boolean()),
          },
          { description: "Required when action='ask'." },
        ),
      ),
      filter: Type.Optional(
        Type.Object(
          {
            needs: Type.Array(
              Type.String({
                enum: ["text", "image", "pdf", "audio", "video", "codeRepo", "grounding"],
              }),
            ),
          },
          { description: "Required when action='filter'." },
        ),
      ),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      // Type assertion via unknown — TS rejects the direct narrowing because
      // RawParams has stricter discriminants than Record<string, unknown>.
      // The TypeBox schema above validates the shape at runtime; the cast
      // is just to give the discriminated-union switch its type.
      const raw = rawParams as unknown as RawParams;

      if (raw.action === "list") {
        return jsonResult({ voices: listWebVoices() });
      }
      if (raw.action === "filter") {
        if (!raw.filter?.needs?.length) {
          throw new Error("filter.needs required");
        }
        return jsonResult({ voices: voicesSupporting(raw.filter.needs) });
      }
      if (raw.action === "lease") {
        return jsonResult({ lease: inspectLease() });
      }
      if (raw.action === "selectors") {
        return jsonResult({ registry: inspectRegistry() });
      }
      if (raw.action === "ask") {
        if (!raw.ask?.voiceId || !raw.ask?.prompt) {
          throw new Error("ask.voiceId + ask.prompt required");
        }
        const voice = findWebVoice(raw.ask.voiceId);
        if (!voice) throw new Error(`unknown voice: ${raw.ask.voiceId}`);
        // v0.1: ask is dryRun-only. The harness layer ships in v0.2.
        const result: WebVoiceAskResult = {
          ok: false,
          voiceId: raw.ask.voiceId,
          label: raw.ask.label ?? "ASK",
          replyPath: null,
          reply: "",
          chars: 0,
          ms: 0,
          error: "v0.1 ships catalog + lease + selector registry only; harness lands in v0.2",
          warnings: [
            "Until v0.2 ships, dispatch through the existing apex-panel-ask.mjs subprocess via @openclaw/skill-panel-ask runPanelAsk() which already handles per-voice drivers.",
          ],
        };
        return jsonResult(result);
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
