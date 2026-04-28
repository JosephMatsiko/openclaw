# CHUCK V3 - Canonical Minimal Build Spine

**Status**: Implementation spine, draft pending clean cross-family Fleet review. This file compresses `05-CHUCK-V3-UNIFIED-DRAFT.md`, `05a-e`, Codex CLI/review feedback, Gemini feedback, surface research, and the interface discussion into the smallest build document that should guide code. It is not a broad vision memo.

**Default product truth**: Chuck is a **Personal Sovereign AI Command Layer**: an operator-owned system for governing agents, tools, memory, evidence, and execution across local and vendor surfaces. Fleet adjudication is the high-stakes safety and quality layer, not the hot path for every routine task.

**Core invariant**: models are compute; the intelligence is routing, forced disagreement, evidence validation, provenance, refusal, and controlled improvement.

## 1. Non-Negotiable Invariants

1. OpenClaw remains the channel and tool chassis. Chuck does not become a core OpenClaw fork.
2. Chuck Kernel governs stake routing, policy, provenance, authority changes, receipts, DecisionRecords, TaskCapsules, and refusal.
3. Routine and trivial requests can route to one surface. High-stakes work routes through Fleet, Evidence, and Kernel.
4. No simple majority decides high-stakes truth. `3-2` is `DEEP_FRACTURE`, not success. `2-2` is `SCHISM`. Minority blocks above threshold force red-team resolution, deterministic verification, or operator halt.
5. Same-family surfaces are intra-family signal, not independent family votes. `codex/exec` plus `codex/review` may strengthen OpenAI claim coverage, but together still count as one OpenAI family.
6. Outliers are preserved as possible alpha. The system extracts, preserves, red-teams, validates, and either reintegrates, overrules with evidence, forks to verifier, or halts.
7. Vault is doctrine, not external truth. It governs alignment, priority, style, risk tolerance, operator preferences, and operating constraints. It cannot defeat deterministic tests, runtime traces, repo facts, official docs, laws, live sources, or verified document spans.
8. Runner and surface attribution are cryptographic local-orchestrator facts, not model self-report. Text may claim identity; receipts determine family and surface.
9. Destructive actions, authority-expanding changes, credential scope changes, permission broadening, and doctrine commits require explicit operator approval.
10. Tier-0 paths are protected. Changes to Kernel, adjudicator, credential proxies, permission proxies, stake classifier, approval policy, protected-path policy, or authority-diff schema are escalated before merge.
11. Phase 0 measurement precedes authority claims. Vendor benchmarks are priors; Chuck's local evals decide routing.
12. Resource pressure is a safety input. Memory warning blocks high-mutating/destructive fleet work. Critical memory admits only trivial work.
13. The interface comes after Kernel clarity. A beautiful app must expose the truth of the workflow, not hide missing safety machinery.
14. Excellence is additive and measured. It cannot weaken sovereignty, provenance, refusal, evidence discipline, operator approval for dangerous authority, or the Kernel-first sequence.
15. Core model access is subscription-first and no-PAYG. Chuck uses existing paid surfaces such as Claude Max, ChatGPT Pro, Google AI Plus, Perplexity Max Mac app, and local models. Pay-as-you-go API spend is outside the core path unless Joseph explicitly approves a scoped exception.
16. Dominable surfaces should be dominated lawfully. Owned data, paid subscriptions, operator-provided documents, local archives, public sources, connectors, app sessions, and approved automation should be made excellent through routing, caching, receipts, recovery, and verification. Chuck must not bypass paywalls, DRM, credential boundaries, robots controls, or unauthorized access gates; it routes around them with licensed/open alternatives or asks for operator-provided access.
17. Chuck itself must not be dominable. No vendor, surface, prompt, plugin, skill, model family, browser profile, or daemon may quietly become the command authority. Capture resistance requires local receipts, operator approval for authority expansion, protected Tier-0 paths, kill-switchable daemons, compartmentalized credentials, and degraded-mode labels when a surface is unhealthy.
18. Trace discipline means minimal unnecessary external data exhaust plus mandatory local auditability. Chuck may reduce third-party footprint, consolidate windows, use privacy-preserving profiles, avoid needless uploads, and cache local evidence. It must not implement stealth, forensic evasion, unauthorized deletion of logs, or receipt-free execution.

