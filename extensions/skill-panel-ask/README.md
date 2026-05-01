# @openclaw/skill-panel-ask

Broadcast a single intent across multiple AI voices in parallel and synthesize
the replies with cross-family discipline.

This is the OpenClaw-native packaging of the parallel-fleet-broadcast pattern.
Other multi-agent frameworks treat the model layer as one provider at a time;
this skill treats the entire personal subscription stack — Anthropic Max,
ChatGPT Plus, Google AI Pro, Perplexity Pro, xAI, plus a local Ollama backstop
— as a coherent panel that can be summoned per question.

## What it does

When an agent calls the `panel_ask` tool:

1. Resolves the requested voice subset against the catalog
   (`@openclaw/skill-panel-ask` ships 15 voices across 6 families).
2. Dispatches the prompt to every voice **in parallel** through that voice's
   own working surface (CLI, web Chrome, native Mac app, or local runtime).
3. Each voice writes a reply artifact to disk: `<Label>-<Voice>-<Date>.md`.
4. If `mode: "synthesize"` is set, the panel is folded into one consolidated
   answer via Opus 4.7 — with the hard rule that the synthesizer voice cannot
   share the dominant contributor's training family.

## Why a panel instead of a single voice

- Independent priors. Different families ship different training distributions,
  RLHF reward shapes, refusal policies. The panel surfaces real disagreement
  before it becomes a one-voice failure mode.
- Outage resilience. When any one provider goes down, the panel still answers
  through the remaining 9+ voices.
- Cross-family discipline. Any synthesis whose synthesizer shares family with
  the contributors is just one model nodding at itself. The skill enforces
  this as a hard rule, not a guideline.

## Install

```sh
openclaw plugins install @openclaw/skill-panel-ask
```

Configure in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "skill-panel-ask": {
        "enabled": true,
        "config": {
          "defaultMode": "synthesize",
          "defaultVoices": ["claude-cli", "chatgpt-web", "gemini-cli", "grok-web", "perplexity-web"]
        }
      }
    }
  }
}
```

## Use it

### From an agent (the canonical path)

The agent calls `panel_ask` with either a `prompt` body or a path to a `file`:

```json
{
  "tool": "panel_ask",
  "args": {
    "prompt": "Sharpest assessment of the attached architecture.",
    "voices": ["claude-cli", "gemini-cli", "grok-web", "perplexity-web"],
    "mode": "synthesize",
    "label": "ARCH-V1"
  }
}
```

The tool returns a `PanelAskOutput` with per-voice paths + chars + ms,
plus the synthesis result if requested.

### From other plugins / agents (programmatic)

```ts
import { runPanelAsk } from "@openclaw/skill-panel-ask";

const result = await runPanelAsk({
  prompt: "...",
  voices: ["claude-cli", "chatgpt-web", "gemini-web"],
  mode: "synthesize",
});

console.log(result.synthesis?.path);
```

### Inspect the catalog without dispatching

```json
{
  "tool": "panel_ask",
  "args": { "action": "list" }
}
```

## Voice catalog

Each voice is identified by family + surface so cross-family discipline can
be enforced at synthesis time.

| Family     | Voices                                               |
| ---------- | ---------------------------------------------------- |
| anthropic  | claude-cli, claude-cli-web-styled, claude-ai         |
| openai     | chatgpt-web, chatgpt-mac, codex                      |
| google     | gemini-cli, gemini-web, aistudio-web, notebooklm-web |
| xai        | grok-web                                             |
| perplexity | perplexity-web, perplexity-mac, comet-web            |
| local      | ollama-local                                         |

`list` returns the full metadata: surface, capabilities, outage-resilience.

## Cross-family discipline

When `mode: "synthesize"` is set, the synthesizer voice is selected such that
its family does NOT match the dominant contributor's family. Example: a panel
of claude-cli + claude-ai + chatgpt-web (anthropic majority) gets a non-Anthropic
synthesizer (typically gemini-cli or grok-web).

This is enforced in code (`selectSynthesizer()`), not as a configuration
guideline.

## Config

| Key                 | Type     | Default         | What                                                           |
| ------------------- | -------- | --------------- | -------------------------------------------------------------- |
| `enabled`           | boolean  | `true`          |                                                                |
| `defaultMode`       | string   | `"synthesize"`  | `raw` or `synthesize`                                          |
| `defaultVoices`     | string[] | `[]`            | Voices used when caller omits `voices`. Empty = all healthy.   |
| `perVoiceTimeoutMs` | integer  | `300000`        | Per-voice hard timeout                                         |
| `outputDir`         | string   | `"~/Documents"` | Where per-voice artifacts land                                 |
| `scriptPath`        | string   | `""`            | Override path to the dispatch script. Empty = bundled default. |

## Dispatch internals (transitional)

The first iteration of this plugin wraps the existing battle-tested
`apex-panel-ask.mjs` dispatch script as a subprocess. That keeps the per-voice
driver code where it already lives (with proven AppleScript / CDP / CLI
handlers per voice) while exposing a typed in-process API + agent tool here.

Stage 3 follow-on lifts dispatch into TypeScript and removes the subprocess
hop. Voice ids stay stable; PanelAskInput / PanelAskOutput don't change.
Callers see no contract drift.

## License

MIT
