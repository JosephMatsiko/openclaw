// Anti-spam dedupe.
//
// Identical (subject + body + severity) tuples within a configurable window
// are squelched so a misbehaving caller in a tight loop doesn't shred the
// reach-ledger. State has two layers:
//
//   1. In-process Map keyed by hash → ts(ms). Cheap, never crosses process
//      boundaries.
//   2. Cold-start consult: the cascade's notification ledger is read for any
//      entry inside the window with a matching `antispamHash`. This catches
//      back-to-back invocations from short-lived CLI calls (cron jobs, etc).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEntry, NotifyPayload } from "./types.js";

export interface AntispamCache {
  /**
   * Returns true when this hash was seen within the configured window.
   * On a fresh hit the cache records `now()` so subsequent calls keep
   * triggering until the window expires.
   */
  check: (hash: string, now?: number) => boolean;
}

export function antispamHash(payload: NotifyPayload): string {
  const key = `${payload.subject ?? ""}::${payload.body ?? ""}::${payload.severity ?? "info"}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

export function createAntispamCache(opts: { ledgerDir: string; windowMs: number }): AntispamCache {
  const cache = new Map<string, number>();

  function pruneStale(now: number): void {
    for (const [k, ts] of cache) {
      if (now - ts > opts.windowMs) cache.delete(k);
    }
  }

  function ledgerHasRecent(hash: string, cutoff: number): boolean {
    if (!existsSync(opts.ledgerDir)) return false;
    try {
      const recent = readdirSync(opts.ledgerDir).filter((n) => {
        if (!n.startsWith("notif-") || !n.endsWith(".json")) return false;
        const m = n.match(/^notif-(\d+)-/);
        return !!(m && parseInt(m[1], 10) >= cutoff);
      });
      for (const f of recent) {
        try {
          const entry = JSON.parse(readFileSync(join(opts.ledgerDir, f), "utf8")) as LedgerEntry;
          if (entry?.antispamHash === hash) return true;
        } catch {
          // Skip malformed ledger entries.
        }
      }
    } catch {
      // Directory access failure → fail open (don't squelch).
    }
    return false;
  }

  return {
    check(hash, now = Date.now()): boolean {
      pruneStale(now);
      const seen = cache.get(hash);
      if (seen != null && now - seen < opts.windowMs) return true;
      const cutoff = now - opts.windowMs;
      if (ledgerHasRecent(hash, cutoff)) {
        cache.set(hash, now);
        return true;
      }
      cache.set(hash, now);
      return false;
    },
  };
}
