# skill-panel-ask Boundary

This extension wraps the parallel-fleet-broadcast pattern as an OpenClaw
agent tool. It belongs to the same plugin boundary that third-party
plugins see — see `extensions/AGENTS.md` for the shared rules.

## Public Contracts

- Tool: `panel_ask` (registered at startup)
- In-process API: `runPanelAsk()`, `listVoices()`, `selectSynthesizer()` from `./api.ts`
- Types: `PanelAskInput` / `PanelAskOutput` / `VoiceCatalogEntry` from `./src/types.ts`

## Internal Files

- `index.ts` — plugin entry; wires the panel_ask tool through definePluginEntry
- `src/tool.ts` — TypeBox schema + execute handler
- `src/dispatch.ts` — subprocess wrapper around apex-panel-ask.mjs (transitional)
- `src/voices.ts` — typed voice catalog, cross-family synthesizer selector
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public types

Treat any other file as private. Promote through `api.ts` if core or another
extension needs it.

## Boundary Rules (extension specific)

- Voice ids in `src/voices.ts` MUST stay in sync with the VOICES block in
  `extensions/memory-graph/scripts/apex-panel-ask.mjs`. The dispatch
  subprocess passes ids straight through to `--only`; drift here breaks
  every panel run.
- Do NOT import the subprocess script's runtime helpers via relative paths.
  The dispatch wrapper resolves the script path at runtime via
  `homedir() + "/Projects/openclaw/extensions/memory-graph/scripts/..."`
  by default; the caller can override via `scriptPath` config.
- Cross-family discipline (synthesizer ≠ dominant contributor's family) is
  enforced in `selectSynthesizer()`. Any change to that function must keep
  the panel-synthesis hard rule from the 2026-05-01 design vote.
- Stage 3 follow-on (separate change): lift the dispatch loop + per-voice
  drivers into TypeScript, kill the subprocess hop. Until then, this
  plugin's purpose is the typed metadata + tool surface — the heavy
  lifting stays in the .mjs script.

## Stage 3 Migration Order

1. ✅ Scaffold (this directory) — typed metadata + tool wrapper.
2. ⏳ Move synthesis (Opus 4.7 reconciliation) into TypeScript.
3. ⏳ Move per-voice drivers into TypeScript one family at a time
   (start with CLI voices: claude-cli, codex, gemini-cli, ollama-local —
   these have the simplest `spawn` contracts).
4. ⏳ Move web-chrome drivers (claude-ai, chatgpt-web, gemini-web, etc.)
   — these need the AppleScript / CDP harness ported.
5. ⏳ Drop the subprocess wrapper; delete the .mjs script.

Each step is independently shippable and keeps PanelAskInput / PanelAskOutput
stable so callers don't see contract drift.
