# 05f — Codex (Mac app) response — workflow correction + 05d distillation

**Voice:** Codex via Mac-app GUI, gpt-5.5, OpenAI family
**Surface:** `codex/mac-app` (Electron GUI, manually driven by Joseph)
**Source:** pasted by Joseph from the Codex Mac app, 2026-04-26 22:30 CDT
**Inputs read by this surface:** [`05-CHUCK-V3-UNIFIED-DRAFT.md`](05-CHUCK-V3-UNIFIED-DRAFT.md), [`05a-claude-code-critique-of-unified-draft.md`](05a-claude-code-critique-of-unified-draft.md), [`05b-codex-exec-response.md`](05b-codex-exec-response.md), [`05c-codex-review-response.md`](05c-codex-review-response.md), [`05d-spec-patch-surface-as-first-class-field.md`](05d-spec-patch-surface-as-first-class-field.md), [`05e-claude-code-rating-of-chuck-overall.md`](05e-claude-code-rating-of-chuck-overall.md)
**Driven by:** Joseph manually (not via `apex-panel-ask.mjs`). No `Producer-Family` cryptographic signing on this artifact — provenance is paste-trust.

**Why this surface matters:** third Codex surface this session (after `codex/exec` and `codex/review`). Same model, third framing. The 2026-04-26 multi-surface evidence base for [`05d`](05d-spec-patch-surface-as-first-class-field.md) §2 grows from N=1 (codex/exec vs codex/review) to N=2 (codex/exec, codex/review, codex/mac-app — but the latter saw a richer input set, so the comparison isn't clean).

---

## Response (verbatim, with paste artifacts cleaned)

I read the referenced files. Claude's commands are a proposed **review campaign** around two new artifacts:

- [`05d-spec-patch-surface-as-first-class-field.md`](05d-spec-patch-surface-as-first-class-field.md)
- [`05e-claude-code-rating-of-chuck-overall.md`](05e-claude-code-rating-of-chuck-overall.md)

My read: **05d is important, but too exhaustive to fold wholesale.** The core idea is right: `family` and `surface` are different dimensions. OpenAI via `codex exec`, OpenAI via `codex review`, ChatGPT Mac, and ChatGPT web are one family but different surfaces. Chuck should preserve that signal without pretending it adds independent family votes.

But the workflow should not become: "every new idea gets another giant fleet run." That is how the spec keeps expanding.

I'd do this instead:

1. **Do not run the duplicated commands as-is.**
   `--only codex-review` followed by `--only codex,codex-review` repeats the same surface. Same for `05e`. If we run panels later, do one clean dual-surface pass per artifact.

2. **Treat 05d as a patch to distill, not adopt whole.**
   Keep:
   - surface as first-class field
   - surface attribution in receipts
   - intra-family surface divergence logged
   - same-family surfaces do not count as multiple family votes
   - `INTRA_FAMILY_FRACTURE` only when surfaces disagree on verdict/action, not when they merely frame differently

3. **Treat 05e as a calibration warning.**
   The headline is right: design/governance ahead of implementation. That strengthens the case for workflow-first: `06-V3-CANONICAL-MINIMAL.md`, `authority-diff.schema.json`, Phase 0 metrics, then Kernel.

4. **Review the canonical minimal spec, not the sprawling draft.**
   Running a fleet pass on `05-CHUCK-V3-UNIFIED-DRAFT.md` may generate more ideas. Better workflow: first compress into `06-V3-CANONICAL-MINIMAL.md`, then run the fleet against that smaller target.

So yes, this Claude batch belongs in our consolidation, but I'd revise the workflow:

**Consolidate → distill 05d/05e → write minimal canonical spec + authority diff + Phase 0 metrics → then fleet-review the minimal spec.**

That keeps the system disciplined instead of feeding the beautiful-spec-growth machine.

---

## What this surface actually delivered

Three load-bearing things the prior two Codex surfaces (exec, review) did not deliver on 05a:

1. **A name for the meta-failure mode: "the beautiful-spec-growth machine."** Specs that get fleet-reviewed generate more ideas; ideas get added; specs grow; fleet-reviews again; repeat. Naming the trap is half the defense. This is the kind of meta-observation that emerges when a surface looks at the _workflow_ rather than the _artifact_.

2. **Distillation of 05d's surviving core** (replacing my exhaustive 18-section patch with the 5-bullet keep-list above). The five bullets are the load-bearing primitives — everything else in 05d is supporting structure that may or may not survive when the patch lands in `06-V3-CANONICAL-MINIMAL.md`.

3. **Workflow reordering: distill before fleet-review, not after.** The unified draft (51 KB) shouldn't be the next fleet-review target. The compressed canonical (25–30 KB) should. Otherwise tomorrow's Round 3 dispatch produces more sprawl.

The third point is a discipline rule the unified draft does not currently encode. Add it explicitly to the V3 §10 phase ordering: **"Compression precedes fleet review at every revision boundary."**

## What this surface caught that I missed

- **Dispatch-command redundancy.** The three options I gave Joseph for firing 05e (`--only codex`, `--only codex-review`, `--only codex,codex-review`) overlap — option 3 contains option 2. If Joseph fires all three serially, codex-review runs twice. Better surfacing: **one** dual-surface command per artifact, not three options where two are subsets.
- **Workflow-as-architecture.** The 05a/05d/05e cycle treated the _artifacts_ as the architecture. Codex Mac correctly notes that the _workflow_ is part of the architecture too — and a fleet-review-everything workflow is its own design choice that the spec hasn't named.

## How this updates the 05d empirical basis

`05d` §2 was built on N=1 (single 2026-04-26 multi-surface observation, codex/exec vs codex/review on 05a). This response is the third Codex surface in the same day, but on different inputs (05a + 05b + 05c + 05d + 05e, not just 05a). It's not a clean replication. What it does add:

- **Verdict convergence with the prior two surfaces:** all three Codex surfaces agree on the surface-as-first-class core.
- **Framing divergence with the prior two surfaces:** the meta-workflow critique is unique to codex/mac-app. codex/exec stayed at the artifact level (frontier primitives missing). codex/review went deeper on internal architecture gaps (operator attention, deferral list). codex/mac-app went up a level — to workflow.
- **A new pattern: surface-as-zoom-level.** CLI surfaces (exec, review) zoom in on artifact substance. The Mac-app surface — perhaps because it's session-stateful and the operator has been thinking with it — zoomed out to workflow. This is a hypothesis for Phase 0 multi-surface eval to test, not a confirmed pattern.

## Asks back to the fleet (deferred to Round 3)

When canonical-minimal exists and is reviewed:

1. Validate the workflow rule "compression precedes fleet review at every revision boundary" — does the fleet agree that's the right discipline?
2. Validate the surface-as-zoom-level hypothesis — does the Mac-app surface consistently zoom out compared to CLI surfaces, or was 2026-04-26 a one-off?
3. Should the 05d distilled core (5 bullets) be canonical, or further compressed?

These get held until `06-V3-CANONICAL-MINIMAL.md` exists. No more sprawling-draft fleet runs.

---

## Lineage map

- [`00-DISCIPLINE.md`](00-DISCIPLINE.md) — discipline rule
- [`00-source-gemini-thread.md`](00-source-gemini-thread.md) — original Gemini Pro V3 spec
- [`01-design-doc.DRAFT-single-voice-pending-fleet-adjudication.md`](01-design-doc.DRAFT-single-voice-pending-fleet-adjudication.md) — earlier single-voice synthesis (quarantined)
- [`02-fleet-adversarial-review.md`](02-fleet-adversarial-review.md) — Round 1 cross-fleet synthesis
- [`03-spec-v2-DRAFT-pending-fleet.md`](03-spec-v2-DRAFT-pending-fleet.md) — Round 2 v2.1 corrections
- [`04-extension-codex-components.md`](04-extension-codex-components.md) — Codex round-3: 15 component extensions
- [`frontier-lab-primitive-harvest.md`](frontier-lab-primitive-harvest.md) — Phase 0 primitive harvest
- [`05-CHUCK-V3-UNIFIED-DRAFT.md`](05-CHUCK-V3-UNIFIED-DRAFT.md) — unified V3 working draft
- [`05a-claude-code-critique-of-unified-draft.md`](05a-claude-code-critique-of-unified-draft.md) — Claude Code six-critique pass
- [`05b-codex-exec-response.md`](05b-codex-exec-response.md) — Codex (`codex exec`) response
- [`05c-codex-review-response.md`](05c-codex-review-response.md) — Codex (`codex review`) response
- [`05d-spec-patch-surface-as-first-class-field.md`](05d-spec-patch-surface-as-first-class-field.md) — exhaustive spec patch
- [`05e-claude-code-rating-of-chuck-overall.md`](05e-claude-code-rating-of-chuck-overall.md) — Claude Code overall rating
- **`05f-codex-mac-response.md`** — this file — Codex Mac-app workflow correction + 05d distillation
- (next) `06-V3-CANONICAL-MINIMAL.md` — compressed canonical V3 (target 25–30 KB), folding distilled 05d core + the discipline rule "compression precedes fleet review"
- (next) `06b-authority-diff.schema.json` — typed authority-diff schema
- (next) `06c-phase-0-metric-definitions.md` — Phase 0 metric definitions
