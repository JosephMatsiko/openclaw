# 05d — Spec Patch: Surface as a first-class field

**Status:** DRAFT spec patch, derived from intra-family multi-surface signal observed 2026-04-26.
**Target:** [`05-CHUCK-V3-UNIFIED-DRAFT.md`](05-CHUCK-V3-UNIFIED-DRAFT.md), to land in `06-V3-CANONICAL-MINIMAL.md`.
**Authored by:** Chuck (Claude Code / Opus 4.7), 2026-04-26 21:55 CDT.
**Empirical basis:** [`05b-codex-exec-response.md`](05b-codex-exec-response.md) and [`05c-codex-review-response.md`](05c-codex-review-response.md) — same prompt ([`05a-claude-code-critique-of-unified-draft.md`](05a-claude-code-critique-of-unified-draft.md)), same model (`gpt-5.5`), same OpenAI seat — fired through two different surfaces (`codex exec` vs `codex review`) ~30 minutes apart on the same day. Result: 100% verdict convergence on the six numbered critiques, ~30% framing divergence on substance. Single empirical observation, N=1 — patch is structurally motivated but not yet calibrated.

**Codex: this is the file you should read carefully.** It is exhaustive on purpose — pre-canonical V3 spec patch ready to fold into `06-V3-CANONICAL-MINIMAL.md`. Look for `### CHANGE` markers when scanning. Each `### CHANGE` block is self-contained (current state → proposed text) and applies to a specific V3 section.

---

## Table of contents