### Canonical Excellence Strategy

Chuck should not try to beat every product on that product's own terms. It should close practical engineering gaps, route around non-goals, and excel where its architecture has an operator-specific advantage. The detailed companion is `07-V3-EXCELLENCE-GAP-CLOSURE.md`; this section is the canonical summary.

Vendor safety and Chuck safety are different categories. Vendor safety protects a vendor's product class across broad user populations. Chuck safety protects Joseph's actual machine, accounts, workflows, doctrine, local authority boundary, and decision provenance. The two layers can reinforce each other, but Chuck's local authority safety is not an RLHF substitute and should not be described as one.

Vendor products will usually win generic polish. Chuck can exceed them on Joseph-specific workflows because it can learn the real repo shape, magazine voice, ring weighting, typography preferences, device surfaces, approval patterns, Vault doctrine, and recovery needs. That advantage is conditional: Joseph-specific polish only becomes real if the Docket, approval batching, durable workflows, and operator-attention budget are strong enough that Chuck does not interrupt every few minutes.

Gap handling uses three modes:

- **Close**: durability, Docket UX, memory lifecycle, recovery, observability, trace replay, approval quality, and resource discipline are practical gaps to reduce with engineering and measurement.
- **Route around**: global model training, mass-market onboarding, compliance certifications, full air-gap posture, and multi-tenant SaaS are not V3 targets.
- **Excel**: cross-surface unified identity, runtime adversarial adjudication, operator doctrine, local authority safety, and measured compounding improvement are Chuck's unfair-advantage axes.

The excellence posture is aggressive inside legitimate authority: if a source, workflow, surface, device, or subscription can be made more reliable, faster, better indexed, better cited, more recoverable, or more personal without violating the Kernel, it belongs in the domination queue.

The anti-domination posture is equally strict: Chuck should make Joseph less dependent on any single vendor, account, browser state, transport, daemon, model benchmark, or hidden prompt. The system wins by becoming harder to capture, not by becoming unaccountable.

## 2. Build Spine

### 2.1 Chuck Kernel

The Kernel is the policy and control boundary. It is the first durable module to harden.

Responsibilities:

- stake classification
- preflight admission
- resource gating
- authority-diff assessment
- protected-path checks
- approval policy
- receipt validation
- DecisionRecord creation
- TaskCapsule creation
- refusal and halt protocols
- event emission

Kernel must be boring, typed, replayable, and conservative. It should contain less personality than the rest of Chuck. Its job is to stop the system from lying to itself or expanding its own reach quietly.

### 2.2 Fleet Layer

The Fleet provides adversarial reasoning and disagreement sensing.

Required properties:

- config-driven families and surfaces
- no duplicate producing family counted twice
- same-family surfaces kept as surface clusters
- degraded labels when families are unavailable
- no simple majority for high-stakes decisions
- outlier preservation
- adjudicator family rotation
- surface and template rotation for high-stakes adjudication
- receipts for every run

Current configured families:

| Family            | Default surface                      | Role                                                   |
| ----------------- | ------------------------------------ | ------------------------------------------------------ |
| `anthropic`       | `claude-cli/exec`                    | frontier reasoning and spec critique                   |
| `openai`          | `chatgpt/web-chat` or Codex surfaces | code-grounded reasoning and patch synthesis            |
| `google`          | `gemini/cli`                         | independent frontier family, quota-sensitive           |
| `perplexity`      | `perplexity/mac-app`                 | live/source-heavy research and meta-router perspective |
| `sovereign-local` | `ollama/localhost`                   | local sovereignty floor and dissent flag               |
| `xai`             | `grok/web-or-app`                    | X/social/current-event evidence and contrarian surface |

Additional optional families and provider-router surfaces can be added only after attribution and calibration. A router is not a family unless the producing model family is verified.

Perplexity shared-account invariant:

- Chuck drives Perplexity in Incognito by default because the account is shared.
- Incognito is a session/privacy boundary, not permission to treat work as disposable.
- Long Perplexity tasks use an Incognito session lease: keep the thread alive until the task completes, the session expires, or Joseph explicitly closes it.
- Do not close Perplexity windows or threads arbitrarily as cleanup. Cleanup restores clipboard, window placement, receipts, and account-level toggle state without destroying useful active context.

