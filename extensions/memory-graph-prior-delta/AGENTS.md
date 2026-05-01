# memory-graph-prior-delta Boundary

This extension adds the Universal Prior + Posterior Delta typed contract on
top of the memory-graph plugin's SQLite store. See `extensions/AGENTS.md` for
shared boundary rules.

## Public Contracts

- Tool: `prior_delta` (registered at startup)
- Validators: `validateAppendOnly`, `validateCompaction`,
  `validateCompactionPreservesDissent`, `validateThreeSignatures`,
  `validateCrossFamilyDiscipline`
- Hash helpers: `priorCapsuleId`, `posteriorDeltaId`, `stableStringify`, `sha256`
- Types: `PriorCapsule`, `PosteriorDelta`, `CompactionRecord`, `DissentRecord`,
  edges, `VoiceFamily`, `VoiceSurface` from `./src/types.ts`

## Internal Files

- `index.ts` — plugin entry; registers prior_delta tool
- `src/tool.ts` — TypeBox schema + execute handler
- `src/types.ts` — public type definitions
- `src/invariants.ts` — schema validators (the four invariants)
- `src/hash.ts` — content-address helpers
- `src/config.ts` — runtime config resolver

Treat any other file as private. Promote through `api.ts` if core or another
extension needs it.

## Boundary Rules

- All four invariants are **structural protections**, not policies:
  the plugin rejects mutations that violate them at the validator layer,
  not as guidelines an auditor must catch later. Any code change that
  weakens an invariant must come with explicit owner approval.
- `validateCrossFamilyDiscipline` requires a `voiceFamilies` context map
  passed by the caller. We do NOT reach into skill-panel-ask for the voice
  family registry — the caller wires it in. This keeps the plugin
  independently shippable.
- Schema is v1. Future schema bumps must keep the validator API
  backwards-compatible (new optional fields, no removed required fields).
- The memory-graph host plugin owns persistence; this plugin only owns
  the typed contract + validators. v0.2 follow-on adds the persistence
  hook surface once memory-graph exposes one.

## Roadmap

1. ✅ v0.1 — types + validators + hash helpers + tool stub (this scaffold)
2. ⏳ v0.2 — persistence: write nodes/edges through memory-graph's storage
   API; emit bus events on prior advance and compaction commit
3. ⏳ v0.3 — read-marker advance loop: when a prior advances, mark all
   active voices as needing to re-read
4. ⏳ v0.4 — compaction ceremony API: propose / approve / sign with
   three-step state machine and timeout / cancellation
5. ⏳ v0.5 — migration path from existing markdown prior capsules in
   `~/.openclaw/workspace/state/chuck-v3/priors/`

Each step keeps the v0.1 surface (types + validators + hashes) stable so
callers don't see contract drift across versions.
