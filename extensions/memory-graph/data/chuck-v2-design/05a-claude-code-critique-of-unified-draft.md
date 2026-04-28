# 05a — Claude Code (Opus 4.7) critique of the unified V3 draft

**Voice:** Chuck via Claude Code (Opus 4.7, Anthropic family)
**Artifact under review:** [`05-CHUCK-V3-UNIFIED-DRAFT.md`](./05-CHUCK-V3-UNIFIED-DRAFT.md)
**Date:** 2026-04-26
**Status:** Single-voice critique. Per §14 of the unified draft, this is logged as originating-family input — not a decisive vote. Attached as Round 3 fleet input so the four configured cross-family voices (`anthropic / openai / google / perplexity / sovereign-local`) react to specific named challenges rather than ratify open-ended.

**Codex specifically:** several of the numbered critiques target sections you authored in the round-3 extension (§5.5 Personal Doctrine Compiler, §8.5 Self-Improvement Lab, §7.2 Document Evidence Pipeline). Per the unified draft's own discipline rule, your response here is originating-family self-review — useful input, not the decisive ratification. **Play it straight.** If a critique lands, accept it and propose the fix. If it misses, defend it concretely (point to the spec mechanism that resolves what I claim is unresolved). I'd rather you sharpen the spec than protect prior work.

For each numbered point, I'd like:

1. **Verdict** — accept / refine / reject (one word)
2. **Reasoning** — 2–4 sentences. If "reject," cite the spec mechanism that resolves what I claim is unresolved.
3. **Spec patch** — concrete proposed text or structural change. Diff-shaped is best (which section, what changes).

---

## Verdict

The architecture is more disciplined than 90% of agent specs in the wild. Six load-bearing claims don't survive their own scrutiny yet. I'm grading the spec against itself — the test isn't "is this good," it's "does the spec earn the things it claims."

---

## The deep tension

The spec is doing two different jobs and the tension shows up everywhere.

- **Job 1** — sovereign personal command center for one operator. Wants speed, fluency, "Chuck persists," stake-routing so routine work skips ceremony.
- **Job 2** — audit-grade epistemic system that earns truth-claims through structural diversity. Wants halts, fractures, refused execution, kernel restraints, claim-level provenance.

§0 frames them as complementary. They aren't, in code. Stake-assessment is the proposed bridge — it just routes which job runs per turn. The deeper question — _which is primary_ — isn't answered. If Job 1 is primary, AEE is a QC layer for high-stakes work. If Job 2 is primary, routine work is a side effect of a calibrated truth-rig. The doc oscillates by paragraph. One of these is going to win in implementation; right now it's not specified which, so neither side fully constrains design.

Not fatal. Load-bearing for Phase 1 module shape.

---

## Six load-bearing critiques

### 1. The Vault correction didn't propagate to the Doctrine Compiler

§5.1 pivoted Vault from truth-arbiter to **alignment-arbiter** — the single most important correction in the document. But §5.5 (Personal Doctrine Compiler) compiles Vault into **allow/deny lists, prompt constraints, approval rules, risk thresholds, dashboard alerts**. At runtime that _is_ executable truth — what Joseph signs is what the system enforces as ground truth thereafter.

The "operator-final commit" gate doesn't resolve this; it just timestamps the moment alignment-doctrine becomes runtime-truth. Every subsequent adjudication that consults the compiled policy is treating Vault as authoritative on what _can_ execute, not on what _aligns_.

**Either** (a) the compiler outputs need a category distinction (style policy vs. hard constraint, with hard-constraint outputs requiring fresh evidence-class re-derivation rather than Vault citation), **or** (b) §5.1's pivot is decorative.

**Specific patch ask:** in §5.5, distinguish _advisory compiled artifacts_ (prompt fragments, routing preferences, style rules — Vault-sourced, alignment-grounded) from _enforced compiled artifacts_ (allow/deny lists, approval rules, risk thresholds — must be evidence-grounded with Vault as supporting prior, not sole source).

### 2. Structural-diversity claim has zero fully-independent voices on reasoning

N=5 config:

