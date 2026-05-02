# skill-prior-compaction Boundary

Joseph-gated compaction gate for chuck-v3 priors. Mechanical claim
promotion across schema-validated posterior deltas; the model does NOT
get silent editor authority over the prior. Three commands:

- **`status`** — summarize latest applied + draft + an in-memory preview
- **`preview`** — produce a deterministic draft compaction (writes only
  with `write:true`)
- **`approve`** — transition `draft → approved → applying → applied`
  with confirm token `APPROVE_PRIOR_COMPACTION`. The applied step
  refreshes the compact prior capsule via `chuck-prior-capsule`
  subprocess (Unit 15+ candidate)

Salvages `chuck-prior-compaction.mjs` (862 LOC). The `.mjs` survives as
a TRANSITIONAL DUPLICATE because `chuck-dashboard.mjs` line 933
subprocess-spawns it (`runPriorCompaction → spawnSync(node,
[CHUCK_PRIOR_COMPACTION, ...args])`).

## Public Contracts

- Tool: `prior_compaction` actions: `status` | `preview` | `approve`
- Programmatic API from `./api.ts`: `buildStatus`, `previewDecision`,
  `approveDecision`, `buildPreviewDecision`, `summarizeDecision`,
  `appliedCompactionCursor`, `compactionDecisionFiles`,
  `latestCompactionDecision`, `assessDelta`, `claimDeferralReason`,
  `receiptOnlyDeferralReason`, `deferredClaim`, `deferredClaimForDelta`,
  `docketTaskForDelta`, `promoteClaim`, `evidenceRefsFor`,
  `collectDissentRefs`, `collectStrings`, `strongerStatus`,
  `strongerConfidence`, `strongerAuthorityImpact`, `readLatestPrior`,
  `writeDecision`, `defaultRefreshPriorCapsule`, `createDecisionValidator`,
  `validateOrThrow`, util helpers
- Types from `./src/types.ts`: `CompactionDecision`, `PromotedClaim`,
  `DeferredClaim`, `DecisionApproval`, `DecisionCursor`,
  `DecisionStatus`, `DecisionSummary`, `StatusResult`, `PreviewReceipt`,
  `ApproveReceipt`, `RunDeps`, `PriorRecord`, `PriorCapsuleReceipt`,
  `PosteriorDeltaInput`, `DocketTask`, `AppliedCursor`, `ClaimStatus`,
  `Confidence`, `AuthorityImpact`, plus options types

## Internal Files

- `index.ts` — plugin entry; registers `prior_compaction` tool
- `src/status.ts` — `buildStatus()` + `summarizeDecision()`
- `src/preview.ts` — `previewDecision()` (build → optional write +
  draft-written event) + `writeDecision()` (file-write with non-draft
  overwrite refusal)
- `src/approve.ts` — `approveDecision()` (draft → approved → applying
  → applied) + bus events at each transition. `RunDeps.refresh
PriorCapsule` is injectable for tests; production uses
  `defaultRefreshPriorCapsule(config)`
- `src/decision.ts` — `buildPreviewDecision()` + `readLatestPrior()` +
  `deterministicDecisionTime()`
- `src/cursor.ts` — `appliedCompactionCursor()` (sums up appliedDeltaIds
  across all `status:applied` decisions, returns latest decisionId +
  resultingPriorId), `compactionDecisionFiles()`,
  `latestCompactionDecision()`
- `src/assess.ts` — per-delta `assessDelta()` (schema/evidence/claims/
  authorityImpact/dissent gates), per-claim `claimDeferralReason()`,
  `receiptOnlyDeferralReason()` (read-canary heuristic against
  delta.taskTitle / docket task title), `deferredClaim()` /
  `deferredClaimForDelta()`, `docketTaskForDelta()`
- `src/promote.ts` — `promoteClaim()` (merges by normalized claim text
  hash; tracks families + surfaces + sourceDeltaIds + sourceClaimIds +
  evidenceRefs), `evidenceRefsFor()` (claim refs first, then delta
  evidence), `collectDissentRefs()`, `collectStrings()`,
  `strongerStatus/Confidence/AuthorityImpact()`
- `src/capsule.ts` — `defaultRefreshPriorCapsule()` subprocess wrapper
  for `chuck-prior-capsule.mjs --write --markdown --json`; returns
  `PriorCapsuleReceipt` parsed from stdout
