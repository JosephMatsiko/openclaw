# skill-gateway-watchdog Boundary

Gateway event-loop health probe + auto-restart. Polls openclaw gateway
liveness (parses err.log warnings + ps %CPU). When pinned past a
threshold, fires `launchctl kickstart -k gui/501/ai.openclaw.gateway`.
Anti-flap backoff (2min base, doubling, 1h max). Daily restart cap (12).

Salvages `chuck-gateway-watchdog.mjs` (343 LOC) — probe/tick/status
paths. The polling daemon stays in the .mjs invoked by the LaunchAgent
until openclaw cron supports long-running plugin daemons (queued for v0.2).

## Public Contracts

- Tool: `gateway_watchdog` (registered at startup) — actions: `probe` |
  `status` | `tick [--dryRun]`
- Programmatic API: `probe`, `tick`, `summarizeStatus`, `restartGateway`,
  individual probe primitives (`findGatewayPid`, `readGatewayCpu`,
  `recentEventLoopBlocks`), state IO (`loadState`, `saveState`,
  `ensureWatchdogDir`, `rollDayBucket`, `statePath`),
  `createEventEmitter` from `./api.ts`
- Types: `ProbeResult`, `EventLoopBlocks`, `RestartResult`, `WatchdogState`,
  `HistoryEntry`, `TickAction`, `TickResult`, `TickOptions`, `StatusSummary`
  from `./src/types.ts` and module facades

## Internal Files

- `index.ts` — plugin entry; registers gateway_watchdog tool
- `src/probes.ts` — findGatewayPid (pgrep) + readGatewayCpu (ps) +
  recentEventLoopBlocks (parses err.log liveness warnings within window)
- `src/probe.ts` — probe() composes the three primitives into a single
  health verdict (healthy/reason)
- `src/restart.ts` — restartGateway (launchctl kickstart -k)
- `src/tick.ts` — tick() single iteration: probe → bail if healthy /
  cooldown / daily-cap → restart with backoff + day bucket
- `src/state.ts` — loadState/saveState/rollDayBucket/ensureWatchdogDir
- `src/status.ts` — summarizeStatus (current probe + persisted state)
- `src/events.ts` — apex-events.jsonl emit (best-effort)
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **Healthy = no event-loop blocks > `longBlockThresholdMs` in the
  `pinDetectionWindowMs` window AND cpu < `highCpuThresholdPercent`.**
  Defaults are evidence-derived: 60s block threshold ("annoying but
  acceptable" line), 4-min window (worst observed pin = 6.7 min sustained;
  4 min catches real pins, not long agent runs), 80% CPU ceiling.
- **Anti-flap via consecutiveRestartFailures.** Failed restart bumps the
  counter, sets `nextRestartAllowedMs = now + base * 2^(failures-1)`,
  capped at `restartBackoffMaxMs` (default 1h). A successful restart
  resets the counter.
- **Daily cap = sanity ceiling.** If we hit `maxRestartsPerDay` (12),
  emit `chuck.gateway.watchdog.cap_hit` and stop trying — something is
  broken beyond auto-recovery and Joseph needs to intervene.
- **Cooldown after successful restart.** `cooldownAfterRestartMs` (5min
  default) gives the new gateway PID time to cold-start (build-info,
  plugins load, channel sidecars connect) before the next health check
  can declare it pinned again.
- **Day bucket rolls on local-date change.** `rollDayBucket()` resets
  `restartCountToday` when the local-date string differs from the saved
  `todayKey`. The lifetime `restartCount` never resets.

## Migration debt

- `chuck-gateway-watchdog.mjs` is a **transitional duplicate** for the
  LaunchAgent `com.openclaw.chuck-gateway-watchdog.plist` invocation
  (long-running daemon, polls every 60s). Vanilla Node can't import the
  TS plugin's `api.ts` at runtime, so the .mjs preserves the same probe/
  restart/tick semantics with a header pointing back here as the
  canonical implementation.
- The .mjs retires when openclaw cron grows long-running plugin-daemon
  support and absorbs the LaunchAgent.
