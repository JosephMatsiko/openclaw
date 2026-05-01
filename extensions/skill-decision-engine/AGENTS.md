# skill-decision-engine Boundary

Autonomy primitive: scans Chuck's actual operating state via 6 detectors,
generates structured proposals, auto-applies low-risk docket promotions,
and stages med/high proposals for Joseph through @openclaw/skill-reach-cascade.

Salvages `chuck-decision-engine.mjs` (902 LOC).

## Public Contracts

- Tool: `decision_engine` (registered at startup) — actions: `scan` |
  `status` | `apply <decisionId>` | `reject <decisionId> [--reason "..."]`
- Programmatic API: `runScan`, `summarizeStatus`, `applyDecision`,
  `rejectDecision`, `ALL_DETECTORS`, individual detectors,
  `shouldAutoApply`, `loadDecisions`, `loadLastScan` from `./api.ts`
- Types: `Proposal`, `DetectorHit`, `DetectorContext`, `Detector`,
  `RiskClass`, `DecisionStatus`, `DetectorCategory`, `ScanSummary`,
  `DocketTask`, `BusEvent` from `./src/types.ts`

## Internal Files

- `index.ts` — plugin entry; registers decision_engine tool
- `src/scan.ts` — runScan() orchestrator (load → detect → dedupe → cap → emit)
- `src/detectors/` — six independent pattern detectors:
  - `failed-task-cluster.ts` — >=3 failed tasks in 6h sharing commandKind (medium)
  - `zombie-cluster.ts` — >=3 chuck.zombie_recovered events in 24h (medium)
  - `channel-drift.ts` — enabled channel silent 7d+ (low)
  - `scanner-tune.ts` — scanner-promoted tasks failing >50% (n>=5) (low)
  - `orphan-mcp.ts` — apex-\* MCP script registered in 0/3 CLI registries (low)
  - `stale-mac-heal.ts` — mac-self-heal latest.json > 12h old (low)
- `src/policy.ts` — shouldAutoApply (low-risk + drop-a-docket-task only)
- `src/auto-apply.ts` — dropFollowupDocketTask (the only mutating side-effect)
- `src/notify.ts` — sendProposalNotification via skill-reach-cascade
- `src/store.ts` — decision file IO + last-scan fingerprint state
- `src/status.ts` — summarizeStatus + applyDecision + rejectDecision
- `src/loaders.ts` — loadDocket + loadEvents
- `src/util.ts` — readJson/writeJson/fingerprint/decisionId/event emit helpers
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **Telegram delivery flows through `@openclaw/skill-reach-cascade.notify()`**
  (severity = critical for high-risk, warn for medium; tier =
  immediate-low-friction). No raw bot-API curl path here.
- **Auto-apply stays narrow.** Only low-risk + recommendation action contains
  "drop a docket task" or "promote" (without "openclaw.json"). Config edits
  always stage as proposals — Joseph's eyes-on every authority change.
- **Idempotency via fingerprint dedupe.** Each detector's hit gets a
  `sha1(category::evidence-summary)[:12]` fingerprint. Last-scan state
  stores fingerprints with timestamps; same fingerprint within
  `fingerprintDedupHours` is skipped silently.
- **Anti-flood cap.** `maxProposalsPerScan` (default 3) bounds proposals
  per scan. Surplus hits are counted in `floodSkipped`, not emitted.
- **Detector failures never kill the scan.** Each detector wrapped in
  try/catch; an exception logs to stderr and returns null.
- **Reject is sticky.** Once a fingerprint has a rejected decision, the
  scan skips it without checking the dedup window.

## Migration debt

- `chuck-decision-engine.mjs` is a **transitional duplicate** for the
  LaunchAgent `com.openclaw.chuck-decision-engine.plist` invocation
  (StartInterval=1800, every 30 min). Vanilla Node can't import the TS
  plugin's `api.ts` at runtime, so the .mjs preserves the same scan +
  proposal + Telegram path with a prominent header pointing back here as
  the canonical implementation. Both copies write to the same
  `~/.openclaw/workspace/state/chuck-v3/decisions/` directory.
- The .mjs retires when the LaunchAgent migrates to openclaw cron
  (queued for the watchers/cron migration unit, alongside
  chuck-morning-digest, chuck-cascade-watcher, chuck-introspect).
