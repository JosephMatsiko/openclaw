# Migration-debt corrections — supersedes earlier per-unit AGENTS.md claims

This document corrects architectural claims I (Chuck) made in the migration-
debt sections of Units 6c, 8, 9, 10, 11, 13, 14, 15, 16, 17 — and in the
TRANSITIONAL DUPLICATE banners of the corresponding `chuck-*.mjs` files —
based on a deeper reading of the openclaw documentation.

The corrections supersede the original claims; please read these blocks
before relying on the per-unit notes.

---

## Correction 1 — Cron is NOT a daemon-runtime substitute

**Claim that was wrong (Units 6c, 8, 9, 10, 11, 13, 14, 15, 16, 17):**

> "The .mjs daemon stays in .mjs until openclaw cron supports long-running
> plugin daemons" (paraphrased — appears with variations in 17 files).

**Why it's wrong (per `https://docs.openclaw.ai/automation/cron-jobs`):**

> "Cron does **not** support long-running daemons. The system is designed
> for discrete, time-triggered executions: one-shot jobs auto-delete after
> success; recurring jobs execute on a schedule and complete; isolated
> runs include best-effort browser cleanup when done; timeoutSeconds
> aborts runs that exceed their window. There is no mechanism for
> persistent, always-on daemon processes. Jobs are event-driven snapshots,
> not continuous services."

**The real openclaw-native paths for the chuck-\* daemons are:**

1. **`automation/standing-orders`** — programs with permanent operating
   authority. Define scope, triggers, escalation rules; the agent
   executes autonomously within those boundaries. This is the natural
   home for chuck-introspect (autonomous reasoning loop), chuck-cascade-
   watcher (auto-promote-to-docket), chuck-self-improvement-scanner
   (recurring gap detection).

2. **`automation/taskflow`** — durable multi-step flows with state +
   revision tracking + sync semantics. This is the natural home for
   chuck-docket-executor (multi-step task execution with intermediate
   state preservation).

3. **`automation/hooks`** — scripts that run when something happens
   inside the Gateway (channel events, agent events, session events).
   This is the natural home for chuck-cascade-watcher's auto-promote
   logic (event-driven instead of polling).

4. **`automation/cron-jobs`** — for discrete time-triggered work
   (every 2h scan, daily roll-up). This IS appropriate for chuck-
   introspect's 2h scan AND chuck-mac-self-heal's 2h plan/apply, BUT
   only as snapshots — not as continuous loops.

5. **`automation/tasks`** (background tasks) — durable detached work
   units; complement to taskflow. Useful for one-off long operations
   spawned by an agent run.

**What this means for migration:**

- chuck-cascade-watcher → split into hooks (event-driven promote) + cron
  (periodic safety sweep)
- chuck-decision-engine → standing-order programs + cron (periodic scan)
- chuck-docket-executor → taskflow with the docket state model
- chuck-introspect → cron job firing the introspect tool every 2h
- chuck-mac-self-heal → cron job firing the mac_self_heal status + safe-
  stabilize every 2h, plus standing-order for approval-gated apply
- chuck-self-improvement-scanner → standing-order + cron
- chuck-morning-digest → cron
- chuck-dashboard → not retired by these primitives; the cockpit HTTP
  server is a long-running process by nature; either it stays as a
  LaunchAgent or moves to a fully-fledged openclaw-app-SDK external
  client (per `concepts/openclaw-sdk`)

**Action queued:** v0.2 of the migration is to wire the chuck-\* loops
onto these primitives. Until then the LaunchAgent + .mjs path is the
only one that works; the TRANSITIONAL DUPLICATE plugin siblings give
the typed surface for in-process callers but DON'T yet provide the
long-running execution path.

---

## Correction 2 — "Skill" ≠ "Plugin" in openclaw vocabulary

**Naming I used (Units 5b–10, 12, 14–19):**

> Every extension prefixed `extensions/skill-*` (e.g. `skill-introspect`,
> `skill-health-steward`, `skill-prior-compaction`, etc.).

**Why it's misleading (per `https://docs.openclaw.ai/tools/skills` +
`https://docs.openclaw.ai/tools/creating-skills`):**

In openclaw's vocabulary:

- A **skill** is a `SKILL.md` file in a discoverable directory
  (workspace `/skills`, project `/.agents/skills`, `~/.agents/skills`,
  `~/.openclaw/skills`, bundled, or `skills.load.extraDirs`). Skills
  teach an agent how/when to use existing tools.
- A **plugin** is a full extension with `openclaw.plugin.json`. Plugins
  add tools, channels, providers, hooks. Plugins can SHIP skills (by
  declaring `skills` directories in their manifest), but a plugin is
  not itself a skill.

