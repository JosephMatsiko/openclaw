# skill-prior-capsule Boundary

Typed wrapper for the chuck-prior-capsule generator. The shared,
compact, evidence-bearing world-state that every family should read
before divergent work — produced by walking 15+ chuck-v3 state files
(working memory, health snapshot, model doctor, docket, runs, runner
executions, posterior deltas, read markers, dissent, compactions,
fleet health, apex-events, chuck-v2 events, design doctrine, source
task) and rendering a deterministic capsule with a sha256-stable
sourceHash and `prior-<compact-iso-ts>-<sourceHash[:12]>` ID.

**Plugin-stage v0.1**: this plugin is a TYPED WRAPPER around
`chuck-prior-capsule.mjs` (1253 LOC). The .mjs stays canonical because:

1. It's the source of truth for the prior-capsule wire format and is
   battle-tested across the chuck-v2/v3 prior loop.
2. Three subsystems already subprocess-spawn it: `chuck-docket-executor.mjs`
   (Unit 6c, still .mjs daemon), `extensions/skill-docket-executor/src/
commands.ts` (Unit 6c plugin's prior-refresh hook), and
   `extensions/skill-prior-compaction/src/capsule.ts` (Unit 14 plugin's
   `approve` step via `defaultRefreshPriorCapsule`).
3. A 1253-LOC TS port would risk silent wire-format drift at every probe
   rewrite — receipt JSON shape, sourceHash determinism, capsule body
   structure are all consumed downstream by readers (executor injection,
   compaction gate cursor, dashboard surface).

Full source-port is queued for the openclaw cron / daemon-plugin phase,
when the .mjs duplicates retire entirely.

## Public Contracts

- Tool: `prior_capsule` action: `build` (takes `write` / `markdown` /
  `sourceTaskPath` / `limit`)
- Programmatic API from `./api.ts`: `runBuildPriorCapsule(config,
options, deps)`, `defaultSubprocessRunner()`, `resolveConfig()`
- Types from `./src/types.ts`: `BuildOptions`, `BuildResult`,
  `PriorCapsuleReceipt`, `PriorCapsuleSummary`, `RunDeps`,
  `SubprocessRunner`, `SubprocessResult`

## Internal Files

- `index.ts` — plugin entry; registers `prior_capsule` tool
- `src/runner.ts` — `runBuildPriorCapsule()` orchestrator (config →
  build args → subprocess via injectable runner → parse stdout JSON →
  validate receipt vs capsule shape → return BuildResult)
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver (scriptPath + priorsDir +
  buildTimeoutMs + defaultLimit)
- `src/types.ts` — public type definitions

## Boundary Rules

- **Subprocess is the implementation.** v0.1 explicitly does NOT
  re-implement the source readers / summarizers / renderer / ID
  generation in TypeScript. The `runSubprocess` runner shells out to
  `chuck-prior-capsule.mjs` with the args derived from `BuildOptions`,
  always including `--json` so stdout is parseable.
- **Receipt vs capsule shape detection.** With `write: true` the .mjs
  prints a receipt (`{priorId, sourceHash, createdAt, path,
markdownPath, latestPath}`); without `write` it prints the full
  capsule body (`{schemaVersion: "chuck.prior-capsule.v1", priorId,
...}`). The wrapper validates the parsed JSON against both shapes
  and throws on shape mismatch — no silent degradation.
- **Subprocess runner is injectable.** Tests pass a synthetic
  `runSubprocess` so they never spawn the real .mjs (which itself
  needs ~15 chuck-v3 state files present). Production wires
  `defaultSubprocessRunner()` which uses `node:child_process.spawn` with
  a configured timeout (`config.buildTimeoutMs`, default 60s) and
  SIGKILL on timeout.
- **Limit only forwarded when it differs from default.** Keeps the CLI
  invocation byte-clean against the .mjs's default-10 fallback. Same
  pattern that other Unit 6c-style wrappers use to avoid drift.
- **Never write through the wrapper if write=false.** No filesystem
  side effects in the dry-run path. The .mjs respects this — `--write`
  is required for prior-\*.json + latest.json to land.

## Migration debt

- **PARTIAL SALVAGE.** Unit 15 ships the typed surface + subprocess
  wrapper; the 1253 LOC source readers / summarizers / renderer stay
  in `chuck-prior-capsule.mjs`. When the daemon-plugin phase lands and
  callers can import the plugin directly, port the source readers
  (workingMemory, healthSnapshot, modelDoctor, docket, runs, runner
  executions, posterior deltas, read markers, dissent, compactions,
  fleet health, apex-events, chuck-v2 events, design doctrine), the
  summarizer family (summarizeDocketTask / Run / RunnerExecution /
  PosteriorDelta / ReadMarker / LedgerState / CompactionDecision /
  CompactionCursor / CompactedClaims / WorkingMemory / ModelDoctor /
  HealthSnapshot / Executor / FleetRecency / Events), the derive
  helpers (deriveOpenQuestions / deriveRecommendedNextActions /
  deriveEvidencePointers), the prior hygiene filters
  (filterPriorOpenQuestions / filterPriorRecommendedNextActions), and
  the markdown renderer into ./src/\* and retire the .mjs.
- The .mjs's wire format MUST stay byte-stable: receipt JSON shape,
  sourceHash determinism (`sha256(stableStringify(capsuleBase))`),
  priorId pattern (`prior-<compact-iso-ts>-<sha256[:12]>`), capsule
  body schema (chuck.prior-capsule.v1) — drift here breaks readers
  downstream.
- Pairs tightly with: `@openclaw/skill-prior-compaction` (Unit 14, the
  approve action's `refreshPriorCapsule` calls into this plugin once
  the in-process call site is wired), `@openclaw/skill-posterior-delta`
  (Unit 13, the deltas this prior compacts), and the daemon
  `chuck-docket-executor.mjs` (Unit 6c, which subprocess-invokes the
  .mjs after each runner-execution).
