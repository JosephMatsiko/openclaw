// Receipt writer — idempotent same-day overwrite under
// ~/.openclaw/workspace/state/chuck-v3/morning-digest/digest-<yyyymmdd>.json.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MorningDigestConfig } from "./config.js";
import type { DigestData, DigestSummary } from "./types.js";

export interface WriteReceiptInput {
  data: DigestData;
  summary: DigestSummary;
  markdown: string;
  banner: string;
  telegramPosted: boolean | null;
}

export function writeReceipt(input: WriteReceiptInput, config: MorningDigestConfig): string | null {
  if (!existsSync(config.digestDir)) {
    try {
      mkdirSync(config.digestDir, { recursive: true });
    } catch {
      // ignore — we'll fail-open below
    }
  }
  const date = new Date(input.data.window.endMs).toISOString().slice(0, 10).replace(/-/g, "");
  const path = join(config.digestDir, `digest-${date}.json`);
  const payload = {
    ...input.summary,
    emitted: {
      markdown: input.markdown,
      banner: input.banner,
      telegramPosted: input.telegramPosted,
    },
    receiptPath: path,
  };
  try {
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return path;
  } catch (err) {
    process.stderr.write(`[skill-morning-digest] receipt write failed: ${String(err)}\n`);
    return null;
  }
}
