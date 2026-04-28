# CHUCK V3 — Unified Architecture (Working Draft)

**Status**: **WORKING DRAFT.** Single-document synthesis of every artifact in `chuck-v2-design/` plus today's session findings. Purpose: one place to read the whole architecture. **Not authoritative** — the canonical Chuck V3 spec is what comes out the other side of configured cross-family fleet review (`anthropic / openai / google / perplexity / sovereign-local` on this draft). Because multiple V3 extensions were authored by Codex/OpenAI, the OpenAI pass is tagged as originating-family self-review and cannot be the decisive independent vote. This is the input to that pass, not its output.

**Lineage**:

- `00-source-gemini-thread.md` — Gemini Pro spec, the original 36-turn brief (2026-04-25)
- `00-DISCIPLINE.md` — discipline rule (no significant work product without fleet adjudication)
- `01-design-doc.DRAFT-single-voice-pending-fleet-adjudication.md` — my earlier single-voice synthesis (quarantined per discipline)
- `02-fleet-adversarial-review.md` — cross-fleet synthesis of Gemini's spec (6 voices, 3 distinct families)
- `03-spec-v2-DRAFT-pending-fleet.md` — v2.1 corrections to Gemini's spec, Codex round-1 + round-2 review folded in
- `04-extension-codex-components.md` — Codex round-3: 15 component extensions + Frontier Lab Primitive Harvest + Document Evidence Pipeline
- `frontier-lab-primitive-harvest.md` — Phase 0 industry-wide primitive harvest (OpenAI, Anthropic, Google, xAI, Meta, Mistral, Cohere, AWS, Microsoft, DeepSeek, Qwen, Kimi, Perplexity, OpenClaw, LangGraph)
- Today's session empirical findings (housekeeper validation, NOPASSWD purge, perplexity driver bug, voice-impersonation under pressure, session-sovereignty design, chuck-watch dashboard)

**Discipline**: this document is single-voice (Chuck/Claude in this session) integrating multiple voices' contributions. Round-2 fleet review of v2.1 + Round-3 configured cross-family fleet review of this unified draft must happen before any v3 is treated as canonical. Date target: 2026-04-27 (Google quota reset window).

---

## Table of contents