Everything in `extensions/skill-*` is a **plugin**, not a skill.

**Why I'm leaving the naming as-is for now:**

Renaming 19 plugins would mean breaking the workspace package names
(`@openclaw/skill-introspect` etc), the `plugins.entries.skill-*`
references in `~/.openclaw/openclaw.json`, and the AGENTS.md / CLAUDE.md
boundary docs. Joseph hasn't requested the rename. Flagging here so
future readers (or future me) understand the misnomer; v0.2 is the
right time to migrate with proper deprecation aliases.

**Action queued:** v0.2 candidate — rename `extensions/skill-*` to
`extensions/plugin-*`, package names to `@openclaw/plugin-*`, with
aliases so existing `plugins.entries.skill-*` registrations stay valid
during the transition.

---

## Correction 3 — Multi-agent routing is the right home for chuck-as-persona

**Pattern I used:**

Treated chuck as a layer ON TOP of a single `agents/main` agent
(persona via SOUL.md, identity via IDENTITY.md, behavior via
AGENTS.md, etc.).

**Per `https://docs.openclaw.ai/concepts/multi-agent` +
`https://docs.openclaw.ai/concepts/delegate-architecture`:**

OpenClaw natively supports multiple agents per Gateway, each with own
workspace + auth profiles + session stores + channel bindings. The
proper path for chuck-as-its-own-persona is:

```bash
openclaw agents add chuck
openclaw agents bind --agent chuck --bind telegram:default
```

This gives chuck:

- Own workspace (`~/.openclaw/workspace-chuck`)
- Own auth profiles (`~/.openclaw/agents/chuck/agent/auth-profiles.json`)
- Own session store
- Own SOUL.md / IDENTITY.md / AGENTS.md / USER.md
- Routed Telegram messages from the operator hit chuck, not main

**Action queued:** v0.2 candidate — extract chuck into a separate
agent. Doesn't break anything; opens the door for multiple personas
(coder agent, ops agent, research agent) on one Gateway.

---

## Correction 4 — Memory layer should evaluate `memory-wiki` before custom graph

**Pattern I used:**

Built `memory-graph` as a custom plugin (SQLite + custom schema) for
storing principle bundles + reference content + commitments.

**Per `https://docs.openclaw.ai/concepts/memory` +
`https://docs.openclaw.ai/plugins/memory-wiki`:**

OpenClaw ships `memory-wiki` as a structured knowledge base with:

- Deterministic page structure
- Structured claims + evidence tracking
- Contradiction + freshness monitoring
- Generated dashboards
- Wiki-native tools (`wiki_search`, `wiki_get`, `wiki_apply`,
  `wiki_lint`)

This is closer to Joseph's "principle layer with graph-backed bundles"
goal than a hand-rolled SQLite schema. Built-in memory backends
(`memory-builtin`, `memory-qmd`, `memory-honcho`, `memory-lancedb`)
already cover hybrid semantic + keyword search.

**Action queued:** v0.2 evaluation — does `memory-wiki` cover the chuck
principle-layer use case? If yes, retire the custom memory-graph
schema. If no, document the specific gap as a memory-wiki contribution.

---

## Why these corrections weren't caught earlier

I shipped Units 1-19 over ~6 hours of an autonomous loop, working from
the codebase + my prior assumptions. I did not read the openclaw docs
in detail until Joseph explicitly redirected ("don't miss anything…
have you read everything"). The migration-debt notes in each unit's
AGENTS.md were written without grounding in `docs.openclaw.ai` — they
reflected what I imagined openclaw might do, not what it does.

All 17 commits stand as correct code (TS source + tests pass + plugins
load + tools register). The architectural narrative around them was
partially wrong. This file documents the corrections; v0.2 is when the
re-architecture lands.

---

## See also

- `https://docs.openclaw.ai/llms.txt` — full doc index
- `https://docs.openclaw.ai/automation/cron-jobs` — cron is event-driven only
- `https://docs.openclaw.ai/automation/standing-orders` — long-running authority
- `https://docs.openclaw.ai/automation/taskflow` — durable multi-step
- `https://docs.openclaw.ai/automation/hooks` — event-triggered scripts
- `https://docs.openclaw.ai/concepts/multi-agent` — agent isolation + bindings
- `https://docs.openclaw.ai/concepts/delegate-architecture` — named delegate pattern
- `https://docs.openclaw.ai/tools/skills` — skill vs plugin distinction
- `https://docs.openclaw.ai/plugins/memory-wiki` — structured knowledge plugin
