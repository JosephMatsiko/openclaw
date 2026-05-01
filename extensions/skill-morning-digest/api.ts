// Public API barrel for @openclaw/skill-morning-digest.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { runDigest } from "./src/run.js";
export { computeDigest, computeWindow } from "./src/digest.js";
export { fmtMarkdown, fmtBanner, fmtSummary, formatAll } from "./src/format.js";
export { writeReceipt } from "./src/receipt.js";
export { postDigestToTelegram } from "./src/post.js";
export { resolveConfig, type MorningDigestConfig } from "./src/config.js";
export type {
  DigestData,
  DigestFormat,
  DigestSummary,
  DigestWindow,
  DocketTaskRecord,
  DecisionEvent,
  RunDigestOptions,
  RunDigestResult,
} from "./src/types.js";