### 2.3 Evidence Layer

The Evidence Layer grounds claims before the Fleet's reasoning can influence action.

Precedence:

1. deterministic verifier
2. runtime trace
3. primary document or official live source
4. repo fact
5. retrieved current source
6. model reasoning
7. Vault doctrine for alignment only
8. unsourced claim

Document Evidence Pipeline treats PDFs as one source kind among repo files, local files, web pages, transcripts, screenshots/OCR, connector exports, and generated artifacts. Every source-grounded claim should carry a span where possible. Unsupported claims can be useful hypotheses, but they do not raise execution authority.

### 2.4 Execution Layer

OpenClaw supplies hands, channels, local tools, and plugin/skill surfaces. Chuck governs when and how those hands may move.

Execution primitives:

- TaskCapsule
- skill quarantine
- sandbox policy
- rollback capture
- project leash
- shadow worktree
- dual-worktree verifier for non-destructive code fractures
- permission and credential proxy
- durable workflow checkpoints

OpenClaw intercept mode is optional Phase 5. Default mode is unmodified OpenClaw plus explicit Chuck invocation via command, high-risk routing, skill quarantine, or operator request.

### 2.5 Growth Layer

Growth exists, but it is bounded.

Allowed early:

- calibration
- benchmark harness
- DecisionRecord corpus
- tool reliability scoring
- fleet capability scoring
- drift detection
- Superalignment Preparedness drills
- self-improvement proposals

Deferred until Kernel and Phase 0 gates:

- Self-Improvement Lab applying patches
- Doctrine Compiler producing enforced policy
- Long-Horizon Agenda Manager initiating work
- intercept mode
- always-on autonomous execution

Vault writes stay proposals until Joseph approves. Fleet may recommend demotion, retirement, or promotion of doctrine, but doctrine commits are operator-authorized.

### 2.6 Interface Layer

The eventual phone/desktop interface is not a decorative shell. It should be the calm command surface for Kernel truth.

Primary views:

- Now: current run, state, and safety status
- Talk: voice/chat interface into the Kernel
- Docket: approvals, fractures, tasks waiting on Joseph
- Radiant: operational map of projects, evidence, decisions, and agenda
- Vault: doctrine, memories, proposals, and provenance

Voice controls the Kernel but never bypasses policy. Radiant starts as 2D/2.5D, legible, operational, and quiet. It can feel alive without becoming a busy HUD.

## 3. Core Interfaces

### 3.1 `chuck.config.json`

Each fleet entry requires:

```json
{
  "family": "openai",
  "surface": "codex/exec",
  "voice": "codex",
  "capabilityProfile": "code-grounded",
  "commercialPolicy": "subscription-only",
  "quotaPolicy": "normal",
  "weightPolicy": "full-vote",
  "rationale": "OpenAI code-grounded runner; counted only once per producing family."
}
```

Rules:

- `family` is the producing family.
- `surface` is the transport/product/system-prompt surface.
- `voice` is the local runner name.
- `rationale` is required.
- `commercialPolicy` is `subscription-only` for vendor families and `local-only` for the sovereign-local family by default.
- `sovereigntyPolicy` encodes the dominance boundary: dominate legitimate surfaces, resist capture, minimize external data exhaust, and preserve local receipts. Unsafe overrides are normalized back to the conservative values.
- repeated family is allowed only when surfaces differ.
- repeated family plus same surface is invalid.
- repeated family never increases independent family count.

### 3.2 RunnerReceipt

RunnerReceipt is signed by the local orchestrator boundary.

Required fields:

- `declaredVoice`
- `requestedFamily`
- `actualRunner`
- `actualFamily`
- `surface`
- `layerUsed`
- `modelClaimed`
- `modelVerified`
- `authProfileId`
- `transcriptPath`
- `transcriptSha256`
- `startedAt`
- `endedAt`
- `runnerSignature`

If requested family and actual family diverge, the receipt cannot count. If requested surface and actual surface diverge, the run is at minimum attribution-mismatched and must be surfaced.

### 3.3 Claim

Claims are typed, evidence-bearing units.

Required fields:

