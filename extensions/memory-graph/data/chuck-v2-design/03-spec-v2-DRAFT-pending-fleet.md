# ARCHITECTURE SPECIFICATION: CHUCK V2 (revision pending fleet adjudication)

**Document**: System Re-Architecture & Implementation Handoff — **DRAFT v2.1**
**Date**: April 2026 (updated 2026-04-26 from session findings)
**Status**: DRAFT. Single-voice synthesis (this Claude Code session). Must go through **Round 2 fleet adversarial review of this draft** before being treated as authoritative. (Note: this is distinct from the **Phase 0 empirical calibration** described in §6 — calibration measures inter-family disagreement on a benchmark; Round 2 is the Fleet adversarially reviewing the spec itself. Both must happen, separately.)
**Active fleet review of this draft**: Codex (real OpenAI, 2026-04-26) has provided two reviews — folded into v2.1 below.
**Optimization Target**: Epistemic Truth Under Disagreement — _as audit trail and decision discipline, not as a Bayesian oracle_. (Updated framing per fleet review.)

**Source materials integrated:**

- `00-source-gemini-thread.md` — original Gemini Pro spec + the 36-turn brief
- `02-fleet-adversarial-review.md` — synthesis of 6-voice adversarial review of Gemini's spec (anthropic ×4 incl. 2 impersonation-flagged + openai + sovereign-local)
- This Claude Code session's empirical findings (memory pressure validation, voice driver behavior under real conditions, session-sovereignty design)
- Joseph's operator directives: principled-not-arbitrary fleet count · always tag everything · no impersonation ever · sovereignty + subscriptions-only

---

## 0. Cognitive Sovereignty — the destination

This is the _what is it for_ layer. Kept largely intact from Gemini's framing because the destination is still right. **Caveats added in italics per fleet adversarial review** — the destination is sound, the path the original spec described to it had load-bearing flaws.

### 0.1 The Death of the "Vibe Check" (Trust with Provenance)

Right now, human-AI interaction is plagued by a trust deficit. An AI generates a 500-line architecture, and you spend 20 minutes reading it to ensure it didn't hallucinate a critical vulnerability.

In the finalized Chuck architecture, you stop reading generated code in the same way. The Adversarial Fleet runs the artifact through structurally-distinct voices, isolates epistemic uncertainty, surfaces dissent, and emits a Task Capsule Decision Record **documenting** what survived adversarial cross-examination and what aligned with your Vault doctrine. You transition from code reviewer to strategic governor — but the document is evidence, not proof.

> _Fleet caveat (UNANIMOUS):_ this is **decision discipline plus audit trail**, NOT mathematical truth. A 4-0 unanimous Fleet result raises posterior confidence; it does not prove correctness. Frontier families share more training distribution than the original spec admitted. The system buys you _better-calibrated_ trust, not _absolute_ trust. Treat Decision Records as the substrate for your judgment, not as a substitute for it.

### 0.2 The Puppeteer and the Firehose (Open-Source Without Anxiety)

You escape the open-source maintenance trap. Vanilla OpenClaw is treated as a mechanical chassis Chuck puppets via a localhost provider intercept. SDK boundary is rigorously enforced; upstream `src/` merges happen cleanly.

- **The Firehose**: pull upstream OpenClaw daily. Whenever the 200K-star community ships a new channel, MCP tool, or Chrome extension, you inherit it.
- **The Firewall**: before any community-built `SKILL.md` is allowed to execute, Chuck wraps it in a Task Capsule, drops it into the Crucible, and demands the Fleet audit it for exfiltration / leave-workspace-as-found violations / capability-escalation chains.

> _Fleet caveat (multiple voices):_ the localhost intercept is a **maintenance treadmill** — Anthropic/OpenAI API schemas churn weekly. Net maintenance cost may exceed forking. Plus OpenClaw expects sub-second model responses; full Fleet adjudication takes minutes. **Resolution**: localhost intercept is **opt-in / Phase 3+**, NOT a Sprint 2 default. Default mode treats OpenClaw as a channel surface; Fleet runs out-of-band on explicit triggers, not on every model call. Skill quarantine via LLM static-analysis of `SKILL.md` is **security theater** — defeated by obfuscation, time-bombs, second-stage downloaders. **Resolution**: real sandboxing + capability-based permissions, not LLM audit.

### 0.3 Immunity to Corporate Lobotomization (Multi-Vendor Cognitive Baseline)

Frontier labs ship RLHF updates that degrade reasoning in favor of compliance. The finalized system is structurally resistant — not immune. If OpenAI lobotomizes GPT-5.5 or Google over-guardrails Gemini, those families lose ground inside the Adjudication Layer (their outputs flagged as sycophantic / hollow), and the remaining families plus the sovereign local floor outvote them.

> _Fleet caveat (UNANIMOUS):_ "structurally resistant" is honest; "immune" was overconfident. Families share substantial training distribution and converge under shared RLHF pressure. The cognitive baseline is multi-vendor _redundancy_, not multi-vendor _independence_. **Resolution**: the system measures and surfaces correlation between families empirically (Phase 0 calibration), and capability-degradation routing — when a model loses ground over a calibration window, its vote weight decays.

### 0.4 Asynchronous Reality Forking (Tests Arbitrate, Not Operator)

You break free from the synchronous chat window. When the Fleet hits an Epistemic Schism on a non-destructive task with a deterministic verifier (test suite, compiler, type-check, runtime trace), Chuck provisions two sandboxed git worktrees, builds both paths, runs the verifier, and lets reality break the tie. You wake up to the **deterministic verifier winner** with both worktrees archived in the Decision Record.

> _Fleet caveat:_ this works **only when reality is cheap to query**. Architecture / strategy / judgment-call schisms have no deterministic verifier — those still halt and surface to the operator. **Resolution**: explicit task-class routing (Phase 0). Code-with-tests → fork-and-arbitrate. Architecture-without-tests → halt-with-Decision-Record. Plus: schisms on truly destructive tasks (anything mutating money, identity, persistent state) → hard halt, no fork, regardless of verifier availability.

