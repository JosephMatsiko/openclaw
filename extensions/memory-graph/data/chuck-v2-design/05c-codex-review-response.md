# 05c — Codex (review) response to 05a

**Voice:** Codex CLI (`codex review`), gpt-5.5, OpenAI family
**Surface:** `codex review -` (non-interactive, code-review-posture system prompt)
**Prompt:** [`extensions/memory-graph/data/chuck-v2-design/05a-claude-code-critique-of-unified-draft.md`](05a-claude-code-critique-of-unified-draft.md)
**Original landing:** `~/Documents/v3-r3-claude-critique-Codex-Review-CLI-2026-04-27.md`
**Run timing:** 99 sec, 6,240 chars output, primary layer (no fallback)
**Fired:** 2026-04-26 21:41 CDT via `apex-panel-ask.mjs --only codex-review`

**Why this surface exists:** Joseph flagged 2026-04-26 that two surfaces of the same model will return measurably different output even on identical input. The `codex-review` voice was added to `apex-panel-ask.mjs` at [extensions/memory-graph/scripts/apex-panel-ask.mjs:121](../../../scripts/apex-panel-ask.mjs) immediately before this run to test the hypothesis. Result: 100% verdict convergence with `codex` (exec) on the six numbered critiques, but ~30% divergence on framing — substantial enough to be load-bearing for the patch in [`05d-spec-patch-surface-as-first-class-field.md`](05d-spec-patch-surface-as-first-class-field.md).

---

## Provenance headers (verbatim from runner)

```
Voice-Requested: codex-review (Codex-Review-CLI)
Producer-Family: openai
Impersonation: false
Model: codex/gpt-5.5 (review posture)
Layer used: primary (codex/gpt-5.5 (review posture))
Retrieved: 2026-04-27T02:42:51.440Z
Prompt size: 14355 chars
```

---

## Response (verbatim)

I read the draft. Sharp take:

## 1. Genuinely dominant / best-in-class

- **The kernel/fleet/vault/evidence/execution split is the strongest part.** The draft does not confuse "model output" with "system authority." That is rare and important.
- **Producer-family attribution is genuinely load-bearing.** Signing actual runner/provenance at the orchestrator boundary is the right primitive. Most ensemble systems hand-wave this and are vulnerable to silent fallback / impersonation.
- **DEEP_FRACTURE = halt is correct.** The spec preserves dissent instead of averaging it away. That is the main epistemic advantage over majority-vote agent stacks.
- **Vault-as-alignment-not-truth is the right correction.** If preserved, it prevents the memory system from becoming a self-reinforcing cult of old decisions.
- **The evidence hierarchy is the right ordering.** Tests/docs/source facts beating model consensus is exactly the right invariant.
- **Defaulting OpenClaw to chassis/channel surface, with intercept deferred, is mature.** The original "puppeteer everything" instinct would likely rot under schema churn and latency.

## 2. Fragile / likely to break first

- **Stake assessment.** This is the bridge between "usable assistant" and "audit rig." If the classifier under-routes one destructive or authority-expanding task, the whole safety model is bypassed. This needs measurable false-negative targets, not prose.
- **Operator attention.** The architecture creates many Joseph-final gates: Vault writes, authority expansion, destructive actions, fractures, impersonation, long-horizon initiation. If approval UX is not excellent, the system either stalls or trains Joseph to rubber-stamp.
- **Independence math.** The fleet is not five independent truth samples. Anthropic/OpenAI/Google share corpus and benchmark pressure; Perplexity is a router; local Llama is not an equal reasoning peer. Raw `N` thresholds are overconfident.
- **Self-Improvement Lab.** As written, it is the highest-risk component with the least mechanical specification. "Kernel gates patch merge" is not enough unless authority expansion is mechanically diffed.
- **Doctrine Compiler.** It currently risks converting "operator alignment prior" into executable truth. Advisory policy and enforced policy must be separated.
- **Citation span rule.** "Span exists" is underspecified. Exact match is brittle; semantic match is LLM-judged. The critique lands.
- **Consumer-surface automation.** Browser/PWA/CLI sessions, quotas, app updates, GUI state, and ToS churn will break before the pure architecture does. Treat these as unreliable transports, not foundations.
- **Spec mass.** At 51 KB, it already contains duplicated concepts and too many Phase 3/4 ambitions. Implementation will drift unless V3 canonical is much smaller.

## 3. Missing / what frontier competitors would ship

