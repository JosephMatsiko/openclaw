// `morning_digest` agent tool — exposes runDigest through openclaw's tool
// surface so agents can compute / preview / post the digest in-conversation.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { MorningDigestConfig } from "./config.js";
import { runDigest } from "./run.js";
import type { DigestFormat } from "./types.js";

interface RawParams {
  format?: DigestFormat;
  postToTelegram?: boolean;
}

export function createMorningDigestTool(_params: {
  api: OpenClawPluginApi;
  config: MorningDigestConfig;
}) {
  const config = _params.config;
  return {
    name: "morning_digest",
    label: "Morning Digest",
    description:
      "Compute the daily one-screen digest (shipped / blockers / decisions / awaiting-Joseph) over the prior 24h anchored to yesterday's anchor hour. Default format posts the digest to Telegram via skill-reach-cascade and writes a same-day receipt.",
    parameters: Type.Object({
      format: Type.Optional(Type.String({ enum: ["markdown", "banner", "json", "default"] })),
      postToTelegram: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      const result = await runDigest(
        {
          format: raw.format ?? "default",
          postToTelegram: raw.postToTelegram,
        },
        config,
      );
      return jsonResult({
        receiptPath: result.receiptPath,
        telegramPosted: result.telegramPosted,
        summary: result.summary,
        banner: result.banner,
        markdown: result.markdown,
      });
    },
  };
}
