// Prompt construction — scan + focus modes.

import { renderStateForPrompt } from "./bundle.js";
import type { IntrospectConfig } from "./config.js";
import type { StateBundle } from "./types.js";

const SCAN_PROMPT_PREFIX = (max: number) =>
  `You are Chuck's introspection layer. Read the recent state below.
Identify up to ${max} NOVEL observations that the rule-based decision-engine
would NOT catch. Look for: surprising patterns, emerging risks, cross-
subsystem correlations, drift from established discipline, things that
are technically working but architecturally wrong.

For each observation, emit:
{
  "id": "<unique slug>",
  "category": "<short kind>",
  "observation": "<what you see, 1-2 sentences>",
  "why_novel": "<why pattern-detect would miss this, 1 sentence>",
  "recommendation": "<concrete action, 1 sentence>",
  "risk_class": "low|medium|high",
  "rationale": "<why this matters, 1-3 sentences>",
  "evidence": [{"source": "<file or event>", "snippet": "<excerpt>"}]
}

Be terse. Quality over quantity — emit 0 observations if nothing
genuine. Don't repeat what the decision-engine already proposed
(their ids start "decision-"; your work starts "introspect-").

Output a JSON array of observation objects (no prose, no markdown fences).
If nothing novel, output an empty array: [].`;

export function buildScanPrompt(bundle: StateBundle, config: IntrospectConfig): string {
  const state = renderStateForPrompt(bundle);
  return `${SCAN_PROMPT_PREFIX(config.maxObservationsPerScan)}\n\n<STATE>\n${state}\n</STATE>`;
}

export function buildFocusPrompt(topic: string, bundle: StateBundle): string {
  const state = renderStateForPrompt(bundle);
  return `You are Chuck's introspection layer. Joseph asked:

<TOPIC>
${topic}
</TOPIC>

Read the recent state below and respond with focused analysis. Answer
specifically what was asked. Then, IF (and only if) you identify concrete
novel observations or recommendations relevant to the topic, append a JSON
array of observation objects in the same schema the scan mode uses:

{
  "id": "<unique slug>",
  "category": "<short kind>",
  "observation": "<what you see, 1-2 sentences>",
  "why_novel": "<why pattern-detect would miss this, 1 sentence>",
  "recommendation": "<concrete action, 1 sentence>",
  "risk_class": "low|medium|high",
  "rationale": "<why this matters, 1-3 sentences>",
  "evidence": [{"source": "<file or event>", "snippet": "<excerpt>"}]
}

Wrap the JSON array in <OBSERVATIONS>...</OBSERVATIONS> tags so it can be
parsed out from your prose. If nothing actionable, write
<OBSERVATIONS>[]</OBSERVATIONS>.

<STATE>
${state}
</STATE>`;
}
