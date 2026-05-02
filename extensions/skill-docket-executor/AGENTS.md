# skill-docket-executor Boundary

Typed canonical for chuck-v3 docket executor's read-only surface: command
registry (8 commandKinds), lane timeout/running-cap policies, mac health
gate (disk + swap thresholds + lane-exempt list), eligibility checks,
executor control state, env builder.

Salvages `chuck-docket-executor.mjs` (1560 LOC) — handle/eligibility/
status surface. The long-running daemon (claim/run/lock/sweep/heartbeat/
posterior-delta/prior-refresh) stays in the .mjs invoked by the LaunchAgent
until openclaw cron supports long-running plugin daemons. v0.2 will fold
the daemon in.

## Public Contracts

- Tool: `docket_executor` (registered at startup) — actions: `status` |
  `eligibility` | `timeout-policy` | `mac-gate` | `list-commands`
- Programmatic API: `COMMANDS`, `commandLane`, `commandHasRequiredFields`,
  `listCommandKinds`, `LANE_TIMEOUT_POLICY`, `EXECUTOR_LANE_POLICY`,
  `laneTimeoutPolicy`, `laneRunPolicy`, `DEFAULT_TIMEOUT_MS`,
  `macHealthGateStatus`, `macHealthGateBlockers`,
  `MAC_GATE_EXEMPT_COMMAND_KINDS`, `clearMacGateCache`,
  `readExecutorControl`, `executorIntakePaused`, `eligibilityBlockers`,
  `checkEligibility`, `timeoutPolicyForTask`, `summarizeStatus`,
  `buildExecutorEnv` from `./api.ts`
- Types: `Task`, `Lane`, `CommandKind`, `CommandSpec`, `CommandDescriptor`,
  `LaneTimeoutPolicy`, `LaneRunPolicy`, `ResolvedTimeoutPolicy`,
  `MacHealthGateStatus`, `DiskStatus`, `SwapStatus`, `ExecutorControl`,
  `EligibilityCheck`, `Risk`, `TaskStatus` from `./src/types.ts`

## Internal Files

- `index.ts` — plugin entry; registers docket_executor tool
- `src/commands.ts` — COMMANDS registry (9 commandKinds: bootstrap,
  doctor, capability-ledger, docket-list, prior-capsule, live-scout,
  codex-build, claude-cli-build, mac-self-heal); commandLane;
  commandHasRequiredFields; listCommandKinds
- `src/lanes.ts` — LANE_TIMEOUT_POLICY (5 lanes, default/long/max ceilings)
  - EXECUTOR_LANE_POLICY (per-lane maxRunning + description) + helpers
- `src/mac-gate.ts` — readDiskStatus + readSwapStatus + macHealthGateStatus
  (5s cache) + macHealthGateBlockers + MAC_GATE_EXEMPT_COMMAND_KINDS
- `src/eligibility.ts` — eligibilityBlockers (status/risk/allowlist/required-
  fields/mac-gate/lane-cap/global-cap) + checkEligibility wrapper
- `src/timeout.ts` — timeoutPolicyForTask (CLI override > task-requested >
  long-running flag > lane-default; capped at lane.maxMs)
- `src/control.ts` — readExecutorControl (ENOENT = active; malformed =
  fail-closed paused) + executorIntakePaused
- `src/env.ts` — buildExecutorEnv (PATH augment for launchd minimal env)
- `src/status.ts` — summarizeStatus (catalog + lanes + mac gate + control)
- `src/tool.ts` — TypeBox docket_executor tool
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **The daemon is NOT in this plugin.** v0.1 ships only the read-only
  typed surface that consumers (cockpit, scanners, decision-engine, future
  schedulers) can query without booting a daemon. The
  `chuck-docket-executor.mjs` LaunchAgent invocation remains the canonical
  daemon path until openclaw cron supports long-running plugin daemons.
- **Eligibility is pure.** `eligibilityBlockers(task, ctx)` does no I/O
  beyond the macHealthGateStatus probe (which is itself cached). Pass
  `activeTasks` explicitly so the plugin doesn't hit the docket directory
  unprompted.
- **Mac health gate exemption stays narrow.** Only diagnostic/memory/
  maintenance commands (bootstrap, doctor, capability-ledger, docket-list,
  prior-capsule, mac-self-heal) bypass the disk/swap gate. Any new
  commandKind that needs the bypass must be added to
  `MAC_GATE_EXEMPT_COMMAND_KINDS` deliberately.
- **Timeout policy is always capped at lane.maxMs.** A task can REQUEST
  longer (via task.timeoutMs / longRunning flag / CLI override) but the
  resolved `timeoutMs` is `min(requested, lane.maxMs)`. `capped: true` in
  the result tells the daemon to emit a "timeout-capped" bus event.
- **Executor control fail-closed.** A missing control file = active (the
  default). A malformed/unreadable control file = paused (operator
  ergonomics > silent state corruption).

## Migration debt

- LLM-introspection layer (validateBuildDeliverableViaLLM) is owned by
  `@openclaw/skill-task-validator` (queued for v0.2 there). The executor
  delegates to that plugin's `validateTaskDeliverable()`.
- The daemon's claim/runTask/spawnBounded/zombie-sweep/heartbeat/
  posterior-delta/prior-refresh paths stay in the .mjs. v0.2 of this
  plugin will port them when openclaw cron supports long-running plugin
  daemons.
- `chuck-docket-executor.mjs` is a **transitional duplicate** for the
  LaunchAgent `com.openclaw.chuck-docket-executor.plist` invocation
  (long-running daemon, --loop with 60s tick interval). Both copies share
  the COMMANDS registry / lane policies / mac gate / eligibility logic;
  bug fixes go in BOTH places until the daemon migrates. The .mjs imports
  `commsNotify` from chuck-comms-cascade.mjs (transitional duplicate of
  skill-reach-cascade.notify) so failed-task notifications stay live.
- Retires alongside chuck-cascade-watcher.mjs when openclaw cron absorbs
  the watchers/executors. At that point the entire
  chuck-comms-cascade.mjs / chuck-reach-ledger.mjs / chuck-sms-bridge.mjs /
  chuck-format-update.mjs / chuck-task-validator.mjs duplicate chain
  finally collapses.
