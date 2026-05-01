// Cascade ranking — promotes freshly-proven channels, demotes circuit-
// broken ones. Salvaged from chuck-reach-ledger.mjs's rankChannels.

import { getStatus, type StoreOptions } from "./store.js";
import type { Ledger, RankOptions } from "./types.js";

const DEFAULT_FRESHNESS_MS = 15 * 60_000;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;

/**
 * Rank channels by reach freshness:
 *   1. Channels proven within `freshnessMs` (sorted by recency)
 *   2. Channels never proven OR stale (kept in defaultOrder)
 *   3. Channels with `consecutive_failures >= circuitBreakerThreshold`
 *      (still tried, but pushed to the end; less-broken first)
 */
export function rankChannels(
  defaultOrder: ReadonlyArray<string>,
  opts: RankOptions & StoreOptions = {},
): string[] {
  const freshnessMs = opts.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const breaker = opts.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
  const now = Date.now();
  const ledger: Ledger = getStatus(opts);

  const fresh: Array<{ ch: string; provenAt: number }> = [];
  const normal: string[] = [];
  const tripped: Array<{ ch: string; failures: number }> = [];

  for (const ch of defaultOrder) {
    const rec = ledger.channels[ch];
    const failures = rec?.consecutive_failures ?? 0;
    if (failures >= breaker) {
      tripped.push({ ch, failures });
      continue;
    }
    const provenAt = rec?.last_proven_at ? Date.parse(rec.last_proven_at) : NaN;
    if (Number.isFinite(provenAt) && now - provenAt <= freshnessMs) {
      fresh.push({ ch, provenAt });
    } else {
      normal.push(ch);
    }
  }

  fresh.sort((a, b) => b.provenAt - a.provenAt);
  tripped.sort((a, b) => a.failures - b.failures);

  return [...fresh.map((x) => x.ch), ...normal, ...tripped.map((x) => x.ch)];
}