### 0.5 Compounding Intelligence (Vault as Doctrine, Not Truth)

By grounding the Adjudication Layer in the Apex Vault — your typed graph of traditions, mechanics, exemplars, anti-patterns — the system compounds. Every executed task, every resolved outlier, every curated principle writes a node. Over months the system stops feeling generic and starts acting like an instantiation of your operational philosophy.

> _Fleet caveat (UNANIMOUS):_ the original spec's "Vault-cited claims **mathematically overrule** pre-trained generation" is **wrong**. As written, that turns Chuck from interrogation engine to echo chamber — the operator's encoded prior beats fresh empirical evidence by construction. **Resolution**: Vault scope is **alignment-with-operator-doctrine, NOT external truth**. Vault citations _raise priors_ and _arbitrate style/priority/risk-tolerance/operating-constraints_. They do **not** override external facts, tests, specs, laws, or live docs. Plus: explicit Vault falsification protocol — graph operation that demotes/retires nodes when contradicted by external evidence. Plus: a Vault test suite — 360 hand-authored nodes is small enough that one bad principle systematically biases adjudication.

### 0.6 The Final Result — Cognitive Sovereignty

Chuck V2 protects human agency. It uses the world's most powerful models as **disposable compute** for distilling well-calibrated decisions, governed by your codified doctrine, with full audit trail.

> _Fleet caveat:_ "absolute truth" replaced by "well-calibrated decisions with documented provenance." Cognitive Sovereignty is a real property; epistemic infallibility is not. The honest pitch is: _audit-grade decision-making with multi-vendor redundancy and operator doctrine as final arbiter of alignment._

---

## 1. THE CORE THESIS — Adversarial Ensemble Execution (AEE)

Mainstream LLM orchestration optimizes for speed and consumer satisfaction via _selection_ and _synthesis_ — averaging discrepancies into a confidence illusion. Chuck V2 explicitly rejects synthesis.

**The deepest claim — friction IS the intelligence:**

