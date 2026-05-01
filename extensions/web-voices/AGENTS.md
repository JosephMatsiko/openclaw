# web-voices Boundary

Subscription-driven web voices as a first-class OpenClaw provider plugin.
Wraps DOM-fragile UI-intercept logic behind a versioned, contract-bound surface
so vendor CSS-class changes can be patched in one place instead of breaking
every user's bespoke scripts. See `extensions/AGENTS.md` for shared rules.

## Public Contracts

- Tool: `web_voice` (registered at startup)
- Catalog: `listWebVoices`, `findWebVoice`, `voicesSupporting`
- Lease primitive: `tryAcquireLease`, `acquireWithRetry`, `releaseLease`,
  `inspectLease`
- Selector registry: `getSelectorProfile`, `upsertSelectorProfile`,
  `inspectSelectorRegistry`
- Types: `WebVoiceCatalogEntry`, `WebVoiceAskInput`, `WebVoiceAskResult`,
  `SelectorProfile`, `SelectorRegistry` from `./src/types.ts`

## Internal Files

- `index.ts` — plugin entry; registers web_voice tool
- `src/tool.ts` — TypeBox schema + execute handler (v0.1: list/filter/ask-dryRun/lease/selectors)
- `src/voices.ts` — typed catalog of 8 web voices
- `src/lease.ts` — workstation lease (file-based, single-host)
- `src/selector-registry.ts` — versioned per-voice DOM selector registry
- `src/config.ts` — runtime config resolver
- `src/types.ts` — public type definitions

The harness layer (`./src/harness/<voice-id>.ts`) lands in v0.2.

## Boundary Rules

- The catalog (voice ids + vendor + surface + capability matrix) is the
  stable contract third-party plugins depend on. Adding voices is additive;
  removing or renaming a voice id is a major version bump.
- The workstation lease format is shared with the legacy
  `chuck-surface-control.mjs` script (file at
  `~/.openclaw/workspace/state/chuck-v2/surface-control/active-workstation-lease.json`).
  Both legacy .mjs scripts and this TS plugin coordinate over the same
  state. v0.2+ may migrate to a gateway-resident lease registry.
- The selector registry stores vendor + version-pinned CSS selectors.
  Newer versions win in `getSelectorProfile`. Auto-patch heuristics
  (DOM probe + candidate inference) land in v0.2.
- Per-voice harnesses (v0.2) MUST acquire the workstation lease before
  driving Chrome and release after. Failure to release within
  `MAX_LEASE_HOLD_MS` triggers stale-detection on the next caller's
  attempt.
- Cross-family discipline: this plugin is just a substrate. Synthesis
  decisions (which voice to call) live in `@openclaw/skill-panel-ask`'s
  `selectSynthesizer`. We do NOT duplicate that logic here.

## Roadmap

1. ✅ v0.1 — catalog + lease + selector registry + tool stub (this scaffold)
2. ⏳ v0.2 — per-voice harnesses ported from
   `extensions/memory-graph/scripts/research-*-chat.mjs`. Start with the
   simplest (chatgpt-web, claude-ai-web — main Chrome AppleScript path),
   then PWA-mode voices (gemini-web, grok-web, aistudio-web), then the
   trickier ones (notebooklm-web, comet-web, perplexity-web).
3. ⏳ v0.3 — auto-patch on selector miss: DOM probe + candidate inference.
4. ⏳ v0.4 — gateway-resident lease registry (replaces file-based lease).
5. ⏳ v0.5 — model-provider integration: register each web voice as an
   OpenClaw model provider so agents can call them through the standard
   provider runtime instead of via the bespoke web_voice tool.

Each step keeps PanelAskInput / WebVoiceAskInput / WebVoiceAskResult
stable so callers don't see contract drift across versions.
