# skill-watchers-status Boundary

Single-command health view across the chuck/apex LaunchAgent surface.
Salvages `chuck-watchers-status.mjs` (228 LOC). The .mjs survives only
as the manual operator CLI (`node chuck-watchers-status.mjs`); no other
subsystem subprocess-spawns it.

## Public Contracts

- Tool: `watchers_status` — takes optional `label` (filter to one) +
  `busWindowHours` (override config default)
- Programmatic API from `./api.ts`: `reportWatchers(config, options,
deps)`, `defaultLaunchctlRunner()`, `defaultPsRunner()`,
  `DEFAULT_WATCHERS`, `resolveConfig()`
- Types from `./src/types.ts`: `WatcherEntry`, `WatcherReport`,
  `ReportOptions`, `LaunchctlRunner`, `PsRunner`, `RunDeps`

## Internal Files

- `index.ts` — plugin entry; registers `watchers_status` tool
- `src/report.ts` — `reportWatchers()` orchestrator; per-watcher reads
  launchctl + ps + last bus event (within window) + last log line +
  state-file parse-ok
- `src/runners.ts` — `defaultLaunchctlRunner()` (spawns `/bin/launchctl
list <label>` with SIGKILL on timeout) + `defaultPsRunner()` (spawns
  `/bin/ps -p <pid> -o pcpu=,etime=` and parses CPU + etime)
- `src/registry.ts` — `DEFAULT_WATCHERS` array of all 13 chuck/apex
  watchers + their log paths + bus sources + state files
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **Read-only.** Doesn't start / stop / restart any LaunchAgent. Tests
  pass synthetic launchctl + ps runners so they never spawn the real
  binaries.
- **Bus event window is bounded.** Default 6h; configurable via
  `busWindowHours` (config default OR per-call). Avoids treating a
  stale event from days ago as "recent".
- **Tail-reads only the last 1MB of `apex-events.jsonl`.** Doesn't load
  the entire ledger when scanning for the most recent bus event per
  source. Prevents OOM on large ledgers.
- **stateOk is null when no stateFile is configured.** false only when
  the file exists but doesn't parse as JSON. true when it parses.
- **Per-watcher launchctl spawn.** No batched `launchctl print system`
  parsing in v0.1; one `launchctl list <label>` per watcher. Sequential
  to keep the implementation simple. With 13 watchers and 5s timeout
  each, worst-case is 65s; typical ~1s total.

## Migration debt

- chuck-watchers-status.mjs survives as TRANSITIONAL DUPLICATE for the
  shell CLI surface. Once openclaw exposes a CLI shim that calls this
  plugin's `watchers_status` tool, the .mjs retires.
- Watcher registry is hardcoded in `src/registry.ts`. v0.2 candidate:
  read from a config block so operators can add/remove their own
  watchers without editing the plugin. Keeping it static for v0.1
  matches the .mjs pattern and what the current chuck/apex set looks
  like.
- The bus event tail-read scans for `source` field matches; events
  written without that field (older watchers) won't appear. Keeping
  this behavior since current chuck/apex bus emitters all sign with
  `source`.