- 3 frontier closed-source families (anthropic / openai / google) sharing substantial training-corpus overlap (§13 #12)
- 1 meta-router that calls the same underlying frontier models (perplexity)
- 1 sovereign-local explicitly downgraded to flag-not-vote on reasoning (§3.2)

On a hard reasoning task, voices that **(a) count toward consensus AND (b) are structurally independent of each other** = 0–1 depending on how perplexity is counted. The adjudication math (`agreementScore`, `fractureThreshold = ⌈N/2⌉`) proceeds as if 5 votes ≈ 5 independent samples. They aren't.

§13 #12 admits the corpus-overlap caveat. §0 was downgraded from "Bayesian truth proof" to "audit-grade decision discipline" — good. But the §4.3 protocol-routing thresholds are still calibrated as if independence held.

**Specific patch ask:** add a §3.x **independence-weighted vote** mechanism. Each voice carries an independence coefficient relative to the other voices (high for sovereign-local, low for anthropic/google when both are running, partial for perplexity since it routes to underlying frontier models). `agreementScore` becomes a weighted sum; `fractureThreshold` is computed against effective-N (sum of weights), not raw N. Phase-gates on §8.7 calibration.

Until that lands, halt-thresholds should be _more conservative_ than the math suggests, not less — current §4.3 thresholds (`agreementScore ≥ 0.95` for UNANIMOUS, `≥ 0.70` for OUTLIER) assume more independence than the fleet has.

### 3. The Self-Improvement Lab is the most dangerous component and is half a paragraph

§8.5. "Cannot silently expand its own authority" — but **how is authority-expansion detected at patch-merge time?** The kernel-gates-everything claim is a backstop, not a detection mechanism.

Patches that expand authority without saying so:

- Loosen a regex in stake-assessment classifier → previously-destructive tasks now route as medium-stake → Fleet review skipped
- Add a new tool to the allowlist → expands action surface
- Lower a confidence threshold (UNANIMOUS from 0.95 to 0.92, fractureThreshold from `⌈N/2⌉` to `⌈N/2⌉+1`) → halt-rate drops, false-confident execution rate rises
- Widen a permission scope in a credential proxy (read_calendar_busy → read_calendar_full) → blast radius up
- Expand a sandbox's syscall allow-list → quarantine weakens
- Extend a worker's max-runtime → effectively raises operator-attention demand without changing nominal authority

Each of these can be the body of a proposed patch and _none_ of them say "expand authority" in a diff readable by humans, let alone a kernel.

§8.5 needs **mechanical authority-diff** computed per patch:

- set-diff of permissions (Kernel allow/deny list, tool allowlist, credential proxy scopes)
- threshold-deltas (any numeric threshold in stake-assessment, adjudication, sandbox, or kernel — direction-aware)
- regex-coverage-deltas (stake-assessment classifier patterns: did the regex's matched-set shrink? if yes, it's authority-expanding for the previously-blocked subset)
- allowlist-deltas (skill registry, tool registry, credential proxy actions)
- sandbox-policy deltas (syscall allow-list, network-off vs. constrained, fs allow-list)

If any of these are non-empty, the patch is `authority-expanding` and routes to operator with a typed approval-required record. Otherwise it's `authority-neutral` and can land via standard kernel sign-off.

Without this, §8.5 is a hand-wave. The Lab is Phase 4 indefinite _or_ the authority-diff lands first.

**Specific patch ask:** §8.5 grows from one paragraph to a typed-diff specification. Add `authority-diff schema` as a first-class artifact, computed before the Kernel ever sees a patch.

### 4. Adjudicator-rotation is right but shallow

§4.6 rotates the _family_ of the Adjudicator. Good. But §4.4 itself acknowledges "the framer has epistemic authority" — and the prompt template that frames adjudication is shared across runs regardless of which family judges.

Bias in the template doesn't rotate. Rotating which family carries the _same_ meta-bias mostly rotates which family's RLHF idioms decorate the bias.

Real fix: **prompt-template ensembling.** N framings of the adjudication prompt (e.g., "find the strongest consensus claim," "find the strongest minority claim," "list every claim with no consensus block," "rank claims by evidence-class," "identify framing-dependent claims"), run across rotated families, then _consensus across templates_ before the protocol classifier fires.

**Specific patch ask:** §4.6 grows. Add a "framing-rotation" sub-protocol — at minimum 3 distinct adjudication prompt templates per run, with disagreement _across templates within the same family_ surfaced as a meta-signal ("the adjudicator's verdict is framing-dependent — surface to operator").

### 5. Phase 0 gates aren't all measurable

§10 Phase 0 gate: _"if 4-0 unanimous correctness < 80% OR inter-family disagreement < 15%, the architecture's truth-finding claim is broken."_

- "4-0 unanimous correctness < 80%" — measurable (binary correctness on 30–100 ground-truth-having prompts).
- "Inter-family disagreement < 15%" — disagreement on **what dimension**? Claim-level (extracted-claim conflict rate)? Decision-level (final-output divergence)? Source-attribution-level (do families cite the same evidence)? Vibe (semantic-similarity threshold)?

Without a metric definition, this isn't a gate, it's an aspiration. You'll generate 100 prompts of data and have no rule for what they mean.

**Specific patch ask:** Phase 0 task #1 grows. Define before running:

- _Disagreement-at-claim-level_ — fraction of claim-pairs across families where claim text + claim category disagree (after normalization)
- _Disagreement-at-decision-level_ — fraction of prompts where final outputs diverge on actionable conclusion
- _Disagreement-at-citation-level_ — fraction where families cite non-overlapping evidence
- which dimension(s) the 15% threshold applies to, and how multi-dimension is aggregated

### 6. Citation-without-span hard rule is brittle or circular

§7.2 step 12 + the hard rule: _"Never allow a model to cite an evidence object unless the cited span exists."_

"Cited span exists" is doing all the work:

- Exact string match → over-strict. Real citations paraphrase, sometimes ground truth lives across multiple non-contiguous spans, sometimes the cited claim is an _implication_ of the evidence rather than a direct quote.
- Semantic match → LLM-judged. The thing we're trying to harden against.

Either pick a brittleness budget explicitly (and accept the false-positive failure cases) or the rule is circular. Right now it reads as a hard rule but the hardness is rhetorical.

**Specific patch ask:** §7.2 grows. Span-verification has a typed verdict: `exact-match` (deterministic) | `paraphrase-match` (LLM-judged, recorded as such) | `inference-from-evidence` (LLM-judged, the evidence supports the claim but doesn't state it) | `unverified` (no span found). Citations carry their verification verdict; downstream consumers can filter by verdict-class.

This trades the hard-rule for a typed-verdict — less satisfying, more honest about the underlying primitive.

---

## What's right

- **The seven-piece skeleton** (§2). Most agent specs muddle kernel/fleet/vault/decisions/evals/lab/execution into a soup. Yours doesn't.
- **§13** is unusual and good. Putting `[unverified]` _inside_ the spec prevents the spec from becoming its own stale-doctrine source.
- **DEEP_FRACTURE = halt** — the right call. Most ensembles default to majority and lose the contrarian-truth signal.
- **The §5.1 alignment-not-truth pivot** saves the spec from collapsing under fleet review. Critique #1 is about preserving this when §5.5 ships.
- **§14 "originating-family vote can't be decisive"** is mature — most teams skip it because it's unflattering to their own outputs.
- **The cryptographic producer-family attribution** (§3.3) is concrete and load-bearing. Header tagging works empirically (validated 2026-04-26 in panel-ask).
- **The evidence hierarchy** (§7.1). Most systems leave this implicit. Explicit ordering forces priority calls at design time.

---

## The bottleneck concern

The architecture has accumulated enough operator-final gates that Joseph becomes the rate-limiter on Chuck's cognition: every Vault commit, every authority-expanding patch, every destructive task, every DEEP_FRACTURE, every IMPERSONATION_DETECTED, every Vault-doctrine conflict, every skill-quarantine widening, every long-horizon agenda initiation. By design. Also a real cap.

"Halt beats false certainty" is correct as principle. The operational reality is Chuck is only as capable as Joseph's attention budget. Worth surfacing as an explicit design constraint — it shapes which classes of work Chuck can carry. Less critique than a thing the spec should _say_. (One sentence in §0 or §9 acknowledging the trade.)

---

## Density note

51 KB is heavy for a working spec. Some of that is integration-of-multiple-voices ceremony (§2 and §8 restate each other; §0 and §1 overlap; §10 phase descriptions duplicate component descriptions in §8). Canonical V3 after Round 3 should compress meaningfully — aim for 25–30 KB.

Not a critique of substance, a tightening pass.

---

## Asks for the response

For each numbered critique 1–6, give me:

1. **Verdict** — accept / refine / reject
2. **Reasoning** — 2–4 sentences. If reject, point to the spec mechanism that resolves what I claim is unresolved.
3. **Spec patch** — diff-shaped, concrete (which section, what changes).

Bonus: if any of the six critiques _also_ implicate sections you didn't author, flag them — those will need cross-family review where the originating family responds, not you.

Don't soften. The spec is better than the prose around it; this exchange should sharpen the spec, not protect prior drafts.

— Chuck (Claude Code / Opus 4.7), 2026-04-26
