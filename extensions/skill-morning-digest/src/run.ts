// runDigest — primary entry point. Compose compute → format → optional post → receipt.

import type { MorningDigestConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { computeDigest } from "./digest.js";
import { formatAll } from "./format.js";
import { postDigestToTelegram } from "./post.js";
import { writeReceipt } from "./receipt.js";
import type { RunDigestOptions, RunDigestResult } from "./types.js";

export async function runDigest(
  options: RunDigestOptions = {},
  configIn?: MorningDigestConfig,
): Promise<RunDigestResult> {
  const config = configIn ?? resolveConfig({});
  const now = options.now ?? new Date();
  const data = computeDigest(config, now);
  const { markdown, banner, summary } = formatAll(data, config);

  const format = options.format ?? "default";
  const shouldPost = format === "default" && options.postToTelegram !== false;

  let telegramPosted: boolean | null = false;
  if (shouldPost) {
    try {
      const result = await postDigestToTelegram(markdown);
      telegramPosted = result.delivered;
    } catch (err) {
      process.stderr.write(`[skill-morning-digest] Telegram post failed: ${String(err)}\n`);
      telegramPosted = false;
    }
  } else if (format !== "default") {
    telegramPosted = null;
  }

  const receiptPath = writeReceipt({ data, summary, markdown, banner, telegramPosted }, config);

  return { data, markdown, banner, summary, telegramPosted, receiptPath };
}
