# skill-health-steward Boundary

Receipt-first stewardship for Mac/openclaw resource pressure. Probes
disk/swap/memory/load + executor control + docket roll-up + process
groups + the `chuck-mac-self-heal` plan/status, and emits three action
families: **automatic** (safe enough to run on `stabilize`), **approval-
gated** (require explicit confirm tokens via `apply`), **operator-
handoff** (cannot be automated; surface only).

Salvages `chuck-health-steward.mjs` (735 LOC, no LaunchAgent, no
callers). The `.mjs` is **fully retired** in this commit — first true
mass-reduction unit of the migration. The plugin is now the only
surface.

## Public Contracts

- Tool: `health_steward` (registered at startup) — actions: `status` |
  `stabilize` | `apply --applyAction <a> --confirm <token>`
- Programmatic API from `./api.ts`: `buildStatus`, `summarizeStatus`,
  `stabilize`, `applyAction`, `buildHealthSnapshot`, `summarizeDocket`,
  `readExecutorControl`, `writeExecutorControl`, `buildAutomaticActions`,
  `buildApprovalActions`, `buildHandoffActions`, `writeApprovalCapsules`,
  `latestVerifiedLocalArchiveCandidate`, `defaultProbes`, `mergeProbes`,
  `defaultSelfHealRunner`, util helpers
- Types from `./src/types.ts`: `StatusResult`, `StabilizeResult`,
  `ApplyResult`, `HealthSnapshot`, `DocketSummary`, `ExecutorControl`,
  `ApprovalAction`, `AutomaticAction`, `HandoffAction`, `ApprovalCapsule`,
  `LocalArchiveCandidate`, `ProcessGroup`, `SelfHealRunner`,
  `SystemProbes`, `RunDeps`, `StatusOptions`, `StabilizeOptions`,
  `ApplyOptions`

## Internal Files

- `index.ts` — plugin entry; registers `health_steward` tool
- `src/status.ts` — `buildStatus()` orchestrator (probes → executor →
  docket → process groups → mac-self-heal plans → action lists)
- `src/stabilize.ts` — runs safe automatic actions (pause executor on
  blocked; safe self-heal under pressure); writes
  `chuck-v3.health-steward/1` receipt
- `src/apply.ts` — confirm-token-gated actions: `cloud-offload`
  (`RUN_APPROVED_CLOUD_OFFLOAD`), `purge-local-archive`
  (`PURGE_VERIFIED_LOCAL_ARCHIVE`), `write-approval-capsules`
- `src/health.ts` — `buildHealthSnapshot()` (probes + thresholds → state
  - blockers + warnings)
- `src/probes.ts` — default macOS probes (statfs / sysctl vm.swapusage /
  memory_pressure / loadavg / ps `-axo`); `mergeProbes()` merges test
  overrides on top
- `src/selfheal.ts` — `chuck-mac-self-heal.mjs` subprocess wrapper
  (`plan` / `status` / `apply`); `SelfHealRunner` is injectable for
  tests
- `src/executor.ts` — read/write `executor-control.json` (chuck-v3
  executor pause toggle)
- `src/docket.ts` — counts by status + stale-running detection (>2h
  window for "running" tasks with `startedAt`)
- `src/archive.ts` — `latestVerifiedLocalArchiveCandidate()` walks
  mac-self-heal receipts; only purge-eligible if cloud copies exist
  AND local archive root is still present
- `src/actions.ts` — `buildAutomaticActions` /
  `buildApprovalActions` / `buildHandoffActions` /
  `writeApprovalCapsules`
- `src/util.ts` — atomic JSON write, safe readers, `formatBytes`,
  `defaultReceiptId`, event makers, `pathInside` (path-traversal guard
  for archive root containment)
- `src/types.ts` — public type definitions
- `src/config.ts` — runtime config resolver (paths + thresholds + timeouts)
- `src/tool.ts` — TypeBox tool schema + execute handler

## Boundary Rules

- **Stabilize is safe-only; apply is approval-gated.** `stabilize` may
  pause the executor and run `chuck-mac-self-heal apply --only-under-
pressure --max-actions <stabilizeMaxSafeActions>`, but never invokes
  cloud-offload or local-archive purge. Those require `apply` with the
  exact confirm token. The token strings are part of the wire contract
  with the operator; do not change them.
- **Local-archive purge is double-gated.** A receipt is purgeable only
  when (a) it recorded `copied-to-cloud-and-moved-local-archive`, (b)
  every recorded `cloudPath` still exists on disk, AND (c) the local
  archive root still contains files. Missing cloud paths flip the
  candidate to `blocked: true` — purge refuses.
- **Path-traversal guard.** `pathInside(child, root)` enforces that the
  archive root being purged is a subpath of `macSelfHealArchivesDir`. A
  rogue receipt with `receiptId: "../something"` cannot escape the
  archive sandbox.
- **mac-self-heal subprocess is injectable.** Tests pass a synthetic
  `SelfHealRunner` so they never invoke the real `.mjs` (which itself
  requires macOS sysctl/sips/etc.). Production uses
  `defaultSelfHealRunner(config)` which spawns the configured
  `macSelfHealScript`.
- **Probes are injectable.** Tests inject `SystemProbes` overrides to
  fabricate disk/swap/memory pressure and process groups deterministi-
  cally. Production wires `defaultProbes()` which calls the macOS
  binaries.
- **Receipt-first.** Every `stabilize` and most `apply` paths write a
  JSON receipt under `<stewardDir>/receipts/` BEFORE emitting the bus
  event. Bus emit is best-effort (best-effort `appendFileSync` to
  `apex-events.jsonl`); receipts are the source of truth.
- **Wire format unchanged from .mjs.** Bus event names
  (`chuck.health.stabilized`, `chuck.health.approval-applied`,
  `chuck.health.local-archive-purged`), receipt schemas
  (`chuck-v3.health-steward/1`,
  `chuck-v3.mac-self-heal.local-archive-purge/1`), approval-capsule
  schema (`chuck-v3.approval-capsule/1`), executor-control JSON shape,
  and confirm-token strings are byte-identical to the retired `.mjs`.

## Migration debt

- Subprocess-invokes `chuck-mac-self-heal.mjs` (Unit 13+ candidate, 1272
  LOC, has LaunchAgent). When that .mjs is salvaged into
  `@openclaw/skill-mac-self-heal`, swap the subprocess invocation here
  for a direct programmatic call — keep the `SelfHealRunner` adapter so
  tests still inject. Subprocess interface (CLI args, JSON output shape)
  must stay stable until both ends migrate.
- The .mjs CLI surface (`chuck-health-steward.mjs status|stabilize|
apply`) is gone; operator now invokes via the `health_steward` tool
  (gateway/openclaw CLI). If a manual shell script is needed before the
  CLI surface lands cleanly, write a thin shim that calls the plugin
  rather than re-introducing duplicate logic.
