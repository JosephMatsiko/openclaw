# skill-ollama-runner Boundary

Direct local-LLM HTTP runner for in-process callers. Salvages
`chuck-ollama-runner.mjs` (325 LOC). The .mjs survives as a TRANSITIONAL
DUPLICATE because `apex-runtime-chooser.mjs` (still .mjs) subprocess-spawns
it as `node chuck-ollama-runner.mjs -p "..."`.

## Public Contracts

- Tool: `ollama_ask` — single action; takes prompt + optional model /
  system / maxTokens / temp / keepAlive
- Programmatic API from `./api.ts`: `askOllama(config, options, deps)`,
  `defaultHttpPoster()`, `resolveConfig()`
- Types from `./src/types.ts`: `AskOptions`, `AskResult`,
  `HttpJsonPoster`, `RunDeps`

## Internal Files

- `index.ts` — plugin entry; registers `ollama_ask` tool
- `src/client.ts` — `askOllama()` orchestrator (POST to
  `/api/generate` with `stream:false`); `defaultHttpPoster()` uses
  node:http with abort-on-timeout
- `src/tool.ts` — TypeBox tool schema + execute handler
- `src/config.ts` — runtime config resolver (baseUrl + model + temp +
  keepAlive + timeout defaults)
- `src/types.ts` — public type definitions

## Boundary Rules

- **Direct HTTP (no subprocess spawn).** v0.1 calls
  `localhost:11434/api/generate` directly via `node:http.request`.
  Doesn't go through the chuck-ollama-runner.mjs subprocess. The .mjs
  stays alive ONLY for callers (apex-runtime-chooser) that haven't
  migrated.
- **HTTP poster is injectable.** Tests pass a synthetic
  `HttpJsonPoster` so they never hit a live ollama (which would need
  the model loaded). Production uses `defaultHttpPoster()` with the
  configured `generateTimeoutMs` (default 60s).
- **Defaults match the .mjs.** `llama3.1:8b`, 512 max_tokens, temp 0.2,
  keep_alive 10m — all evidence-derived per the .mjs comments.
- **No streaming in v0.1.** `stream:false` on every call. Streaming
  would need a different tool surface; v0.2 candidate.
- **No `ok: true` without content.** When `response` field is empty
  string, returns `ok:false` with reason. Same posture as
  `chuck-notify`'s "no silent success."

## Migration debt

- `apex-runtime-chooser.mjs` subprocess-spawns `chuck-ollama-runner.mjs`
  to dispatch ollama-routed prompts. When that .mjs is salvaged, swap
  to direct programmatic call into this plugin's `askOllama` and the
  .mjs retires.
- v0.1 covers `/api/generate` only. `/api/chat` (multi-turn) and
  `/api/embeddings` are queued for v0.2.
- Streaming responses queued for v0.2 — would require a Server-Sent-
  Events surface in the tool API.