- **Shadow-mode calibration.** Run the fleet behind normal work before gating real work. Collect stake-classifier misses, latency, cost/quota, consensus correctness, fracture rate, and operator-minute cost.
- **Authority-diff schema.** First-class typed diffs for tool permissions, credential scopes, sandbox policy, thresholds, regex coverage, allowlists, runtime limits.
- **Approval UX.** Typed approval cards, batch approvals, reversible vs irreversible labels, "approve once / approve recipe / always require" controls, and clear timeout behavior.
- **Policy DSL / capability model.** Not just prose allowlists. Capabilities need stable IDs, scopes, owners, risk classes, escalation rules, and diff semantics.
- **Prompt/template versioning.** Adjudicator-family rotation is insufficient. Frontier systems would version adjudication prompts, run prompt ensembles on high-stakes cases, and track prompt-regression metrics.
- **Memory poisoning defenses.** The Vault section needs contamination labels, source trust, demotion, stale-node detection, recursive self-citation prevention, and retrieval evals.
- **Incident review loop.** Near-miss records, root-cause taxonomy, recurring-risk dashboard, and regression tests generated from incidents.
- **Budget governor.** Quota, latency, model-call budget, local resource pressure, and operator-attention budget should be first-class routing inputs.
- **Minimal vertical slice.** Competitors would ship one working lane: e.g. "code-review task → fleet review → decision record → safe patch proposal," not the whole sovereign mind.

## 4. What to prioritize next

1. **Decide the primary identity.** I'd make it explicit: Chuck is a sovereign personal command center; AEE is the high-stakes quality/safety layer. If "truth rig" is primary, routine usefulness dies.

2. **Patch the six critiques before canonical V3.** My verdicts:
   - #1 Doctrine Compiler: **accept**
   - #2 Independence weighting: **refine** — use conservative effective-N now; empirical correlation later.
   - #3 Self-Improvement Lab: **accept**
   - #4 Adjudicator rotation shallow: **refine** — template ensembling for high-stakes/fracture cases, not every trivial run.
   - #5 Phase 0 metrics: **accept**
   - #6 Citation spans: **accept** — replace hard binary rule with typed verification verdicts.

3. **Write the authority model before building the Lab or Compiler.** Kernel, capabilities, authority-diff, approval records, and DecisionRecord schemas come first.

4. **Run Phase 0 as shadow-mode eval, not a paper exercise.** Define metrics before data:
   - stake classifier false-negative rate
   - unanimous correctness
   - claim-level disagreement
   - decision-level disagreement
   - citation overlap/divergence
   - latency/quota/operator-attention cost

5. **Compress the canonical spec.** Target 25–30 KB. Keep invariants, schemas, routing rules, phase gates. Move vision, duplicate component descriptions, and aspirational modules to appendices.

6. **Defer these until after Kernel + evals are real:** Self-Improvement Lab, Doctrine Compiler, OpenClaw intercept, Long-Horizon Agenda Manager, Grok expansion, frontier primitive harvest beyond what directly informs Phase 0/1.

The highest-leverage next artifact is not more philosophy. It is: **`06-V3-CANONICAL-MINIMAL.md` + `authority-diff.schema.json` + Phase 0 metric definitions.**

---

## Lineage map

- [`00-DISCIPLINE.md`](00-DISCIPLINE.md) — discipline rule
- [`00-source-gemini-thread.md`](00-source-gemini-thread.md) — original Gemini Pro spec
- [`01-design-doc.DRAFT-single-voice-pending-fleet-adjudication.md`](01-design-doc.DRAFT-single-voice-pending-fleet-adjudication.md) — earlier single-voice synthesis (quarantined)
- [`02-fleet-adversarial-review.md`](02-fleet-adversarial-review.md) — Round 1 cross-fleet synthesis
- [`03-spec-v2-DRAFT-pending-fleet.md`](03-spec-v2-DRAFT-pending-fleet.md) — Round 2 v2.1 corrections
- [`04-extension-codex-components.md`](04-extension-codex-components.md) — Codex round-3: 15 component extensions
- [`frontier-lab-primitive-harvest.md`](frontier-lab-primitive-harvest.md) — Phase 0 primitive harvest
- [`05-CHUCK-V3-UNIFIED-DRAFT.md`](05-CHUCK-V3-UNIFIED-DRAFT.md) — unified draft (this artifact under review)
- [`05a-claude-code-critique-of-unified-draft.md`](05a-claude-code-critique-of-unified-draft.md) — Claude Code (Opus 4.7) critique that this response answers
- [`05b-codex-exec-response.md`](05b-codex-exec-response.md) — sibling Codex surface response (`codex exec`)
- **`05c-codex-review-response.md`** — this file
- [`05d-spec-patch-surface-as-first-class-field.md`](05d-spec-patch-surface-as-first-class-field.md) — spec patch landed from intra-family multi-surface signal in 05b vs 05c
