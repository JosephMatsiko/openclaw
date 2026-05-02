# skill-task-validator Boundary

Post-spawn deliverable validator for chuck-v3 docket tasks. Catches the
"exit=0 but no deliverable" failure mode (originally surfaced 2026-04-29
when chuck-morning-digest task exited cleanly without writing the script
or LaunchAgent plist).

Salvages `chuck-task-validator.mjs` (heuristic path; LLM-introspection
layer queued for v0.2).

## Public Contracts

- Tool: `validate_task` (registered at startup) — params: `task`
  (DocketTask object); returns `{ valid, reason, category, evidence, llm? }`
- Programmatic API: `validateTaskDeliverable`, `VALIDATORS`, individual
  validators (`validateBuildTask`, `validateMacSelfHeal`, etc.), path
  helpers (`inferDeliverablePaths`, `syntaxCheck`, `resolveCandidatePath`,
  `parseStartedAtMs`, `expandHome`) from `./api.ts`
- Types: `DocketTask`, `ValidationResult`, `ValidationCategory`,
  `Validator`, `SyntaxCheckResult` from `./src/types.ts` and
  `./src/path-infer.ts`

## Internal Files

- `index.ts` — plugin entry; registers validate_task tool
- `src/dispatch.ts` — validateTaskDeliverable() dispatcher with exception
  isolation (validator throws → result.valid=true with "trusting exit code")
- `src/path-infer.ts` — inferDeliverablePaths (6 pattern families),
  syntaxCheck (node --check / plutil -lint / JSON.parse),
  resolveCandidatePath, parseStartedAtMs, expandHome
- `src/validators/` — per-commandKind validators:
  - `build.ts` — claude-cli-build / codex-build (deliverable existence
    - size + freshness + syntactic check)
  - `mac-self-heal.ts` — mac-self-heal (latest.json + receipts/ check)
  - `live-scout.ts` — live-scout (scout receipt freshness)
  - `prior-capsule.ts` — prior-capsule (latest.json mtime check)
  - `mcp-registration.ts` — mcp-registration (3-config wire check)
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

## Boundary Rules

- **Validators never false-fail real work.** When a validator can't infer
  what to check, it returns `valid: true` with a "trusting exit code"
  reason. Validator exceptions also produce a `valid: true` result with
  category=`validator-error` so the dispatcher never crashes a task.
- **Build-class validators prefer `task.deliverable.{path|paths}`** over
  intent text inference. Scanners (chuck-self-improvement-scanner,
  chuck-decision-engine) set this explicitly so the validator doesn't have
  to guess from prose.
- **Path inference is conservative.** Six pattern families cover absolute
  paths, tilde paths, LaunchAgent plists, label-style plist mentions,
  repo-relative `extensions/` paths, and explicit "Build/Output/Write/Create
  <path>" verbs. Loose `*.mjs` mentions outside these patterns are
  intentionally NOT inferred.
- **Syntactic check picks the right tool per extension:** `.mjs/.js` →
  `node --check`; `.plist` → `plutil -lint`; `.json` → `JSON.parse`;
  `.ts/.tsx` → existence-only (no reliable stdlib TS check at runtime).
- **TS-only paths get existence-only validation** because the .ts loader
  isn't part of vanilla Node — failing those would false-fail every TS
  build deliverable. The chuck-docket-executor already runs the .ts
  through its own build pipeline before validation.

## Migration debt

- LLM-introspection layer (`validateBuildDeliverableViaLLM`,
  `readLlmBudget`, `dispatchClaudeCli` in chuck-task-validator.mjs) is
  **queued for v0.2**. The .mjs ships with it today; this plugin omits
  it for now but exposes the toggle via `config.skipLlmLayer` so the
  port can land additively.
- `chuck-task-validator.mjs` is a **transitional duplicate** for the
  chuck-docket-executor.mjs caller (`import { validateTaskDeliverable }
from "./chuck-task-validator.mjs"`). Vanilla Node can't import the TS
  plugin's `api.ts` at runtime, so the .mjs preserves the same
  validation surface (heuristic + LLM) with a header pointing back here
  as the canonical implementation. Retires when chuck-docket-executor
  migrates (queued in the watchers/cron migration unit).
