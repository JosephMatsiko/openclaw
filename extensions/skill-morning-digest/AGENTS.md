# skill-morning-digest Boundary

Daily one-screen summary at 08:05 CDT (anchor configurable). Reads the
chuck-v3 docket + apex-events.jsonl, aggregates last-24h activity into
shipped / blockers / decisions / awaiting-Joseph, posts to Telegram via
@openclaw/skill-reach-cascade, and writes an idempotent same-day receipt.

Salvages `chuck-morning-digest.mjs` (418 LOC).

## Public Contracts

- Tool: `morning_digest` (registered at startup) — params: `format`
  (markdown | banner | json | default), `postToTelegram` (bool override)
- Programmatic API: `runDigest`, `computeDigest`, `computeWindow`,
  `formatAll`, `fmtMarkdown`, `fmtBanner`, `fmtSummary`, `writeReceipt`,
  `postDigestToTelegram` from `./api.ts`
- Types: `DigestData`, `DigestSummary`, `DigestFormat`, `DigestWindow`,
  `DocketTaskRecord`, `DecisionEvent`, `RunDigestOptions`, `RunDigestResult`
  from `./src/types.ts`

## Internal Files

- `index.ts` — plugin entry; registers morning_digest tool
- `src/run.ts` — runDigest() compose: compute → format → optional post → receipt
- `src/digest.ts` — pure compute over docket + events; computeWindow + computeDigest
- `src/format.ts` — markdown / banner / summary formatters
- `src/post.ts` — Telegram post via @openclaw/skill-reach-cascade.notify()
- `src/receipt.ts` — idempotent same-day receipt writer
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **Telegram delivery flows through `@openclaw/skill-reach-cascade.notify()`**
  (with `tier: "digest"`) — never re-implement the bot-API curl path here.
  This means the digest gets the same openclaw-native send + raw-API
  fallback + reach-ledger writes as every other Chuck-to-Joseph cascade.
- **Receipt path is wire-compatible** with `chuck-morning-digest.mjs` so
  same-day overwrites cleanly when the .mjs and TS plugin coexist during
  the transitional period.
- **Window anchoring matches the .mjs** — always anchored to YESTERDAY's
  anchor hour:minute even when called before today's anchor, so a digest at
  06:00 covers yesterday-08:05 -> now (the prior morning's anchor closes
  the prior day).
- **No I/O outside of the configured paths.** `docketDir`, `eventsPath`,
  `digestDir` all flow through config; tests use temp dirs to isolate.

## Migration debt

- `chuck-morning-digest.mjs` is a **transitional duplicate** for the
  LaunchAgent `com.openclaw.chuck-morning-digest.plist` invocation at
  08:05 CDT. Vanilla Node can't import the TS plugin's `api.ts` at
  runtime, so the .mjs preserves the same compute + Telegram path with a
  prominent header pointing back here as the canonical implementation.
  Both copies write the same receipt format; same-day reruns overwrite
  cleanly.
- The .mjs retires when the LaunchAgent migrates to openclaw-managed
  cron (queued for the watchers/cron migration unit, after openclaw
  exposes timezone-aware StartCalendarInterval semantics).
