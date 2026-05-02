# skill-cascade-watcher Boundary

Bus-tail comms-cascade trigger. Tails apex-events.jsonl and routes failure-
class / notable bus events through `@openclaw/skill-reach-cascade.notify()`.
Editable trigger table; anti-recursion guards (no echo loops); anti-flood
(3 fires per 5min per type+source); auto-promote-to-docket for medium/high
introspect observations.

Salvages `chuck-cascade-watcher.mjs` (740 LOC) — handle + status + test
paths. The polling daemon stays in the .mjs invoked by the LaunchAgent
until openclaw cron supports long-running plugin daemons.

## Public Contracts

- Tool: `cascade_watcher` (registered at startup) — actions: `status` |
  `test <eventType> [--severity=...] [--dryRun]`
- Programmatic API: `handleEvent`, `runTest`, `summarizeStatus`,
  `CASCADE_TRIGGERS`, `findTrigger`, `isOwnEcho`, `loadState`, `saveState`,
  `checkAndRecordFlood`, `pruneFloodCounters`, `shouldPromoteToDocket`,
  `promoteObservationToDocket`, `alreadyPromoted`, `fireCascade` from
  `./api.ts`
- Types: `BusEvent`, `Trigger`, `WatcherState`, `MatchRecord`, `FireRecord`,
  `SuppressionRecord`, `PromotionRecord`, `FloodCounters`, `FireOptions`,
  `FloodCheck`, `PromoteResult` from `./src/types.ts` and module facades

## Internal Files

- `index.ts` — plugin entry; registers cascade_watcher tool
- `src/triggers.ts` — CASCADE_TRIGGERS table (7 patterns); findTrigger;
  isOwnEcho (anti-recursion guard)
- `src/antiflood.ts` — antifloodKey + pruneFloodCounters + checkAndRecordFlood
- `src/promote.ts` — shouldPromoteToDocket + promoteObservationToDocket +
  alreadyPromoted (idempotent on introspectId)
- `src/handle.ts` — handleEvent (anti-recursion → flood gate → match →
  promote → fireCascade); orchestrates one event end-to-end
- `src/notify.ts` — fireCascade wrapper around skill-reach-cascade.notify()
- `src/state.ts` — loadState/saveState (trim limits enforced)
- `src/run.ts` — runTest (dryRun + live), summarizeStatus
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **Anti-recursion is critical.** Any event whose source is this watcher,
  whose type starts with `chuck.notify.*` (cascade-emitted), or whose type
  starts with `chuck.cascade.watcher.*` is rejected before pattern matching.
  Without this, a failed cascade would fire another cascade in a loop.
- **Cascade firing flows through `@openclaw/skill-reach-cascade.notify()`** —
  never re-implement the bot-API curl path here.
- **Anti-flood gate is per (triggerType + source)** so a misbehaving emitter
  in one subsystem can't block legitimate fires from another. Default 3
  fires per 5-minute window.
- **Auto-promote is idempotent on `introspectId`.** A medium/high-risk
  introspect observation produces at most ONE docket task across watcher
  restarts because state.promotions persists across saves.
- **Auto-promote runs in PARALLEL to (not instead of) the cascade fire.**
  A high-risk observation both notifies AND lands as an actionable docket
  task — different acknowledgement rituals serve different operator needs.
- **Risk-class is capped at "medium" when docketed** so a failed
  auto-promoted task doesn't trip dockethealth into the recursive failure-
  investigation cycle.
- **State arrays are trimmed on save** so the watcher's state.json never
  unbounded-grows: matches/fires/suppressions to `stateRecentLimit` (50);
  promotions to `promotedRecentLimit` (200) for cross-restart idempotency.

## Migration debt

- `chuck-cascade-watcher.mjs` is a **transitional duplicate** for the
  LaunchAgent `com.openclaw.chuck-cascade-watcher.plist` invocation
  (long-running daemon, polls every 500ms). Vanilla Node can't import
  the TS plugin's `api.ts` at runtime, so the .mjs preserves the same
  trigger / handle / flood / promote semantics with a header pointing
  back here as the canonical implementation. The .mjs imports
  `commsNotify` from chuck-comms-cascade.mjs (transitional duplicate of
  skill-reach-cascade.notify) so both sides stay in sync.
- The .mjs retires when openclaw cron grows long-running plugin-daemon
  support and absorbs the LaunchAgent. At that point the
  chuck-comms-cascade.mjs / chuck-reach-ledger.mjs / chuck-sms-bridge.mjs /
  chuck-format-update.mjs duplicate chain finally collapses too.