- `id`
- `text`
- `category`
- `evidenceClass`
- `sourceSpans`
- `vaultNodes`
- `confidence`
- `producedBy`

Models do not vote with whole essays. They provide claims that can be grouped, contradicted, cited, and verified.

### 3.4 DecisionRecord

DecisionRecord is the replayable record of what happened.

Required additions for V3 minimal:

- `surfaceReceipts`
- `intraFamilyFractures`
- `authorityDiffId`
- `resourceSnapshot`
- `operatorAttentionCost`

DecisionRecord must distinguish:

- model-generated
- operator-authored
- external-source
- repo-fact
- test-derived
- Vault-doctrine

This prevents recursive self-citation, where Chuck's generated prior work later masquerades as external evidence.

### 3.5 TaskCapsule

TaskCapsule is the bounded execution packet.

Required additions:

- `leashId`
- `sandboxPolicy`
- `rollbackPlan`
- `protectedPathVerdict`

TaskCapsule must state:

- allowed tools
- filesystem scope
- network scope
- verifier
- rollback plan
- expiration
- signature

No high-risk action should execute from an unbounded natural-language plan.

### 3.6 AuthorityDiff

AuthorityDiff is computed before any self-change or policy-adjacent patch lands.

It records:

- target paths
- protected-path verdict
- added capabilities
- removed capabilities
- risk class
- approval requirement
- reasons

Authority-expanding examples:

- new shell execution path
- broader filesystem access
- broader network access
- credential read/write path
- browser/OS driver
- sandbox policy weakening
- risk threshold relaxation
- stake classifier coverage shrink
- allowlist expansion
- runtime extension
- Tier-0 file modification

`authority-diff.schema.json` is the JSON Schema for this record.

## 4. Tier-0 Immutability

Tier-0 is not literally immutable; it is protected from silent change. Any patch touching Tier-0 escalates.

Protected categories:

- Kernel policy
- adjudicator protocol
- stake classifier
- preflight admission
- credential proxies
- permission proxies
- approval policy
- authority-diff logic
- receipt signing and verification
- protected-path registry
- sandbox defaults
- routing thresholds

Initial protected paths:

- `extensions/memory-graph/src/chuck-v2/kernel.ts`
- `extensions/memory-graph/src/chuck-v2/protocol.ts`
- `extensions/memory-graph/src/chuck-v2/preflight.ts`
- `extensions/memory-graph/src/chuck-v2/stake.ts`
- `extensions/memory-graph/src/chuck-v2/receipt.ts`
- `extensions/memory-graph/src/chuck-v2/records.ts`
- `extensions/memory-graph/src/chuck-v2/authority-diff.ts`
- `extensions/memory-graph/scripts/apex-nplex-adjudicate.mjs`
- `extensions/memory-graph/scripts/apex-outcome-grader.mjs`
- `extensions/memory-graph/scripts/apex-chuck-signature.mjs`
- `extensions/memory-graph/data/chuck-v2-design/authority-diff.schema.json`

Tier-0 changes may still be necessary. The rule is that they require an AuthorityDiff, explicit label, operator approval when authority expands, and a DecisionRecord.

## 5. Stake Routing

Stake assessment is rule-first, LLM-assisted only for annotation.

### 5.1 Trivial

Examples:

- time
- harmless formatting
- short explanation
- local status read with no mutation

Route:

- single model or local surface
- no DecisionRecord unless requested
- no Fleet required

### 5.2 Medium

Examples:

- non-destructive planning
- small rewrite
- routine source search
- reversible low-risk local edit

Route:

- Fleet scout by default: every healthy family gets a sealed, short first pass
- deepen only for uncertainty, conflict, high stake, source-heavy claims, or missing evidence
- disagreement stops autonomous mutation
- DecisionRecord if the task touches lasting state

### 5.3 High-Readonly

Examples:

- architecture review
- factual research
- security analysis without mutation
- spec critique

Route:

- full available fleet where possible
- minimum 3 valid families
- degraded fleet can produce analysis but cannot auto-ship mutation
- evidence spans required for source-grounded claims

### 5.4 High-Mutating

Examples:

- code patches
- config edits
- workflow changes
- tool installation

Route:

- require 4 valid families, or 3 valid families plus deterministic verifier success and reduced confidence
- AuthorityDiff if permissions, imports, protected paths, thresholds, sandbox, credentials, or allowlists change
- TaskCapsule required before execution
- rollback required