- [1. Verdict](#1-verdict)
- [2. Empirical evidence — `codex exec` vs `codex review` on 05a](#2-empirical-evidence)
- [3. The frame — what surface is, what it isn't](#3-the-frame)
- [4. CHANGE — V3 §3.1 Fleet config table adds `surface` column](#4-change-fleet-config)
- [5. CHANGE — V3 §3.x NEW: Surface taxonomy](#5-change-surface-taxonomy)
- [6. CHANGE — V3 §3.x NEW: Intra-family multi-surface dispatch protocol](#6-change-multi-surface-dispatch)
- [7. CHANGE — V3 §3.3 Producer-family attribution extends to producer-surface attribution](#7-change-producer-attribution)
- [8. CHANGE — V3 §4.3 Adjudication adds two-level convergence check](#8-change-two-level-convergence)
- [9. CHANGE — V3 §4.3 New protocol class: `INTRA_FAMILY_FRACTURE`](#9-change-intra-family-fracture)
- [10. CHANGE — V3 §4.6 Adjudicator rotation extends to three axes](#10-change-three-axis-rotation)
- [11. CHANGE — Decision Record schema additions](#11-change-decision-record)
- [12. Implementation impact in the apex codebase](#12-implementation-impact)
- [13. Worked examples](#13-worked-examples)
- [14. What this patch does NOT solve](#14-bounds)
- [15. Failure modes](#15-failure-modes)
- [16. Verification — how we'd know this is working](#16-verification)
- [17. Open questions](#17-open-questions)
- [18. CHANGE — V3 §13 Claims requiring evidence: new entries](#18-change-claims-requiring-evidence)
- [Lineage map](#lineage-map)

---

<a id="1-verdict"></a>

## 1. Verdict

**Surface and family are different dimensions and the V3 unified draft conflates them.** §3.3 (cryptographic producer-family attribution) signs the family that actually ran. It does not sign the surface. §4.3 (resolution protocols) computes consensus over family-keyed votes. It does not detect convergence-or-divergence within a family across multiple surfaces.

The 2026-04-26 codex/codex-review run is direct empirical evidence: same family, two surfaces, identical prompt, and the responses converged perfectly on direction (verdicts) while diverging substantially on framing (gap categories named, priorities, next-artifact recommendation). Under the current spec, both responses would attribute to `openai`, count as one openai-family vote, and the divergence in framing would be silently dropped from the alignment matrix.

**Patch:** add `surface` as a first-class voice attribute, add intra-family multi-surface dispatch as an explicit protocol, add `INTRA_FAMILY_FRACTURE` as a halt-eligible classification, extend Decision Records to record surface-level provenance, and rotate adjudication along three axes (family, surface, prompt template) instead of one.

The patch is **structural**, not numerical. It does not propose new threshold values. Phase 0 calibration sets the numbers.

---

<a id="2-empirical-evidence"></a>

## 2. Empirical evidence — `codex exec` vs `codex review` on 05a

Same prompt: [`05a-claude-code-critique-of-unified-draft.md`](05a-claude-code-critique-of-unified-draft.md) (14,355 chars, six numbered critiques + verdict-shaped asks).
Same model: `gpt-5.5`.
Same OAuth seat: Joseph's OpenAI Codex subscription.
Same binary: `/Applications/Codex.app/Contents/Resources/codex` (181 MB Mach-O).
Different argv mode: `codex exec --skip-git-repo-check` vs `codex review -` (with cwd pinned to the openclaw repo root).
Fired ~28 min apart through `apex-panel-ask.mjs`.

### 2.1 Quantitative

| Metric              |       `codex` (exec) |       `codex-review` |
| ------------------- | -------------------: | -------------------: |
| Output chars        |                3,229 |        6,240 (1.93×) |
| Latency (sec)       |                  137 |           99 (0.72×) |
| Density (chars/sec) |                 23.6 |         63.0 (2.67×) |
| Layer used          | primary, no fallback | primary, no fallback |

**The review-posture surface produced 1.93× the content in 0.72× the time. Density 2.67×.** This is not noise. The system prompt that ships with `codex review` is meaningfully different from the system prompt that ships with `codex exec`, and that difference shows up in output mass, latency, and shape.

### 2.2 Qualitative — verdict convergence (Level 1)

| #   | Critique                                             | `codex` (exec) | `codex-review` |
| --- | ---------------------------------------------------- | -------------- | -------------- |
| 1   | Doctrine Compiler doesn't propagate Vault correction | accept         | accept         |
| 2   | Independence math overcounts                         | refine         | refine         |
| 3   | Self-Improvement Lab underspecified                  | accept         | accept         |
| 4   | Adjudicator-rotation shallow                         | refine         | refine         |
| 5   | Phase 0 gates not measurable                         | accept         | accept         |
| 6   | Citation-without-span brittle/circular               | accept         | accept         |

**Six of six. 100% direction convergence. Zero rejections.** Strong intra-family signal that the six critiques are real architectural beams and not single-voice artifacts of Claude Code's framing.

### 2.3 Qualitative — framing divergence (Level 2)

The two surfaces converged on _what to do_ but diverged on _how to think about what's missing_.

**Where `codex` (exec) went deeper:**

- Cited specific frontier-competitor product URLs (Claude Code permission modes, LangGraph durable execution, OpenAI Agents SDK tracing, Google ADK evalsets). Outward-looking, harvest-ready.
- Five missing primitives, all benchmarked against existing open competitor docs.

**Where `codex-review` went deeper:**

- Surfaced fragility categories `codex` (exec) missed entirely: operator attention as a fragility, consumer-surface automation churn, spec mass as self-imposed problem.
- Refines on critiques #2 and #4 came with direction (`codex` exec: bare "refine" labels; `codex-review`: "use conservative effective-N now; empirical correlation later" and "template ensembling for high-stakes/fracture cases, not every trivial run").
- Nine missing primitives, all architecture-internal: shadow-mode calibration, authority-diff schema, approval UX, policy DSL, prompt versioning, memory-poisoning defenses, incident review loop, budget governor, minimal vertical slice. Inward-looking, build-ready.
- Explicit deferral list: Self-Improvement Lab, Doctrine Compiler, OpenClaw intercept, Long-Horizon Agenda, Grok expansion, frontier harvest beyond Phase 0.
- Concrete next artifact named: `06-V3-CANONICAL-MINIMAL.md + authority-diff.schema.json + Phase 0 metric definitions`.

**Both contributions are real and neither is subsumed by the other.** Combined they cover more ground than either alone. Under the current V3 spec, the `codex-review` deeper-refines on #2 and #4, the operator-attention fragility surfacing, and the deferral list would be silently dropped (since both responses count as one openai vote and the alignment matrix would only show their _intersection_).

### 2.4 What this proves and doesn't

**Proves (one observation, N=1):** identical input through two surfaces of the same model produces verdicts that converge AND framing that diverges. The architecture currently captures the convergence implicitly (both vote `openai`) and discards the divergence entirely. Both halves are signal.

**Does not yet prove:** that this pattern generalizes; that intra-family divergence is a useful halt-eligible signal at scale; that the cost of multi-surface dispatch (extra latency + extra quota) is justified for non-trivial classes of work. **Phase 0 calibration must include a multi-surface-dispatch eval to validate.**

---

<a id="3-the-frame"></a>

## 3. The frame — what `surface` is, what it isn't

### 3.1 Definitions

**Family** — the vendor / org / training-corpus origin of the model weights. Examples: `anthropic`, `openai`, `google`, `xai`, `perplexity` (meta-router family), `sovereign-local`. Family is the unit V3 §3.3 currently signs at the runner boundary. Family captures _who trained the weights_ and _whose RLHF/policy shaped them_.

**Surface** — the concrete invocation pathway through which the model weights are addressed: which binary, which subcommand, which app GUI, which web URL, which API endpoint, which system prompt that ships with the surface. Examples for the `openai` family: `codex-cli` (`codex exec`), `codex-review` (`codex review`), `chatgpt-mac` (Mac-app GUI), `chatgpt-web` (chatgpt.com web chat). Surface captures _what wrapper sits between the prompt and the weights_.

**Same family, different surface = same weights, different framing.** The differences come from system prompts, tool affordances, conversation-history priming, sampling defaults, reasoning-budget defaults, and any post-processing the surface applies before the user sees the output.

### 3.2 Why this matters for adjudication

V3 §3.3 says the family that _actually_ ran is what gets counted. Cryptographic, not statistical. Good. But two openai-surface responses are not "the same response," and treating them as one vote loses real signal:

1. **Convergence across surfaces of the same family** is a _stronger_ signal than a single-surface family vote, because it shows the direction is robust to system-prompt and surface-bias variation. The §3.3 invariant currently can't express this.
2. **Divergence across surfaces of the same family** is a _halt-eligible_ signal — something in the framing of one surface caused the model to reach a different conclusion than the other surface using the same weights. That's exactly the kind of thing operator review wants surfaced.
3. **Framing divergence on identical verdicts** — what we observed in 2026-04-26 — is _neutral_: the direction is robust, but each surface contributed unique substance. Both contributions should land in the alignment matrix; the framing differences should be logged but not halt.

### 3.3 What surface is NOT

- Surface is not a substitute for family. Two surfaces of the same family are still corpus-correlated and policy-correlated. Adding surfaces does not increase structural-diversity in the §3.2 sense.
- Surface is not a substitute for prompt-template rotation. Surface differences come from the surface's _baked-in_ system prompt; template differences come from the _adjudicator's_ prompt that wraps the surface call.
- Surface is not a free-cost addition. Multi-surface dispatch multiplies latency (in parallel: ~max latency; in serial: sum) and quota draw. Routing rules (§6 below) decide when it's worth firing.

---

<a id="4-change-fleet-config"></a>

## 4. CHANGE — V3 §3.1 Fleet config table adds `surface` column

### Current state (V3 §3.1 table)

```
| Family       | Voice         | Surface                              | Rationale |
|--------------|---------------|--------------------------------------|-----------|
| anthropic    | claude-cli    | Opus 4.7 CLI                         | ...       |
| openai       | chatgpt-web   | Mac-app primary, web fallback        | ...       |
| google       | gemini-cli    | Gemini 3.1 Pro CLI                   | ...       |
| ...          | ...           | ...                                  | ...       |
```

The current table already has a `Surface` column, but it is treated as descriptive narrative — it does not feed adjudication. The voice key (`claude-cli`, `chatgpt-web`, etc.) is informally surface-specific, but the consensus math operates over the family field.

### Proposed change

Promote `surface` to a first-class typed field per voice entry, with stable IDs that match the cryptographic attribution path (§7 below). Voice entries become tuples `(voiceId, family, surface, rationale)` where `voiceId` is the human-readable name, `family` is the corpus/policy origin, and `surface` is the invocation pathway.

```
| voiceId         | family            | surface                          | rationale |
|-----------------|-------------------|----------------------------------|-----------|
| claude-cli      | anthropic         | claude-cli/exec                  | ...       |
| claude-ai       | anthropic         | claude-ai/web-chat               | ...       |
| chatgpt-mac     | openai            | chatgpt/mac-app                  | ...       |
| chatgpt-web     | openai            | chatgpt/web-chat                 | ...       |
| codex           | openai            | codex/exec                       | ...       |
| codex-review    | openai            | codex/review                     | ...       |
| gemini-cli      | google            | gemini/cli                       | ...       |
| gemini-web      | google            | gemini/web-chat                  | ...       |
| gemini-studio   | google            | gemini/aistudio                  | ...       |
| perplexity-mac  | perplexity        | perplexity/mac-app-incognito     | ...       |
| ollama-local    | sovereign-local   | ollama/llama-3.1-8b              | ...       |
```

Surface IDs follow the convention `<surface-family>/<surface-mode>`. The surface-family prefix may equal the family (`gemini/...`) or may differ (`codex/...` for the openai family). The `mode` portion captures the actual invocation path.

Load-time validation (extends V3 §3.5 config rules):

- **Duplicate `(family, surface)` tuples are rejected** — two voice entries cannot share both family and surface (that's a config error).
- **Duplicate surface across families is permitted** in principle but currently not used.
- **Missing surface is rejected** — every voice must declare its surface; no surface-anonymous voice can join the fleet.
- **Rationale required** — unchanged from current rule.

---

<a id="5-change-surface-taxonomy"></a>

## 5. CHANGE — V3 §3.x NEW: Surface taxonomy

Add a new subsection between §3.1 (fleet config) and §3.2 (capability-aware routing).

### §3.1.1 Surface taxonomy (NEW)

Surfaces fall into typed classes based on what mediates the prompt → weights call. The class determines latency expectations, fragility profile, attribution rules, and routing eligibility.

| Class               | Examples                                                                                            | Latency                | Fragility                                                                   | Attribution path                        |
| ------------------- | --------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| **CLI-headless**    | `codex/exec`, `codex/review`, `claude-cli/exec`, `gemini/cli`                                       | low (1–3 min)          | low — owned binary, stable argv                                             | binary path + argv signature            |
| **CLI-interactive** | `codex` (REPL), `claude` (REPL)                                                                     | low                    | low                                                                         | session id + binary path                |
| **Mac-app GUI**     | `chatgpt/mac-app`, `claude-ai/mac-app`, `perplexity/mac-app-incognito`, `codex/mac-app` (potential) | medium (3–8 min)       | medium — accessibility tree, cliclick coords, app updates churn UI          | bundle id + window id + AX path         |
| **Web-chat GUI**    | `chatgpt/web-chat`, `claude-ai/web-chat`, `gemini/web-chat`, `gemini/aistudio`                      | medium-high (5–15 min) | high — Cloudflare/Turnstile, cookie expiry, account switching, layout drift | URL + profile dir + session cookie hash |
| **MCP-stdio**       | `codex/mcp-server`, hypothetical `claude/mcp-server`                                                | low                    | low — bidirectional stdio frame                                             | server pid + stdio fd pair              |
| **Local-model**     | `ollama/llama-3.1-8b`, `ollama/qwen-3-32b`                                                          | medium-low             | very low — sovereign                                                        | local socket + model id                 |

For each class, surface attribution carries:

- A **canonical surface ID** (string) — the `<surface-family>/<surface-mode>` form from §3.1.
- An **attribution path** — the runtime signal that proves which surface ran (binary path, bundle id, session cookie hash, etc.).
- A **fragility class** (low / medium / high / very-low) — feeds routing rules.

Surface taxonomy is **operator-extensible**: adding a new surface class requires (a) a new entry in this table with rationale, (b) a runner implementation that emits the right attribution path, and (c) Phase 0 sanity-check on at least 5 representative prompts.

### §3.1.2 Surface stability commitments (NEW)

Surfaces are **named at the level of stability we control**, not at the level of granularity we observe.

- `codex/review` is a stable surface name even though OpenAI may change `codex review`'s system prompt without notifying us. Surface name = what we ship; surface behavior = empirical.
- A surface whose system prompt changes meaningfully should be **versioned** in the alignment matrix (`codex/review@2026-04`), not silently re-treated as the same surface. Phase 0 includes a "surface drift detector" that flags when a surface's empirical behavior on a calibration suite diverges by > X% from the previous calibration. (X is set in Phase 0.)
- Surfaces NOT under our control (web-chat layouts, app updates) carry a `surfaceDrift: high` flag in their voice config. Routing penalizes high-drift surfaces for high-stakes work.

---

<a id="6-change-multi-surface-dispatch"></a>

## 6. CHANGE — V3 §3.x NEW: Intra-family multi-surface dispatch protocol

Add a new subsection in §3, immediately after §3.4 (degraded-fleet protocols).

### §3.5 Intra-family multi-surface dispatch (NEW)

Multi-surface dispatch fires more than one surface of the _same_ family on the _same_ prompt, and treats the resulting responses as a typed cluster ("the openai cluster") rather than as independent votes.

#### When multi-surface fires

Per task class (extends V3 §4.1 stake assessment):

| Stake class     | Multi-surface dispatch policy                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Trivial         | Single voice, single surface. Bypass cluster math.                                                                        |
| Medium          | Optional. Default off. Operator can enable per-task with `--multi-surface`.                                               |
| **High**        | **Default on for at least one family.** The family is rotated round-robin per run (next §10 axis).                        |
| **Destructive** | **Default on for every family that has ≥ 2 surfaces available.** Halt rules (§4.5) escalate on any intra-family fracture. |

When multi-surface is on, the dispatcher selects 2 (or more, configurable) surfaces from the same family. Default selection rule: **lowest-fragility surface + highest-stability-different-system-prompt surface**. For openai today: `codex/exec` (CLI-headless, low fragility) + `codex/review` (CLI-headless, low fragility, distinct system prompt). For anthropic today: `claude-cli/exec` (CLI-headless) + `claude-ai/web-chat` (web-chat, but only if available; otherwise skip multi-surface for anthropic this run).

#### Counting in adjudication

When the cluster includes K surfaces of family F with K ≥ 2:

- **Verdict-level (Level 1):** the family votes once per family-cluster, where the cluster's vote is determined by intra-cluster verdict consensus. If all K surfaces agree on a verdict, that's the family vote. If they disagree, see §9.
- **Claim-level (Level 2):** every claim from every surface enters the alignment matrix tagged with both `family` and `surface`. Claims that appear across surfaces of the same family carry `intraFamilyConsensus: true`. Claims that appear in only one surface carry `intraFamilyUnique: <surfaceId>`. Both classes are first-class inputs to cross-family adjudication.

#### Why claims-yes verdict-no

The 2026-04-26 codex/codex-review run: same verdict, different framing. The `codex-review` operator-attention-as-fragility claim, the deferral list, the concrete next-artifact recommendation — none of these were in the `codex` exec response. Counting both surfaces' claims (Level 2) lets these contributions enter the cross-family alignment matrix. Counting only the verdict (Level 1, family vote) keeps adjudication math from being inflated by intra-family corpus correlation.

#### Cost / quota policy

Multi-surface dispatch ~doubles per-task quota draw on the targeted family. The §10 budget governor (Codex round-3 finding, 05c response) gates multi-surface as a budget item:

- Trivial / medium tasks: never multi-surface (bypass).
- High tasks: multi-surface enabled subject to monthly quota budget per family.
- Destructive tasks: multi-surface enabled regardless of budget — operator pays the quota for safety.

If a family's quota is exhausted, multi-surface degrades to single-surface for that family in the current run, logged in Decision Record as `multiSurfaceDegraded: <family>`.

---

<a id="7-change-producer-attribution"></a>

## 7. CHANGE — V3 §3.3 Producer-family attribution → producer-surface attribution

### Current state (V3 §3.3)

> Attribution is **signed at the runner/orchestrator boundary** with HMAC keyed to a per-session orchestrator secret. Signing record carries: actual binary path, transcript path on disk, invocation timestamp, exit status, parent process tree.

### Proposed change

The signed attestation carries `family` AND `surface` AND `surfaceVersion` AND `surfaceDriftFlag` as separate fields. Output-file headers (the human-readable form) become:

```
Voice-Requested: codex (Codex-CLI)
Voice-Surface: codex/exec
Voice-Surface-Version: 0.125.0-alpha.3              # detected from runner output
Voice-Surface-Drift: low                            # from §3.1.2 stability table
Producer-Family: openai
Producer-Surface: codex/exec                        # NEW — duplicates Voice-Surface UNLESS impersonation cascade fired
Producer-Family-Mismatch: false                     # NEW — replaces "Impersonation: false"
Producer-Surface-Mismatch: false                    # NEW
Model: codex/gpt-5.5
Layer used: primary (codex/exec)
```

`Producer-Family-Mismatch` and `Producer-Surface-Mismatch` are **typed mismatch signals**. Mismatch means: the surface that was requested is not the surface that ran, OR the family that was requested is not the family that ran. Mismatch causes the V3 §4.3 `IMPERSONATION_DETECTED` halt classification (rename to `ATTRIBUTION_MISMATCH` for accuracy — impersonation is one type of mismatch, but surface-level mismatch is a different and equally-haltable case).

The cryptographic signing record extends from family-only to family + surface. Verification at adjudication time becomes a tuple-match, not a scalar-match.

---

<a id="8-change-two-level-convergence"></a>

## 8. CHANGE — V3 §4.3 Adjudication adds two-level convergence check

### Current state (V3 §4.3)

V3 §4.3 has a single-level convergence check based on `agreementScore` over voice claims, with `fractureThreshold = ⌈N/2⌉ for N≥4` driving classification (UNANIMOUS / OUTLIER / DEEP_FRACTURE / FRAGMENT / IMPERSONATION_DETECTED / INCOMPLETE).

### Proposed change

Replace the single-level check with a two-level check **whenever any family contributes ≥ 2 surfaces** (i.e. multi-surface dispatch is on for that family).

**Level 1 — Verdict consensus across families.** Each family contributes one verdict-level vote (computed via §9 below from its surface-cluster). Cross-family `agreementScore`, `fractureThreshold`, and protocol classification work exactly as today, just over family-votes rather than voice-votes.

**Level 2 — Claim consensus across all surfaces of all families.** Every claim, tagged with `(family, surface)`, enters the alignment matrix. The matrix exposes:

- `crossFamilyConsensus` — claims appearing in ≥ 2 families
- `intraFamilyConsensus` — claims appearing in ≥ 2 surfaces of one family but no others
- `singleSurfaceUnique` — claims appearing in exactly one surface

Decision Records at the verdict-level use Level 1 outputs. Decision Records at the claim-level use Level 2 outputs. Phase 4 reporting and Long-Horizon Agenda use both.

### Pseudocode

```
function adjudicate(voiceResponses):
  # group by family
  byFamily = groupBy(voiceResponses, r => r.attribution.family)

  # Level 1 — verdict-level family votes
  familyVotes = {}
  intraFamilyFractures = []
  for family, surfaceResponses in byFamily:
    verdict, fractureSignal = collapseSurfaceCluster(surfaceResponses)
    if fractureSignal == 'INTRA_FAMILY_FRACTURE':
      intraFamilyFractures.push({family, surfaceResponses})
    familyVotes[family] = verdict

  # Level 2 — claim-level alignment matrix across ALL surfaces
  allClaims = flatten(voiceResponses.map(extractClaims))
  alignmentMatrix = buildAlignmentMatrix(allClaims, tagBy=['family', 'surface'])

  # Classification
  if intraFamilyFractures.length > 0:
    return classify('INTRA_FAMILY_FRACTURE', {fractures: intraFamilyFractures, matrix: alignmentMatrix})

  crossFamilyScore = computeAgreementScore(familyVotes)
  return classifyByThresholds(crossFamilyScore, alignmentMatrix)
```

`collapseSurfaceCluster` is defined in §9.

---

<a id="9-change-intra-family-fracture"></a>

## 9. CHANGE — V3 §4.3 New protocol class: `INTRA_FAMILY_FRACTURE`

Add to the protocol classification table in V3 §4.3.

| Protocol                | Trigger                                                                                                                                                                  | Trust signal                                                                                                                                        | Action                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INTRA_FAMILY_FRACTURE` | Within a single family's surface cluster, surfaces produce **opposing verdicts** (one says "accept," another says "reject" — not framing divergence on a shared verdict) | Zero — within-family disagreement under same weights signals framing-dependent reasoning that should be inspected before any cross-family math runs | Halt before Level 1 family-vote is computed. Surface to operator with: the prompt, every surface's full response, the specific claims that diverge in verdict, and a recommendation of which surface's environment to inspect (system prompt, conversation history, sampling config). Cross-family adjudication does not proceed until operator resolves. |

### `collapseSurfaceCluster` definition

```
function collapseSurfaceCluster(surfaceResponses):
  # K = surfaceResponses.length
  # If K == 1, no cluster — return the single surface's verdict, no fracture.
  if surfaceResponses.length == 1:
    return (surfaceResponses[0].verdict, null)

  verdicts = surfaceResponses.map(r => r.verdict)

  # If all verdicts agree, family votes that verdict.
  if allEqual(verdicts):
    return (verdicts[0], null)

  # Verdicts disagree within the family. Categorize:
  if verdictsAreOpposing(verdicts):  # "accept" vs "reject" — direction-opposing
    return (null, 'INTRA_FAMILY_FRACTURE')

  # Verdicts are not opposing but not identical — e.g. {"accept", "refine"}.
  # This is a "soft fracture" — direction is compatible, but specificity differs.
  # Do NOT halt; record the soft fracture and let operator review it during
  # standard Decision Record review, but proceed with the most-conservative
  # verdict as the family vote.
  return (mostConservative(verdicts), 'INTRA_FAMILY_SOFT_FRACTURE')
```

### Examples of intra-family fracture vs soft fracture vs no fracture

| Surface A verdict | Surface B verdict | Classification            | Action                                            |
| ----------------- | ----------------- | ------------------------- | ------------------------------------------------- |
| accept            | accept            | no fracture               | family votes "accept"                             |
| accept            | refine            | soft fracture             | family votes "refine" (more conservative); logged |
| refine            | reject            | soft fracture             | family votes "reject" (more conservative); logged |
| accept            | reject            | **INTRA_FAMILY_FRACTURE** | **halt; operator inspects**                       |

`mostConservative` ordering for verdicts: `reject > halt > refine > accept`. Intuition: the more action-restraining verdict is the safer family-vote when surfaces disagree non-oppositionally.

### Why opposing-verdict halts but soft-fracture continues

Opposing verdicts (accept ↔ reject) under the same weights mean **framing alone flipped the model's direction**. That's not a routine inter-prompt-template difference; that's a strong signal that surface-system-prompt or surface-conversation-state caused the model to reach a directionally-incompatible conclusion. Operator should know.

Soft fractures (accept ↔ refine) under the same weights mean **framing produced different specificity**. That's expected and useful — the more-specific surface's contribution lands in Level 2 claim alignment. No halt needed; the family-vote uses the conservative side and the alignment matrix preserves the specificity.

---

<a id="10-change-three-axis-rotation"></a>

## 10. CHANGE — V3 §4.6 Adjudicator rotation extends to three axes

### Current state (V3 §4.6)

V3 §4.6 rotates the _family_ of the Adjudicator per run. Round-robin, pinned to whichever family was least-represented in the producer set.

### Proposed change

Rotate along three axes per run, not one. Each axis is rotated independently (round-robin within axis):

1. **Family** (existing) — which family runs the Adjudicator's claim-extraction + protocol-routing call. Round-robin pinned to least-represented family in the producer set.
2. **Surface** (NEW) — within the chosen family, which surface is used. Round-robin within the family's available surfaces, weighted by surface-stability (low-drift surfaces preferred for adjudication).
3. **Prompt template** (NEW — partial overlap with critique #4 of 05a) — which framing of the adjudication prompt is used. Round-robin from a curated bank of N templates (initial N=3, expandable). Templates emphasize different facets: claim-by-claim extraction, framing-dependence detection, evidence-class ranking.

### Why three axes

- Family rotation alone (current) addresses cross-family meta-bias.
- Surface rotation addresses **same-family system-prompt bias** that the empirical 2026-04-26 run exposed.
- Template rotation addresses **adjudication-framer bias** that V3 §4.4 acknowledges ("the framer has epistemic authority") but the spec currently does nothing about.

For high-stakes runs, all three rotate simultaneously. For trivial runs, no rotation (single-voice bypass). For medium runs, family + template rotate; surface stays at the default for the chosen family.

### Anti-collusion: rotation independence

Family, surface, and template rotation **must be independent** — they cannot be coupled into a single round-robin pointer or the rotation degenerates back to one axis. Each axis maintains its own rotation pointer and increments per high-stakes run. Implementation note: the rotation pointers go in `~/.openclaw/state/apex-adjudicator-rotation.json` (or equivalent post-migration `~/.chuck/state/`).

### Logging in Decision Record

Every Decision Record from a run with rotation enabled carries:

```
Adjudicator: {family: "google", surface: "gemini/cli", template: "framing-dependence-v2"}
RotationPointers: {family: 3, surface: 0, template: 2}
```

Operator can audit meta-bias drift by querying the Decision Record corpus over time.

---

<a id="11-change-decision-record"></a>

## 11. CHANGE — Decision Record schema additions

V3 §8.3 (Decision Record Corpus) currently specifies: `voice, family, layer, model, prompt-hash, output-hash, alignment-matrix-hash, evidence-cited, vault-doctrine-cited, confidence-labels, signed runner attestation`.

### Additions

```
{
  ...existing fields...,
  surface: "codex/exec",
  surfaceVersion: "0.125.0-alpha.3",
  surfaceDriftFlag: "low",
  multiSurfaceDispatch: true,
  multiSurfaceCluster: [
    {voiceId: "codex", surface: "codex/exec", outputHash: "..."},
    {voiceId: "codex-review", surface: "codex/review", outputHash: "..."}
  ],
  intraFamilyFracture: false,
  intraFamilySoftFracture: false,
  intraFamilyConvergedVerdicts: ["accept", "refine", "accept", "refine", "accept", "accept"],
  intraFamilyUniqueClaims: [
    {family: "openai", surface: "codex/review", claimText: "operator-attention as fragility category", ...}
  ],
  adjudicatorAxes: {
    family: "google",
    surface: "gemini/cli",
    template: "framing-dependence-v2"
  },
  rotationPointers: {family: 3, surface: 0, template: 2},
  budgetCharged: {openai: 2, anthropic: 1, google: 1, perplexity: 1, sovereign: 1},
  multiSurfaceDegraded: []
}
```

`intraFamilyUniqueClaims` is the field that prevents the codex-review-only contributions from being silently dropped. Every claim that appeared in only one surface of a family lands there with full attribution.

### Replay-ability

Decision Records remain replayable: signed runner attestation now signs `(family, surface)` instead of `family` only, so the actual surface used can be cryptographically verified at any future review.

---

<a id="12-implementation-impact"></a>

## 12. Implementation impact in the apex codebase

### Files that change

| File                                                           | Change                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/memory-graph/scripts/apex-panel-ask.mjs`           | `VOICES` entries gain a `surface` field. `inferProducerFamily` extends to `inferProducerAttribution` returning `{family, surface, ...mismatch flags}`. The `LAYER_TO_FAMILY` and `NOMINAL_VOICE_FAMILY` maps split into `LAYER_TO_FAMILY` + `LAYER_TO_SURFACE` and `NOMINAL_VOICE_FAMILY` + `NOMINAL_VOICE_SURFACE`. |
| `extensions/memory-graph/scripts/apex-nplex-adjudicate.mjs`    | Two-level convergence check replaces single-level. `collapseSurfaceCluster` lives here. `INTRA_FAMILY_FRACTURE` classification added. Three-axis rotation reads from `apex-adjudicator-rotation.json`.                                                                                                               |
| `extensions/memory-graph/scripts/apex-dispatch.mjs`            | Multi-surface dispatch policy per stake class. Budget-governor integration for multi-surface cost.                                                                                                                                                                                                                   |
| `extensions/memory-graph/data/apex-fleet.json`                 | Voice entries gain `surface` field with stable IDs. Existing entries keyed by voiceId map cleanly: `codex` → `codex/exec`, `codex-review` → `codex/review`, etc.                                                                                                                                                     |
| `extensions/memory-graph/state/apex-adjudicator-rotation.json` | New file. Three independent rotation pointers.                                                                                                                                                                                                                                                                       |
| `extensions/memory-graph/state/apex-decision-records/*.json`   | Schema bumps for new fields (additive — old records remain readable).                                                                                                                                                                                                                                                |
| `extensions/memory-graph/scripts/apex-event-bus.mjs`           | Bus events for `multi-surface.dispatch.fired`, `intra-family.fracture.detected`, `adjudicator.rotation.advanced`.                                                                                                                                                                                                    |

### Sequencing

1. Land `surface` field in `apex-panel-ask.mjs` VOICES (additive — backward compatible if existing scripts only read `family`). **Done in `codex-review` voice landing 2026-04-26 21:41 CDT.** Other voices need backfill.
2. Land `LAYER_TO_SURFACE` and `NOMINAL_VOICE_SURFACE` maps. Land `inferProducerAttribution`.
3. Land output-file header changes (`Voice-Surface`, `Producer-Surface`, etc.).
4. Land `apex-decision-records/` schema additions (schema-versioned).
5. Land `collapseSurfaceCluster` and `INTRA_FAMILY_FRACTURE` in `apex-nplex-adjudicate.mjs`.
6. Land multi-surface dispatch policy in `apex-dispatch.mjs` (gated on stake class + budget).
7. Land three-axis rotation. (Family axis already exists; add surface + template axes.)
8. Phase 0 calibration suite includes multi-surface eval (validates §6 routing rules).

Steps 1–4 are mechanical. Steps 5–7 are the substantive logic. Step 8 is the empirical validation gate.

### What's already shipped

As of 2026-04-26 21:41 CDT, `codex-review` voice exists in `apex-panel-ask.mjs` with `surface: "codex/review"`-equivalent semantics carried in the existing `modelName` field. The wiring is the embryo of this patch — single voice with a distinct surface, parallel to the existing `codex` voice.

---

<a id="13-worked-examples"></a>

## 13. Worked examples

### 13.1 The actual 2026-04-26 codex/codex-review run, retrofitted

**Inputs:** prompt = 05a, fleet config includes `codex` (surface `codex/exec`) and `codex-review` (surface `codex/review`), both family=`openai`.

**Multi-surface dispatch:** ON (high-stakes — V3 architectural decision). Cluster fired: `[codex, codex-review]`.

**Surface-cluster collapse (`collapseSurfaceCluster`):**

- Verdicts on critique #1: ["accept", "accept"] → no fracture, family votes "accept"
- Verdicts on critique #2: ["refine", "refine"] → no fracture, family votes "refine"
- Verdicts on critiques #3, #4, #5, #6: all converged
- Result: openai-family vote is the per-critique verdict vector `["accept","refine","accept","refine","accept","accept"]`. Zero intra-family fractures.

**Level 2 claim alignment (illustrative subset):**

| Claim                                                   | codex/exec | codex/review | classification                    |
| ------------------------------------------------------- | :--------: | :----------: | --------------------------------- |
| "Doctrine Compiler accept verdict #1"                   |     ✓      |      ✓       | intraFamilyConsensus(openai)      |
| "Self-Improvement Lab accept verdict #3"                |     ✓      |      ✓       | intraFamilyConsensus(openai)      |
| "Five frontier-competitor missing primitives with URLs" |     ✓      |      ✗       | singleSurfaceUnique(codex/exec)   |
| "Operator-attention as fragility category"              |     ✗      |      ✓       | singleSurfaceUnique(codex/review) |
| "Defer Lab + Compiler + intercept + Long-Horizon"       |     ✗      |      ✓       | singleSurfaceUnique(codex/review) |
| "06-V3-CANONICAL-MINIMAL.md as next artifact"           |     ✗      |      ✓       | singleSurfaceUnique(codex/review) |
| "Move durable workflow + observability into Phase 1/2"  |     ✓      |      ✗       | singleSurfaceUnique(codex/exec)   |
| "Compress to 25–30 KB"                                  |     ✓      |      ✓       | intraFamilyConsensus(openai)      |

**Decision Record summary:**

```json
{
  "stakeClass": "high",
  "multiSurfaceDispatch": true,
  "multiSurfaceCluster": [
    { "voiceId": "codex", "surface": "codex/exec", "outputHash": "..." },
    { "voiceId": "codex-review", "surface": "codex/review", "outputHash": "..." }
  ],
  "intraFamilyFracture": false,
  "intraFamilySoftFracture": false,
  "intraFamilyConvergedVerdicts": ["accept", "refine", "accept", "refine", "accept", "accept"],
  "intraFamilyUniqueClaims": [
    {
      "family": "openai",
      "surface": "codex/exec",
      "claimText": "five frontier-competitor missing primitives with URLs"
    },
    {
      "family": "openai",
      "surface": "codex/review",
      "claimText": "operator-attention as fragility"
    },
    {
      "family": "openai",
      "surface": "codex/review",
      "claimText": "deferral list (Lab/Compiler/intercept/etc.)"
    },
    {
      "family": "openai",
      "surface": "codex/review",
      "claimText": "06-V3-CANONICAL-MINIMAL.md next artifact"
    }
  ],
  "budgetCharged": { "openai": 2, "anthropic": 0, "google": 0, "perplexity": 0, "sovereign": 0 }
}
```

Six unique claims preserved — three from each surface — that the current spec would have silently dropped from the alignment matrix.

### 13.2 Hypothetical INTRA_FAMILY_FRACTURE

**Inputs:** prompt = "should we deploy this auth-middleware change?", fleet config includes `chatgpt-mac` and `codex/review`, both family=`openai`.

- `chatgpt-mac` says: "yes, ship it — the change is safe" (verdict: accept)
- `codex/review` says: "do not ship — the diff has a session-token leak on line 47" (verdict: reject)

**Surface-cluster collapse:** verdicts are opposing (accept vs reject). `INTRA_FAMILY_FRACTURE` triggered. Cross-family adjudication does NOT proceed.

**Operator surfacing:** prompt + both responses + diff between the two claims + recommendation: "the codex/review surface had access to repo-grounded evidence (line 47 of the diff). The chatgpt-mac surface did not see the diff. Inspect whether the system-prompt difference between the two surfaces is a function of tool affordance, not reasoning."

**Resolution paths:**

- Operator confirms codex/review's read → `chatgpt-mac` is voted out for this run, openai votes "reject," cross-family adjudication proceeds.
- Operator confirms `chatgpt-mac`'s read → `codex/review` is voted out, openai votes "accept," cross-family adjudication proceeds. (Unlikely given the evidence asymmetry but operator-final.)
- Operator escalates to manual review → halt persists.

### 13.3 Hypothetical multi-family multi-surface run

**Inputs:** prompt = "review V3 spec," stake = high, fleet config includes 5 families with multi-surface available for openai (codex, codex-review) and anthropic (claude-cli, claude-ai).

**Cluster fires:**

- openai: [codex/exec, codex/review]
- anthropic: [claude-cli/exec, claude-ai/web-chat]
- google: [gemini/cli] (single-surface, no multi-surface for google this run)
- perplexity: [perplexity/mac-app-incognito] (single-surface, meta-router family)
- sovereign-local: [ollama/llama-3.1-8b] (single-surface)

**Level 1 family votes computed via `collapseSurfaceCluster` for openai and anthropic.** Single-surface families pass through.

**Level 2 alignment matrix has every claim from 7 surfaces tagged with both family + surface.**

**Adjudicator rotation:** family=`google` (least-represented in producer set), surface=`gemini/aistudio`, template=`evidence-class-ranking-v1`.

**Cross-family agreement score, fracture threshold, classification** all proceed as today over the 5 family-votes.

**Decision Record carries everything:** 7 attestations, 2 surface clusters, 1 alignment matrix, 1 protocol classification, all 3 adjudicator axes.

---

<a id="14-bounds"></a>

## 14. What this patch does NOT solve

- **Cross-family corpus correlation.** Same-surface or multi-surface, frontier families still share substantial training-corpus overlap (V3 §13 #12). Surface-as-first-class addresses _intra-family_ signal; it does not increase _inter-family_ independence. Critique #2 of 05a stands and is not subsumed by this patch.
- **The adjudicator-prompt-template-bias problem.** §10 here adds template rotation, but template ensembling (multiple templates per single run, consensus across templates) is still unbuilt. That's a follow-up patch, not this one.
- **The Doctrine Compiler / executable-truth tension.** Critique #1 of 05a is unresolved. This patch is orthogonal.
- **The Self-Improvement Lab authority-diff requirement.** Critique #3 of 05a is unresolved. This patch is orthogonal.
- **The Phase 0 metric definitions.** Critique #5 of 05a is unresolved. This patch's §6 (multi-surface dispatch validation) adds a sub-requirement to Phase 0 but does not write the metric definitions themselves.
- **The citation-without-span typed-verdict mechanism.** Critique #6 of 05a is unresolved. This patch is orthogonal.
- **The "two jobs" tension at V3 §0 / §1.** Surface-as-first-class doesn't pick between command center vs truth rig. Both Codex responses pick command center; that's a separate decision.

This patch is one of six structural fixes the unified draft needs before canonicalization. It addresses only critique #4 (adjudicator-rotation shallow) by adding the missing axis, plus surfaces an architectural omission (intra-family multi-surface signal) the unified draft did not name at all.

---

<a id="15-failure-modes"></a>

## 15. Failure modes

### 15.1 Multi-surface dispatch becomes always-on for all families

If the budget governor (§6) is misconfigured or absent, multi-surface defaults can creep. Every high-stakes task fires 2× quota per family. Quota exhausts before high-priority work lands. Recovery: enforce per-family monthly quota gates; degrade to single-surface with `multiSurfaceDegraded: <family>` log and continue.

### 15.2 Surface drift silently invalidates calibration

A surface's system prompt changes upstream (OpenAI updates `codex review`'s default behavior). Calibration data from before the change gets compared against responses from after the change as if nothing happened. False signal. Recovery: §3.1.2 surface-drift detector compares calibration responses pre- and post-update; surfaces flagged as drifted are explicitly re-versioned (`codex/review@2026-Q3` vs `codex/review@2026-Q4`).

### 15.3 INTRA_FAMILY_FRACTURE becomes operator alert fatigue

If opposing-verdict fractures fire frequently on edge cases, operator stops inspecting. Recovery: track `intraFamilyFracture` rate per family per week; if rate > X% on a stable prompt class, the family's surfaces are likely behaving inconsistently, and the family enters a "review" status (down-weighted in §3.2 capability routing) until the operator inspects.

### 15.4 `mostConservative` ordering is wrong for the actual task

Soft-fracture defaults to the most-conservative verdict (reject > halt > refine > accept). For tasks where "accept" is the conservative direction (deny by default? approve by default?), the static ordering misroutes. Recovery: operator can override per-task class; logged in Decision Record with reason. (Phase 1 sets the default; operator pin-points exceptions.)

### 15.5 Adjudicator rotation pointer corruption

Rotation state lives in a JSON file. Concurrent writes or partial-file-truncate could corrupt it. Recovery: atomic rename pattern (write-temp + rename), checksum on read, fallback to "all axes at zero" if corrupt.

### 15.6 Surface taxonomy becomes a coupling point

If too many components reference surface IDs by string match, renaming a surface (e.g. `codex/exec` → `codex/cli-exec`) breaks the world. Recovery: surface IDs become enums in TypeScript with a single source of truth; renames are migrations, not edits.

---

<a id="16-verification"></a>

## 16. Verification — how we'd know this is working

Phase 0 calibration includes a **multi-surface eval** with known-correct prompts:

1. **Same-prompt multi-surface convergence rate.** Fire 50 prompts through codex/exec and codex/review. Measure verdict-convergence rate. Expected baseline: 80%+. If lower, the two surfaces produce more direction-incompatible results than we thought — `INTRA_FAMILY_FRACTURE` triggers more often than designed; routing rules need adjustment.
2. **Same-prompt multi-surface unique-claims contribution.** For the 80%+ that converge on verdict, measure how many unique claims each surface contributes. Hypothesis: 20–40% of total claims are surface-unique. If approaching 0%, multi-surface dispatch is wasted quota; if approaching 80%+, the framing differences are large enough that single-surface attribution is dangerously incomplete.
3. **Surface-drift detection.** Re-run the calibration suite at month boundaries. Flag surfaces whose convergence pattern with the rest of the fleet changed by > X% (threshold set in Phase 0).
4. **Operator-fracture-resolution latency.** Measure how long `INTRA_FAMILY_FRACTURE` halts wait for operator review. If > Y minutes routinely, operator-attention budget (Codex 05c finding) is exhausted; routing rules promote more tasks to halt-on-medium rather than halt-on-destructive.
5. **Decision Record query consistency.** Replay random Decision Records using their signed surface attestations. Verify the (family, surface) tuple round-trips through the verification path.

The 2026-04-26 codex/codex-review run is observation #1. **N=1.** Phase 0 must add at least 49 more before any threshold gets numerical defaults.

---

<a id="17-open-questions"></a>

## 17. Open questions

1. **What's the right cluster size?** This patch defaults to K=2 for multi-surface dispatch. Should K=3 (e.g. codex/exec + codex/review + chatgpt-mac for openai) be the default for destructive-class tasks? Cost vs signal trade.
2. **Should sovereign-local participate in multi-surface?** Today there's only one local surface (`ollama/llama-3.1-8b`). Adding a second (qwen-3, deepseek-r1) would let multi-surface fire even on the sovereign tier.
3. **How does multi-surface interact with Patience-is-MO?** Multi-surface in serial = sum of latencies (slow). Multi-surface in parallel = max latency (fast but quota-doubling). Default should be parallel for high/destructive, but operator may want serial for cost.
4. **`mostConservative` for non-binary verdicts.** What about verdicts like priority orderings or numeric thresholds? Soft-fracture collapse needs a typed reducer per claim category, not a global ordering.
5. **Adjudicator template bank — operator-curated or fleet-curated?** §10 template rotation pulls from a bank of N templates. Who writes them? Operator-curated keeps it sovereign. Fleet-curated may inject the family's framing biases via the templates the family wrote.
6. **What about reasoning-budget as a surface dimension?** `codex exec` and `codex review` may have different default reasoning-effort budgets. Should `(surface, reasoningBudget)` be the unit of attribution rather than `surface` alone?
7. **Deployment migration.** Existing Decision Records don't have `surface` fields. Schema-version them and accept both? Or backfill? (Backfill: the existing Records all came through the old single-surface mapping, so backfill is mostly mechanical: `codex` → `codex/exec`, `codex-review` → `codex/review`, etc.)

---

<a id="18-change-claims-requiring-evidence"></a>

## 18. CHANGE — V3 §13 Claims requiring evidence: new entries

Add to the §13 table.

| #   | Claim                                                                                                                       | Source                                                | Status                                                                                      | Impact if wrong                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | Two surfaces of the same family produce verdict-converging, framing-diverging output on identical input                     | 2026-04-26 codex/codex-review run                     | **N=1, structurally suggestive but not calibrated** — Phase 0 multi-surface eval to confirm | If wrong, multi-surface dispatch is wasted quota; INTRA_FAMILY_FRACTURE may fire more often than designed                                                                                             |
| 14  | INTRA_FAMILY_FRACTURE rate is rare on stable prompt classes                                                                 | unverified — depends on #13                           | gates on Phase 0 measurement                                                                | If high (e.g. > 20% of high-stakes tasks fracture intra-family), the architecture's intra-family-as-strong-signal claim weakens                                                                       |
| 15  | Same-family surface-unique claims contribution is 20–40% of total claims at Level 2                                         | hypothesis from 2026-04-26 single-observation         | **N=1, gates on Phase 0**                                                                   | If approaching 0%, this whole patch is wasted complexity; if approaching 80%+, single-surface dispatch is silently incomplete on every task and multi-surface should default-on for medium-stakes too |
| 16  | Surface-drift on consumer-product surfaces (web-chat, mac-app) is detectable via calibration-pattern delta within a quarter | unverified — Phase 0 surface-drift detector validates | designed not yet built                                                                      | If drift is sub-threshold-detectable, calibration data ages silently and Decision Record replays compare apples to oranges                                                                            |

---

<a id="lineage-map"></a>

## Lineage map

- [`00-DISCIPLINE.md`](00-DISCIPLINE.md) — discipline rule
- [`00-source-gemini-thread.md`](00-source-gemini-thread.md) — original Gemini Pro spec
- [`01-design-doc.DRAFT-single-voice-pending-fleet-adjudication.md`](01-design-doc.DRAFT-single-voice-pending-fleet-adjudication.md) — earlier single-voice synthesis (quarantined)
- [`02-fleet-adversarial-review.md`](02-fleet-adversarial-review.md) — Round 1 cross-fleet synthesis
- [`03-spec-v2-DRAFT-pending-fleet.md`](03-spec-v2-DRAFT-pending-fleet.md) — Round 2 v2.1 corrections
- [`04-extension-codex-components.md`](04-extension-codex-components.md) — Codex round-3: 15 component extensions
- [`frontier-lab-primitive-harvest.md`](frontier-lab-primitive-harvest.md) — Phase 0 primitive harvest
- [`05-CHUCK-V3-UNIFIED-DRAFT.md`](05-CHUCK-V3-UNIFIED-DRAFT.md) — unified draft (this artifact under review)
- [`05a-claude-code-critique-of-unified-draft.md`](05a-claude-code-critique-of-unified-draft.md) — Claude Code (Opus 4.7) critique
- [`05b-codex-exec-response.md`](05b-codex-exec-response.md) — Codex (`codex exec`) response to 05a
- [`05c-codex-review-response.md`](05c-codex-review-response.md) — Codex (`codex review`) response to 05a
- **`05d-spec-patch-surface-as-first-class-field.md`** — this file
- (next) `06-V3-CANONICAL-MINIMAL.md` — canonical V3, post-Round-3 fleet review, including this patch
- (next) `06b-authority-diff.schema.json` — schema for the §11 Self-Improvement Lab authority-diff (per 05c §3 + 05c §4)
- (next) `06c-phase-0-metric-definitions.md` — Phase 0 metric definitions (per 05c §4 ask)

---

## How to read this file

If you're Codex, Claude, or any voice asked to review this patch:

1. Start with §1 (Verdict). One paragraph; tells you what changes.
2. Read §2 (Empirical evidence). The actual numbers from the 2026-04-26 run. Single observation, N=1.
3. Read §3 (The frame). Defines `surface` vs `family` so the rest of the patch makes sense.
4. Skim §§4–11 (CHANGE blocks). Each is self-contained: current state → proposed text. Apply mentally to the V3 unified draft sections they target.
5. Spend time on §13 (Worked examples) if you want to see the patch applied to real data.
6. Read §14 (Bounds) and §15 (Failure modes) before forming an opinion. The patch is structural, not numerical; Phase 0 sets the numbers.
7. §17 (Open questions) is where I'd most welcome adversarial pressure.

If you're going to push back, push back on §6 (multi-surface dispatch policy — is the cost worth the signal?), §9 (`INTRA_FAMILY_FRACTURE` rules — is opposing-verdict the right halt trigger?), or §10 (three-axis rotation — is it implementable without coupling?). Those are the load-bearing structural choices.

If you're going to accept, the next deliverables this patch implies are: `06-V3-CANONICAL-MINIMAL.md` (compressed canonical with this patch folded in), `06b-authority-diff.schema.json`, `06c-phase-0-metric-definitions.md`. The minimum-implementation-set lands in `apex-panel-ask.mjs` (already partially shipped: `codex-review` voice 2026-04-26 21:41 CDT) plus `apex-nplex-adjudicate.mjs` (cluster collapse + INTRA_FAMILY_FRACTURE classification).

— Chuck (Claude Code / Opus 4.7), 2026-04-26 21:55 CDT.