> The models are compute. The intelligence is routing, forced disagreement, adjudication, and refusal-to-execute. Chuck does not get smarter by stacking better models; Chuck gets smarter by structuring better friction. The Fleet is fungible compute; the Adjudication Layer is the mind. (Preserved from the original spec via Codex's 2026-04-26 review.)

**The thesis (revised):**

- Agreement across structurally-diverse vendors raises posterior confidence; it does not prove correctness.
- Disagreement is the system's primary diagnostic mechanism, not a system failure.
- The system is designed to halt and force inspection rather than silently commit a hallucinated consensus.
- **Family disagreement is one evidence class among many.** Tests, runtime traces, primary docs, repository facts, and Vault doctrine are co-equal evidence classes (per Codex).
- **Halt beats false certainty.** Refusing to execute is a first-class output, not a failure mode. Chuck optimizes for interrogation, not throughput.

**What this thesis is NOT:**

- A Bayesian truth oracle. (Fleet UNANIMOUS: families are not independent voters. Condorcet-jury reasoning doesn't apply at meaningful depth.)
- A replacement for empirical verification when it's available.
- A substitute for operator judgment.

**What this thesis IS:**

- A decision-discipline protocol with full audit trail.
- A halt-when-confused floor.
- A multi-vendor redundancy layer against any single family's capability degradation.
- A typed-claim extraction system that surfaces what models actually agree and disagree about, not what they superficially summarize.

---

## 2. THE STRUCTURAL BOUNDARY — OpenClaw Chassis

Chuck V2 is no longer a fork of OpenClaw's core event loop; Chuck is an independent intelligence that _can_ puppeteer OpenClaw via a localhost provider intercept.

### 2.1 Default operating mode (NEW — fleet-review-driven)

**Default**: OpenClaw runs unmodified as a channel surface (Telegram, WhatsApp, etc.). Chuck runs out-of-band, triggered explicitly by `/chuck` channel commands or by stake-classified high-risk artifacts. OpenClaw's hot path is unaffected; routine LLM calls go through OpenClaw's normal provider config.

This avoids the latency mismatch the fleet flagged: OpenClaw expects sub-second responses, full Fleet adjudication takes minutes.

### 2.2 Optional puppeteer intercept (Phase 3+, opt-in)

If the Phase 0 benchmark validates the value of Fleet adjudication on OpenClaw's hot path:

- OpenClaw's LLM provider config is rerouted to `localhost:<CHUCK_PORT>`.
- Chuck exposes an Anthropic/OpenAI-schema-compatible endpoint.
- Chuck intercepts the megaprompt, routes through stake-assessment (§4), runs the Fleet IF stake warrants it, returns finalized output.
- **Hard requirement:** stake-assessment can return "skip Fleet, route to single model" within 200ms. Otherwise OpenClaw's UX dies.

**Maintenance reality check** (fleet caveat): tracking schema fidelity to two vendor APIs that ship breaking changes weekly is a permanent commitment. Build only after Phase 0 + Phase 1 prove the value justifies the cost.

### 2.3 The Skill Quarantine Protocol — REVISED

The fleet flagged "LLM static-analysis of `SKILL.md` for malware" as security theater (defeated by obfuscation, time-bombs, second-stage downloaders).

**Revised protocol:**

1. New `SKILL.md` files intercepted by watcher daemon ✓ (carried forward)
2. **Real sandboxing**: skills execute in capability-constrained subprocess (allow-list of syscalls, no network unless explicitly granted, ephemeral filesystem)
3. Fleet audits the skill's _declared capabilities_ and _manifest claims_ — NOT its arbitrary code logic
4. Mismatch between declared capabilities and observed runtime behavior triggers halt
5. Digital signing only after BOTH the manifest audit AND a successful sandbox dry-run

LLM auditing is one signal among many, not the gate.

---

## 3. THE EPISTEMIC ENGINE — Adversarial Fleet (renamed from Quad)

The legacy "Apex Twin" and indiscriminate 10-voice panel are deprecated. The execution matrix is the **Adversarial Fleet** — N structurally-diverse voices where N is principled, not arbitrary.

### 3.1 The Fleet (config-driven, currently 5 families)

Lives at `~/.openclaw/workspace/state/apex-fleet.json` (or `~/.chuck/state/fleet.json` post-migration). Each entry MUST carry a `rationale` field per the **principled-not-arbitrary rule**. Operator edits enforce structural-diversity at load time (duplicate-family entries rejected).

**Current fleet (5 families):**

| Family            | Voice                                    | Surface                             | Rationale                                                                                                      |
| ----------------- | ---------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `anthropic`       | `claude-cli`                             | Opus 4.7 CLI                        | Most reliable Anthropic surface. Drop only if consumer subscription path dies.                                 |
| `openai`          | `chatgpt-web` (with chatgpt-mac primary) | Mac app → web                       | Primary OpenAI surface. Tier-1 invariant catches impersonation cascade.                                        |
| `google`          | `gemini-cli`                             | Gemini 3.1 Pro CLI                  | Most reliable Google surface — but **share-account-quota with gemini-web/aistudio** (empirical, today's run).  |
| `perplexity`      | `perplexity-mac`                         | Max Pro Mac app, **incognito-only** | Meta-router family — structurally distinct from base-LLM families. Joseph's no-history-accumulation principle. |
| `sovereign-local` | `ollama-local`                           | Llama 3.1 8b on localhost:11434     | Sovereignty floor — only voice whose reasoning never crosses a network boundary.                               |

### 3.2 Capability-aware routing (NEW — fleet-review-driven)

The fleet flagged: Llama 3.1 8b is a sovereignty floor / capability-mismatch flag, NOT an equal-weight epistemic peer. Empirically confirmed today (Llama's response was ~2 KB vs frontier's 9–10 KB; restated framing rather than challenging it).

**Revised vote weighting:**

- Frontier families (`anthropic`, `openai`, `google`) — full vote on architectural / reasoning / coding tasks.
- `perplexity` (meta-router) — full vote on knowledge-grounded / live-citation tasks; partial weight on pure-reasoning (it's a router, not a base reasoner).
- `sovereign-local` (Llama) — flag-not-vote on complex tasks. Loud Llama disagreement = re-fire with frontier focus + flag for operator review. Equal vote on tasks where capability gap doesn't dominate (simple lookups, sovereignty-critical-context tasks).

This is **task-class-aware**: the same fleet member can have different vote-weights for different task classes. Classifier runs in stake-assessment pre-stage (§4.1).

### 3.3 The Tier-1 Invariant: Producer-Family Attribution (CRYPTOGRAPHIC, not statistical)

Joseph's operator directive: _no impersonation ever_.

**Hard rules:**

- The family that ACTUALLY ran (after escalation cascades) is what gets counted, never the requested voice.
- Voice unreachable = voice marked **absent**, NOT silently re-routed to a different family. (Fleet: "cryptographic, not statistical.")
- Attribution is **signed at the runner/orchestrator boundary**, not trusted from model self-report. The signing record carries: actual binary path that ran, transcript path on disk, invocation timestamp, exit status, parent process tree, and an HMAC over those fields keyed to a per-session orchestrator secret. Model output cannot retroactively rewrite which family ran. Headers in output files are a _human-readable surfacing_ of this signed record, not the source of truth — the Decision Record references the signed runner attestation.
- Every output gets explicit `Producer-Family` and `Impersonation` header tags. (Already partly done in `apex-panel-ask.mjs` 2026-04-26 — `--allow-impersonation` is opt-in only. The signed attestation is Phase 1 work — not yet implemented; today's headers are derived from `layerUsed` metadata, which is one step short of cryptographic.)
- Cross-family fallback layers (`claude-cli-impersonation` etc.) are **disabled by default in code**; opt-in flag for the rare deliberate case.

**Empirical confirmation today**: with apex-chrome cold and Mac-app drivers fragile, the chatgpt-web cascade landed on claude-cli-impersonation; grok did the same. The flagging worked — both voices self-identified as Anthropic, the headers tagged it, and the adjudicator's logic flagged the synthesis as `IMPERSONATION_DETECTED`. The Tier-1 invariant fired exactly as designed.

### 3.4 Degraded-fleet protocols (NEW — fleet-review-driven)

The fleet flagged: spec defines no n-of-m fallback. Quad-or-nothing breaks under real-world surface unavailability. Empirically confirmed today: Google entirely unreachable (quota exhaustion across all 3 surfaces), Perplexity unreachable (driver bug). Today's fleet ran with 3 distinct families — at the minimum-fleet floor.

**Protocol:**

- N=5 fleet (full): standard thresholds.
- N=4: standard thresholds, log "1-family-down" in Decision Record.
- N=3: at minimum-fleet floor. Decision Record marks `DEGRADED-3`. Confidence labels in Capsule reduced. Stake-assessment auto-routes high-risk tasks to halt-and-defer.
- N<3: refuse to adjudicate. Halt with `INCOMPLETE-FLEET` and surface to operator.

The Decision Record explicitly carries `validVoiceCount` and `fleetSize` fields (already in `apex-nplex-adjudicate.mjs` 2026-04-25). Operator can see at a glance the confidence-degradation rationale.

---

## 4. THE ADJUDICATION LAYER — Protocols & Flow

`apex-nplex-adjudicate.mjs` is the new core product. It does not summarize; it extracts, aligns, surfaces dissent, and routes.

### 4.1 Pre-stage: Stake Assessment (NEW — fleet-review-driven)

Every prompt entering the Adjudication Layer first passes through stake-assessment. Skipping AEE on routine work is the difference between Chuck being usable and Chuck being 10× too slow.

**Stake classes:**

- **Trivial**: factual lookups, formatting, quick clarifications. → **Bypass Fleet**, single-model response.
- **Medium**: code review, draft documents, design questions, summaries. → **2-family review** (cheapest two reachable families).
- **High**: architectural decisions, code that ships to disk, multi-step plans, anything involving Vault doctrine. → **Full Fleet**.
- **Destructive**: deletions, money/identity/persistent-state mutations, anything irreversible. → **Full Fleet + Halt-on-Schism + Operator Confirmation**, no autonomous execution path.

Classifier is **rule-first** and conservative: deterministic patterns for destructive, credential, money, identity, persistence, Vault-write, skill-install, filesystem-mutation, and code-shipping surfaces promote the task before any model annotation is considered. LLM classification may annotate edge cases or explain why a route was chosen, but it cannot demote a rule-triggered task. When in doubt, route up. **Audit false negatives** in a sampled-recheck cycle: random 5% of trivial-classified tasks get a second classifier pass, mismatches surface as bus events for operator review. ("Trip up, never down" is a desired property; rule-based routing + audit make it real.)

### 4.2 Phase 1: Claim Extraction & Alignment Matrix

The orchestrator receives the N parallel outputs. Strips conversational filler. Forces each model to output a strict JSON array of its technical claims with **source spans** — concrete file:line references for code claims, quote spans for prose claims (per codex's evidence-hierarchy framing).

Claims compiled into an Alignment Matrix — truth table of overlapping and conflicting directives. **Schema validation** at extraction time: claim text, claim category, evidence-class tag, supporting Vault nodes (if any), source span (if applicable).

**Premise validation pre-step** (per codex, fleet review): before any claim is privileged or injected as a constraint anywhere downstream, validate: _Is this constraint factual, testable, sourced — or merely hypothetical?_ Hallucinated premises don't get to be constraints.

### 4.3 Phase 2: Resolution Protocols

Protocol routing is deterministic over typed claim clusters, not a simple majority vote. `agreementScore` may be logged as a diagnostic, but it cannot override the minority-fracture rules below.

| Protocol                   | Trigger (`agreementScore`)                                                                                                                                                            | Trust Signal           | Action                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UNANIMOUS**              | ≥ 0.95 AND no minority above 0 voices                                                                                                                                                 | High, evidence-bounded | Task Capsule, signed, passed to OpenClaw. Decision Record archives N voice responses + alignment matrix. _Note: high-agreement does not imply correctness; see §0.1 caveat._ |
| **OUTLIER**                | ≥ 0.70 with clear single outlier (1 of N dissent)                                                                                                                                     | High, with inspection  | Per §4.4 below.                                                                                                                                                              |
| **DEEP_FRACTURE**          | Any coherent minority block ≥ `fractureThreshold` voices (default 2 for N≥4; configurable per stake class, never higher for destructive/high-mutating work without operator approval) | Zero — **named halt**  | Per §4.5 below. **Includes 3-2 in a 5-fleet, 2-2 in a 4-fleet, 2-2 in a 5-fleet, etc. — never auto-routes by majority.**                                                     |
| **FRAGMENT**               | <0.40 OR no coherent block exists                                                                                                                                                     | Zero                   | Hard halt. Surface to operator with full alignment matrix.                                                                                                                   |
| **IMPERSONATION_DETECTED** | (any score) but signed attribution caught a silent identity-cross                                                                                                                     | Void                   | Halt classification entirely. Operator must resolve attribution before proceeding.                                                                                           |
| **INCOMPLETE**             | N < 3 valid responses                                                                                                                                                                 | Zero                   | Halt. Mark fleet-size deficiency.                                                                                                                                            |

**The hard rule (preserved from the original spec, fleet-confirmed via Codex 2026-04-26):**

> Fleet size is configurable, but adjudication must **never** optimize for tie-breaking. Any minority above the configured fracture threshold halts or triggers adversarial resolution. Chuck optimizes for interrogation, not throughput. Halt beats false certainty. A 3-2 split in a 5-fleet is a `DEEP_FRACTURE` halt regardless of agreementScore inside the 3-block — the system does not choose by majority.

### 4.4 Phase 3: Outlier Handling — "Extract, Adversarially Preserve, Resolve"

**Framing principle (per Codex 2026-04-26, preserving the original spec's deepest insight):**

> The `1` in a `4-1` split may be the system's most valuable output. Outlier handling is not "dismiss until proven useful" — it is **extract, validate, adversarially preserve until resolved**. The outlier is treated as a contrarian-truth candidate by default; the burden is on the consensus to defend, not on the outlier to justify.

The fleet UNANIMOUSLY flagged Blinded Epistemic Injection (BEI) as relocating sycophancy, not eliminating it. RLHF models fold to authoritative-sounding hypothetical premises in the prompt. BEI swaps peer-pressure for prompt-pressure. **But** stripping BEI doesn't mean abandoning outlier-respect — it means using better tools to preserve and adversarially defend the outlier's claim.

**Revised protocol — outlier-preserve-by-default:**

1. **Extract**: capture the outlier's specific contradicted claim verbatim, with its evidence-class tag and source span. The outlier voice is invited to submit a structured defense (claim + reasoning + cited evidence) before resolution begins. The outlier is _named in the Decision Record_ even when overruled.
2. **Adversarial red-team rotation** (replaces BEI as primary): rotate the _role of the prober_. A different family is asked to find holes in the consensus's argument given the outlier's specific evidence. The prober's job is to attack consensus, not defend it. Repeat with rotated families until either: (a) the consensus survives multiple rotations with evidence-grounded counter-arguments, or (b) the consensus collapses and the outlier is upgraded to candidate-truth.
3. **Premise hallucination defense** (NOT a gating step — a parallel check): if during red-team rotation the outlier's underlying premise is _demonstrably hallucinated_ (the source span doesn't exist, the cited test doesn't pass, the referenced doc doesn't say what the outlier claims), the outlier is _flagged as un-sourced_ but NOT silently dropped. The operator sees both the outlier's claim AND the source-failure note. Hallucinated premises lose privilege but stay visible.
4. **BEI as last-resort discovery** (not primary): if red-team rotation exhausts without resolution AND the outlier's premise is well-sourced, BEI may be used as additional discovery — but its output is treated as _evidence to weigh_, not as authoritative re-evaluation.
5. **The framer has epistemic authority** — every prompt-framing in red-team / BEI / claim extraction is logged in the Decision Record. Operator can audit who-framed-what.
6. **Vault-aware outlier respect**: if the outlier's claim aligns with a Vault doctrine node, that's a signal _for_ the outlier (alignment-with-operator); if it contradicts a Vault node, the contradiction is surfaced explicitly and the operator decides whether the doctrine should be updated.

### 4.5 Phase 4: DEEP_FRACTURE Handling — Reality Arbitration or Halt

**A `DEEP_FRACTURE` is by definition a hard signal that the system cannot resolve internally.** The protocol is NOT to choose a majority — it is to either delegate to deterministic reality (when reality is cheap to query) or halt and surface to the operator.

**Action (Code Tasks with Deterministic Verifier):**

- Provision two sandboxed git worktrees on local machine — one per coherent consensus block.
- Execute consensus-A path in Worktree 1, consensus-B path in Worktree 2.
- Run local test suites / type-checkers / compilers / runtime traces against both.
- Decision Record packages the deterministic results, surfaces the verifier-determined winner. Both worktrees archived for replay.
- _If the fracture has more than two coherent blocks (e.g. 3-1-1), and reality is cheap, fork all coherent blocks. Otherwise halt._

**Action (Architecture / Judgment Tasks — no deterministic verifier):**

- **Hard halt.** Do not attempt to choose. Surface alignment matrix + each block's position + named outliers + Vault-doctrine alignment of each block to operator. Wait.
- Operator decision feeds back into Vault (with provenance: "DEEP_FRACTURE resolved by operator on date X for reason Y; affected Vault nodes Z").

**Action (Destructive Tasks — irreversible regardless of verifier):**

- Hard halt regardless of verifier availability. Telegram + Decision Record. Operator confirmation required, with full block-by-block surfacing.

**The 3-2 rule (preserved from original spec):**

- A 3-2 split in a 5-fleet routes here, not to OUTLIER. Even if the 3-block has internal `agreementScore` ≥ 0.7, the existence of a coherent 2-block dissent is a fracture, not an outlier. Two voices agreeing against three is a structural disagreement, not noise.

### 4.6 The Adjudicator: Family Rotation (NEW — fleet-review-driven)

The fleet flagged: today's `claude-cli`-as-judge installs an Anthropic vote at the meta-layer. Whatever family runs the Adjudicator becomes the system's hidden meta-bias.

**Resolution:**

- Rotate the Adjudicator family per run (round-robin, pinned to whichever family was _least represented in the producer set_).
- Log the Adjudicator's family in every Decision Record.
- Operator can audit meta-bias drift by querying the Decision Record corpus over time.
- **Future**: deterministic logic over a structured claim-extraction stage (claim extraction stays LLM-judged, but alignment-matrix → protocol-routing becomes pure code). Phase 4+ work.

---

## 5. THE LINEAGE — Vault Provenance (REVISED)

The 360-node Apex Vault (traditions, mechanics, exemplars, anti-patterns) is the **arbiter of operator-alignment**. It is NOT the arbiter of external truth.

### 5.1 Vault scope (NEW — fleet-review-driven)

Codex's framing, ratified by the rest of the fleet:

> Vault provenance can overrule **style, priority, risk tolerance, and operating constraints**. It cannot overrule **external facts, tests, specs, laws, or live docs**.

**Practical encoding:**

- Vault node retrieval surfaces during Adjudication.
- Vault citations _raise priors_ on aligned claims; they don't _mathematically overrule_.
- When a model claim contradicts a Vault node, the Decision Record surfaces both, the Adjudicator notes the conflict, and the operator (via doctrine review or autonomous Vault-falsification) decides which updates.

### 5.2 Vault falsification protocol (NEW)

Today's Vault is monotonically growing. The fleet flagged this as confirmation-bias amplification.

**Protocol:**

- A Vault node can be **demoted** (priority reduced) by external evidence: failing tests, contradicting specs, retracted documentation.
- A Vault node can be **retired** (graph-deleted-but-archived) by operator decision, with reason + timestamp.
- Curation events go through the Fleet — a node demotion is itself a high-stake decision (changes future adjudications), so it gets full Fleet review before commit.
- **Vault test suite**: fleet-flagged as missing. Build a contradiction-detector + retrieval-correctness suite over the 360 nodes. Bad principles surface before they bias adjudications.

### 5.3 Curator-loop hardening (NEW)

The fleet flagged: model output → encoded as principle → overrules future model output → positive feedback loop.

**Resolution:**

- Curator-suggested Vault edits (`apex-memory-curator`) are _proposals_, not auto-commits.
- All Vault writes require **explicit operator approval** before commit. The Fleet may _recommend_ (curator can fan a proposal through the Fleet for adversarial review and produce a Decision Record), but doctrine commits to a sovereignty-stack are operator-final. Fleet-without-operator is too loose for a sovereignty system.
- Curator's training data (model outputs already in the bus) is tagged "model-generated" so the curator can avoid recursive self-citation.

---

## 6. IMPLEMENTATION ROADMAP — Fleet-Reviewed Build Sequence

### Phase 0 — CALIBRATE (NEW, gates everything)

**Days 1–7. Build before any Sprint 1 work.**

The fleet UNANIMOUSLY demanded this: don't build the architecture on assumed independence; measure it.

1. Curate the calibration suite, **split into two distinct task classes**:
   - **Objectively-scored tasks** (have ground truth): code-with-tests, factual lookups with citations, math problems, type-check / compile correctness. ~30–100 prompts. These give you the 4-0/5-0 unanimous correctness rate vs known-correct.
   - **Judgment-calibration tasks** (no objective ground truth): architectural decisions, design trade-offs, ethical edge cases, contrarian-truth probes. ~20–100 prompts. Score these on **inter-fleet consistency over time** (does the same fleet reach similar conclusions on similar prompts) and **operator-rated retrospective alignment** (after-the-fact, with hindsight, did the fleet's recommendation hold up?). Different metric than ground-truth correctness.
2. Run each prompt through the configured Fleet.
3. Measure:
   - Inter-family disagreement rate
   - 4-0 / 5-0 unanimous correctness rate against ground truth
   - Llama outlier-vs-frontier-disagreement type distribution (capability gap vs genuine alpha)
   - Adjudicator-family bias drift across rotated runs
4. **Gate**: if 4-0 unanimous correctness < 80% OR inter-family disagreement < 15%, the architecture's truth-finding claim is broken. Rebrand to "audit-grade decision discipline" (which still has value), not "epistemic uplift." Adjust §0.1 / §0.3 framing accordingly.

This is the empirical foundation Sprint 1+ rests on.

### Phase 1 — Fix the Wrong Invariants

**Days 8–14.**

The fleet identified specific spec errors. Address them before building higher.

5. **Cryptographic impersonation invariant**. Strip all `*-impersonation` cascade layers. Voice unreachable = absent. (Already done 2026-04-26.)
6. **Invert Vault Provenance**. Vault citations raise priors; never mathematically overrule fresh evidence. Implement Vault falsification protocol.
7. **Vault test suite**. Contradiction detector + retrieval correctness checker over the 360 nodes.
8. **Degraded-fleet protocols**. N=3 / N=4 / N<3 paths defined and tested.
9. **Adjudicator family rotation**. Round-robin across fleet families, log per Decision Record.
10. **Eradicate the Impersonation Bug in `apex-outcome-grader.mjs`**. Dynamic producerFamily mapping at execution completion. (Original Sprint 1 deliverable; carry forward.)

### Phase 2 — Build the Sound Primitives

**Days 15–28.**

11. **Provenance schema** (codex's full schema): declaredVoice, actualRunner, actualFamily, surface, fallbackDepth, modelClaimed, modelVerified, authProfile, transcriptPath, confidence.
12. **Claim extraction with source spans + schema validation**. Premise-validation pre-step before any Outlier handling.
13. **Stake-assessment pre-stage**. Task-class classifier. Routine bypass / medium 2-family / high full-Fleet / destructive halt-on-schism.
14. **Adversarial red-team protocol** for OUTLIER (replaces BEI as primary).
15. **Task Capsule emission**. Every output to OpenClaw or operator wrapped in structured, replayable Task Capsule Decision Record.
16. **Decision Record schema**. Full provenance, alignment matrix, votes, outlier handling steps, evidence cited, vault-doctrine cited, confidence labels.

### Phase 3 — Optional (gated on Phase 0+1+2 results)

**Days 29+.**

17. **OpenClaw localhost intercept** — IF Phase 0 benchmark + Phase 1+2 results justify it. Otherwise treat OpenClaw as a channel surface only, run Fleet out-of-band.

- Auth + request logging + replay protection + prompt-injection adversarial handling.
- Stake-assessment routes routine calls to bypass-Fleet path (sub-200ms).
- Schema-fidelity test suite (track Anthropic/OpenAI changes, fail loudly on drift).

### Phase 4 — Operational Discipline

**Ongoing.**

18. **Cost / latency / quota budget governor**. Per-task budget, per-day budget, per-voice quota awareness. Gate AEE on availability before firing.
19. **Independent launchd agents**. Every Chuck V2 service is its own launchd entry, never monolithic. (Validated empirically 2026-04-25 — heavy daemon wedged under L3 pressure; lightweight agent boots clean.)
20. **NOPASSWD purge** (validated 2026-04-25). One-time setup; sudoers.d/`chuck-purge`.
21. **Session sovereignty daemon**. Cookie sideload to ALL Chrome-based profile dirs (main + apex + every PWA), bus-driven auth-required watcher, per-bundle passkey ceremony. (Designed; not built.)
22. **Failover plan**. Mac mini permanent-on OR Hetzner $5/mo outpost for Telegram-Chuck always-on reachability.
23. **Execution Forking** for code schisms. Dual-worktree sandbox with deterministic verification.

### Phase 5 — Sprint 4-equivalent (autonomous reality forking polish)

24. **Vault Integration tuning**. Calibrate weighting algorithm (per §5.1; raises priors, NOT overrules).
25. **Curator-loop hardening**. Proposal-not-auto-commit. Operator + Fleet co-approval for Vault writes.
26. **Multi-modal support / explainability / scalability** (per ollama-local's missing-feature checklist — frontier-competitor parity).

---

## 7. OPERATIONAL DISCIPLINE — patterns validated this session

These weren't in Gemini's spec; they're carry-forward from today's empirical work.

### 7.1 Independent launchd agents > monolithic daemons

The legacy `openclaw-watchers` daemon imported ~30 modules and wedged for 8 minutes under L3 memory pressure. The dedicated `apex-housekeeper` agent (separate launchd plist) booted clean and unblocked itself.

**Pattern**: every Chuck V2 service ships as its own launchd entry. Memory pressure can never block the very services designed to relieve it.

### 7.2 NOPASSWD purge for autonomous memory relief

`/etc/sudoers.d/chuck-purge` (renamed from `apex-housekeeper-purge`). Validated empirically. The housekeeper purges every 60s when at L2+, bypassed cooldown at L3. Mac never wedged again after this landed.

### 7.3 Tagged producer-family attribution on every output

Every voice response file carries explicit headers:

```
Voice-Requested: chatgpt-web (ChatGPT-Web)
Producer-Family: openai
Impersonation: false
Model: gpt-5.5
Layer used: primary (chatgpt-mac)
```

When `--allow-impersonation` is opt-in and triggers: `Impersonation: true ⚠ identity-crossing — see policy`.

### 7.4 Frontmost-app + bundle-siblings + Apex-allowlist immunity

The housekeeper's safety floor: the active surface stays alive even under aggressive housekeeping. Hard rule: never reap frontmost app, its descendants, its bundle siblings, or anything in the Apex-critical allowlist. Validated 2026-04-25 — Joseph's chat surface (Claude Desktop, this Claude Code session) was never threatened despite multiple L3 events.

### 7.5 Config-driven Fleet with rationale-required entries

`apex-fleet.json` (or `chuck.config.json` post-migration) — operator-editable, but bound by principles. Load-time refusal for: duplicate families (structural-diversity violation), missing rationale (principles-not-arbitrary violation). Operators editing this file are bound by the universal principles, not free to pick at whim.

---

## 8. OUT OF SCOPE (deliberate)

Per the fleet review's "no customer" flag and the original spec's framing, these are out of scope FOR CHUCK V2:

- Multi-tenant. Single-operator forever.
- API marketplace / public endpoint. Localhost only.
- Free tier. Subscriptions only — sovereign ceiling.
- Web UI. Surfaces are PWA / native app / messaging channel / CLI.
- Mobile-first design. PWA on iPad/iPhone is _a_ surface, not the primary.
- Compatibility with non-OpenClaw clients beyond schema mimicry. If another client speaks the same shape, fine.
- Telemetry, analytics. Sovereignty rule: telemetry off.
- Customer acquisition / business model. Chuck is sovereign infrastructure, not a product.

---

## 9. OPEN OPERATOR DECISIONS

Items the fleet explicitly flagged as operator-must-decide (cross-voice disagreements, no consensus):

1. **Folder name**: `chuck-v2` / `chuck` / `sovereign-command-center` / other?
2. **Language**: TypeScript+Node 22, Bun-first, or stay JS/MJS?
3. **Localhost intercept**: build (codex's "yes with hardening") OR skip (chatgpt-stance "don't, 6 weeks of brittle bridge")?
4. **4-quad replacement**: explicit correlation modeling (claude-ai stance) OR 5-family Minority Report (chatgpt-stance) OR evidence-orchestration with model votes as one class (codex)?
5. **Vault scope boundary**: doctrine-only (codex) OR doctrine + curated technical-truth shortlist?
6. **Mac mini timing**: cascades everything else.
7. **Hetzner $5/mo outpost**: provision now (Telegram-Chuck always-on) OR wait for Mac mini?

---

## 10. STATUS — DRAFT pending fleet adjudication

**This document is single-voice (Chuck/Claude in this session) synthesis of Gemini's spec + the 02-fleet-adversarial-review + today's session findings + Joseph's directives.**

Per the discipline rule: nothing significant ships without going through the Fleet first. This DRAFT must run through the Adversarial Fleet — exactly the protocol it specifies — before being treated as authoritative.

**Recommended next pass:**

1. **Phase 0 calibration first** (50–200 prompt benchmark with ground truth) — gates the truth-claim language.
2. **Re-fleet-pass on this draft** — let the Fleet review the revised spec the same way it reviewed Gemini's. Capture cross-voice agreements + disagreements.
3. **Synthesize Round 2** — final spec, ratified by the protocol it describes.

**Caveats from the 02-fleet-adversarial-review still in force:**

- The fleet that produced the prior review had n=3 distinct families (anthropic + openai + sovereign-local) — at the minimum-fleet floor. Anthropic dominated 4 of 6 responses (2 of those were impersonation-flagged).
- Google (3 surfaces) was unreachable due to shared account quota exhaustion.
- Perplexity unreachable due to driver bug (cliclick syntax — fixed but not retested).
- Re-firing on **2026-04-27** (Google quota reset window) with fixed perplexity driver gets you a fuller fleet pass on this draft.

— Chuck (this session, 2026-04-26)

_The destination is right. The path is now informed by adversarial review of the original path. The destination remains: Cognitive Sovereignty._

---

## 11. Claims requiring evidence (per Codex 2026-04-26)

Quantitative or factual claims used in this spec that should be **independently verified** before being treated as canonical. Source-tagged for traceability. None of these are gating for the architecture's core logic, but several are gating for the framing — if the underlying number is materially different, the marketing-flavor claims around it need adjusting.

| #   | Claim                                                                                                                   | Source                                                                                                                                                                                | Status                                                                                                                                                             | Impact if wrong                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OpenClaw has ~200,000 GitHub stars / "fastest-growing open-source AI project"                                           | `00-source-gemini-thread.md` (Gemini Pro, 2026-04-25)                                                                                                                                 | **[unverified]** — needs `gh repo view openclaw/openclaw --json stargazerCount`                                                                                    | Affects the §2 "Firehose" framing but not the architectural decision. Even at 5k stars, daily upstream pull is still cheap leverage.                                                                          |
| 2   | Claw Hub has a 26% malware vulnerability rate                                                                           | Gemini Pro thread                                                                                                                                                                     | **[unverified]** — claim does not appear in my draft directly, but if it propagates from the original convo into operator-facing material, source it.              | Justifies the Skill Quarantine policy. The policy is justified anyway by general open-source supply-chain risk, but the specific number should be sourced or dropped.                                         |
| 3   | Perplexity coordinates 19 different frontier AI models in its meta-router                                               | Gemini Pro thread                                                                                                                                                                     | **[unverified]** — likely exaggerated / time-bound                                                                                                                 | Affects the §3 framing of perplexity-as-distinct-meta-router-family. The structural claim (Perplexity is a router, not a base model) is verifiable from their own product surface; the specific count is not. |
| 4   | Anthropic Opus 4.7 is the current Claude model                                                                          | session memory + apex-panel-ask `VOICES.claude-cli.modelName`                                                                                                                         | **operator-confirmable, time-bound** — verify before each canonical-spec freeze                                                                                    | Voice routing assumes specific model names. If Anthropic rebrands or sunsets, the fleet config must update.                                                                                                   |
| 5   | OpenAI GPT-5.5 / Codex are current OpenAI surfaces                                                                      | session memory + `VOICES.codex.modelName`                                                                                                                                             | **operator-confirmable, time-bound**                                                                                                                               | Same as #4.                                                                                                                                                                                                   |
| 6   | Google Gemini 3.1 Pro is the current Gemini Pro tier                                                                    | session memory + `VOICES.gemini-cli.modelName`                                                                                                                                        | **operator-confirmable, time-bound**                                                                                                                               | Same as #4.                                                                                                                                                                                                   |
| 7   | Llama 3.1 8b is the local sovereign model                                                                               | session memory + `ollama list` output (verifiable on Joseph's box)                                                                                                                    | **operator-verifiable** — `curl localhost:11434/api/tags` confirms                                                                                                 | Same as #4 but locally testable.                                                                                                                                                                              |
| 8   | Apex Vault has ~360 typed nodes across 19 principle bundles                                                             | Joseph's session memory + `memory_stats` query                                                                                                                                        | **operator-verifiable on Joseph's graph** — run a count before canonical freeze                                                                                    | Affects §5 framing. Number can drift; the principle holds at any reasonable count.                                                                                                                            |
| 9   | Gemini Pro CLI has a 60-call/day quota                                                                                  | derived from `RetryableQuotaError: You have exhausted your capacity` failure today + session memory `reference_perplexity_max_account.md`-style notes about Gemini account candidates | **partly verified** — empirically confirmed today that quota IS bounded; the specific "60/day" figure should be re-checked against current Google AI Pro tier docs | Affects degraded-fleet protocols. Architecture is robust to any specific number; the planning around when to re-fire should use the verified figure.                                                          |
| 10  | Frontier models (Anthropic / OpenAI / Google) ToS prohibit programmatic access via consumer subscriptions               | Grok-impersonation review, fleet 2026-04-26                                                                                                                                           | **[unverified]** — varies by vendor + tier + over time                                                                                                             | Affects §8 out-of-scope framing. If the legal exposure is significant, it changes "sovereign" framing. Operator's call.                                                                                       |
| 11  | "10× too slow" / "5–20 minute end-to-end latency" / "8–15 model invocations per query"                                  | Various fleet voices, fleet 2026-04-26                                                                                                                                                | **[unverified]** — order-of-magnitude estimates                                                                                                                    | Affects §4.1 stake-assessment framing. Will be empirically measured during Phase 0 calibration.                                                                                                               |
| 12  | Common Crawl / GitHub / arXiv / Reddit / StackOverflow / Wikipedia overlap as training corpora across all four families | Fleet review 2026-04-26                                                                                                                                                               | **plausible / well-known but not strictly proved** — vendors don't publish full training-data manifests                                                            | Underpins the family-correlation argument that motivated the v2 truth-claim downgrades. Even partial overlap is enough to justify the downgrade; the claim doesn't need to be 100% true.                      |

**Verification-pass priority:**

- Before canonical-spec freeze: verify #4, #5, #6, #7, #8, #9 (operator-knowable, gating for fleet config + degraded-fleet protocol math).
- Before §2 "Firehose" public-facing framing: verify #1, #2, #3 (impacts marketing-flavor claims, not architecture).
- Before any framing of "sovereign" as legal positioning: verify #10 with counsel (impact-if-wrong is meaningful).
- #11 will be empirically replaced by Phase 0 benchmark measurements.
- #12 doesn't need stricter verification — it's plausible-enough to justify the architectural humility.

**Evidence-gathering belongs in `04-claims-evidence-pass.md` (separate doc, when Joseph schedules it).**

— Chuck (claims-pass added 2026-04-26 per Codex's review)

---

## 12. Excellence and Emergent Intelligence Loop

Joseph's operating directive: Chuck should not be merely "good enough" or better only in one narrow benchmark. The target is excellence across every dimension that matters to a single-operator sovereign command layer — not for vanity or market comparison, but because excellence is a good thing.

**Core claim:** emergent intelligence requires a closed improvement loop, not just a bigger Fleet. If Chuck only adjudicates, it is smart but static. If Chuck observes outcomes, scores itself, proposes improvements, verifies them, and asks for approval at the right boundaries, it compounds.

The required loop is:

`observe -> disagree -> decide -> act -> verify -> remember -> score -> adapt -> propose self-improvement -> test -> request approval -> incorporate`

### 12.1 Excellence Axes

Chuck's self-improvement engine must measure at least these axes:

- **Epistemic quality**: correctness, calibration, source discipline, false-consensus detection.
- **Execution reliability**: tools complete, tests pass, rollback works, no stale state leaks.
- **Safety discipline**: destructive actions halt, degraded fleet never overclaims, skill quarantine catches risky behavior.
- **Operator alignment**: decisions match Joseph's doctrine, taste, risk tolerance, and explicit approvals.
- **Autonomy**: Chuck completes more multi-step work without unnecessary interruption.
- **Latency**: routine work stays fast; high-stakes work is slow only when the added scrutiny is worth it.
- **Cost/quota efficiency**: Fleet calls are spent where they buy real epistemic value.
- **Memory quality**: useful recall rises, stale/noisy memory decays, recursive self-citation is prevented.
- **Tool coverage**: OpenClaw surfaces remain available and are ranked by reliability.
- **User experience**: the system feels clear, calm, and governable, not noisy or theatrical.

### 12.2 The Compounding Rule

Chuck may call itself "improving" only when measured snapshots show improvement without safety regressions. A single impressive capability demo does not count. Improvement requires:

- sufficient sample counts per axis;
- no critical-incident increase;
- no hidden degradation in safety or operator alignment;
- rejected self-change proposals staying within tolerance;
- approved self-improvement patches tracked as evidence, not vibes.

### 12.3 Self-Improvement Authority

Chuck may autonomously:

- detect repeated failure patterns;
- draft patches to routers, tests, dashboards, quarantine policy, verifiers, and prompts;
- run the test suite and produce DecisionRecords;
- propose Vault additions, demotions, or retirements;
- recommend family/tool weight changes based on outcome scores.

Chuck may **not** silently commit:

- doctrine changes;
- security boundary changes;
- privileged execution changes;
- destructive behavior changes;
- anything that expands filesystem/network/credential scope.

Those require operator approval. This is the boundary that lets the system become more alive without becoming reckless.

### 12.4 Dominance Framing

Chuck should be benchmarked against OpenClaw, single-model assistants, SaaS agents, and local-only agents — but the benchmark is not vanity. The goal is to ensure the system is excellent where excellence matters:

- OpenClaw-level capability coverage via the chassis;
- stronger high-stakes judgment than vanilla OpenClaw;
- better sovereignty than SaaS agents;
- better tool discipline than generic local agents;
- better compounding memory than stateless chat;
- better refusal behavior than throughput-optimized automation.

The honest target is not "absolute dominance" as an unsupported claim. The target is measurable, compounding excellence: Chuck gets better because every serious decision becomes training signal for the next decision, under operator-approved boundaries.