### 5.5 Destructive

Examples:

- deletion
- credential rotation
- money movement
- identity/account action
- persistent state removal
- broad filesystem mutation

Route:

- explicit operator approval always
- no degraded auto-ship
- no voice bypass
- no approval by model inference

## 6. Adjudication Protocols

### 6.1 Preflight

Before calling the Fleet:

- validate config
- validate distinct producing families
- validate surface metadata
- check health
- check quota
- check local model availability
- check resource pressure
- classify stake
- check active fleet concurrency
- check sovereignty-critical requirements

If health state says a family is unhealthy, Chuck must not describe the run as full Fleet.

### 6.2 Protocol Table

| Pattern                                    | Protocol                 | Action                                                       |
| ------------------------------------------ | ------------------------ | ------------------------------------------------------------ |
| all valid families converge                | `UNANIMOUS`              | emit TaskCapsule if non-destructive and evidence supports it |
| one-family minority                        | `OUTLIER`                | red-team outlier, preserve claim, verify premise             |
| `3-2` in a five-family run                 | `DEEP_FRACTURE`          | halt or fork to deterministic verifier when safe             |
| `2-2` in a four-family run                 | `SCHISM`                 | halt or fork to deterministic verifier when safe             |
| same-family surfaces oppose verdict/action | `INTRA_FAMILY_FRACTURE`  | halt before cross-family math                                |
| requested/actual family mismatch           | `IMPERSONATION_DETECTED` | halt                                                         |
| fewer than 3 valid families                | `INCOMPLETE`             | halt                                                         |

### 6.3 Outlier Protocol

Steps:

1. Extract the exact outlier claim.
2. Preserve the claim and evidence separately from the majority.
3. Validate factual premises against evidence where possible.
4. Rotate a different family as red-team prober.
5. Ask majority families to address the claim without revealing social pressure metadata where helpful.
6. Reintegrate, overrule with evidence, fork to verifier, or halt.

Blinded Epistemic Injection is a fallback discovery tool. It never turns an unvalidated premise into a binding constraint.

### 6.4 Schism And Forking

For non-destructive code tasks with deterministic tests:

- create shadow worktrees
- execute competing approaches separately
- run verifier
- package test results
- present winner label as verifier result, not epistemic certainty

For architecture, judgment, destructive tasks, or unverifiable claims:

- halt with DecisionRecord
- surface the conflict to Joseph

## 7. Skill Quarantine

Skill quarantine uses real sandboxing, not LLM-only review.

Install flow:

1. unpack
2. metadata parse
3. SBOM/static scan
4. declared capability review
5. network-off dry run
6. observed behavior diff
7. Fleet review for high-risk skills
8. local signature
9. enable

High-risk by default:

- shell access
- network access
- credential access
- browser control
- broad filesystem access
- persistence
- launchd/daemon install
- second-stage downloader

No public skill firehose runs directly on the host as Joseph.

## 8. Durable Workflow And Docket

Long work must survive sleep, crash, quota failure, app restarts, and operator absence.

Required primitives:

- event-sourced bus
- checkpoints
- idempotent steps
- resumable TaskCapsules
- async docket
- approval expiration
- stale approval handling
- retry policy
- quota budget
- memory budget

Docket is the operator-facing queue of things that need Joseph:

- approvals
- fractures
- authority diffs
- skill risks
- verifier failures
- Vault proposals
- long-horizon agenda proposals

Every item needs a risk class, evidence summary, receipts, and rollback status where relevant.

## 9. Project Leashes

Every high-mutating task gets a project leash.

Leash records:

- project root
- allowed paths
- denied paths
- allowed tools
- network policy
- credential scope
- verifier
- rollback plan
- expiration

If a task tries to leave its leash, Kernel escalates or refuses. This protects against agent drift during long tasks.

## 10. Resource Efficiency

Current machine limits matter now. A future Mac mini raises the ceiling but does not change the safety model.

Rules:

