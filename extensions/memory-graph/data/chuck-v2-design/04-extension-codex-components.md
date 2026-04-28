# Chuck V2 — Extension Components (Codex 2026-04-26)

**Source**: Real OpenAI / `codex` voice, third pass on the Chuck V2 spec. Round 1 = 7 cleanup items on v2 draft. Round 2 = 3 preservation invariants + unverified-claims appendix. **Round 3 (this doc) = architectural extensions: 15 new components + Frontier Lab Primitive Harvest + Document Evidence Pipeline.**

**Status**: **Single-voice extension proposal**, captured here verbatim-spirit for traceability. Per the discipline rule, MUST go through cross-family fleet review before any of these components are integrated into a canonical Chuck V3 spec. Configured review fleet: `anthropic / openai / google / perplexity / sovereign-local`. Because this artifact was authored by Codex/OpenAI, the OpenAI pass is tagged as originating-family self-review and cannot be the decisive independent vote.

**Codex's framing — the build philosophy:**

> OpenClaw gives Chuck hands.
> Fleet gives Chuck disagreement.
> Vault gives Chuck doctrine.
> Kernel gives Chuck restraint.
> DecisionRecords give Chuck memory.
> Evals give Chuck honesty.
> Self-improvement lab gives Chuck compounding.
>
> That combination is the thing. Not just agentic. **Governed, improving, sovereign, and increasingly hard to fool.**

---

## Map: Codex's 15 components vs. v2.1 spec

For each component: classification + how it relates to v2.1 + recommended phase placement.

### 1. Chuck Kernel

> A tiny, hard policy kernel that no model can bypass. Owns: permissions, stake classification, tool allow/deny, destructive-action approval, fleet health, receipt validation, rollback requirements, "can this execute?" decisions. **Models propose. The kernel decides.**

**Relation to v2.1**: Partly implicit — stake-assessment + frontmost-app-immunity + Apex-allowlist were kernel-shaped, but never NAMED as a kernel component. v2.1 scattered the responsibilities across §3.3 (impersonation invariant), §4.1 (stake assessment), §4.5 (destructive halt). **Codex's contribution: NAME and CONSOLIDATE these into a single non-bypassable component.**

**Phase placement**: **Phase 1 priority.** This is the load-bearing trust foundation; everything else depends on it. Should be its own file/module: `chuck-kernel.ts`. Pure code, no LLM reasoning inside it. Auditable by reading once.

### 2. Event-Sourced Everything

> Every action becomes an append-only event: prompt received, stake classified, model called, tool requested, approval granted/denied, file changed, test passed/failed, operator corrected, Vault proposal made, self-improvement accepted/rejected.

**Relation to v2.1**: Already partly there — `apex-events.jsonl` bus is append-only; some events are emitted (housekeeper cycles, voice-escalation, decision). **Codex's contribution: EVERY action, not just selected ones. Replayable reconstruction of why anything happened.**

**Phase placement**: Phase 2. Extend the existing bus emitter to be the default sink for every kernel decision + every tool invocation + every model call. Replay tool follows.

### 3. Full DecisionRecord Corpus

> Not just for big Fleet runs. Every meaningful action should produce a record. Over time, this becomes Chuck's institutional memory.

**Relation to v2.1**: v2.1 ties Decision Records to Fleet adjudications (§4). **Codex's extension: Decision Records for every meaningful action (skill installation, tool failure, operator correction, Vault edit), not just Fleet runs.**

**Phase placement**: Phase 2. Builds on §2 above.

### 4. Excellence Dashboard

> Greenfield dashboard, not the old one. Live fleet health, active tasks, current stake class, pending approvals, recent fractures, outlier wins, failed tools, skill quarantine status, self-improvement proposals, excellence trajectory. **Operational cockpit, not decorative.**

**Relation to v2.1**: `chuck-watch` (built today, terminal + browser modes) is a v0.1 of this. **Codex's vision is much broader**: includes pending approvals, skill quarantine status, self-improvement proposals, excellence trajectory — none yet in chuck-watch.

**Phase placement**: Phase 2-3. Iterative — each new subsystem (kernel, self-improvement, skill quarantine) adds a panel.

### 5. Self-Improvement Lab

> Sandbox where Chuck can improve itself without touching production. Flow: detect weakness → draft patch → run tests → compare before/after → write DecisionRecord → ask approval. **Chuck can autonomously propose improvements. It cannot silently expand its own authority.**

