// Layer-5 gateway pre-inference routing hook (Phase 3c).
//
// Registered into OpenClaw's `before_model_resolve` plugin hook from
// `index.ts`. Classifies the incoming prompt via the (sync) heuristic
// classifier and — in "on" mode — returns a model/provider override.
//
// Design constraints:
//   - Zero latency in "off" mode (no classifier call at all).
//   - Heuristic-only at the hook site — the LLM fallback is ~500ms and
//     would add that to every turn. If you want LLM-grade classification,
//     run `memory_classify_message` from the calling agent, not here.
//   - Fail-closed: any thrown error returns `undefined` so the runner
//     falls back to the configured primary model. A broken hook must never
//     block a turn.
//   - Explicit shadow mode: log the verdict, don't enforce. Lets Joseph
//     verify the classifier's decisions against live traffic before
//     flipping `on`.
//
// Firing scope — important: this hook is only invoked by
// `resolveHookModelSelection` in `src/agents/pi-embedded-runner/run/setup.ts`.
// Turns that route through the CLI backend (`claude-cli/*` providers)
// bypass the hook entirely. For an install whose primary is a claude-cli
// model, this hook will not fire on default turns — only on explicit
// overrides that target embedded-runner-eligible providers (google,
// anthropic, openai, etc). Adding the hook call to the CLI-backend path is
// tracked as a separate core change.
//
// End-to-end verification (2026-04-22): `on` mode + "what did we talk
// about yesterday?" (contextual) correctly overrides target from
// google/gemini-2.5-pro back to itself (hook emits tier=contextual,
// runner logs `[hooks] model overridden to gemini-2.5-pro`), then runs
// with graceful fallback to Opus on 429.

import type { RoutingMode } from "./config.js";
import { classify, type OrchestratorModel, type OrchestratorTier } from "./orchestrator.js";

// Provider IDs match the OpenClaw provider plugin ids (see
// `extensions/google/openclaw.plugin.json` etc). `undefined` means "don't
// override provider" — the runner keeps its configured primary.
const TIER_TO_OVERRIDE: Record<
  OrchestratorTier,
  { provider: string; model: OrchestratorModel } | null
> = {
  trivial: { provider: "google", model: "gemini-2.5-flash" },
  contextual: { provider: "google", model: "gemini-2.5-pro" },
  // Complex stays on whatever the configured primary is (Opus on Joseph's
  // install). Returning null signals "no override, keep default."
  complex: null,
};

export type RoutingHookLogger = {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

export type RoutingHookEvent = {
  prompt: string;
};

export type RoutingHookResult = { modelOverride?: string; providerOverride?: string } | undefined;

export type RoutingHookOptions = {
  mode: RoutingMode;
  logger?: RoutingHookLogger;
  // Override the tier→model mapping for tests and per-install customization.
  // Pass null in a tier slot to mean "never override for this tier."
  tierOverrides?: Partial<Record<OrchestratorTier, { provider: string; model: string } | null>>;
};

function resolveOverride(
  tier: OrchestratorTier,
  opts: RoutingHookOptions,
): { provider: string; model: string } | null {
  if (opts.tierOverrides && Object.hasOwn(opts.tierOverrides, tier)) {
    return opts.tierOverrides[tier] ?? null;
  }
  return TIER_TO_OVERRIDE[tier] ?? null;
}

// Pure function so it's easy to test. The plugin's `api.on` callback just
// wraps this with the live logger + config.
export function runRoutingHook(
  event: RoutingHookEvent,
  opts: RoutingHookOptions,
): RoutingHookResult {
  if (opts.mode === "off") {
    return undefined;
  }
  const prompt = typeof event.prompt === "string" ? event.prompt : "";
  let verdict;
  try {
    verdict = classify(prompt);
  } catch (err) {
    opts.logger?.warn?.(
      `memory-graph routing: classifier threw (${err instanceof Error ? err.message : String(err)}); falling back to default`,
    );
    return undefined;
  }
  const tag = `tier=${verdict.tier} via=${verdict.viaHeuristic ? "heuristic" : "llm"} rationale=${verdict.rationale}`;
  if (opts.mode === "shadow") {
    opts.logger?.info?.(`memory-graph routing [shadow]: ${tag}`);
    return undefined;
  }
  // mode === "on"
  const override = resolveOverride(verdict.tier, opts);
  if (!override) {
    opts.logger?.info?.(`memory-graph routing [on]: ${tag} — keeping default model`);
    return undefined;
  }
  opts.logger?.info?.(
    `memory-graph routing [on]: ${tag} — overriding to ${override.provider}/${override.model}`,
  );
  return { providerOverride: override.provider, modelOverride: override.model };
}
