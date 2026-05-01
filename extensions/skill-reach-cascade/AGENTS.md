# skill-reach-cascade Boundary

Outage-resilient comms cascade across web-push, apex-apple-bridge, telegram,
discord, imessage, sms-bridge, voice, and the digest safety-net. Salvages
`chuck-comms-cascade.mjs` (1075 LOC) into a typed openclaw skill.

## Public Contracts

- Tool: `reach_cascade` (registered at startup) — actions: `notify`
  (first-success cascade) | `broadcast` (parallel fan-out) | `status` |
  `replay`
- Programmatic API: `notify`, `broadcast`, `replay`, `summarizeStatus`,
  `listRecentLedger`, `findLedgerEntry`, `resolveCascadeOrder`,
  `DEFAULT_CASCADE` from `./api.ts`
- Types: `NotifyPayload`, `NotifyResult`, `BroadcastOptions`, `BroadcastResult`,
  `CascadeAttempt`, `LedgerEntry`, `Severity`, `Tier`, `ChannelName`
  from `./src/types.ts` and `./src/broadcast.ts`

## Internal Files

- `index.ts` — plugin entry; registers reach_cascade tool
- `src/notify.ts` — first-success cascade orchestrator; tier resolution, cascade walk, ledger writes
- `src/broadcast.ts` — parallel fan-out orchestrator; broadcast-ledger writes
- `src/cascade.ts` — DEFAULT_CASCADE, resolveCascadeOrder, channel filter, quiet-hours filter
- `src/antispam.ts` — sha1 hash + in-process cache + cold-start ledger consult
- `src/sign.ts` — `buildSignedText` (matches chuck-comms-cascade.mjs wire format)
- `src/time.ts` — quiet-hours helpers
- `src/events.ts` — apex-events.jsonl emitter (best-effort)
- `src/openclaw-native.ts` — subprocess wrapper around `openclaw message send --json`
- `src/status.ts` — `summarizeStatus`, `replay`, ledger inspection
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions
- `src/channels/*.ts` — per-channel attempters

## Boundary Rules

- **Wire-compatible with `chuck-comms-cascade.mjs`.** The notification ledger
  format under `~/.openclaw/workspace/state/chuck-v3/notification-ledger/` is
  identical so existing audits + replay tooling still work.
- **Reach-ledger writes go through `@openclaw/plugin-reach-ledger`'s
  programmatic API** (`recordSuccess` / `recordFailure`) — never re-implement
  the JSON store here.
- **iMessage / SMS path goes through `@openclaw/plugin-imessage-osascript`'s
  `sendImessage`** (channel name `sms-bridge`), with `recordToLedger: false`
  so the cascade owns the per-channel ledger write under its canonical
  channel name.
- **Telegram long-form HTML uses raw Bot API curl** because openclaw's
  message-send CLI doesn't expose `parse_mode` yet (the underlying telegram
  channel SUPPORTS it via `presentation.renderText`; surfacing that as a CLI
  flag is upstream work). Once that lands, the HTML branch collapses back
  into `sendViaOpenclaw`.
- **Anti-spam squelches identical (subject+body+severity) within
  `antispamWindowMs`** (default 30s). Cold-start consults the ledger so
  a freshly-spawned cron job sees recent state.
- **Digest is the safety-net terminus.** It always succeeds locally and is
  appended to every cascade so an "all live channels failed" run still
  leaves a paper trail.

## Migration debt

- `chuck-comms-cascade.mjs` is a **transitional duplicate**, not a
  re-export shim — vanilla Node can't import the TS plugin's `api.ts` at
  runtime, so the .mjs preserves the same wire format with a prominent
  header pointing back here as the canonical implementation. The .mjs
  retires when `chuck-cascade-watcher.mjs` and `chuck-docket-executor.mjs`
  migrate (Unit 6 in the migration plan).
- `chuck-reach-ledger.mjs`, `chuck-sms-bridge.mjs`, and
  `chuck-format-update.mjs` continue as transitional duplicates while
  chuck-comms-cascade.mjs (which imports them) remains live.
- `chuck-broadcast.mjs` was deleted in Unit 5a — `broadcast()` now lives
  in `src/broadcast.ts` and is exposed via the `reach_cascade` tool's
  `action: "broadcast"`. No backward-compat .mjs shim because no callers
  existed (no launchd/cron/script invocations; pure CLI).