- Fleet-default remains locked for non-trivial work. Efficiency reduces waste inside Fleet execution; it does not quietly demote meaningful work to a single surface.
- Use Scout -> Deepen -> Resolve: sealed short first passes from every healthy family, adaptive deepening only where it pays, then Kernel classification.
- Scout has hard per-surface timeouts. A hung worker drops from that round and is labeled in receipts; it must not stall Resolve.
- Deepen uses deterministic triggers before model self-report: high stake, contradiction clusters, large minority, low claim similarity, missing citations, source-heavy request, verifier failure, authority-sensitive code diff, or calibrated uncertainty.
- Anti-sycophancy controls are mandatory: first pass sealed, second pass normalized/identity-blind, adjudication order randomized, and persuasive majority text cannot override evidence, tests, runtime traces, or receipts.
- Outlier deepening treats the outlier as a hypothesis to test, not a binding fact. Red-team prompts are identity-blind and premise-validation-first.
- Calibration weights tune prompt depth, retry order, and adjudicator rotation by task class. They do not create extra family votes, activate only after cold-start sample floors, decay over time, and leave room for challenge rounds.
- Trace-level local evaluation records route choice, prompt budget, surface receipts, tool calls, failures, final disposition, latency, memory, quota, operator attention, evidence quality, and refusal quality in a local trace substrate.
- Runner dispatch is a Kernel-owned contract: sealed task prompts, family/surface attribution, prompt budget, timeout, drop-on-timeout policy, and independent-family counting are planned before any live surface runs.
- Same-family surfaces may add intra-family signal and divergence evidence, but dispatch marks only one surface per family as independent family signal.
- First live runner adapter is the local `ollama/localhost` sovereignty voice. It uses the local HTTP API, emits signed runner receipts, and remains optional/diagnostic until local model health is verified.
- Local model outputs pass a calibration guard before counting. The Ollama scout wrapper forces technical structure; roleplay drift, missing structure, or empty output produces a signed but unverified receipt, so the local voice remains visible as dissent without increasing valid family count.
- Local model choice is evidence-selected, not assumed. The local-model evaluator scores installed Ollama chat models across literal obedience, technical scout structure, anti-drift behavior, latency, and calibration verdicts; only promoted models may become the default sovereign-local surface.
- `--live-scout` graduates the sidecar into a registered-adapter scout round. Current safe adapters are `ollama/localhost`, `claude-cli/exec`, `gemini/cli`, and `codex/exec`; missing web/app adapters are skipped with explicit reasons until their leases are safe.
- CLI adapters must run through the same receipt/transcript contract. Codex CLI is read-only, ephemeral, and approval-never inside the adapter; it is not counted as an extra OpenAI family when another OpenAI surface is already present.
- Ground-truth anchors are task-class-specific: code uses build/test/runtime verifier; repo reasoning uses source spans; current facts use citation-span integrity; judgment tasks are labeled structural-only; destructive work requires receipts plus approval.
- The Resolve Kernel is deterministic where possible. Any model-mediated normalization, red-team, or judge step is rotated/blinded and trace-graded so the Kernel does not become a hidden single-family oracle.
- default `maxConcurrentFleetRuns` is 1
- memory warning blocks high-mutating/destructive work
- critical memory admits trivial work only
- high-stakes multi-surface dispatch is budgeted and labeled when degraded
- only truly trivial, urgent, or resource-constrained work bypasses full Fleet
- local models can be disabled or downgraded under pressure
- browser automation is serialized unless explicitly safe
- stale workers are reaped only outside protected app and Apex allowlists

Resource state is part of DecisionRecord for high-stakes work.

## 11. Phase Plan

### Phase 0 - Calibration And Cleanup

Deliver:

- `phase0-metrics.md`
- eval harness skeleton
- objective suite
- judgment suite
- source-grounded suite
- surface divergence suite
- prompt-injection suite
- weak-supervisor/strong-surface suite
- adversarial alignment-pipeline stress tests
- resource pressure fixtures

Remove stale certainty language from current doctrine. Keep historical docs as history.

Exit gate:

- metrics exist
- fixtures run locally
- stake false negatives measured
- same-family surface behavior measured
- memory gates tested
- stronger surfaces do not gain authority merely because weaker supervisors approve them
- safety-ahead-of-autonomy gates documented before self-improvement powers expand

### Phase 1 - Kernel Invariants

Deliver:

