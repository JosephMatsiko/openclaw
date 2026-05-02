# web-push Boundary

Web Push (RFC 8030 / 8291 / 8292) sender + VAPID + subscription store for
the chuck-v3 PWA. Wraps the `web-push` npm lib (loaded lazily via
createRequire so import-only consumers don't crash if the lib is missing).

Salvages `chuck-web-push.mjs` (264 LOC).

## Public Contracts

- Tool: `web_push` (registered at startup) — actions: `list` | `save` |
  `remove` | `vapid-public` | `send-test`
- Programmatic API: `sendWebPush`, `listSubscriptions`, `saveSubscription`,
  `removeSubscription`, `loadVapidKeys`, `loadVapidPublic`, `sanitizeEndpoint`
  from `./api.ts`
- Types: `PushSubscriptionRecord`, `VapidKeys`, `SendWebPushParams`,
  `SendWebPushResult`, `SendWebPushPayload`, `SaveSubscriptionResult`,
  `RemoveSubscriptionResult` from `./src/types.ts`

## Internal Files

- `index.ts` — plugin entry; registers web_push tool
- `src/send.ts` — sendWebPush (lazy-load `web-push` lib via createRequire;
  uniform result shape for cascade attempters)
- `src/store.ts` — listSubscriptions / saveSubscription /
  removeSubscription / sanitizeEndpoint (sha1-endpoint hash dedupe)
- `src/vapid.ts` — loadVapidKeys + loadVapidPublic (strips privateKey)
- `src/tool.ts` — TypeBox web_push tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **Subscription file format is wire-compatible with `chuck-web-push.mjs`**
  (per-device sub-<sha1(endpoint).slice(0,12)>.json) so existing
  registrations under `~/.openclaw/workspace/state/chuck-v3/push-subscriptions/`
  survive the migration.
- **VAPID keys never leak.** `loadVapidPublic()` returns publicKey + subject
  only; the privateKey lives only inside `sendWebPush()`'s in-process call
  to `webpush.setVapidDetails()`.
- **The `web-push` lib is lazy-loaded** via `createRequire(openclaw/package.json)`
  so consumers that only need `listSubscriptions()` (e.g. cascade probing
  whether any device is subscribed) don't crash if the lib is missing.
- **Endpoint sanitization for logs.** `sanitizeEndpoint()` keeps host + last
  8 chars of path so logs are useful but don't leak the full subscription
  URL (which would let anyone push to the device).

## Migration debt

- `chuck-web-push.mjs` is a **transitional duplicate** for two .mjs callers:
  `chuck-dashboard.mjs` (LaunchAgent on :7777) and `chuck-comms-cascade.mjs`
  (transitional duplicate of skill-reach-cascade). Both copies share the
  subscription file format. The .mjs retires when chuck-dashboard.mjs and
  chuck-comms-cascade.mjs migrate.
- TS callers (chuck-pwa plugin's legacy-routes.ts, skill-reach-cascade's
  channels/web-push.ts) are switched to import from this plugin's
  `../web-push/api.js`. The chuck-web-push.d.mts type companion can retire
  once those imports flip.
