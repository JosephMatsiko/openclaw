# skill-dashboard Boundary

Typed HTTP client for `chuck-dashboard.mjs` — Chuck's persistent +
dynamic status surface. The .mjs is a long-running HTTP server on
`localhost:7777` aggregating fleet health, principle scores, in-flight
processes, recent panels, live event stream + ~50 `/api/*` endpoints
across the chuck-v3 / chuck-v2 / top-level surfaces.

**Plugin-stage v0.1**: this plugin is a typed HTTP CLIENT (not a
subprocess wrapper) for the live daemon. The .mjs stays canonical
because:

1. It's a long-running HTTP daemon (`KeepAlive=true` under
   `~/Library/LaunchAgents/com.openclaw.chuck-dashboard.plist`), not a
   one-shot script — Unit 15/16's subprocess-wrapper pattern doesn't
   apply.
2. 9454 LOC of state aggregation across ~50 `/api/*` endpoints
   (chuck-v3 perichoresis / compaction / docket-drafts / executor /
   authority-gates / self-improvement-lab / push; chuck-v2 build /
   work-ledger / live-build / doctor / family-registry /
   latest-fleet-run / surface-control / surface-atlas /
   capability-ledger / transport-audit; top-level snapshot / fleet /
   principles / processes / mac-health / mac-self-heal /
   repo-hygiene / github-hygiene / upstream-sync / panels / curator /
   scorer / router) — full TS port is a multi-week unit, not a single
   plugin commit.
3. The cockpit is the operator surface Joseph reads in his browser;
   restart-on-port-bind would disrupt the live page. v0.1 is
   read-only by design.

Full source-port queued for the openclaw daemon-plugin phase. At that
point, the cockpit could be re-implemented as a long-running plugin
that exposes the same `/api/*` surface plus a typed in-process call
site (no HTTP round-trip for in-process callers).

## Public Contracts

- Tool: `dashboard` actions: `query` | `health` | `status`
- Programmatic API from `./api.ts`: `fetchDashboardEndpoint(config,
options, deps)`, `checkDashboardHealth(config, deps)`,
  `readLaunchAgentStatus(config, deps)`, `defaultFetcher()`,
  `defaultLaunchctlRunner()`, `resolveConfig()`
- Types from `./src/types.ts`: `DashboardEndpoint` (curated string
  literal union of well-known paths), `QueryOptions`, `QueryResult`,
  `HealthResult`, `LaunchAgentStatus`, `DashboardFetcher`,
  `LaunchctlRunner`, `RunDeps`, `FetchResult`, `DashboardJson`

## Internal Files

- `index.ts` — plugin entry; registers `dashboard` tool
- `src/client.ts` — `fetchDashboardEndpoint()` (URL build with optional
  search params + timeoutMs override) + `checkDashboardHealth()`
  (probe via `/api/snapshot`); `defaultFetcher()` uses node:http
  request with abort-on-timeout
- `src/lifecycle.ts` — `readLaunchAgentStatus()` parses
  `launchctl list <label>` output (loaded? pid? lastExitCode?);
  `defaultLaunchctlRunner()` spawns `/bin/launchctl`
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver (host + port + baseUrl +
  queryTimeoutMs + launchAgentLabel)
- `src/types.ts` — public type definitions

## Boundary Rules

- **Read-only.** Never POSTs through the wrapper. Never sends DELETE.
  Never restarts the daemon. Operator state mutations go through the
  daemon's own `/api/*` endpoints OR through the typed plugins
  (`prior_compaction`, `mac_self_heal`, etc.) — never through this
  client.
- **Fetcher is injectable.** Tests pass a synthetic
  `DashboardFetcher` so they never make real HTTP requests. Production
  wires `defaultFetcher()` which uses `node:http.request` with
  `req.destroy(timeoutErr)` on the configured timeout.
- **launchctl runner is injectable.** Same pattern for
  `LaunchctlRunner` — tests stub `launchctl list <label>` output
  without spawning the binary.
- **Path normalization.** `query.path` is forwarded as-is when it
  starts with `/`, otherwise prefixed with `/`. Search params come in
  as a `Record<string, string|number|boolean>` and are encoded via
  `URL.searchParams.set`.
- **Non-JSON bodies don't throw.** When the daemon returns HTML (404
  page) or empty body, the wrapper returns `{ok: false, body: {raw:
text}}` instead of throwing. Callers can detect by checking
  `result.ok` + `result.status`.
- **Health probe target is `/api/snapshot`.** It's the cheapest
  always-on endpoint. If the daemon serves it, the cockpit is alive.

## Migration debt

- **PARTIAL SALVAGE.** Unit 17 ships the typed HTTP client + lifecycle
  status surface; the 9454 LOC HTTP server / state aggregator /
  routing / per-endpoint handlers stay in `chuck-dashboard.mjs`. When
  the openclaw daemon-plugin phase lands, port the routing layer + per-
  endpoint handlers + state aggregation pipeline into ./src/\* and
  retire BOTH the .mjs AND the LaunchAgent.
- The .mjs's wire format MUST stay byte-stable: every `/api/*`
  response shape, the routing semantics, the port (7777 default), the
  loopback-only bind. Drift here breaks the live cockpit AND every
  in-process caller using this plugin's typed query.
- The `com.openclaw.chuck-dashboard.plist` LaunchAgent retires ONLY
  when openclaw cron supports long-running plugin daemons AND the TS
  port lands. Until then, the .mjs is the daemon AND the typed
  plugin's HTTP target.
- Adjacent .mjs callers (skill-prior-compaction's note about
  `runPriorCompaction` line 933 in chuck-dashboard.mjs) confirm the
  cockpit is still the central orchestration surface for
  Joseph-facing controls. Migration of those control planes is
  downstream of this plugin landing.