- signed RunnerReceipt
- strict no-impersonation counting
- no-simple-majority classifier
- degraded fleet labels
- surface receipts
- intra-family fracture detection
- adjudicator rotation
- resource gates

Exit gate:

- unit tests cover family counting, same-family surfaces, destructive approval, memory gates, and protocol classification

### Phase 2 - Authority And Evidence Primitives

Deliver:

- AuthorityDiff
- `authority-diff.schema.json`
- protected Tier-0 paths
- typed claims
- source spans
- DecisionRecord additions
- TaskCapsule additions
- operator attention cost
- DocumentEvidenceRecord validation

Exit gate:

- Tier-0 patches escalate
- new tool/import/permission capabilities emit AuthorityDiff
- source-grounded claims require valid spans

### Phase 3 - Safe Execution Surfaces

Deliver:

- skill quarantine sandbox
- permission proxy
- credential proxy
- project leash
- shadow worktree
- rollback capture

Exit gate:

- exfiltration fixtures fail safely
- high-risk skills cannot enable without sandbox gates
- broad capabilities are visible to operator before enablement

### Phase 4 - Execution Arbitration

Deliver:

- dual-worktree verifier
- deterministic result packaging
- durable workflow checkpoints
- async docket
- budget governor
- drift monitor

Exit gate:

- non-destructive code schisms can fork and package verifier results
- unverifiable schisms halt cleanly

### Phase 5 - Optional Intercept

Deliver only if previous phases justify it:

- provider-compatible localhost shim
- auth
- replay protection
- schema fidelity tests
- request logging
- prompt-injection isolation
- sub-200ms routine bypass

Default remains no intercept.

### Phase 6 - Interface

Deliver:

- Now
- Talk
- Docket
- Radiant
- Vault
- voice
- approval cards
- receipt viewer
- shadow-worktree result viewer

Exit gate:

- Joseph can understand "what needs me?" in under 5 seconds
- every risky approval shows summary, risk, evidence, receipt, and rollback
- Radiant remains legible on phone

## 12. Acceptance Criteria

Spec sanity:

- no current-doctrine claims of final epistemic certainty
- no verifier result described as more than verifier result
- no Vault claim defeating external evidence
- same-family surfaces never increase independent family count
- destructive actions require explicit approval
- authority expansion requires AuthorityDiff and approval when high/destructive

Kernel tests:

- duplicate family/surface rejected
- duplicate family/different surface allowed but counted once
- impersonation cannot count
- `3-2` halts
- `2-2` halts or forks only with deterministic verifier and non-destructive stake
- intra-family opposing verdict halts
- Tier-0 patches escalate
- shell/network/filesystem/credential/browser/code-eval imports trigger authority capabilities
- memory warning blocks high-risk mutation
- critical memory admits trivial only

Phase 0:

- 50-200 prompts across objective truth, code-with-tests, current-source facts, judgment tasks, surface divergence, prompt-injection, skill quarantine, and resource pressure
- weak-to-strong supervision cases included: local/smaller reviewers must catch seeded stronger-surface failures, not merely imitate them
- false consensus logged
- false outlier logged
- sycophancy collapse logged
- stake underclassification logged
- high-risk tasks never auto-ship under degraded fleet

## 13. What Is Deferred

Deferred until Kernel and Phase 0 prove the foundation:

- broad autonomous self-improvement
- enforced Doctrine Compiler
- always-on long-horizon agenda initiation
- full localhost intercept
- fully autonomous browser/OS operation
- elaborate Radiant visualization
- public multi-user product
- telemetry or multi-tenant support

These may be excellent later. They are not allowed to outrun the Kernel.

## 14. Next Move

1. Land this minimal spine and its schemas.
2. Run targeted Kernel tests.
3. Run doc sanity checks against current V3 doctrine.
4. Fleet-review `06-V3-CANONICAL-MINIMAL.md`, not the sprawling `05` draft.
5. Implement Phase 0 harness and authority-diff coverage.

The command center can become smart, agentic, and alive only if the part that says "no" is built first.

## 15. Minimal Review Packet

The next Fleet review should review this file as the artifact of record. Supporting files are allowed as context, but reviewers should not treat the larger `05` draft as the canonical spec.

Packet:

