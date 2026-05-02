# skill-mac-self-heal Boundary

Typed wrapper for the chuck-mac-self-heal stewardship script. Reversible
local-machine stewardship — distinguishes regenerable cache deletion from
evidence/file preservation, writes receipts, refuses to touch active
browser profiles or repo/state source files. Three commands:

- **`status`** — disk/swap/load/uptime + last-receipt summary
- **`plan`** — enumerate reversible actions; `--allow-cloud-offload`
  widens to evidence offload candidates
- **`apply`** — execute up to `--max-actions` (default 24), with
  `--only-under-pressure`, `--cloud-target`, `--allow-cloud-offload`
  gating; `--dry-run` forces downgrade to `plan`

**Plugin-stage v0.1**: this plugin is a TYPED WRAPPER around
`chuck-mac-self-heal.mjs` (1272 LOC). Same pattern as Unit 15 / skill-
prior-capsule. The .mjs stays canonical because:

1. It's the source of truth for receipt format
   (`chuck-v3.mac-self-heal/1` schema), cache enumeration heuristics,
   evidence preservation rules, cloud-offload detection, allowlist
   gating; battle-tested across the chuck-v2/v3 health loop.
2. It runs on a 2h LaunchAgent
   (`~/Library/LaunchAgents/com.openclaw.chuck-mac-self-heal.plist`).
   The daemon path stays in .mjs until openclaw cron supports
   long-running plugin daemons.
3. Three subsystems already subprocess-spawn it: `@openclaw/skill-health-
steward` (Unit 12 plugin's stabilize + apply paths via the
   `SelfHealRunner` interface), `@openclaw/skill-docket-executor` (Unit
   6c plugin's recovery hooks), `@openclaw/skill-self-improvement-
scanner` (Unit 9 plugin's gap detection).
4. A 1272-LOC TS port would risk silent wire-format drift in receipts
   that downstream readers depend on (health-steward's archive purge
   gate walks these receipts looking for
   `copied-to-cloud-and-moved-local-archive` records with verified
   `cloudPath` files; drift here breaks the safety check).

Full source-port queued for the openclaw daemon-plugin phase.

## Public Contracts

- Tool: `mac_self_heal` actions: `status` | `plan` | `apply`
- Programmatic API from `./api.ts`: `runStatus(config, deps)`,
  `runPlan(config, options, deps)`, `runApply(config, options, deps)`,
  `defaultSubprocessRunner()`, `resolveConfig()`
- Types from `./src/types.ts`: `SelfHealReceipt` (generic shape;
  call-site narrowed), `RunResult<T>`, `StatusOptions`, `PlanOptions`,
  `ApplyOptions`, `RunDeps`, `SubprocessRunner`, `SubprocessResult`

## Internal Files

- `index.ts` — plugin entry; registers `mac_self_heal` tool
- `src/runner.ts` — `runStatus` / `runPlan` / `runApply` orchestrators
  (config → subprocess args → injectable runner → parse stdout JSON →
  return RunResult)
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver (scriptPath + stateDir +
  per-command timeouts + defaultMaxActions)
- `src/types.ts` — public type definitions

## Boundary Rules

- **Subprocess is the implementation.** v0.1 explicitly does NOT
  re-implement cache enumeration / evidence preservation / cloud-
  offload detection / allowlist gating in TypeScript. Each command
  shells out to `chuck-mac-self-heal.mjs` with `--json` so stdout is
  parseable.
- **Subprocess runner is injectable.** Tests pass a synthetic
  `runSubprocess` so they never spawn the real .mjs (which itself
  needs the live macOS filesystem to enumerate caches and would block
  on `statfsSync`/`statSync` on test sandboxes). Production wires
  `defaultSubprocessRunner()` which uses `node:child_process.spawn`
  with a per-command timeout (`statusTimeoutMs` 30s,
  `planTimeoutMs` 2min, `applyTimeoutMs` 20min) and SIGKILL on hang.
- **maxActions forwarding is explicit, not ambient.** `runApply`
  forwards `--max-actions` whenever the option is provided (even when
  equal to the default); only ABSENCE of the option suppresses the
  flag. Keeps caller intent visible in the .mjs invocation.
- **Cloud-offload requires explicit opt-in.** `--allow-cloud-offload`
  is never forwarded by default; both `runPlan` and `runApply` require
  the option to be `true`. Mirrors the .mjs's safety posture: cloud
  data transmission stays operator-controlled.
- **Per-command timeouts.** `status` is fast (statfs + last-receipt
  read); `plan` enumerates the filesystem (slow); `apply` may run for
  ~20 minutes when offloading large evidence. The plugin honors the
  config-resolved per-command budget instead of a single timeout.

## Migration debt

- **PARTIAL SALVAGE.** Unit 16 ships the typed surface + subprocess
  wrapper; the 1272 LOC enumeration / heuristics / receipt writing
  stay in `chuck-mac-self-heal.mjs`. When the daemon-plugin phase
  lands and callers can import the plugin directly, port the cache
  classifier (`CACHE_DIR_NAMES`, `REVIEW_ONLY_NAMES`,
  `APP_BUNDLE_PREFIX_RE`), the action enumerators (allowlisted cache
  / npm / yarn / pnpm / Homebrew / Chrome / Codex WAL / trash / stale
  /tmp / old evidence / cloud-offload candidates), the apply pipeline
  (atomic move-to-archive + cloud copy + receipt write), and the
  receipt schema into ./src/\* and retire the .mjs.
- The .mjs's wire format MUST stay byte-stable: receipt schema
  (`chuck-v3.mac-self-heal/1`), result shape (`status` / `action` /
  `cloudPath` / `localArchivePath` / `bytes` fields that
  skill-health-steward's archive purge gate parses), command flag
  semantics, exit codes — drift here breaks downstream readers AND the
  LaunchAgent's idempotent re-run assumption.
- The `com.openclaw.chuck-mac-self-heal.plist` LaunchAgent retires
  ONLY when openclaw cron supports long-running plugin daemons AND the
  TS port lands. Until then, the .mjs is the daemon AND the typed
  plugin's subprocess target.
