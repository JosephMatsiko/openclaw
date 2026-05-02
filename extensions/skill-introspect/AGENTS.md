# skill-introspect Boundary

LLM-driven novel-situation reasoning loop. Where `@openclaw/skill-decision-
engine` pattern-detects from a fixed list of six rules
(failed-task-cluster, zombie-cluster, channel-drift, scanner-tune,
orphan-mcp, stale-mac-heal), this layer reads recent state and asks
claude-cli (Opus 4.7 via Joseph's Max sub) to introspect for things the
rule-based engine WOULD NOT catch — surprising patterns, emerging risks,
cross-subsystem correlations, drift from established discipline, things
technically working but architecturally wrong.

Salvages `chuck-introspect.mjs` (1023 LOC). Observations are PROPOSALS;
never auto-applied. Joseph reviews via `introspect status` and acks via
`apply` / `dismiss`. The cascade-watcher's auto-promote-to-docket logic
(Unit 6b) consumes `chuck.introspect.observed` events with riskClass
medium|high and turns them into actionable docket tasks.

## Public Contracts

- Tool: `introspect` (registered at startup) — actions: `scan
[--dryRun]` | `focus <topic>` | `status` | `apply <introspectId>` |
  `dismiss <introspectId> [reason]`
- Programmatic API: `runScan`, `runFocus`, `summarizeStatus`,
  `applyIntrospection`, `dismissIntrospection`, `bundleState`,
  `renderStateForPrompt`, `buildScanPrompt`, `buildFocusPrompt`,
  `dispatchClaudeCli`, `tryParseObservations`, `normalizeObservation`,
  `loadAllIntrospections`, `loadLastScan`, `saveLastScan`,
  `writeIntrospection`, `findIntrospectionPath`, `isFingerprintBlocked`,
  `fingerprint`, `slugify`, `introspectId`, `buildExecutorEnv`,
  `createEventEmitter` from `./api.ts`
- Types: `IntrospectionRecord`, `RawObservation`, `NormalizedObservation`,
  `LastScanState`, `StateBundle`, `ScanResult`, `FocusResult`,
  `StatusSummary`, `ApplyResult`, `DismissResult`, `RiskClass`,
  `ScanOptions`, `FocusOptions`, `ClaudeDispatchResult` from
  `./src/types.ts`

## Internal Files

- `index.ts` — plugin entry; registers introspect tool
- `src/scan.ts` — runScan() orchestrator (bundle → prompt → dispatch →
  parse → idempotency → write records → emit events)
- `src/focus.ts` — runFocus() variant; topic-prefixed prompt with
  `<OBSERVATIONS>...</OBSERVATIONS>` tag for parsed observations
- `src/bundle.ts` — bundleState (events tail, docket, mac-heal receipts,
  notifications, open decisions, self-improvement, health snapshot, priors
  head, dissents) + renderStateForPrompt
- `src/prompt.ts` — buildScanPrompt + buildFocusPrompt (templates)
- `src/dispatch.ts` — dispatchClaudeCli (`claude -p --model <m>
--permission-mode bypassPermissions`)
- `src/parse.ts` — tryParseObservations (handles tags + fences + array
  recovery + .observations property) + normalizeObservation
- `src/store.ts` — writeIntrospection / loadAllIntrospections /
  loadLastScan / saveLastScan / findIntrospectionPath /
  isFingerprintBlocked
- `src/status.ts` — summarizeStatus + applyIntrospection +
  dismissIntrospection
- `src/util.ts` — fingerprint, slugify, introspectId, readJson,
  writeJson, listJsonByMtime, tailLines, readTextHead,
  buildExecutorEnv, createEventEmitter, ENGINE_KIND
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **Observations are PROPOSALS, never auto-applied.** Every emitted record
  starts with `applied: false, dismissed: false`. Joseph (or the
  cascade-watcher's auto-promote-to-docket pipeline for medium/high risk)
  is what turns them into docket tasks. The `apply` action only marks
  the record as actioned — it doesn't run anything.
- **Idempotency via two-layer fingerprint dedup.** Layer 1: last
  `fingerprintHistoryCap` fingerprints in last-scan.json. Layer 2: any
  undismissed record from the last `dedupWindowDays` with matching
  fingerprint. Both must miss for emission.
- **Focus mode skips the Layer 1 dedup.** Joseph asked specifically;
  block only on exact duplicate from the last 24h to avoid identical
  re-emit on accidental double-fires.
- **claude-cli dispatch is injectable.** Tests pass a synthetic
  `dispatch` function so the plugin's test suite never invokes the real
  binary or burns Anthropic budget. Production uses
  `dispatchClaudeCli(prompt, config)` which spawns claude-cli with the
  configured model + timeout + PATH-augmented env.
- **Bundle reads are size-bounded.** Events tailed to last 100 lines;
  priors/latest.json head-truncated to `priorHeadChars` (default 8KB);
  health snapshot truncated to `healthHeadChars` (default 4KB). Keeps
  the prompt under a sane budget even when state files grow.
- **Risk-class is normalized to {low, medium, high}.** Anything else
  defaults to "low" — observations should err on the side of being
  noticeable but not alarming.

## Migration debt

- `chuck-introspect.mjs` is a **transitional duplicate** for the
  LaunchAgent `com.openclaw.chuck-introspect.plist` invocation
  (every 2h scan via StartInterval=7200). Both copies share the bundle/
  prompt/parse/idempotency/record schema. Bug fixes go in BOTH places
  until the LaunchAgent migrates to openclaw cron.
- Pairs with `@openclaw/skill-cascade-watcher` (Unit 6b): the
  cascade-watcher's auto-promote-to-docket consumer treats
  `chuck.introspect.observed` events with riskClass medium|high as
  promotion candidates. The two plugins together close the recursive
  autonomy loop: introspect detects → cascade-watcher promotes →
  docket-executor runs → task-validator verifies → decision-engine
  watches the failure rate.
