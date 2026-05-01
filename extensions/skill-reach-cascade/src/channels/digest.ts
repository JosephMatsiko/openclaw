// digest channel — write a JSON record to today's morning-digest pending
// queue. This is the cascade's safety-net terminus: it always succeeds
// locally and is included in every cascade so an "all live channels failed"
// run still leaves a paper trail for the morning digest job to surface.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptResult, NotifyPayload } from "../types.js";

export interface DigestOptions {
  digestPendingDir: string;
}

export function attemptDigest(
  payload: NotifyPayload,
  ledgerEntryId: string | null,
  opts: DigestOptions,
): AttemptResult {
  const start = Date.now();
  try {
    if (!existsSync(opts.digestPendingDir)) {
      mkdirSync(opts.digestPendingDir, { recursive: true });
    }
    const id = ledgerEntryId ?? `notif-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const record = {
      id,
      ts: new Date().toISOString(),
      ledgerEntryId,
      payload,
      tier: payload.tier ?? null,
      severity: payload.severity ?? "info",
    };
    writeFileSync(
      join(opts.digestPendingDir, `${id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    return { ok: true, durationMs: Date.now() - start, detail: { recordId: id } };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message ?? String(err),
      durationMs: Date.now() - start,
    };
  }
}