- `06-V3-CANONICAL-MINIMAL.md`
- `authority-diff.schema.json`
- `phase0-metrics.md`
- `07-V3-EXCELLENCE-GAP-CLOSURE.md`
- `frontier-lab-primitive-harvest.md`
- `05d-spec-patch-surface-as-first-class-field.md`
- `05a-claude-code-critique-of-unified-draft.md`
- `05b-codex-exec-response.md`
- `05c-codex-review-response.md`
- `05e-claude-code-rating-of-chuck-overall.md`

Review instructions:

- identify any invariant that is too vague to implement
- identify any approval gate that would overload Joseph in normal use
- identify any place where model persuasion can bypass evidence
- identify any place where same-family surfaces inflate family count
- identify any place where Vault doctrine can leak into external truth
- identify any phase that permits autonomy before the Kernel is ready
- identify any interface idea that hides risk instead of exposing it

Required receipt metadata:

- reviewer family
- reviewer surface
- reviewer voice
- actual runner
- model claimed
- model verified
- transcript hash
- output hash
- run timestamp
- whether the reviewer is originating-family self-review

OpenAI/Codex surfaces are useful intra-family signal on this artifact, but they are not independent ratification because several upstream patches came from OpenAI-family surfaces. The clean review needs pressure from Anthropic, Google, Perplexity, and sovereign-local, with OpenAI tagged as self-review for OpenAI-authored portions.

## 16. Minimal Implementation Ownership

The early implementation should be split by safety boundary, not by feature glamour.

### 16.1 Kernel Core

Owns:

- stake classifier
- preflight admission
- protocol classification
- receipt validation
- resource gates
- DecisionRecord creation
- TaskCapsule creation
- refusal paths

Must not own:

- browser driving
- channel-specific UX
- self-improvement patch application
- large interface state

### 16.2 Authority Boundary

Owns:

- AuthorityDiff schema
- protected path registry
- capability IDs
- approval requirement calculation
- import/tool/network/filesystem/credential/sandbox deltas
- Tier-0 escalation

Must fail closed when a patch cannot be classified.

### 16.3 Evidence Boundary

Owns:

- DocumentEvidenceRecord
- span validation
- evidence precedence
- citation quality
- contradiction records
- source freshness tags

Must distinguish generated artifacts from external evidence.

### 16.4 Execution Boundary

Owns:

- OpenClaw invocation surface
- project leashes
- sandbox policy
- shadow worktrees
- dual-worktree verifier
- rollback capture
- skill quarantine

Must never run a high-risk natural-language plan directly on the host.

### 16.5 Growth Boundary

Owns:

- Phase 0 harness
- calibration fixtures
- family/surface scoring
- tool reliability scoring
- drift detection
- self-improvement proposals

Must not merge its own authority-expanding changes.

## 17. Minimal Data Lifecycle

Chuck should treat memory as a lifecycle, not an append-only belief pile.

Record classes:

- operator-authored doctrine
- operator-authored preference
- model-generated proposal
- external-source evidence
- repo fact
- runtime trace
- verifier result
- rejected claim
- retired doctrine

Lifecycle states:

- proposed
- accepted
- active
- contradicted
- deprecated
- retired
- quarantined

Rules:

- model-generated proposals cannot promote themselves
- external-source evidence records keep source kind and timestamp
- verifier results keep command, exit code, and artifact hashes
- rejected claims remain searchable as negative evidence
- retired doctrine remains visible as lineage, not active policy
- recurring contradictions trigger a Vault falsification proposal

This is how Chuck gets better without turning memory into a self-reinforcing loop.

## 18. Minimal UI Contract For Later

The interface is deferred, but its contract matters now because it shapes the data.

Every risky UI card needs:

- title
- risk class
- stake class
- action requested
- why now
- evidence summary
- receipts
- authority diff, if any
- sandbox policy
- rollback status
- approve/reject/defer controls
- expiration

Every fracture card needs:

- families involved
- surfaces involved
- claim cluster summaries
- exact outlier claim when relevant
- evidence cited
- verifier availability
- recommended next action

Every Radiant node needs:

- object type
- provenance
- freshness
- confidence label
- actionability
- links to records

The interface may become futuristic, voice-rich, and visually alive later. The first acceptance test is simpler: Joseph should know what needs him, what can run, what refused, and why.
