# chuck-pwa Boundary

Tailscale-served operator chat surface. Replaces the standalone
`chuck-pwa-server.mjs` (port 8093) by registering routes on the openclaw
gateway via `api.registerHttpRoute`. See `extensions/AGENTS.md` for shared
plugin boundary rules.

## Public Contracts

HTTP routes registered on the openclaw gateway:

| Route                              | Method | Purpose                                                                            |
| ---------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `/chuck-v3/<file>`                 | GET    | static assets (chat.html, etc.)                                                    |
| `/chat.html`                       | GET    | legacy alias for `/chuck-v3/chat.html` (preserves Joseph's Add-to-Home-Screen URL) |
| `/api/chuck-v3/health`             | GET    | plugin liveness                                                                    |
| `/api/chuck-v3/voices`             | GET    | 8-voice catalog                                                                    |
| `/api/chuck-v3/ask`                | POST   | chat dispatch (calls panel_ask programmatically)                                   |
| `/api/chuck-v3/push/vapid-public`  | GET    | VAPID public key                                                                   |
| `/api/chuck-v3/push/subscribe`     | POST   | save a PushSubscription                                                            |
| `/api/chuck-v3/push/unsubscribe`   | POST   | remove a PushSubscription                                                          |
| `/api/chuck-v3/push/subscriptions` | GET    | list registered subs                                                               |
| `/api/chuck-v3/docket`             | GET    | chuck-v3 docket tasks (compact view)                                               |
| `/api/chuck-v3/status-strip`       | GET    | health/executor/runtime snapshot                                                   |
| `/api/chuck-v3/decisions`          | GET    | recent chuck-decision proposals                                                    |

Programmatic API: `findVoice`, `PWA_VOICES`, `buildChuckPreamble`,
`resolveConfig` from `./api.ts`. Types: `AskRequestBody`, `AskResponse`,
`VoicesResponse`, `VoiceCatalogEntry` from `./src/types.ts`.

## Internal Files

- `index.ts` — plugin entry; registers HTTP routes
- `src/routes.ts` — handler factories (health, voices, ask, static)
- `src/voices.ts` — 8-voice catalog (mirror of skill-panel-ask ids)
- `src/persona.ts` — Chuck preamble builder (IDENTITY.md + memory-graph)
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **`/ask` calls `runPanelAsk` from `@openclaw/skill-panel-ask` directly**
  (no subprocess hop, no shelling out to apex-panel-ask.mjs). The
  programmatic API of skill-panel-ask is the only seam this plugin uses.
- Persona preamble reads `~/.openclaw/workspace/IDENTITY.md` fresh on every
  request — no caching. Joseph's edits to IDENTITY.md land immediately.
  Same file is symlinked at `~/.openclaw/agents/main/workspace/IDENTITY.md`
  so the openclaw native agent reads the same canonical doctrine.
- Static assets are served from `~/.openclaw/workspace/state/chuck-v3/pwa/`
  — same directory `chuck-pwa-server.mjs` serves from. After retirement,
  this becomes the canonical location.
- Routes are registered with `auth: "plugin"` because Tailscale is the
  authentication boundary (tailnet-only access). Gateway-auth is wrong
  here — it would force a token on the iPad.
- The chuck-pwa-server.mjs script + its launchd plist
  (com.openclaw.chuck-pwa-server.plist) are retired in the same commit
  as the Tailscale serve flip from `:8443 → localhost:8093` to
  `:8443 → localhost:18789`. No half-states.

## Migration Status (2026-05-01)

- v0.1 — chat.html surface ports: voices + ask + health + static. SHIPPED.
- v0.2 — VAPID + push subscriptions + docket/status-strip/decisions
  endpoints (the React cockpit at index.html). DEFERRED until the cockpit
  is itself migrated to plugin-managed views.
