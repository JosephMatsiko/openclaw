// chuck-prior-capsule subprocess wrapper — injectable for tests.

import { execFileSync } from "node:child_process";
import type { PriorCompactionConfig } from "./config.js";
import type { PriorCapsuleReceipt } from "./types.js";

export function defaultRefreshPriorCapsule(
  config: PriorCompactionConfig,
): () => Promise<PriorCapsuleReceipt> {
  return async () => {
    const stdout = execFileSync(
      process.execPath,
      [config.priorCapsuleScript, "--write", "--markdown", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: config.priorCapsuleTimeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const text = String(stdout ?? "").trim();
    if (!text) throw new Error("prior capsule refresh returned empty stdout");
    return JSON.parse(text) as PriorCapsuleReceipt;
  };
}