- `src/validators.ts` — Ajv 2020-12 validator for
  `prior-compaction-decision.schema.json`
- `src/util.ts` — atomic JSON write, sha256, fileSha, compactTimestamp,
  stableStringify, compareIso, expandPath, resolveDecisionPath,
  latestJsonFiles (sorted by mtime DESC), makeEvent
- `src/types.ts` — public type definitions
- `src/config.ts` — runtime config resolver
- `src/tool.ts` — TypeBox tool schema + execute handler

## Boundary Rules

- **Joseph-gated.** `approve` requires `confirm: "APPROVE_PRIOR_COMPACTION"`
  (the configured `approvalToken`); anything else throws. The token
  string is part of the wire contract with the operator/cockpit; do
  NOT change it.
- **Deterministic decisionId.** `compaction-<compact-iso-ts>-<sha256[:12]
of stable-key>` where the stable-key is `{sourcePriorId,
includedDeltaIds, promotedClaimKeys (sorted), deferredClaimIds
(sorted)}`. Re-running preview on the same input set produces the
  same decisionId (idempotent in practice). The compact-iso-ts is the
  MAX of `prior.createdAt + delta.createdAt` (most-recent-of-input)
  rather than `now`.
- **Mechanical promotion.** `promoteClaim` keys claims by `sha256[:12]`
  of normalized text (lowercase + collapsed whitespace). Duplicates
  merge: status climbs (`retracted < contested < proposed < supported
< operator-resolved`), confidence climbs (`low < medium < high`),
  authorityImpact climbs (`none < proposal < approval-required <
blocked`), families/surfaces/sourceDeltaIds/sourceClaimIds/evidence
  refs accumulate (de-duplicated via pushUnique).
- **Schema validation is mandatory at every transition.** `preview` →
  validate; `approve` → validate before write at each of the three
  status transitions (`approved`, `applying`, `applied`). Failure
  throws — no silent wire-format degradation.
- **Cursor-aware.** `appliedCompactionCursor()` walks every
  `status:applied` decision and unions their `includedDeltaIds`. The
  preview filters those out, so applied deltas are never re-promoted.
  The cursor also surfaces `previousResultingPriorId` so the new
  decision can carry the lineage.
- **Read-canary defers, doesn't block.** When a delta's task title
  (or docket task title) contains "read canary"/"read-canary", the
  delta's claims are deferred (NOT promoted) but the source delta +
  read marker stay intact. Goal: preserve the canary observation
  trail without polluting the compact prior body.
- **Receipt-first; bus emit is best-effort.** Every preview-with-write,
  every approve transition writes the JSON file BEFORE emitting the
  bus event (`chuck.prior-compaction.draft-written`,
  `chuck.prior-compaction.approved`, `chuck.prior-compaction.applied`).
  Bus emit failures are swallowed; receipts are the source of truth.
- **chuck-prior-capsule subprocess is injectable.** Tests pass
  `RunDeps.refreshPriorCapsule` so they never spawn the real .mjs (which
  itself reads the prior write pipeline). Production wires
  `defaultRefreshPriorCapsule(config)` which spawns `chuck-prior-
capsule.mjs --write --markdown --json` and parses stdout.

## Migration debt

- **TRANSITIONAL DUPLICATE pairing.** `chuck-dashboard.mjs` line 933
  spawns `node chuck-prior-compaction.mjs status --json` (and
  presumably preview/approve too). Until chuck-dashboard is salvaged
  into a typed plugin (queued — biggest remaining leaf at ~2200+ LOC)
  AND that plugin imports `buildStatus` / `previewDecision` /
  `approveDecision` directly, the .mjs CLI surface must stay
  byte-stable: same args, same JSON output, same exit codes, same
  schema versions, same ID patterns.
- Pairs with `@openclaw/skill-prior-capsule` (Unit 15+ candidate, 1253
  LOC) — the subprocess this plugin spawns to refresh the compact
  prior. When that .mjs is salvaged, swap the subprocess invocation
  here for a direct programmatic call (keep the `refreshPriorCapsule`
  adapter so tests still inject).
- Pairs with `@openclaw/skill-posterior-delta` (Unit 13) — the source
  of every input delta this gate considers. Both share the chuck-v3
  prior compaction loop: posterior-delta writes evidence-bearing
  deltas → prior-compaction promotes claims into the compact prior →
  prior-capsule writes the next prior capsule → executor injects the
  refreshed prior into next dispatch.
