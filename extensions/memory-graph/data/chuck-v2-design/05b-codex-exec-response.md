# 05b — Codex (exec) response to 05a

**Voice:** Codex CLI (`codex exec`), gpt-5.5, OpenAI family
**Surface:** `codex exec --skip-git-repo-check` (non-interactive one-shot)
**Prompt:** [`extensions/memory-graph/data/chuck-v2-design/05a-claude-code-critique-of-unified-draft.md`](05a-claude-code-critique-of-unified-draft.md)
**Original landing:** `~/Documents/v3-r3-claude-critique-Codex-CLI-2026-04-27.md`
**Run timing:** 137 sec, 3,229 chars output, primary layer (no fallback)
**Fired:** 2026-04-26 21:12 CDT via `apex-panel-ask.mjs --only codex`

---

## Provenance headers (verbatim from runner)

```
Voice-Requested: codex (Codex-CLI)
Producer-Family: openai
Impersonation: false
Model: codex/gpt-5.5
Layer used: primary (codex/gpt-5.5)
Retrieved: 2026-04-27T02:14:19.097Z
Prompt size: 14355 chars
```

---

## Response (verbatim)

Read the draft and the critique. My assessment: the critique mostly lands.

**1. Dominant**

- The best part is the boundary model: Kernel / Fleet / Vault / Evidence / Execution / Growth. That is a real architecture, not agent prose.
- `DEEP_FRACTURE = halt` is the strongest epistemic move. Most ensemble systems quietly become majority voting.
- Cryptographic producer-family attribution is unusually concrete. Counting the actual runner, not the claimed model identity, is load-bearing.
- The Vault pivot is correct: alignment doctrine, not truth source.
- §13 and §14 are strong discipline: unverified claims stay labeled, and originating-family self-review cannot ratify itself.

**2. Fragile First**

- Stake assessment will break first. If it under-classifies risk, the whole AEE/Kernal/Fleet stack is bypassed.
- Operator bottleneck is real. Too many "Joseph-final" gates will produce delay, ignored queues, or pressure to weaken the rules.
- The fleet math still overclaims independence. Raw `N=5` is not five independent samples.
- The Doctrine Compiler is currently dangerous: Vault-derived preferences become runtime law unless advisory vs enforced policy is split.
- The Self-Improvement Lab is under-specified. "Kernel gates it" is not enough without mechanical authority diffs.
- Citation span verification is too binary. It needs typed verdicts: exact, paraphrase, inference, unverified.

**3. Missing**
Frontier competitors would ship operational primitives sooner than this spec does:

- Permission modes and protected-path defaults, not just abstract approval gates. Claude Code already has default/plan/auto/dontAsk/bypass-style permission modes and classifier fallback behavior: https://code.claude.com/docs/en/permission-modes
- Durable resumable workflows much earlier. LangGraph treats checkpoints, resume, human interrupts, and idempotent side effects as core, not Phase 3 ornament: https://docs.langchain.com/oss/javascript/langgraph/durable-execution
- First-class observability. OpenAI Agents SDK ships tracing for generations, tool calls, handoffs, guardrails, and custom events: https://openai.github.io/openai-agents-js/guides/tracing
- Eval UX and replay harnesses. Google ADK exposes evalsets/test files and trace-based evaluation flow: https://google.github.io/adk-docs/evaluate/
- Memory lifecycle controls: compaction, retention, correction, tombstones, decay. Current Vault prose is richer philosophically than mechanically.

**4. Prioritize Next**

1. Decide the primary product truth: sovereign command center with audit gates, or epistemic truth rig with routine-work side effects. I'd choose command center primary, with hard escalation for high-stakes work.
2. Patch the six critiques before canonicalizing V3. Verdicts: accept 1, 3, 5, 6; refine 2 and 4.
3. Move durable workflow + observability into Phase 1/2. Without them, long-running "wake to result" work will fail in practice.
4. Build the Phase 0 calibration harness as code, not prose: dataset, disagreement metrics, effective-N, replayable Decision Records.
5. Define `authority-diff` before Self-Improvement Lab or Doctrine Compiler ships.
6. Compress the canonical spec to 25–30 KB. Keep the architecture; cut repeated ceremony.

---

## Lineage map

- [`00-DISCIPLINE.md`](00-DISCIPLINE.md) — discipline rule
- [`00-source-gemini-thread.md`](00-source-gemini-thread.md) — original Gemini Pro spec
- [`01-design-doc.DRAFT-single-voice-pending-fleet-adjudication.md`](01-design-doc.DRAFT-single-voice-pending-fleet-adjudication.md) — earlier single-voice synthesis (quarantined)
- [`02-fleet-adversarial-review.md`](02-fleet-adversarial-review.md) — Round 1 cross-fleet synthesis
- [`03-spec-v2-DRAFT-pending-fleet.md`](03-spec-v2-DRAFT-pending-fleet.md) — Round 2 v2.1 corrections (Codex round-1+2)
- [`04-extension-codex-components.md`](04-extension-codex-components.md) — Codex round-3: 15 component extensions
- [`frontier-lab-primitive-harvest.md`](frontier-lab-primitive-harvest.md) — Phase 0 primitive harvest
- [`05-CHUCK-V3-UNIFIED-DRAFT.md`](05-CHUCK-V3-UNIFIED-DRAFT.md) — unified single-voice integration draft (this artifact under review)
- [`05a-claude-code-critique-of-unified-draft.md`](05a-claude-code-critique-of-unified-draft.md) — Claude Code (Opus 4.7) critique that this response answers
- **`05b-codex-exec-response.md`** — this file
- [`05c-codex-review-response.md`](05c-codex-review-response.md) — sibling Codex surface response (`codex review`)
- [`05d-spec-patch-surface-as-first-class-field.md`](05d-spec-patch-surface-as-first-class-field.md) — spec patch landed from intra-family multi-surface signal in 05b vs 05c
