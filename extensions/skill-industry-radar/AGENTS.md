# skill-industry-radar Boundary

Per-commit watcher for upstream source repos. Surfaces architectural
decisions (AGENTS.md / CLAUDE.md changes, breaking changes, refactors)
that Joseph's openclaw fork should react to. Fills the unique gap that
existing watchers (apex-daily-digest, apex-feed-discovery, ClawHub
RSS/release watchers) don't cover: per-commit signal from upstream
maintainer-authored decisions.

Salvages `chuck-industry-radar.mjs` (342 LOC).

## Public Contracts

- Tool: `industry_radar` (registered at startup) — actions: `scan
[--dryRun]` | `status`
- Programmatic API: `runScan`, `summarizeStatus`, `scoreCommit`,
  `fetchRepoCommits`, `buildDigestMarkdown`, `createEventEmitter`,
  `statePath`, `sourcesPath` from `./api.ts`
- Types: `RepoSource`, `SourcesConfig`, `RawCommit`, `ScoredCommit`,
  `RepoSignal`, `Signal`, `SkippedSignal`, `RadarState`, `ScanOptions`,
  `ScanResult` from `./src/types.ts`

## Internal Files

- `index.ts` — plugin entry; registers industry_radar tool
- `src/scan.ts` — runScan() orchestrator (read sources → fetch per repo
  via gh CLI → score → digest → state); summarizeStatus
- `src/score.ts` — scoreCommit (heuristic relevance scoring; over-weights
  architectural-decision signals)
- `src/fetch.ts` — fetchRepoCommits (`gh api repos/<o>/<r>/commits` via
  spawnSync; injectable for tests)
- `src/digest.ts` — buildDigestMarkdown (daily digest output format)
- `src/events.ts` — apex-events.jsonl emit (best-effort)
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **The radar emits bus events; it does NOT write its own digest into
  Telegram.** apex-daily-digest already summarizes the bus, so flagged
  commits land in the morning Telegram digest automatically. The
  `digest-<yyyy-mm-dd>.md` file under stateDir is for replays / audit
  trails, not for direct delivery.
- **`gh` auth is the radar's only external dependency.** When `gh auth`
  isn't set up, `fetchRepoCommits` returns `{ok: false, error: ...}`
  per repo and the radar marks that source unhealthy + continues with
  the rest. No global failure.
- **Heuristic scoring favors architectural-decision signals.** AGENTS.md /
  CLAUDE.md / breaking-change / refactor commits score high. Docs typos /
  dependabot / test-only commits get negative score → never surfaced.
- **Per-repo cap protects digest readability.** Default 8 surfaced
  commits per repo per scan; surplus commits are scored but trimmed
  before write. `surfaced` count in the signal reflects total scored;
  `commits` array reflects what made it into the digest.
- **gmail + blogs are deferred to v0.2.** First-ship focuses on commit
  signal (highest-density actionable surface). Skipped sources are
  documented in the digest under "Sources skipped (first-ship)".

## Migration debt

- `chuck-industry-radar.mjs` is a **transitional duplicate** for any
  manual `node chuck-industry-radar.mjs run` invocations. No LaunchAgent
  invokes it today (industry-radar daemon scheduling deferred); the
  .mjs survives as the CLI surface until the plugin grows a CLI shim.
- gmail + blogs sources are **queued for v0.2** — both are `skipped:
true` placeholders today; the framework + signal types are in place
  so adding them is additive.
