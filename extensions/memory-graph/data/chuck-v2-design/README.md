# Chuck V3 design lineage

This directory holds the working artifacts for Chuck V3 — the unified architecture under fleet review. Files are numbered in the order they were authored. Read in numeric order for the full evolution; jump to **05** if you want the current state and **05d** for the active spec patch.

**Repo location:** `extensions/memory-graph/data/chuck-v2-design/`
**Status:** WORKING DRAFT lineage. Canonical V3 spec lands at `06-V3-CANONICAL-MINIMAL.md` after Round 3 fleet review (target 2026-04-27).

---

## Reading order

| #       | File                                                                                                                               | Authored             | Purpose                                                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 00      | [`00-DISCIPLINE.md`](00-DISCIPLINE.md)                                                                                             | 2026-04-25           | The rule: no significant work product without fleet adjudication                                                                                       |
| 00      | [`00-source-gemini-thread.md`](00-source-gemini-thread.md)                                                                         | 2026-04-25           | Original 36-turn Gemini Pro V3 spec (130 KB)                                                                                                           |
| 01      | [`01-design-doc.DRAFT-single-voice-pending-fleet-adjudication.md`](01-design-doc.DRAFT-single-voice-pending-fleet-adjudication.md) | 2026-04-25           | Earlier single-voice synthesis. Quarantined per discipline rule                                                                                        |
| 02      | [`02-fleet-adversarial-review.md`](02-fleet-adversarial-review.md)                                                                 | 2026-04-25           | Round 1 cross-fleet review. 6 voices, 3 distinct families                                                                                              |
| 03      | [`03-spec-v2-DRAFT-pending-fleet.md`](03-spec-v2-DRAFT-pending-fleet.md)                                                           | 2026-04-25           | Round 2 v2.1 corrections to Gemini's spec (Codex rounds 1+2)                                                                                           |
| 04      | [`04-extension-codex-components.md`](04-extension-codex-components.md)                                                             | 2026-04-26           | Codex round-3: 15 architectural component extensions                                                                                                   |
| –       | [`frontier-lab-primitive-harvest.md`](frontier-lab-primitive-harvest.md)                                                           | 2026-04-26           | Phase 0 industry-wide primitive harvest (15 frontier stacks)                                                                                           |
| **05**  | [`05-CHUCK-V3-UNIFIED-DRAFT.md`](05-CHUCK-V3-UNIFIED-DRAFT.md)                                                                     | 2026-04-26           | **Unified V3 working draft (51 KB) — the artifact under review**                                                                                       |
| 05a     | [`05a-claude-code-critique-of-unified-draft.md`](05a-claude-code-critique-of-unified-draft.md)                                     | 2026-04-26 21:00 CDT | Claude Code (Opus 4.7) single-voice critique of the unified draft. Six numbered load-bearing critiques                                                 |
| 05b     | [`05b-codex-exec-response.md`](05b-codex-exec-response.md)                                                                         | 2026-04-26 21:14 CDT | Codex (`codex exec`) response to 05a. 3,229 chars / 137 sec                                                                                            |
| 05c     | [`05c-codex-review-response.md`](05c-codex-review-response.md)                                                                     | 2026-04-26 21:42 CDT | Codex (`codex review`) response to 05a. 6,240 chars / 99 sec. Sibling-surface signal for 05d                                                           |
| **05d** | [`05d-spec-patch-surface-as-first-class-field.md`](05d-spec-patch-surface-as-first-class-field.md)                                 | 2026-04-26 21:55 CDT | **Spec patch — surface as a first-class field. Exhaustive, ready to fold into 06**                                                                     |
| 05e     | [`05e-claude-code-rating-of-chuck-overall.md`](05e-claude-code-rating-of-chuck-overall.md)                                         | 2026-04-26 22:10 CDT | Claude Code overall rating of Chuck across 9 dimensions. Asks for independent fleet grading                                                            |
| **05f** | [`05f-codex-mac-response.md`](05f-codex-mac-response.md)                                                                           | 2026-04-26 22:30 CDT | **Codex Mac-app response — workflow correction + distillation of 05d to its 5-bullet core. Names "the beautiful-spec-growth machine" trap**            |
| 08      | [`08-APEX-SALVAGE-LEDGER.md`](08-APEX-SALVAGE-LEDGER.md)                                                                           | 2026-04-27           | Apex/OpenClaw salvage ledger. Classifies old scripts and field-learned protocols as port-now, port-behind-Kernel, quarantine, rename/narrow, or retire |

