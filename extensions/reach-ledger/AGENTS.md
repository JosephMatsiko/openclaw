# reach-ledger Boundary

Per-channel `last_proven_at` ledger. The substrate that lets a multi-channel
reach-cascade learn which path wins from one degradation event to the next.
Salvages `chuck-reach-ledger.mjs` into a typed openclaw plugin.

## Public Contracts

- Tool: `reach_ledger` (registered at startup)
- Programmatic API: `recordSuccess`, `recordFailure`, `getStatus`, `rankChannels`,
  `resetLedger` from `./api.ts`. These are the canonical entry points sibling
  plugins (chuck-pwa cascade, comms-cascade, broadcast) use.
- Types: `Ledger`, `ChannelRecord`, `GlobalRecord` from `./src/types.ts`

## Internal Files

- `index.ts` — plugin entry; registers reach_ledger tool
- `src/store.ts` — atomic-write JSON ledger (read/write/record helpers)
- `src/ranking.ts` — cascade ordering by freshness + circuit breaker
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- The ledger file format is **wire-compatible** with the legacy
  `chuck-reach-ledger.mjs` schema. Existing data at
  `~/.openclaw/workspace/state/chuck-v3/reach-ledger.json` migrates with
  zero conversion.
- Atomic writes via tmp-file + rename. Single-host coordination through
  the filesystem; not multi-host.
- `recordSuccess` updates per-channel + global; `recordFailure` only
  updates per-channel. Successive failures bump `consecutive_failures`;
  any success resets it.
- Ranking: fresh-proven first (sorted by recency), normal in default
  order, circuit-broken last (less-broken first within the broken set).

## Migration debt

- `chuck-reach-ledger.mjs` is a **transitional duplicate**, not a re-export
  shim. The .mjs implementation can't import the TS plugin's `api.ts` at
  vanilla-Node runtime (no .ts loader), so it duplicates the logic with a
  prominent header pointing back here as the canonical. Both copies write
  to the same ledger file — wire-compatible. Bug fixes during this
  transition land in BOTH places.
- The .mjs retires entirely when chuck-comms-cascade migrates in Unit 4.