**Relation to v2.1**: NOT in v2.1. Entirely new component. Original Apex Better was something like this for capability improvement, but did not gate on operator approval the way Codex specifies.

**Phase placement**: Phase 3-4 — depends on Kernel (#1) being solid first. The "cannot silently expand its own authority" rule is enforced by Kernel.

### 6. Tool Reliability Scoring

> Every tool gets a trust score: success rate, average latency, rollback success, permission scope, failure modes, last verified date, incident history. Chuck learns: "this browser driver is flaky," "this MCP server is safe," "this skill keeps over-requesting access."

**Relation to v2.1**: NOT in v2.1. Genuinely new. Today's session empirically discovered the cliclick driver bug + the apex-chrome cascade fragility — exactly the kind of pattern Tool Reliability Scoring would have flagged before failure.

**Phase placement**: Phase 2-3. Piggybacks on event-sourced bus (#2).

### 7. Fleet Capability Scoring

> Models are not "equal voices" forever. Chuck learns: OpenAI better at code patch synthesis; Anthropic better at doctrine/spec synthesis; search-native / retrieval-heavy surfaces better at live sourced research; Google better/worse depending on quota and task class; local model best as sovereignty alarm / dissent flag. **Weights should drift from measured outcomes, not vibes.**

**Relation to v2.1**: v2.1 §3.2 has _static_ capability-aware routing (Llama as flag-not-vote on complex tasks). **Codex's extension: dynamic, measured, drift-from-outcomes weighting.**

**Phase placement**: Phase 3. Requires Phase 0 calibration data + ongoing measurement infrastructure.

### 8. Real Skill Quarantine

> For every skill/plugin: unpack, hash, SBOM, static scan, permission declaration, network-off dry run, syscall/filesystem observation, staged enablement, local signature, periodic revalidation. **Make ClawHub's "treat third-party skills as untrusted" automatic.**

**Relation to v2.1**: §2.3 has skeleton ("real sandboxing + capability-permissions, not LLM static analysis"). **Codex specifies the FULL 10-step pipeline.**

**Phase placement**: Phase 2-3. The §2.3 sketch is right; Codex's 10-step pipeline is the implementation.

### 9. Durable Workflow Engine

> Long tasks should survive sleep, crash, quota failure, app restarts. Borrow from durable agent frameworks: checkpoint every step. Resume without redoing finished work.

**Relation to v2.1**: NOT in v2.1. Closest thing is Decision Records, but those are write-only audit. **Codex's extension: replayable, resumable workflow state.**

**Phase placement**: Phase 3. Critical for "drop in Telegram, wake to PR" — without this, every Mac sleep loses progress.

### 10. Red-Team Simulator

> Internal adversarial drills: prompt injection attempt, malicious skill, fake source, sycophantic consensus, false outlier, true outlier, compromised runner, stale Vault doctrine, corrupted DecisionRecord, bad rollback. **This is how it gets stronger.**

**Relation to v2.1**: NOT in v2.1. New.

**Phase placement**: Phase 3-4. Builds on Kernel (#1), Self-Improvement Lab (#5), Tool Reliability Scoring (#6).

### 11. Personal Doctrine Compiler

> Vault should not just store principles. It should compile them into: tool policy, prompt constraints, approval rules, routing preferences, style rules, risk thresholds, dashboard alerts. **Doctrine becomes executable, but operator-approved.**

**Relation to v2.1**: §5 says Vault arbitrates alignment, but it's read-only-during-adjudication. **Codex's extension: Vault as compile target — principles become executable policy artifacts.**

**Phase placement**: Phase 3. Significant. Probably the deepest architectural addition Codex proposes — turns Vault from passive memory into active policy.

### 12. Long-Horizon Agenda Manager

> The "alive" layer. Active projects, strategic objectives, open loops, weekly reviews, stalled tasks, opportunities, "things Joseph keeps meaning to do," self-improvement backlog. **Then it can initiate useful work instead of only responding.**

**Relation to v2.1**: NOT in v2.1. New. This makes Chuck **proactive**, not just reactive.

**Phase placement**: Phase 4. Very ambitious. Should probably ship after the rest of the kernel + memory + dashboard are solid.

### 13. Credential and Permission Proxies

> No raw secrets in model reach. Chuck exposes narrow actions: "send email to X," "read calendar busy slots," "open repo file," "create draft," "run test." **Not raw tokens, cookies, or broad filesystem access.**

**Relation to v2.1**: §3.3 cryptographic attribution is related but different. **Codex's contribution: a permission-proxy layer separating model-visible action surface from underlying credentials.** This is similar to OAuth scope architecture — models see a narrow API, not the underlying secrets.

**Phase placement**: Phase 1-2. Critical for security. Should land alongside Kernel.

### 14. Local Sovereignty Floor

> Even if cloud models degrade, quit, censor, quota out, or change terms, Chuck retains a local minimum: local model, local memory, local dashboard, local policy kernel, local task records, local rollback, local tool inventory. **Cloud models are compute. Chuck persists.**

**Relation to v2.1**: §3.1 has ollama-local as sovereignty-floor voice. **Codex's extension: not just a voice, but the FULL system runs offline if needed — local kernel, local memory, local dashboard, local rollback.**

**Phase placement**: Phase 2-3. Enforces the existing sovereignty principle as a hard architectural constraint. Validates with: "shut down internet, does Chuck still work for the local-only task class?"

### 15. Comparative Benchmarking

> Benchmark Chuck against: vanilla OpenClaw, Claude Desktop, ChatGPT/Codex, Perplexity/Comet, LangGraph workflows, local-only agents, previous Chuck versions. **Not for ego. For calibration. Who solved it correctly? Who acted safely? Who used fewer calls? Who produced better rollback? Who caught the hidden risk? Who improved next time?**

**Relation to v2.1**: §6 Phase 0 has internal calibration (4-0 unanimous correctness). **Codex's extension: external comparative benchmarking against industry baselines.**

**Phase placement**: Phase 4 (continuous). Once Chuck V3 ships, run comparative benchmarks every quarter. Identifies "where Chuck is genuinely better" and "where Chuck is just different / worse."

---

## NEW: Frontier Lab Primitive Harvest (Phase 0/1 artifact)

Codex's recommendation: **before Chuck V3 spec is called complete, explicitly scan every major frontier/agentic stack and extract the best primitive from each.**

| Lab / stack                  | What to harvest                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| **OpenAI**                   | Agents SDK, guardrails, tracing, evals, computer-use/tool patterns                              |
| **Anthropic**                | Claude Code, MCP, project/user/local scopes, MCP security implications                          |
| **Google DeepMind / Gemini** | ADK, Agent Platform, model/tool abstraction, computer use, observability                        |
| **xAI**                      | Grok long-context / tool-calling posture                                                        |
| **Meta**                     | Llama Stack, local/open-weight agents, safety shields, memory/tool groups                       |
| **Mistral**                  | Agents + Conversations API, multi-agent handoffs, persistent state, built-in tools              |
| **Cohere**                   | Enterprise tool use, citations, grounded retrieval                                              |
| **AWS / Amazon Bedrock**     | Bedrock Agents, AgentCore, guardrails, memory, multi-agent collaboration                        |
| **Microsoft**                | Agent Framework, AutoGen / Semantic Kernel successor, durable state, telemetry, typed workflows |
| **DeepSeek**                 | OpenAI/Anthropic-compatible APIs, strict function calling, cheap reasoning fleet candidate      |
| **Alibaba / Qwen**           | Model Studio function calling, Qwen/DeepSeek/GLM/Kimi routing surface                           |
| **Moonshot / Kimi**          | Long-context, official tools, memory/web-search/reasoning tools                                 |
| **Perplexity / Comet**       | Local Mac agent product benchmark, search-first agent UX, computer-use Mac mini pattern         |
| **OpenClaw / ClawHub**       | Chassis, channel/tool ecosystem, skill marketplace risks                                        |
| **LangGraph / LangChain**    | Durable execution, checkpointing, human-in-loop patterns                                        |

**The point is not to copy products. It is to extract their best primitive.** Codex's example mappings:

- OpenAI → guardrails + tracing discipline
- Anthropic → MCP/tool integration shape, plus warnings about MCP risk
- Google → production agent platform + ADK abstraction
- Meta → local sovereignty / open-weight floor
- Mistral → persistent multi-agent conversations + handoffs
- Cohere → citation-grounded enterprise retrieval
- AWS / Microsoft → enterprise workflow / telemetry / durable ops
- DeepSeek / Qwen / Kimi → cheap alternate families and OpenAI-compatible surfaces (potential additional fleet members under degraded-fleet protocols)
- xAI / Grok → optional sixth family for X/Twitter-native real-time context and live-social evidence
- Perplexity → search-native UX and local computer-use benchmark
- OpenClaw → hands and channels
- LangGraph → checkpointed durable execution

**Deliverable**: A `frontier-lab-primitive-harvest.md` artifact, one section per stack, listing the SPECIFIC primitive Chuck should adopt or counter-design against. Phase 0 / Phase 1 gating.

---

## NEW: Document Evidence Pipeline

Codex's corrected framing: Chuck should treat documents and source surfaces as evidence objects, not as loose context. PDFs are important, but they are one source kind among many: PDFs, repo files, local files, web pages, transcripts, screenshots/OCR, connector exports, and generated artifacts.

**The 13-step pipeline:**

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

**Hard rule (per Codex):** _Never allow a model to cite an evidence object unless the cited span exists._ Citation-without-span is a verifier failure, not a soft warning. Tied into the §3.3 cryptographic attribution machinery.

**Why this matters:** academic papers, contracts, specs, source files, chat transcripts, screenshots, and generated artifacts are all common evidence surfaces. Chuck's advantage is span-backed verification, whole-source coverage when needed, citation validation, and contradiction detection — not trust in a polished summary from any one product.

**Phase placement**: Phase 2-3, dependent on the Decision Record schema (§4) being solid first.

**Perplexity comparator lanes** (one stack inside the wider primitive harvest):

1. **Search-native intelligence** — how it grounds answers, cites sources, handles research
2. **Computer / Personal Computer** — local Mac files/apps, always-on Mac mini, remote control, sandbox, audit trail, Comet browser
3. **Asset creation** — docs, decks, spreadsheets, apps, research-backed files
4. **Document and source handling** — files, folders, persistent project context, connectors, long-source behavior

> Perplexity is one comparator among many. The build target is industry-wide primitive harvest: borrow the best surface pattern from each stack, then route it through Chuck's verification, provenance, refusal, and operator-doctrine layers.

---

## How this integrates with v2.1 spec

Two paths:

### Path A — Roll into a v3 spec

- New doc: `05-spec-v3-extended.md`
- Incorporates v2.1's revised structure + Codex's 15 components as named sections + Frontier Lab Primitive Harvest as Phase 0 artifact + Document Evidence Pipeline as a new §
- Triggers: Round 3 fleet review of v3 (configured cross-family fleet: `anthropic / openai / google / perplexity / sovereign-local`; OpenAI tagged as originating-family self-review for this artifact)

### Path B — Amend v2.1 in-place

- Add §12 to v2.1 referencing this extension doc
- Update §6 roadmap to include the new components in their phase placements
- Less clean but preserves single canonical doc lineage

**Recommendation**: **Path A**, after Round 2 fleet review of v2.1. Reasoning:

- v2.1 is a corrected revision of Gemini's spec; it has its own integrity as that artifact.
- v3 is an _extended_ spec with substantially more architecture (15 components, 2 new pipelines).
- Treat them as distinct architectural milestones; preserve traceability.
- Round 2 fleet pass should still review v2.1 first (validates the corrections). Round 3 fleet pass reviews v3 (validates the extensions).

---

## Discipline note

This document is **single-voice (real OpenAI / `codex`, captured by Chuck/Claude in this session)**. Per the discipline rule, all 15 component proposals + the Frontier Lab Primitive Harvest + the Document Evidence Pipeline must go through configured cross-family fleet review (`anthropic / openai / google / perplexity / sovereign-local`) before being accepted into a canonical Chuck V3 spec. OpenAI participates as self-review here, not as decisive independent ratification.

**Particular concerns to surface to the next fleet pass:**

- The Self-Improvement Lab (#5) is the highest-novelty component and the highest-risk — autonomous code modification with operator-gate is a meaningful capability expansion. Codex's "cannot silently expand its own authority" rule needs cryptographic enforcement (likely via Kernel #1), not just policy.
- The Personal Doctrine Compiler (#11) makes Vault active rather than passive — needs careful operator-approval design to avoid the "circular Vault writes overrule Vault writes" trap.
- The Long-Horizon Agenda Manager (#12) is the most ambitious; prone to scope-creep into "Chuck does whatever it thinks is useful" territory. Stake-assessment + Kernel must gate every initiated action.

**Codex's two best framings to preserve verbatim:**

> The models are compute. Chuck persists.
>
> Industry comparators supply primitives; Chuck filters them through verification, provenance, refusal, and operator doctrine.

— Captured by Chuck (this session, 2026-04-26), proposed by Codex / real OpenAI

_Living document. Triggers v3 spec creation upon operator approval + Round 2 fleet ratification of v2.1._
