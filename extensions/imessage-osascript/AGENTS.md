# imessage-osascript Boundary

Send-only iMessage / Continuity-SMS path via Apple Messages.app + osascript.
Bypasses openclaw's bundled imessage channel (which times out on large
`chat.db` — observed on Joseph's 94 MB db). Apple Continuity routes
through the iPhone's LTE link when iMessage is offline, giving the
deepest-reach resilience in the cascade.

## Public Contracts

- Tool: `sms_bridge` (registered at startup)
- Programmatic API: `sendImessage` from `./api.ts`
- Types: `SendInput`, `SendResult` from `./src/types.ts`

## Internal Files

- `index.ts` — plugin entry; registers sms_bridge tool
- `src/send.ts` — osascript Messages.app send + reach-ledger writes
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **Send-only by design.** Receive (inbound iMessage) is a separate
  concern with substantially more complexity (channel plugin SDK,
  long-poll, conversation routing). v0.1 ships only the send half;
  v0.2 may upgrade to a full channel plugin.
- **Records to reach-ledger by default** under channel name `sms-bridge`.
  The reach-ledger plugin is a sibling — we import its programmatic API
  via `../../reach-ledger/api.js`.
- **Timeout-safe**: spawnSync with hard timeout. Apple Messages can hang
  on a stalled service-lookup; we kill the subprocess at `timeoutMs`
  (default 12s).
- **No iCloud / SMS-via-API integration.** Pure local osascript path.
  Joseph's iPhone LTE is the carrier — no Twilio, no third-party SMS API.
  Subscriptions-only sovereignty preserved.

## Migration debt

- `chuck-sms-bridge.mjs` is a **transitional duplicate**, not a re-export
  shim — see Unit 2's reach-ledger AGENTS.md for the same constraint
  (vanilla-Node can't import .ts at runtime). Bug fixes land in BOTH
  places until chuck-comms-cascade migrates in Unit 4 and the .mjs
  retires.
