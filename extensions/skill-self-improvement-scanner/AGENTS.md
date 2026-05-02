# skill-self-improvement-scanner Boundary

Recursive autonomy primitive: scans Chuck's state for gaps and drops
docket tasks to fix them. Mirrors apex-better's "universal exponential"
pattern. Each gap category gets a probe + remediation candidate;
idempotent so the same gap isn't re-dropped on every scan.

Salvages `chuck-self-improvement-scanner.mjs` (446 LOC).

## Public Contracts

- Tool: `self_improvement_scanner` (registered at startup) — actions:
  `scan [--dryRun]` | `status`
- Programmatic API: `runScan`, `summarizeStatus`, `runAllDetectors`,
  individual detectors (`detectDocketHealth`, `detectStuckPending`,
  `detectMcpGap`, `detectPlistGap`, `detectSkillGap`, `detectBusDiversity`),
  `buildTask`, `writeTask`, `existingFingerprints`, `loadDocket`,
  `fingerprint` from `./api.ts`
- Types: `Gap`, `GapCategory`, `DocketTask`, `DropResult`, `ScanSummary`,
  `ScanOptions`, `DetectorContext`, `EXECUTOR_COMMAND_KINDS`,
  `ALL_CATEGORIES` from `./src/types.ts`

## Internal Files

- `index.ts` — plugin entry; registers self_improvement_scanner tool
- `src/scan.ts` — runScan() orchestrator (load docket → context per cat
  → detect → flood-cap → drop → update last-scan.json)
- `src/detectors/` — six gap detectors:
  - `dockethealth.ts` — >5 failed tasks in 24h
  - `stuckpending.ts` — pending task older than 6h
  - `mcpgap.ts` — apex-\* MCP script registered in 0/3 CLI registries
    (sets explicit deliverable to the missing config files)
  - `plistgap.ts` — daemon-shape chuck-\* .mjs without launchd plist
  - `skillgap.ts` — executor commandKind without ~/.claude/skills entry
  - `busdiversity.ts` — fewer than 10 distinct event types in last 200
- `src/task.ts` — buildTask + writeTask (claude-cli-build, risk=low)
- `src/status.ts` — summarizeStatus (open task ids per category)
- `src/util.ts` — fingerprint, readJson, ensureDir, loadDocket,
  existingFingerprints, SCANNER_KIND
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **Idempotency via fingerprint dedupe.** Each gap's fingerprint is
  `sha1(category::evidence-summary)[:12]`. Before emitting, the scanner
  checks the docket for an open (pending|running) scanner-promoted task
  with matching fingerprint; if present, the gap is skipped — the prior
  task is still working it.
- **Anti-flood cap = `maxDropsPerScan`** (default 5). Surplus gaps are
  counted in `floodSkipped`, not emitted.
- **All scanner-promoted tasks are claude-cli-build / risk=low /
  surface=chuck-cockpit.** The executor's risk-class filter accepts low;
  the validator runs heuristic checks on the inferred deliverable.
- **mcpgap sets explicit `task.deliverable.paths`** (the config files
  being modified) so the validator doesn't false-fail by guessing the
  source .mjs script (which already exists and isn't touched).
- **EXECUTOR_COMMAND_KINDS is hardcoded** here rather than imported from
  `@openclaw/skill-docket-executor` because the .mjs duplicate (which
  the LaunchAgent invokes) can't import .ts at runtime. When both
  migrate to openclaw cron, the import becomes available.

## Migration debt

- `chuck-self-improvement-scanner.mjs` is a **transitional duplicate**
  for the LaunchAgent
  `com.openclaw.chuck-self-improvement-scanner.plist` invocation
  (every 6h via StartInterval=21600). Both copies share the gap
  detectors / task shape / fingerprint scheme. Bug fixes go in BOTH
  places until the LaunchAgent migrates to openclaw cron.
- Retires alongside chuck-decision-engine (parallel structure;
  chuck-decision-engine has a related "scanner-tune" detector that
  watches THIS scanner's failure rate).