- [0. The destination — Cognitive Sovereignty](#0)
- [1. Five universal principles](#1)
- [2. Build philosophy (Codex's seven-piece framing)](#2)
- [3. The Adversarial Fleet](#3)
- [4. The Adjudication Layer](#4)
- [5. The Vault](#5)
- [6. The OpenClaw Chassis](#6)
- [7. The Evidence Layer (incl. Document Evidence Pipeline)](#7)
- [8. The 15 Architectural Components](#8)
- [9. Operational discipline (validated 2026-04-25/26)](#9)
- [10. Implementation roadmap (Phase 0 → 4+)](#10)
- [11. Open operator decisions](#11)
- [12. Out of scope (deliberate)](#12)
- [13. Claims requiring evidence](#13)
- [14. Discipline + next pass](#14)

---

<a id="0"></a>

## 0. The destination — Cognitive Sovereignty

(Preserved from Gemini's framing; v2.1 caveats inline.)

Chuck V3 is a **personally-owned, sovereign, multi-vendor adversarial-ensemble agent operating layer** for Joseph Matsiko. It runs on a Mac (16 GB now → Mac mini next), drives N frontier LLMs through their consumer subscription surfaces (no PAYG keys), persists reasoning state in a typed memory graph, and adjudicates outputs through a structurally-diverse fleet rather than trusting any single vendor. It governs OpenClaw rather than forking it.

**The five operator-experience pillars** (Gemini's vision, with v2.1 caveats):

1. **Trust with provenance, not vibe-check** — every artifact comes with a Decision Record _documenting_ what survived adversarial cross-examination. _Caveat: this is decision discipline + audit trail, not Bayesian truth proof. Frontier families share more training distribution than independent-voter math assumes._

2. **Puppeteer + Firehose** — pull OpenClaw upstream daily; SDK-boundary firewall keeps Chuck independent. _Caveat: localhost API intercept is a maintenance treadmill (schema-rot weekly); make it opt-in / Phase 3+, not Sprint-2-default. Default mode treats OpenClaw as channel surface and runs Fleet out-of-band._

3. **Multi-vendor immune system** — single-vendor RLHF degradation can't compromise reasoning baseline; capability-degraded models lose ground in adjudication. _Caveat: structurally resistant, not immune. Families share substantial training distribution._

4. **Asynchronous reality forking** — code-with-tests schisms get worktree-arbitrated by deterministic verifiers; you wake to the verifier-determined winner. _Caveat: only when reality is cheap to query. Architecture/judgment schisms still halt and surface to operator. Destructive tasks always halt._

5. **Compounding intelligence via Vault doctrine** — every executed task, every resolved outlier, every curated principle compounds into operator-aligned operational philosophy. _Caveat: Vault arbitrates **alignment with operator doctrine**, NOT external truth. Vault citations raise priors; never overrule fresh evidence._

**The honest pitch:** _audit-grade decision-making with multi-vendor redundancy and operator doctrine as final arbiter of alignment._ The destination is right; the truth-claim language got downgraded after fleet adversarial review.

---

<a id="1"></a>

## 1. Five universal principles

These are architecture, not config. They survive every fleet change, every Sprint, every Mac upgrade.

| #   | Principle                                       | What it means in code                                                                                                                                                                                            |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Adversarial Ensemble Execution (AEE)**        | Reject synthesis. Force structurally-diverse models into mandatory adjudication. Agreement raises posterior confidence; disagreement halts and forces inspection.                                                |
| 2   | **Producer-Family Attribution** (cryptographic) | The family that _actually_ ran (after escalation cascades) is what gets counted. Signed at runner/orchestrator boundary, not trusted from model self-report. Impersonation = halt.                               |
| 3   | **Score-based Protocol Classification**         | UNANIMOUS / OUTLIER / DEEP_FRACTURE / FRAGMENT / IMPERSONATION_DETECTED / INCOMPLETE — derived from `agreementScore` + minority-block rules. Scales to any N.                                                    |
| 4   | **Minimum-Fleet Floor**                         | At least 3 valid responses per adjudication. Sub-3 collapses to coin-flip arithmetic — the original Apex Twin pathology.                                                                                         |
| 5   | **Vault Provenance** (alignment, not truth)     | Vault citations _raise priors_ and _arbitrate alignment with operator doctrine_. They do NOT override external facts, tests, specs, laws, or live docs. Vault is interrogated alongside the Fleet, not above it. |

**Plus the hard rule the original spec preserved (Codex 2026-04-26):**

> Fleet size is configurable, but adjudication must **never** optimize for tie-breaking. Any minority above the configured fracture threshold halts or triggers adversarial resolution. Chuck optimizes for interrogation, not throughput. **Halt beats false certainty.** A 3-2 split in a 5-fleet is a `DEEP_FRACTURE` halt regardless of agreementScore inside the 3-block.

**Plus the deepest insight the original spec carried (Codex 2026-04-26):**

> The models are compute. The intelligence is routing, forced disagreement, adjudication, and refusal-to-execute. Chuck does not get smarter by stacking better models; Chuck gets smarter by structuring better friction. **The Fleet is fungible compute; the Adjudication Layer is the mind.**

---

<a id="2"></a>

## 2. Build philosophy — Codex's seven-piece framing

> **OpenClaw gives Chuck hands.**
> **Fleet gives Chuck disagreement.**
> **Vault gives Chuck doctrine.**
> **Kernel gives Chuck restraint.**
> **DecisionRecords give Chuck memory.**
> **Evals give Chuck honesty.**
> **Self-improvement lab gives Chuck compounding.**
>
> That combination is the thing. Not just agentic. **Governed, improving, sovereign, and increasingly hard to fool.**

This is the seven-piece skeleton. Every Chuck V3 module fits into one of these.

### 2.1 V3 Build Spine

The spec is not a Perplexity clone, an OpenClaw fork, or a generic agent framework. Chuck V3 is the narrow spine below, with industry primitives harvested only when they strengthen one of these layers.

| Layer               | Responsibility                                                                                     | Hard boundary                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Chuck Kernel**    | Policy enforcement, stake routing, receipts, Decision Records, refusal, authority limits           | Pure code. No model may bypass it or expand its authority.                             |
| **Fleet Layer**     | Family attribution, no-simple-majority protocols, degraded labels, outlier preservation            | Models are compute; their votes are evidence, not truth.                               |
| **Evidence Layer**  | Tests/runtime/docs/repo facts/document spans/model reasoning/Vault doctrine precedence             | Fresh evidence beats doctrine; citation requires verified spans.                       |
| **Execution Layer** | OpenClaw channels/tools, Task Capsules, skill quarantine, dual-worktree verification               | OpenClaw remains the hands; Chuck governs when hands may move.                         |
| **Growth Layer**    | Calibration, comparative benchmarks, self-improvement proposals, operator-approved doctrine writes | Chuck may propose improvement; Joseph approves authority changes and doctrine commits. |

---

<a id="3"></a>

## 3. The Adversarial Fleet

### 3.1 Current configured fleet (5 distinct families)

Lives at `~/.chuck/state/fleet.json` (post-migration; currently `~/.openclaw/workspace/state/apex-fleet.json`). Each entry MUST carry a `rationale` field; load-time refusal for duplicate-family entries.

| Family            | Voice                                                  | Surface                                    | Rationale                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`       | `claude-cli`                                           | Opus 4.7 CLI [unverified — verify per §13] | Most reliable Anthropic surface. Drop only if consumer-subscription path dies.                                                                                                   |
| `openai`          | `chatgpt-web` (cascade: chatgpt-mac → chatgpt.com web) | Mac-app primary, web fallback              | Tier-1 invariant catches impersonation cascade. Cross-family fallback (claude-cli-impersonation) disabled.                                                                       |
| `google`          | `gemini-cli`                                           | Gemini 3.1 Pro CLI [unverified]            | Most reliable Google surface — but **all three Google surfaces (cli/web/aistudio) share account quota** (empirical 2026-04-26).                                                  |
| `perplexity`      | `perplexity-mac`                                       | Max Pro Mac app, **incognito-only**        | Meta-router family — structurally distinct from base-LLM families. No-history-accumulation principle.                                                                            |
| `sovereign-local` | `ollama-local`                                         | Llama 3.1 8b on `localhost:11434`          | Sovereignty floor — only voice whose reasoning never crosses a network boundary.                                                                                                 |
| `xai`             | `grok`                                                 | Candidate web/app/API surface              | Candidate sixth family for X/Twitter-native real-time context, long-context reasoning, function calling, and search/tool posture. Optional until runner attribution is reliable. |

### 3.2 Capability-aware routing

Empirically confirmed 2026-04-26: Llama 3.1 8b's response (~2 KB) is markedly less rigorous than frontier voices (~9–10 KB). Llama is a **sovereignty floor + capability-mismatch flag, NOT an equal-weight epistemic peer**.

| Voice class                                | Vote weight on architectural / reasoning / coding tasks | Vote weight on lookups / sovereignty-critical-context                      | Notes                                                                                         |
| ------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Frontier (`anthropic`, `openai`, `google`) | full                                                    | full                                                                       | as configured                                                                                 |
| Meta-router (`perplexity`)                 | partial                                                 | full on knowledge-grounded tasks                                           | router not base reasoner                                                                      |
| Live-social (`xai` / Grok candidate)       | partial until calibrated                                | full on X/Twitter-originating or live-social tasks if attribution is clean | add as optional sixth family; absent if surface is flaky or falls back through another runner |
| Sovereign Local (`ollama-local`)           | flag-not-vote                                           | full                                                                       | loud Llama disagreement = re-fire with frontier focus + flag for operator review              |

Task-class routing happens in stake-assessment pre-stage (§4.1). The same fleet member can carry different vote-weights for different task classes.

### 3.3 Cryptographic producer-family attribution (Tier-1 invariant)

The family that ACTUALLY ran is what gets counted. **Cryptographic, not statistical.**

- Voice unreachable = voice marked **absent**, NOT silently re-routed.
- Attribution is **signed at the runner/orchestrator boundary** with HMAC keyed to a per-session orchestrator secret. Signing record carries: actual binary path, transcript path on disk, invocation timestamp, exit status, parent process tree.
- Model output cannot retroactively rewrite which family ran.
- Output-file headers (`Producer-Family`, `Impersonation`) are a _human-readable surfacing_ of the signed record, not the source of truth.
- Cross-family fallback layers (`claude-cli-impersonation`, etc.) **disabled by default in code**; opt-in flag for the rare deliberate case (validated 2026-04-26 in `apex-panel-ask.mjs`).
- Decision Records reference the signed runner attestation.

### 3.4 Degraded-fleet protocols

Quad-or-nothing breaks under real-world surface unavailability (empirically confirmed 2026-04-26: Google entirely unreachable, Perplexity unreachable due to driver bug).

| Valid voice count         | Behavior                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| N=5 (full)                | Standard thresholds.                                                                                          |
| N=4                       | Standard thresholds; Decision Record logs "1-family-down" with reason.                                        |
| N=3 (minimum-fleet floor) | `DEGRADED-3` mark. Confidence labels reduced. Stake-assessment auto-routes high-risk tasks to halt-and-defer. |
| N<3                       | Refuse to adjudicate. Halt with `INCOMPLETE-FLEET`, surface to operator.                                      |

Decision Record carries `validVoiceCount` and `fleetSize` fields explicitly.

---

<a id="4"></a>

## 4. The Adjudication Layer

`apex-nplex-adjudicate.mjs` (path post-migration: `chuck-v3/adjudication/orchestrator.ts`). Does not summarize; extracts, aligns, surfaces dissent, and routes.

### 4.1 Pre-stage: Stake Assessment

Every prompt entering the Adjudication Layer first passes through stake-assessment. Skipping AEE on routine work is the difference between Chuck being usable and Chuck being 10× too slow.

| Stake class     | Examples                                                                                              | Routing                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Trivial**     | factual lookups, formatting, quick clarifications                                                     | Bypass Fleet, single-model response                                          |
| **Medium**      | code review, draft documents, design questions, summaries                                             | 2-family review (cheapest two reachable families)                            |
| **High**        | architectural decisions, code that ships to disk, multi-step plans, anything involving Vault doctrine | Full Fleet                                                                   |
| **Destructive** | deletions, money/identity/persistent-state mutations, anything irreversible                           | Full Fleet + Halt-on-Schism + Operator Confirmation, no autonomous execution |

Implementation: LLM classifier (small, cheap) + **rule-based destructive overrides** (regex/AST patterns matching `rm`, deletions, money/identity verbs) that promote regardless of LLM judgment. Conservative classifier — when in doubt, route up. **Audit false negatives**: random 5% of trivial-classified tasks get a second-classifier pass; mismatches surface as bus events.

### 4.2 Phase 1: Claim Extraction & Alignment Matrix

The orchestrator receives the N parallel outputs. Strips conversational filler. Forces each model to output a strict JSON array of claims with **source spans** — concrete file:line for code, quote spans for prose.

Claims compiled into an Alignment Matrix — truth table of overlapping and conflicting directives. Schema validation at extraction time: claim text, claim category, evidence-class tag, supporting Vault nodes (if any), source span.

**Premise validation pre-step**: before any claim is privileged or injected as a constraint anywhere downstream, validate: _Is this constraint factual, testable, sourced — or merely hypothetical?_ Hallucinated premises don't get to be constraints.

### 4.3 Phase 2: Resolution Protocols (score-based, scales to any N)

| Protocol                   | Trigger                                                                            | Trust signal           | Action                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UNANIMOUS**              | `agreementScore` ≥ 0.95 AND no minority above 0 voices                             | High, evidence-bounded | Task Capsule, signed, passed to OpenClaw. Decision Record archives N voice responses + alignment matrix. _High-agreement does not imply correctness._ |
| **OUTLIER**                | ≥ 0.70 with single-voice dissent                                                   | High, with inspection  | §4.4 — extract, adversarially preserve, resolve.                                                                                                      |
| **DEEP_FRACTURE**          | Any minority block ≥ `fractureThreshold` voices (default ⌈N/2⌉ for N≥4; 2 for N=5) | Zero — **named halt**  | §4.5 — reality arbitration or hard halt. Includes 3-2 in 5-fleet, 2-2 in 4-fleet. **Never auto-routes by majority.**                                  |
| **FRAGMENT**               | <0.40 or no coherent block exists                                                  | Zero                   | Hard halt. Surface alignment matrix to operator.                                                                                                      |
| **IMPERSONATION_DETECTED** | (any score) but signed attribution caught silent identity-cross                    | Void                   | Halt classification. Operator must resolve attribution.                                                                                               |
| **INCOMPLETE**             | N < 3 valid responses                                                              | Zero                   | Halt. Mark fleet-size deficiency.                                                                                                                     |

### 4.4 Phase 3: Outlier Handling — _extract, adversarially preserve, resolve_

**Framing principle (Codex):** the `1` in a `4-1` may be the system's most valuable output. Outlier handling is not "dismiss until proven useful" — it is **extract, validate, adversarially preserve until resolved**. The outlier is treated as a contrarian-truth candidate by default; the burden is on the consensus to defend.

**Protocol:**

1. **Extract** the outlier's specific contradicted claim verbatim with evidence-class tag and source span. Outlier voice invited to submit structured defense before resolution begins. Outlier is _named in the Decision Record_ even when overruled.
2. **Adversarial red-team rotation** (replaces BEI as primary): rotate the _role of the prober_. A different family is asked to find holes in the consensus's argument given the outlier's specific evidence. The prober's job is to attack consensus. Repeat with rotated families until: (a) consensus survives multiple rotations with evidence-grounded counter-arguments, or (b) consensus collapses and the outlier is upgraded to candidate-truth.
3. **Premise hallucination defense** (parallel check, NOT gating): if during red-team rotation the outlier's premise is _demonstrably hallucinated_ (source span doesn't exist, cited test doesn't pass, referenced doc doesn't say what the outlier claims), the outlier is _flagged as un-sourced_ but NOT silently dropped. The operator sees both the outlier's claim AND the source-failure note.
4. **Blinded Epistemic Injection (BEI) as last-resort discovery**, not primary: if red-team rotation exhausts AND the outlier's premise is well-sourced, BEI may add discovery — but its output is treated as evidence to weigh, not authoritative re-evaluation. (Per fleet review, BEI relocates sycophancy from peer-pressure to prompt-pressure; can't be primary anti-sycophancy mechanism.)
5. **The framer has epistemic authority** — every prompt-framing in red-team / BEI / claim extraction is logged in the Decision Record. Operator can audit who-framed-what.
6. **Vault-aware outlier respect**: outlier-claim aligning with Vault doctrine is a signal _for_ the outlier (alignment-with-operator); outlier-claim contradicting Vault is surfaced explicitly so the operator decides whether the doctrine should update.

### 4.5 Phase 4: DEEP_FRACTURE Handling — Reality Arbitration or Halt

**A `DEEP_FRACTURE` is by definition a hard signal that the system cannot resolve internally.** The protocol is NOT to choose a majority — it is to either delegate to deterministic reality (when reality is cheap) or halt and surface.

**Action (Code Tasks with Deterministic Verifier):**

- Provision sandboxed git worktrees on local machine — one per coherent consensus block.
- Execute consensus-A path in Worktree 1, consensus-B path in Worktree 2.
- Run local test suites / type-checkers / compilers / runtime traces against both.
- Decision Record packages the deterministic results, surfaces the verifier-determined winner. Both worktrees archived for replay.
- _If the fracture has more than two coherent blocks (e.g. 3-1-1), and reality is cheap, fork all coherent blocks. Otherwise halt._

**Action (Architecture / Judgment Tasks — no deterministic verifier):**

- **Hard halt.** Do not attempt to choose. Surface alignment matrix + each block's position + named outliers + Vault-doctrine alignment of each block to operator. Wait.
- Operator decision feeds back into Vault with provenance.

**Action (Destructive Tasks — irreversible regardless of verifier):**

- Hard halt regardless of verifier availability. Telegram + Decision Record. Operator confirmation required, with full block-by-block surfacing.

**The 3-2 rule (preserved from original spec):**
A 3-2 split in a 5-fleet routes to DEEP_FRACTURE, not OUTLIER. Even if the 3-block has internal `agreementScore` ≥ 0.7, the existence of a coherent 2-block dissent is a fracture, not an outlier. **Two voices agreeing against three is structural disagreement, not noise.**

### 4.6 Adjudicator family rotation

Today's `claude-cli`-as-judge installs an Anthropic vote at the meta-layer. Resolution: **rotate the Adjudicator family per run** (round-robin, pinned to whichever family was _least represented in the producer set_). Log Adjudicator family in every Decision Record. Operator can audit meta-bias drift over time. Phase 4 work: deterministic logic over a structured claim-extraction stage (claim extraction stays LLM-judged; alignment-matrix → protocol-routing becomes pure code).

---

<a id="5"></a>

## 5. The Vault

The 360-node [unverified — see §13] Apex Vault (traditions, mechanics, exemplars, anti-patterns) is the **arbiter of operator-alignment**. NOT the arbiter of external truth.

### 5.1 Vault scope

> Vault provenance can overrule **style, priority, risk tolerance, and operating constraints**. It cannot overrule **external facts, tests, specs, laws, or live docs**. (Codex framing, fleet-ratified.)

**Practical encoding:**

- Vault node retrieval surfaces during Adjudication.
- Vault citations _raise priors_ on aligned claims; they do NOT _mathematically overrule_.
- When a model claim contradicts a Vault node, Decision Record surfaces both, Adjudicator notes conflict, operator decides which updates.

### 5.2 Vault falsification protocol

- A Vault node can be **demoted** (priority reduced) by external evidence: failing tests, contradicting specs, retracted documentation.
- A Vault node can be **retired** (graph-deleted-but-archived) by operator decision, with reason + timestamp.
- Curation events themselves go through the Fleet — a node demotion is a high-stake decision (changes future adjudications), so it gets full Fleet review before commit.

### 5.3 Vault test suite

Today's Vault is monotonically growing. The fleet flagged this as confirmation-bias amplification.

- **Contradiction detector** over the typed nodes (find principles that disagree with each other).
- **Retrieval correctness checker** (does the right node surface for the right query).
- Bad principles surface before they bias adjudications.

### 5.4 Curator-loop hardening

- Curator-suggested Vault edits (`apex-memory-curator`) are **proposals, not auto-commits**.
- All Vault writes require **explicit operator approval** before commit. Fleet may _recommend_ (curator can fan a proposal through the Fleet for adversarial review and produce a Decision Record), but **doctrine commits to a sovereignty stack are operator-final**. Fleet-without-operator is too loose.
- Curator's training data (model outputs already in the bus) is tagged "model-generated" so the curator can avoid recursive self-citation.

### 5.5 Personal Doctrine Compiler (Codex extension — Phase 3)

Vault should not just store principles. It should **compile them into**:

- tool policy (allow/deny lists)
- prompt constraints (system-prompt fragments)
- approval rules (which actions need operator confirm)
- routing preferences (which voice for which task class)
- style rules (formatting, voice register, signature)
- risk thresholds (what counts as destructive)
- dashboard alerts (what to surface to chuck-watch)

**Doctrine becomes executable, but operator-approved.** Compilation runs offline; the compiled policy artifacts are git-tracked and signed by the Kernel (§8.1) before being live.

---

<a id="6"></a>

## 6. The OpenClaw Chassis

Chuck V3 is no longer a fork of OpenClaw's core event loop; Chuck is an independent intelligence that **can** puppeteer OpenClaw via a localhost provider intercept.

### 6.1 Default operating mode

OpenClaw runs unmodified as channel surface (Telegram, WhatsApp, etc.). Chuck runs out-of-band, triggered explicitly by `/chuck` channel commands or by stake-classified high-risk artifacts. OpenClaw's hot path is unaffected; routine LLM calls go through OpenClaw's normal provider config.

This avoids the latency mismatch the fleet flagged: OpenClaw expects sub-second responses, full Fleet adjudication takes minutes.

### 6.2 Optional puppeteer intercept (Phase 3+, opt-in)

If Phase 0 calibration validates the value:

- OpenClaw's LLM provider config rerouted to `localhost:<CHUCK_PORT>`.
- Chuck exposes Anthropic/OpenAI-schema-compatible endpoint.
- Chuck intercepts megaprompt → routes through stake-assessment (§4.1) → runs Fleet IF stake warrants → returns finalized output.
- **Hard requirement:** stake-assessment can return "skip Fleet, route to single model" within 200ms. Otherwise OpenClaw's UX dies.

**Maintenance reality**: tracking schema fidelity to two vendor APIs that ship breaking changes weekly is a permanent commitment. Build only after Phase 0 + Phase 1 prove the value justifies the cost.

### 6.3 Skill Quarantine — real sandboxing (Codex's 10-step pipeline)

LLM static-analysis of `SKILL.md` for malware was flagged as security theater (defeated by obfuscation, time-bombs, second-stage downloaders). Real protocol per Codex:

1. **Unpack** the skill bundle to ephemeral location
2. **Hash** every file (SHA-256, content-addressable)
3. **Generate SBOM** (software bill of materials — every dep + version)
4. **Static scan** (semgrep / known-bad-pattern detector)
5. **Permission declaration** parse — what does the skill claim it needs?
6. **Network-off dry run** in capability-constrained subprocess (no network, ephemeral fs, syscall allow-list)
7. **Syscall / filesystem observation** during the dry run — does observed behavior match declared permissions?
8. **Staged enablement** — start with most-restrictive permission set, widen only if operator approves specific capabilities
9. **Local signature** — Kernel signs the audited skill, only signed skills can execute
10. **Periodic revalidation** — every N days, re-run audit; if skill code changed without re-sign, halt

LLM auditing is one signal among many, not the gate. Make ClawHub's "treat third-party skills as untrusted" automatic.

---

<a id="7"></a>

## 7. The Evidence Layer

### 7.1 Evidence hierarchy (Codex)

Decisions weighted by evidence class. Higher class wins ties.

1. **Tests / compiler / runtime execution** — deterministic, replayable
2. **Primary documentation or source code** — verifiable on disk
3. **Retrieved local repo facts** — file:line precision via `rg` or AST
4. **Vault policy / principles** — operator doctrine (alignment, not external truth)
5. **Model reasoning** — LLM output without external grounding
6. **Unsourced assertion** — to be flagged, not weighted

Without this hierarchy, "four models agree" can incorrectly beat "one test fails."

### 7.2 Document Evidence Pipeline (Codex extension)

Chuck treats documents and source surfaces as evidence objects, not loose context. PDFs matter, but they are one source kind among PDFs, repo files, local files, web pages, transcripts, screenshots/OCR, connector exports, and generated artifacts.

**13-step pipeline:**

1. **Ingest** complete source units where feasible (no relevance filtering at ingest)
2. **Preserve source coordinates** as first-class metadata (page, file line, URL, transcript timestamp, screenshot box, artifact path)
3. **Extract text** into source-specific spans
4. **OCR scanned/image surfaces** when text is not directly available
5. **Extract tables separately** with structural fidelity
6. **Extract figures / captions / screenshots** with coordinates
7. **Hash the source object** (content-addressable, replayable)
8. **Store span-level facts** in the evidence graph
9. **Chunk with overlap** for retrieval (chunks reference original spans)
10. **Cite exact source coordinates** in any model claim derived from the evidence object
11. **Multiple models read different passes** (fleet-style — extraction, contradiction detection, summary, risk review)
12. **Run contradiction detection across the source set** where task value justifies the cost
13. **Produce a `DocumentEvidenceRecord`** — first-class evidence artifact, citable from any Decision Record

**Hard rule:** _Never allow a model to cite an evidence object unless the cited span exists._ Citation-without-span is a verifier failure, not a soft warning. Tied to §3.3 cryptographic attribution.

### 7.3 DocumentEvidenceRecord schema (sketch)

```json
{
  "recordId": "doc-evd-<hash>-<ts>",
  "sourceHash": "sha256:...",
  "sourceKind": "pdf|repo-file|local-file|web-page|transcript|screenshot|connector-export|generated-artifact",
  "sourcePathOrUrl": "/path/or/url",
  "ingestedAt": "2026-04-26T...",
  "units": [
    { "unitId": "page-1|file:12-20|timestamp:00:01:13|box:...", "text": "...", "spans": [...], "tables": [...], "figures": [...] }
  ],
  "contradictions": [
    { "claimA": { "unitId": "page-7", "span": [...] }, "claimB": { "unitId": "page-23", "span": [...] }, "reason": "..." }
  ],
  "citationLog": [
    { "decisionRecord": "...", "voice": "...", "unitId": "page-12", "span": [...], "verifiedExists": true }
  ]
}
```

---

<a id="8"></a>

## 8. The 15 Architectural Components (Codex round-3)

The seven-piece skeleton (§2) decomposes into 15 named modules. Each is tractable to build in isolation and audit by reading.

### 8.1 Chuck Kernel

**A tiny, hard policy kernel that no model can bypass.** Owns: permissions, stake classification, tool allow/deny, destructive-action approval, fleet health, receipt validation, rollback requirements, "can this execute?" decisions.

**Models propose. The kernel decides.**

- Pure code, no LLM reasoning inside.
- Auditable by reading once.
- Own file/module: `chuck-v3/kernel/kernel.ts`.
- Phase 1 priority. Load-bearing trust foundation.

### 8.2 Event-Sourced Bus

Every action becomes an append-only event: prompt received, stake classified, model called, tool requested, approval granted/denied, file changed, test passed/failed, operator corrected, Vault proposal made, self-improvement accepted/rejected.

- Replayable: reconstruct exactly why anything happened.
- Storage: append-only JSONL, content-addressable, indexed by event type + timestamp.
- Phase 2.

### 8.3 Decision Record Corpus

Every meaningful action produces a record (not just Fleet runs). Skill installation, tool failure, operator correction, Vault edit — all get records.

- Schema: voice, family, layer, model, prompt-hash, output-hash, alignment-matrix-hash, evidence-cited, vault-doctrine-cited, confidence-labels, signed runner attestation.
- Searchable corpus over time = Chuck's institutional memory.
- Phase 2.

### 8.4 Excellence Dashboard

Operational cockpit (not decorative). Live fleet health, active tasks, current stake class, pending approvals, recent fractures, outlier wins, failed tools, skill quarantine status, self-improvement proposals, excellence trajectory.

- Today's `chuck-watch` (terminal + browser modes, 6 panes) is v0.1.
- Codex's vision adds: pending approvals, skill quarantine status, self-improvement proposals, excellence trajectory.
- Phase 2-3, iterative.

### 8.5 Self-Improvement Lab

Sandbox where Chuck can improve itself without touching production.

**Flow**: detect weakness → draft patch → run tests → compare before/after → write Decision Record → ask approval.

Chuck can autonomously _propose_ improvements. **It cannot silently expand its own authority.** Enforcement: Kernel (§8.1) gates every patch-merge; "authority-expanding" changes have stricter approval rules.

- Phase 3-4. Highest-novelty + highest-risk component.
- Cryptographic enforcement of authority-bound (not just policy).

### 8.6 Tool Reliability Scoring

Every tool gets a trust score: success rate, average latency, rollback success, permission scope, failure modes, last verified date, incident history.

Chuck learns: "this browser driver is flaky" (today's `cliclick kd:cmd,kd:shift` bug would have surfaced here pre-failure), "this MCP server is safe," "this skill keeps over-requesting access."

- Piggybacks on event-sourced bus (§8.2).
- Phase 2-3.

### 8.7 Fleet Capability Scoring

Models are not "equal voices" forever. Chuck learns:

- OpenAI better at code patch synthesis
- Anthropic better at doctrine/spec synthesis
- search-native / retrieval-heavy surfaces better at live sourced research
- Google better/worse depending on quota and task class
- local model best as sovereignty alarm / dissent flag

**Weights drift from measured outcomes, not vibes.** Requires Phase 0 calibration baseline + ongoing measurement.

- Phase 3.

### 8.8 Real Skill Quarantine

10-step pipeline (covered §6.3). Phase 2-3.

### 8.9 Durable Workflow Engine

Long tasks survive sleep, crash, quota failure, app restarts. **Borrow the best idea from durable agent frameworks (LangGraph et al.): checkpoint every step.** Resume without redoing finished work.

- Critical for "drop in Telegram, wake to PR" — without this, every Mac sleep loses progress.
- Phase 3.

### 8.10 Red-Team Simulator

Internal adversarial drills:

- prompt injection attempt
- malicious skill
- fake source
- sycophantic consensus
- false outlier
- true outlier
- compromised runner
- stale Vault doctrine
- corrupted Decision Record
- bad rollback

Run on a cadence. Builds calibration data + makes the system stronger.

- Builds on Kernel (§8.1), Self-Improvement Lab (§8.5), Tool Reliability Scoring (§8.6).
- Phase 3-4.

### 8.11 Personal Doctrine Compiler

Vault → executable policy artifacts (covered §5.5). Phase 3.

### 8.12 Long-Horizon Agenda Manager — the "alive" layer

Chuck maintains:

- active projects
- strategic objectives
- open loops
- weekly reviews
- stalled tasks
- opportunities
- "things Joseph keeps meaning to do"
- self-improvement backlog

**Then it can initiate useful work instead of only responding.** Stake-assessment + Kernel must gate every initiated action.

- Phase 4. Most ambitious component.
- Risk: scope-creep into "Chuck does whatever it thinks is useful" territory.

### 8.13 Credential & Permission Proxies

No raw secrets in model reach. Chuck exposes narrow actions:

- `send_email(to, subject, body)`
- `read_calendar_busy(date_range)`
- `open_repo_file(path)`
- `create_draft(target, content)`
- `run_test(suite)`

Not raw tokens, cookies, or broad filesystem access. OAuth-scope-style architecture.

- Phase 1-2. Critical security.
- Lands alongside Kernel.

### 8.14 Local Sovereignty Floor (full-system)

Even if cloud models degrade / quit / censor / quota out / change terms, Chuck retains a **local minimum**: local model, local memory, local dashboard, local policy kernel, local task records, local rollback, local tool inventory.

**Cloud models are compute. Chuck persists.**

Validation test: shut down internet, does Chuck still work for the local-only task class?

- Phase 2-3.

### 8.15 Comparative Benchmarking

Benchmark against vanilla OpenClaw, Claude Desktop, ChatGPT/Codex, Perplexity/Comet, LangGraph workflows, local-only agents, previous Chuck versions.

Not for ego — for calibration. The scoreboard:

- who solved it correctly?
- who acted safely?
- who used fewer calls?
- who produced better rollback?
- who caught the hidden risk?
- who improved next time?

- Phase 4 (continuous). Quarterly cadence post-V3.

---

<a id="9"></a>

## 9. Operational discipline (validated 2026-04-25 / 2026-04-26)

These weren't in Gemini's spec; they're carry-forward from today's empirical work.

### 9.1 Independent launchd agents > monolithic daemons

The legacy `openclaw-watchers` daemon imported ~30 modules and wedged for 8 minutes under L3 memory pressure. The dedicated `apex-housekeeper` agent (separate launchd plist) booted clean and unblocked itself.

**Pattern**: every Chuck V3 service ships as its own launchd entry. Memory pressure can never block the very services designed to relieve it.

### 9.2 NOPASSWD purge for autonomous memory relief

`/etc/sudoers.d/chuck-purge` (renamed from `apex-housekeeper-purge`). Validated empirically. The housekeeper purges every 60s when at L2+, bypasses cooldown at L3. After this landed, the Mac never wedged again.

### 9.3 Tagged producer-family attribution on every output

Every voice response file carries explicit headers:

```
Voice-Requested: chatgpt-web (ChatGPT-Web)
Producer-Family: openai
Impersonation: false
Model: gpt-5.5
Layer used: primary (chatgpt-mac)
```

When `--allow-impersonation` is opt-in and triggers: `Impersonation: true ⚠ identity-crossing — see policy`.

Today's run had multiple chatgpt-web cascades land on `claude-cli-impersonation` (apex-chrome was cold). The flagging worked — voices self-identified, headers tagged it, adjudicator's `IMPERSONATION_DETECTED` would have fired. Tier-1 invariant fired exactly as designed.

### 9.4 Frontmost-app + bundle-siblings + Apex-allowlist immunity

The housekeeper's safety floor: the active surface stays alive even under aggressive housekeeping. Hard rule: never reap frontmost app, its descendants, its bundle siblings, or anything in the Apex-critical allowlist. Validated 2026-04-25 — Joseph's chat surface (Claude Desktop, this Claude Code session) was never threatened despite multiple L3 events.

### 9.5 Config-driven Fleet with rationale-required entries

`apex-fleet.json` (post-migration: `chuck.config.json`) — operator-editable, but bound by principles. Load-time refusal for: duplicate families (structural-diversity violation), missing rationale (principles-not-arbitrary violation). Operators editing this file are bound by the universal principles, not free to pick at whim.

### 9.6 Session Sovereignty (designed, not yet built)

Per the "never log in again" directive (2026-04-26):

- Discover all Chrome-based profile dirs (main + apex a/b/c + every PWA's user-data-dir)
- Master session source = main Chrome profile (always-signed-in)
- Sideload every 6h (extends existing 30-min apex-only)
- Auth-required watcher → trigger immediate sideload + retry, no operator prompt
- Pre-expiry refresh (within 7 days of `expires_utc`)
- Phase 2: Keychain monitor for native Mac apps (Claude.app, ChatGPT.app)
- Phase 1.5: per-bundle passkey ceremony for new PWAs

---

<a id="10"></a>

## 10. Implementation roadmap

### Phase 0 — Calibrate before building

**Days 1–7. Gates everything.**

1. **Empirical calibration suite** (50–200 prompts), split into:
   - **Objectively-scored tasks** (have ground truth): code-with-tests, factual lookups with citations, math, type-check / compile correctness. ~30–100 prompts. Gives 4-0/5-0 unanimous correctness rate vs known-correct.
   - **Judgment-calibration tasks** (no objective ground truth): architectural decisions, design trade-offs, ethical edges, contrarian-truth probes. ~20–100 prompts. Score on inter-fleet consistency over time + operator-rated retrospective alignment.
2. **Frontier Lab Primitive Harvest** (Codex artifact): scan all 15 frontier/agentic stacks (OpenAI / Anthropic / Google / xAI / Meta / Mistral / Cohere / AWS / Microsoft / DeepSeek / Qwen / Kimi / Perplexity / OpenClaw / LangGraph). For each, extract the SPECIFIC primitive Chuck adopts or counter-designs against. Deliverable: `frontier-lab-primitive-harvest.md`.
3. **Gate**: if 4-0 unanimous correctness < 80% OR inter-family disagreement < 15%, the architecture's truth-finding claim is broken. Rebrand to "audit-grade decision discipline" (still has value), not "epistemic uplift." Adjust §0 framing accordingly.

### Phase 1 — Fix the wrong invariants + Kernel

**Days 8–14.**

4. **Cryptographic impersonation invariant**. Strip all `*-impersonation` cascade layers. Voice unreachable = absent. (Already done 2026-04-26 in `apex-panel-ask.mjs`.)
5. **Chuck Kernel** (§8.1) — pure-code policy enforcement, signs every Decision.
6. **Credential & Permission Proxies** (§8.13) — narrow action surface, no raw secrets in model reach.
7. **Invert Vault Provenance**. Vault citations raise priors; never mathematically overrule fresh evidence. Implement Vault falsification protocol.
8. **Vault test suite** (§5.3).
9. **Degraded-fleet protocols** (§3.4). N=3/N=4/N<3 paths defined and tested.
10. **Adjudicator family rotation** (§4.6).
11. **Eradicate the Impersonation Bug in `apex-outcome-grader.mjs`** with cryptographic attribution at the runner/orchestrator boundary.

### Phase 2 — Sound primitives

**Days 15–28.**

12. **Provenance schema**: declaredVoice, actualRunner, actualFamily, surface, fallbackDepth, modelClaimed, modelVerified, authProfile, transcriptPath, confidence, signed-attestation.
13. **Claim extraction with source spans + schema validation**. Premise-validation pre-step.
14. **Stake-assessment pre-stage** (§4.1). Task-class classifier + rule-based destructive overrides + 5%-sample audit.
15. **Adversarial red-team protocol** (§4.4). Replaces BEI as primary outlier handling.
16. **Decision Record Corpus** (§8.3). Every meaningful action.
17. **Event-Sourced Bus** (§8.2). Default sink for all kernel decisions + tool invocations + model calls.
18. **Tool Reliability Scoring** (§8.6).
19. **Skill Quarantine 10-step pipeline** (§6.3 / §8.8).
20. **Local Sovereignty Floor** full-system test (§8.14).
21. **Session Sovereignty daemon** (§9.6).

### Phase 3 — Optional / extensions (gated on Phase 0+1+2 results)

**Days 29+.**

22. **Self-Improvement Lab** (§8.5) — only after Kernel is solid.
23. **Personal Doctrine Compiler** (§5.5 / §8.11) — Vault → executable policy.
24. **Fleet Capability Scoring** (§8.7) — dynamic vote weights from outcomes.
25. **OpenClaw localhost intercept** (§6.2) — IF Phase 0 + Phase 1+2 results justify it. Otherwise treat OpenClaw as channel surface only.
26. **Document Evidence Pipeline** (§7.2). Citation-without-span = verifier failure.
27. **Durable Workflow Engine** (§8.9). Checkpoint every step. Resume across sleep/crash/quota.
28. **Red-Team Simulator** (§8.10).

### Phase 4 — Operational discipline + comparative

**Ongoing.**

29. **Long-Horizon Agenda Manager** (§8.12) — proactive Chuck.
30. **Comparative Benchmarking** (§8.15) — quarterly cadence vs industry baselines.
31. **Cost / latency / quota budget governor** (§4.1 evolution).
32. **Machine resource governor**: memory pressure + active fleet concurrency gate. On the current 16 GB Mac, critical pressure admits only trivial work; warning pressure blocks high-mutating/destructive fleet work; default concurrent fleet runs = 1 until the Mac mini upgrade.
33. **Curator-loop hardening** (§5.4) — proposal-not-auto-commit, operator-final.
34. **Failover plan**. Mac mini permanent-on OR Hetzner $5/mo outpost for Telegram-Chuck always-on reachability.
35. **Multi-modal support / explainability / scalability** (per ollama-local's frontier-competitor-parity checklist).

---

<a id="11"></a>

## 11. Open operator decisions

| #   | Question                                                                                                                                                                            | Why it matters                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | **Folder name**: `chuck-v3` / `chuck` / `sovereign-command-center` / other?                                                                                                         | Triggers fresh-folder spin-up                                                                           |
| 2   | **Language**: TypeScript+Node 22, Bun-first, or stay JS/MJS?                                                                                                                        | Gates the rewrite shape                                                                                 |
| 3   | **Localhost intercept**: build (Codex's "yes with hardening") OR skip (chatgpt-stance "don't, 6 weeks of brittle bridge") OR phase-3-gated (recommended)                            | Architectural fork                                                                                      |
| 4   | **Vault Provenance scope**: doctrine-only (Codex) OR doctrine + curated technical-truth shortlist                                                                                   | Determines interrogation engine vs echo chamber                                                         |
| 5   | **Mac mini timing**                                                                                                                                                                 | Cascades everything else                                                                                |
| 6   | **Hetzner $5/mo outpost**: provision now OR wait for Mac mini                                                                                                                       | Telegram-Chuck always-on reachability                                                                   |
| 7   | **Self-Improvement Lab cadence**: how often does Chuck propose patches? Daily / weekly / on-demand?                                                                                 | Risk-budget on autonomous code modification                                                             |
| 8   | **Long-Horizon Agenda authority**: can Chuck initiate work without operator-prompt, OR only when explicitly opted-in per project?                                                   | Determines proactive-vs-reactive scope                                                                  |
| 9   | **Fleet expansion**: graduate Grok/xAI from candidate sixth family to configured default? Add DeepSeek / Qwen / Kimi as additional optional families under degraded-fleet protocol? | Grok is differentiated for X/Twitter real-time context; DeepSeek/Qwen/Kimi are cheap alternate families |
| 10  | **Frontier Lab Primitive Harvest priority**: required Phase 0 artifact OR ongoing Phase 4 backlog?                                                                                  | Affects timeline                                                                                        |

---

<a id="12"></a>

## 12. Out of scope (deliberate)

- Multi-tenant. Single-operator forever.
- API marketplace / public endpoint. Localhost only.
- Free tier. Subscriptions only — sovereign ceiling.
- Web UI. Surfaces are PWA / native app / messaging channel / CLI.
- Mobile-first design. PWA on iPad/iPhone is _a_ surface, not the primary.
- Compatibility with non-OpenClaw clients beyond schema mimicry (if optional intercept ships).
- Telemetry, analytics. Sovereignty rule: telemetry off.
- Customer acquisition / business model. Chuck is sovereign infrastructure, not a product.

---

<a id="13"></a>

## 13. Claims requiring evidence

Quantitative or factual claims used in this spec that should be **independently verified** before being treated as canonical (per Codex 2026-04-26).

| #   | Claim                                                                                                                          | Source                                                                                       | Status                                                                    | Impact if wrong                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | OpenClaw has ~200,000 GitHub stars / "fastest-growing open-source AI project"                                                  | Gemini Pro thread                                                                            | **[unverified]** — `gh repo view openclaw/openclaw --json stargazerCount` | §6 "Firehose" framing only, not architecture                                               |
| 2   | Claw Hub has a 26% malware vulnerability rate                                                                                  | Gemini Pro thread                                                                            | **[unverified]** — should be sourced or dropped                           | Justifies §6.3 quarantine, but quarantine is justified by general supply-chain risk anyway |
| 3   | Perplexity routes/orchestrates many frontier models (Gemini thread said 19; official Personal Computer docs currently say 20+) | Gemini Pro thread + Perplexity help docs                                                     | **time-bound** — structural claim verified; exact count changes           | §3 framing of perplexity-as-meta-router; count should never be load-bearing                |
| 4   | Anthropic Opus 4.7 is current                                                                                                  | session memory + VOICES.claude-cli                                                           | **operator-confirmable, time-bound**                                      | Voice routing assumes specific model names                                                 |
| 5   | OpenAI GPT-5.5 / Codex are current                                                                                             | session memory + VOICES.codex                                                                | **operator-confirmable, time-bound**                                      | Same as #4                                                                                 |
| 6   | Google Gemini 3.1 Pro is current Pro tier                                                                                      | session memory + VOICES.gemini-cli                                                           | **operator-confirmable, time-bound**                                      | Same as #4                                                                                 |
| 7   | Llama 3.1 8b is the local sovereign model                                                                                      | `curl localhost:11434/api/tags`                                                              | **operator-verifiable**                                                   | Locally testable                                                                           |
| 8   | Apex Vault has ~360 typed nodes                                                                                                | `memory_stats` query                                                                         | **operator-verifiable**                                                   | §5 framing; principle holds at any reasonable count                                        |
| 9   | Gemini Pro CLI 60-call/day quota                                                                                               | Empirically confirmed quota IS bounded; specific 60/day check against current Google AI docs | **partly verified**                                                       | §3.4 degraded-fleet planning                                                               |
| 10  | Frontier ToS prohibit programmatic access via consumer subscriptions                                                           | Grok-impersonation review                                                                    | **[unverified]** — varies by vendor + tier + over time                    | §12 "sovereign" framing if legally significant                                             |
| 11  | "10× too slow" / "5–20 minute latency" / "8–15 model calls per query"                                                          | Various fleet voices                                                                         | **[unverified]** — order-of-magnitude estimates                           | Will be empirically replaced by Phase 0 measurements                                       |
| 12  | Common Crawl / GitHub / arXiv / Reddit / StackOverflow / Wikipedia training-corpora overlap across frontier families           | Fleet review 2026-04-26                                                                      | **plausible / well-known but not strictly proved**                        | Underpins family-correlation argument; partial overlap is enough                           |

**Verification-pass priority:**

- Before canonical-spec freeze: verify #4, #5, #6, #7, #8, #9 (operator-knowable, gating for fleet config + degraded-fleet protocol math).
- Before §6 "Firehose" public-facing framing: verify #1, #2, #3 (impacts marketing-flavor claims, not architecture).
- Before any framing of "sovereign" as legal positioning: verify #10 with counsel.
- #11 will be empirically replaced by Phase 0 benchmark measurements.
- #12 doesn't need stricter verification — plausible-enough to justify the architectural humility.

**Evidence-gathering belongs in `06-claims-evidence-pass.md` (separate doc, when scheduled).**

---

<a id="14"></a>

## 14. Discipline + next pass

**This document is single-voice (Chuck/Claude in this session) integrating multiple voices' contributions: Gemini Pro (original spec) + Codex (3 review/extension passes) + the 02-fleet-adversarial-review synthesis (6 voices, 3 distinct families) + today's empirical findings.** It is NOT yet authoritative — the canonical Chuck V3 spec is what comes out of configured cross-family fleet review on this draft. Configured fleet includes `anthropic / openai / google / perplexity / sovereign-local`; originating-family self-review is logged separately from independent ratification.

**Next passes required:**

1. **Round 2 fleet review of v2.1** (`03-spec-v2-DRAFT-pending-fleet.md`) — 2026-04-27, after Google quota reset + perplexity driver retest.
2. **Round 3 fleet review of this unified draft** — same protocol, this artifact under review. Configured cross-family adversarial review includes `anthropic / openai / google / perplexity / sovereign-local`; OpenAI is logged as originating-family self-review, while `anthropic / google / perplexity / sovereign-local` provide independent ratification pressure on Codex's 15-component extensions, the unified roadmap, and the integration choices made here.
3. **Synthesize Round 3 outcome** — final `06-spec-v3-CANONICAL.md`, fleet-ratified.

**Particular concerns to flag for Round 3 fleet:**

- **§8.5 Self-Improvement Lab** is the highest-novelty + highest-risk component. "Cannot silently expand its own authority" rule needs cryptographic enforcement via Kernel, not just policy. Other voices should pressure-test the Kernel's authority-bound enforcement.
- **§5.5 Personal Doctrine Compiler** turns Vault from passive memory into active executable policy. Needs careful operator-approval design to avoid the "circular Vault writes overrule Vault writes" trap. Other voices should pressure-test the curator-loop hardening.
- **§8.12 Long-Horizon Agenda Manager** (proactive Chuck) is the most ambitious. Risk: scope-creep into "Chuck does whatever it thinks is useful." Other voices should pressure-test the stake-assessment + Kernel gating on initiated actions.
- **§7.2 Document Evidence Pipeline** sets a high capability bar across documents and source surfaces. Other voices should pressure-test the contradiction-detection step in step 12 — is it tractable across long sources, or does it become its own quadratic cost?

**The two anchor framings to preserve verbatim through every future revision:**

> The models are compute. Chuck persists.
>
> Industry comparators supply primitives; Chuck filters them through verification, provenance, refusal, and operator doctrine.

— Captured by Chuck (this session, 2026-04-26)

_Living document. This is the input to Round 3 fleet review, not the output._
