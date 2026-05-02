# skill-posterior-delta Boundary

Mechanical converter from chuck-v2/v3 family runner-execution receipts
into schema-validated, append-only posterior deltas
(`chuck.posterior-delta.v1`) plus read markers (`chuck.read-marker.v1`)
when a prior capsule was injected into the executor prompt. Preserves
family attribution + evidence pointers; **never asks a model to merge**
the answers — that's a separate compaction-gate decision.

Salvages `chuck-posterior-delta.mjs` (616 LOC). The `.mjs` survives as a
TRANSITIONAL DUPLICATE because `chuck-docket-executor.mjs` (Unit 6c —
still .mjs daemon) subprocess-invokes it via
`node chuck-posterior-delta.mjs from-runner-execution --runner-execution
<path> --task <path> --prior latest --write --json`.

## Public Contracts

- Tool: `posterior_delta` (registered at startup) — single action
  `from-runner-execution` with `executionPath` (required) +
  optional `runPath` / `taskPath` / `priorPath` / `write` /
  `includeNonCounting` / `writeReadMarkers` flags
- Programmatic API from `./api.ts`: `runFromExecution`, `buildDelta`,
  `buildClaims`, `buildEvidence`, `buildReadMarker`,
  `confidenceForExecution`, `parseScoutSections`,
  `extractRecommendations`, `createValidators`, `validateOrThrow`,
  `writeDelta`, `writeReadMarker`, util helpers
- Types from `./src/types.ts`: `PosteriorDelta`, `ReadMarker`, `Claim`,
  `Producer`, `EvidenceRef`, `MergePolicy`, `ScoutSections`,
  `RunnerExecution`, `RunnerExecutionItem`, `RunnerReceipt`, `TaskRecord`,
  `PriorRecord`, `RunRecord`, `RunReceipt`, `RunFromExecutionOptions`,
  `Confidence`, `ClaimStatus`, `AuthorityImpact`, `ReadMarkerScope`,
  `ReadMarkerResult`

## Internal Files

- `index.ts` — plugin entry; registers `posterior_delta` tool
- `src/runner.ts` — `runFromExecution()` orchestrator (read JSONs →
  per-item buildDelta → schema-validate → optional writeDelta →
  optional buildReadMarker + writeReadMarker → assemble RunReceipt)
- `src/delta.ts` — `buildDelta()` core mapper + `buildClaims()` +
  `buildEvidence()` + `confidenceForExecution()`
- `src/readmarker.ts` — `buildReadMarker()` (returns null unless prior
  was injected AND item completed)
- `src/sections.ts` — `parseScoutSections()` (CLAIMS / RISKS /
  MISSING_EVIDENCE / DEEPEN_NEEDED) + `extractRecommendations()`
  (Recommendation / Recommended Next Actions / Concrete Implementation
  Recommendation headers)
- `src/validators.ts` — Ajv-based validators for posterior-delta + read-
  marker schemas; dissent schema is registered as referenced sub-schema
- `src/util.ts` — atomic JSON write, sha256, fileSha (sha256 of file
  contents prefixed with `sha256:`), normalizeSha, compactTimestamp,
  stableStringify, expandPath (~/, ~), cleanBullet, readJson (decorates
  result with `_path` for object readers)
- `src/types.ts` — public type definitions
- `src/config.ts` — runtime config resolver
- `src/tool.ts` — TypeBox tool schema + execute handler

## Boundary Rules

- **Append-only, never mutates the prior body.** Every emitted delta has
  `mergePolicy.mode = "append-only"`,
  `mergePolicy.mayMutatePriorBody = false`, and
  `mergePolicy.requiresCompactionGate = true`. Reader subsystems (the
  compaction gate) get to decide what becomes the new prior body —
  posterior-delta only records evidence-bearing input.
- **Schema validation is mandatory.** Every delta is run through
  `validateDelta` (Ajv compile of `posterior-delta.schema.json`) before
  it's added to the result; every read marker through
  `validateReadMarker`. If a delta or marker fails validation, the run
  throws — never silently degrades wire-format. Tests inject the same
  Ajv-compiled validators so the schema files are exercised end-to-end.
- **Read markers require BOTH prior injection AND item completion.**
  `task.priorCapsuleBefore.injectedIntoPrompt === true` AND
  `item.status === "completed"`. Anything else returns null and never
  emits a marker. This keeps the chain "Joseph promoted prior →
  executor consumed prior → family signal exists" tight.
- **Mechanical (no LLM).** `parseScoutSections` and
  `extractRecommendations` are regex-based; `buildDelta` is pure
  function. The plugin never spawns or asks claude/gemini/etc. The
  family signal already came from the executor that produced the
  runner-execution JSON; this layer just preserves it in a typed
  schema.
- **Stable IDs from stableStringify + sha256.** `deltaId` =
  `delta-<compact-iso-ts>-<sha256[:12] of stable-key>` and `markerId` =
  `read-<compact-iso-ts>-<sha256[:12]>`. Re-running on the same
  execution receipt produces the same deltaId / markerId — write is
  idempotent in practice.
- **Cap-aware.** `maxClaimsPerDelta` (default 12), `maxOpenQuestions`
  (default 12), `maxRecommendations` (default 8) prevent a verbose
  family scout from blowing the schema. Caps are configurable via
  `pluginConfig.maxClaimsPerDelta` etc.
- **Write is opt-in.** `write: false` (default unless caller passes
  `--write` or `write: true`) returns the constructed deltas + read
  markers in memory only — no filesystem mutation. The CLI default
  matches the .mjs (`--write` is required to persist).

## Migration debt

- **TRANSITIONAL DUPLICATE pairing.** `chuck-docket-executor.mjs` line
  ~1231 spawns `node chuck-posterior-delta.mjs from-runner-execution
--runner-execution <path> --task <path> --prior latest --write --json`
  after each runner execution. Until the executor migrates to importing
  `runFromExecution` directly (Unit 6c follow-up), keep the .mjs CLI
  surface byte-stable: same args, same JSON output shape, same exit
  codes.
- Pairs with `@openclaw/skill-prior-capsule` (Unit 14+ candidate, 1253
  LOC) which writes the prior the executor injects, and the
  `chuck-prior-compaction.mjs` chain (862 LOC) which decides which
  deltas roll forward into the next prior. The three plugins together
  close the read/write loop on the shared prior.