Numbered files are content. Sub-letters (`05a`, `05b`, `05c`, `05d`) are responses or patches that share the parent's review cycle.

---

## Pending artifacts (next deliverables)

After Round 3 fleet review on `05-CHUCK-V3-UNIFIED-DRAFT.md` + this patch lineage:

- **`06-V3-CANONICAL-MINIMAL.md`** — compressed canonical V3 (target 25–30 KB). Folds in:
  - All six accepted/refined critiques from 05a (verdicts confirmed by 05b + 05c)
  - The surface-as-first-class spec patch from 05d
  - Whatever Round 3 cross-family review surfaces tomorrow
- **`06b-authority-diff.schema.json`** — typed authority-diff schema (gates Self-Improvement Lab + Doctrine Compiler per 05c §3, §4)
- **`06c-phase-0-metric-definitions.md`** — Phase 0 metric definitions before any calibration data is collected (per 05a critique #5 + 05c §4)

---

## How to dispatch this lineage to a fleet voice

From the openclaw repo root, via `apex-panel-ask`:

```bash
node extensions/memory-graph/scripts/apex-panel-ask.mjs \
  --file extensions/memory-graph/data/chuck-v2-design/05d-spec-patch-surface-as-first-class-field.md \
  --label v3-spec-patch-surface \
  --only codex
```

Replace `--only codex` with `--only codex-review` for the sibling surface (added 2026-04-26). Omit `--only` to fire the full panel.

For a multi-file review, point at the README and ask the voice to follow the lineage:

```bash
echo "Read extensions/memory-graph/data/chuck-v2-design/README.md, then read 05-CHUCK-V3-UNIFIED-DRAFT.md, 05a-, 05b-, 05c-, and 05d- in order. Give me your take on whether the 05d spec patch is sound." | \
  node extensions/memory-graph/scripts/apex-panel-ask.mjs \
  --prompt-stdin \
  --label v3-spec-patch-review \
  --only codex-review
```

---

## What's NOT in this directory

- Implementation code: lives in `extensions/memory-graph/scripts/` (apex-panel-ask, apex-nplex-adjudicate, apex-dispatch).
- Fleet config: lives in `extensions/memory-graph/data/apex-fleet.json` (or `~/.openclaw/workspace/state/apex-fleet.json` at runtime).
- Decision Records: live in `extensions/memory-graph/state/apex-decision-records/` (post-implementation).
- Adjudicator rotation state: lives in `extensions/memory-graph/state/apex-adjudicator-rotation.json` (post-implementation).
- Calibration data: lives in `extensions/memory-graph/data/calibration/` (Phase 0 deliverable, doesn't exist yet).
- Cutover inventory: generated by `extensions/memory-graph/scripts/chuck-v3-cutover-inventory.mjs` into [`migration/chuck-v3-cutover-inventory.md`](migration/chuck-v3-cutover-inventory.md) and `migration/chuck-v3-cutover-inventory.json`.
- Health snapshot: generated by `extensions/memory-graph/scripts/chuck-v3-health.mjs` into `~/.openclaw/workspace/state/chuck-v3/health-snapshot.json`. Default mode is non-invasive; use `--canary --only <voices>` for live probes. `perplexity-mac` uses a no-submit Incognito/fresh-thread lease proof, cached briefly at `~/.openclaw/workspace/state/chuck-v3/perplexity-mac-lease-proof.json`; `--submit-canary` adds a tiny OCR nonce readback proof but remains provisional until fresh-thread repeatability is hardened.
- Surface control primitives: `extensions/memory-graph/scripts/chuck-surface-control.mjs` provides app-agnostic activate/screenshot/OCR/click-by-text/click-by-ratio tools. App-specific drivers should layer policy and receipts over these primitives rather than hard-code one-off rituals.
- Task docket receipts: `extensions/memory-graph/scripts/chuck-task-docket.mjs` writes start/heartbeat/finish receipts under `~/.openclaw/workspace/state/chuck-v3/docket/`. This is the primitive for "leave chat, work outside, return here with a receipt."

---

_Authored by Chuck (Claude Code / Opus 4.7), 2026-04-26._
