# skill-notify Boundary

Verified-delivery notification surface for openclaw. Salvages
`chuck-notify.mjs` (375 LOC ledger-only CLI). The .mjs only WRITES
`chuck-v3.notification-ledger/1` entries — it never sends. Senders
are downstream consumers (cascade-watcher / reach-cascade); when those
are unhealthy, ledger-only writes silently never deliver.

This plugin fixes the silent-failure mode: when the caller passes
`dispatch: true`, the plugin ALSO sends through the openclaw-bound
channel and returns the per-channel delivery receipt (Telegram
`message_id`, apple-bridge ok/stderr). No more "ok: true" that means
"the JSON file was written but nobody saw it."

## Public Contracts

- Tool: `notify` actions: `write` | `ack` | `list` | `get`
  - `write {event, channel, payload, ts?, meta?, dispatch?, severity?, title?}`
    — record entry; if `dispatch:true` ALSO send via the channel and
    return per-channel receipt
  - `ack {notifId, method, ts?, note?, date?}` — mark a previous notif
    as received
  - `list {pending?, date?, limit?, all?}` — today's or `--date` or
    `--all` entries
  - `get {notifId, date?}` — single entry by `notif_id`
- Programmatic API from `./api.ts`: `writeEntry`, `ackEntry`,
  `listEntries`, `getEntry`, `findLedgerPath`, `makeNotifId`, `ymd`,
  `attemptTelegram`, `attemptAppleBridge`, `dispatchNotification`,
  `defaultHttpPoster`, `defaultOsascriptRunner`,
  `readTelegramBinding`, `resolveConfig`
- Types from `./src/types.ts`: `NotifyEntry`, `WriteOptions`,
  `WriteResult`, `AckOptions`, `AckResult`, `ListOptions`, `ListResult`,
  `GetOptions`, `GetResult`, `ChannelDispatchResult`, `HttpPoster`,
  `OsascriptRunner`, `RunDeps`

## Internal Files

- `index.ts` — plugin entry; registers `notify` tool
- `src/ledger.ts` — `writeEntry`, `ackEntry`, `listEntries`, `getEntry`,
  `findLedgerPath`, `makeNotifId`, `ymd`, `ledgerPathFor` — all
  wire-compatible with `chuck-notify.mjs` schema and atomic-write
  protocol
- `src/openclaw-config.ts` — `readTelegramBinding()` reads
  `openclaw.json#channels.telegram` (botToken + allowFrom)
- `src/channels.ts` — `attemptTelegram()` (HTTP POST to
  `api.telegram.org/bot<token>/sendMessage` for each paired chatId,
  parses `message_id` receipt), `attemptAppleBridge()` (osascript
  display notification with severity-aware sound), default runners
- `src/dispatch.ts` — `dispatchNotification()` orchestrator (telegram
  / apple-bridge / desktop / macos / all)
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **Wire-compatible with chuck-notify.mjs.** Same ledger root
  (`~/.openclaw/workspace/state/chuck-v3/notification-ledger`), same
  `notif_id` pattern (`notif_<YYYYMMDDTHHMMSSZ>_<rand6>`), same
  `chuck-v3.notification-ledger/1` schema, same atomic-write protocol
  (`tmp` + `rename`). Existing readers (cascade-watcher, dashboard
  panels, operator CLI) keep working unchanged.
- **Dispatch is opt-in.** Default behavior matches the .mjs (write
  ledger only). Callers that want guaranteed delivery pass
  `dispatch:true` and inspect the per-channel receipt.
- **Telegram uses openclaw's bot identity.** Reads `botToken` +
  `allowFrom` from `openclaw.json#channels.telegram`. Sends as the
  same bot Joseph already paired with — no new credentials, no new
  pairing, no new authentication step.
- **Per-chat receipts.** When `allowFrom` has multiple chat IDs (group
  - DM, multiple operators), `attemptTelegram` returns one
    `ChannelDispatchResult` per chat ID (`channel: "telegram:<chat_id>"`)
    with the individual `message_id`. Caller sees exactly which deliveries
    succeeded.
- **HTTP poster + osascript runner are injectable.** Tests pass
  synthetic functions so they never hit `api.telegram.org` or pop real
  banners. Production wires `defaultHttpPoster()` (node:https request
  with abort-on-timeout) and `defaultOsascriptRunner()` (spawn
  `/usr/bin/osascript -e <script>` with SIGKILL on timeout).
- **No silent success.** `WriteResult.ok` is `true` only when
  `dispatch:false` (ledger-only intent satisfied) OR all dispatched
  channels returned `ok:true` AND at least one channel was attempted.
  A telegram dispatch with no paired chat ID → `ok: false` with the
  reason surfaced to the caller.
- **No automatic fall-back.** v0.1 runs the channel the caller asked
  for — no "telegram failed, fall back to discord". Multi-channel
  delivery uses `channel: "all"` explicitly (or call the orchestrator
  in JS). This keeps the contract auditable; multi-channel cascade is
  the job of `@openclaw/skill-reach-cascade`.

## Migration debt

- `chuck-notify.mjs` survives as a TRANSITIONAL DUPLICATE while
  operators (and shell scripts that don't have an in-process call site)
  still invoke `chuck-notify --event ... --channel ...`. The .mjs is
  ledger-only by design; once openclaw exposes a CLI shim that calls
  this plugin's `notify` tool with `dispatch: true`, the .mjs retires.
- `chuck-test-notify.mjs` is a smoke test for the .mjs ledger writer
  and is redundant after this plugin's tests cover the same behavior.
  Queued for retire-only commit.
- The downstream consumer chain (cascade-watcher / reach-cascade) is
  the proper architectural home for ledger-driven dispatch. This
  plugin's `dispatch:true` path is a SAFETY NET for direct callers
  who can't wait for the consumer chain to be healthy. When the
  consumer chain is solid, callers should use `dispatch:false` and
  let the consumer route; until then, `dispatch:true` is the only
  way to guarantee delivery.
- Channel coverage is intentionally minimal in v0.1: telegram +
  apple-bridge. Discord, iMessage, voice, web-push, sms-bridge,
  digest are all already implemented in `@openclaw/skill-reach-cascade`
  and this plugin should grow to delegate to those attempters
  directly when cross-extension imports clean up.
