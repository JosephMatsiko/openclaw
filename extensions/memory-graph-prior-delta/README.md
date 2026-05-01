# @openclaw/plugin-memory-graph-prior-delta

Typed dissent-preserving prior contract for multi-agent OpenClaw.

This plugin adds a structured, append-only, content-addressed prior + delta
substrate on top of the `memory-graph` plugin's SQLite store. It's the data
model behind cross-family discipline at synthesis time and the foundation
for governed multi-agent reasoning across an OpenClaw fleet.

Other multi-agent frameworks stuff strings into a vector DB and call it
memory. This plugin treats the panel of voices as an ongoing legislative
record: each voice writes a typed posterior delta against a specific prior;
compactions are three-signature ceremonies; dissent is preserved across
every compaction as a schema invariant.

## What it adds

Four new node types (additive to memory-graph):

| Node                | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `prior-capsule`     | Hash-chained shared world-state. Per-voice read markers.     |
| `posterior-delta`   | Typed reply from a voice keyed against a specific prior.     |
| `compaction-record` | Three-signature ceremony folding deltas into the next prior. |
| `dissent-record`    | Preserved across every compaction as schema invariant.       |

Three edge types:

| Edge                    | Source              | Target            |
| ----------------------- | ------------------- | ----------------- |
| `delta-against-prior`   | `posterior-delta`   | `prior-capsule`   |
| `dissent-against-claim` | `dissent-record`    | claim node        |
| `compaction-folds`      | `compaction-record` | `posterior-delta` |

## Invariants (enforced in code)

These are **structural protections**, not policies. The plugin rejects
mutations that violate them at the validator layer.

1. **Append-only.** `prior-capsule`, `posterior-delta`, `compaction-record`,
   and `dissent-record` are all immutable after insert. The sole exception
   is `prior-capsule.read_markers`, which is monotonically-growing metadata.

2. **Compaction cannot drop dissent.** A `CompactionRecord` that omits any
   dissent id from the deltas it folds in is rejected at validation time.

3. **Three-signature compaction.** `proposer`, `approver`, and `signer` must
   be three distinct voice ids. (In a typical Cabinet: Compiler proposes,
   Court approves, Notary signs.)

4. **Cross-family discipline.** The approver's training family must NOT
   match the majority contributor family. Anthropic-dominant compactions
   need a non-Anthropic approver. The plugin requires the caller to provide
   a `voiceFamilies` registry (typically wired from `@openclaw/skill-panel-ask`).

## Install

```sh
openclaw plugins install @openclaw/plugin-memory-graph-prior-delta
```

Configure in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "memory-graph-prior-delta": {
        "enabled": true,
        "config": {
          "freshnessWindowMinutes": 240,
          "circuitBreakerThreshold": 5,
          "synthesizerCandidatePool": ["claude-cli", "chatgpt-web", "gemini-cli", "grok-web"]
        }
      }
    }
  }
}
```

## Use it

### From an agent (canonical path)

```json
{
  "tool": "prior_delta",
  "args": {
    "action": "validate-compaction",
    "validateCompaction": {
      "record": { "...CompactionRecord": "..." },
      "removedDeltas": [],
      "voiceFamilies": { "claude-cli": "anthropic", "court": "openai" }
    }
  }
}
```

Returns `{ ok: true, violations: [] }` or `{ ok: false, violations: [...] }`.

### Programmatic API

```ts
import {
  validateCompaction,
  validateAppendOnly,
  priorCapsuleId,
  posteriorDeltaId,
  type CompactionRecord,
  type PosteriorDelta,
} from "@openclaw/plugin-memory-graph-prior-delta";

const id = priorCapsuleId({ parent_hash: null, content, generated_at });
validateCompaction(record, removedDeltas, { voiceFamilies });
```

### Compute a content-addressed id without persisting

```json
{
  "tool": "prior_delta",
  "args": {
    "action": "compute-prior-id",
    "computePriorId": {
      "parent_hash": null,
      "content": { "summary": "...", "claim_refs": [], "dissent_refs": [], "evidence_index": {} },
      "generated_at": "2026-05-01T00:00:00Z"
    }
  }
}
```

## Roadmap

- ✅ v0.1 — types + four invariants + content-address helpers + tool stub
- ⏳ v0.2 — persistence: write nodes/edges through memory-graph's storage API
- ⏳ v0.3 — read-marker advance loop on prior-capsule writes
- ⏳ v0.4 — compaction ceremony (propose / approve / sign state machine)
- ⏳ v0.5 — migration from existing markdown prior capsules

Each step keeps the v0.1 surface (types + validators + hashes) stable so
callers never see contract drift across versions.

## Why this belongs upstream

Right now, every OpenClaw user who wants typed multi-agent memory writes
their own ad-hoc prior + delta layer. This plugin makes it a shared,
versioned, contract-bound substrate — and turns OpenClaw into a _governed_
agentic OS rather than another LLM router.

Filed as RFC: openclaw/openclaw#75788.

## License

MIT
