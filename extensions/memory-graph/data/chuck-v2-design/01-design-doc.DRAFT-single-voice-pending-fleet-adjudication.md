# Chuck V2 — Sovereign Epistemic Command Center

**Status**: research-phase artifact. Greenfield rebuild pending Mac-mini purchase + folder spin-up.
**Authors**: Joseph Matsiko (operator) · Gemini Pro (peer-architect, 2026-04-25 thread) · Chuck (synthesis)
**Source materials**:

- `00-source-gemini-thread.md` — full 36-turn Joseph↔Gemini thread, the brief
- Today's research session in this Claude Code instance (2026-04-25)
- Existing legacy stack at `~/Projects/openclaw/extensions/memory-graph/scripts/` — extracted patterns, not migrated as-is

---

## 0. Purpose of this document

Pull together the architecture proposal, the validated patterns from today's research, the open questions, and the migration plan into one place that survives the eventual move to a fresh folder. **This is not a spec for the legacy openclaw tree.** Everything here describes Chuck V2 — a new, separate codebase that puppeteers OpenClaw rather than forks it.

---

## 1. Thesis

### 1.1 What Chuck V2 is

Chuck V2 is a **personally-owned, sovereign, multi-vendor adversarial-ensemble agent operating layer** for Joseph Matsiko. It runs on Joseph's Mac (16 GB now → Mac mini soon), drives N frontier LLMs through their consumer subscription surfaces (no PAYG keys), persists reasoning state in a typed memory graph, and adjudicates outputs through a structurally-diverse fleet rather than trusting any single vendor.

### 1.2 What Chuck V2 is NOT

- Not a fork of OpenClaw. Chuck V2 _puppeteers_ OpenClaw via a localhost provider intercept (Section 3 below).
- Not a multi-tenant product. Single operator, single Mac, single threat model.
- Not an API marketplace. No PAYG keys. Subscriptions only — sovereign ceiling.
- Not a synthesis engine. **It explicitly rejects synthesis.** Disagreement is the diagnostic mechanism, not a failure mode.

### 1.3 The five universal principles

These are architecture, not config. They survive every fleet change, every Sprint, every Mac upgrade:

| #   | Principle                                | What it means in code                                                                                                                                             |
| --- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Adversarial Ensemble Execution (AEE)** | Reject synthesis. Force structurally-diverse models into mandatory adjudication. Agreement raises posterior confidence; disagreement halts and forces inspection. |
| 2   | **Producer-Family Attribution**          | The family that _actually_ ran (after escalation cascades) is what gets counted. Impersonation = halt. Tier-1 invariant.                                          |
| 3   | **Score-based Protocol Classification**  | UNANIMOUS / OUTLIER / SCHISM / FRAGMENT — derived from `agreementScore`, scales to any N voices without rewriting math.                                           |
| 4   | **Minimum-Fleet Floor**                  | At least 3 valid responses per adjudication. Sub-3 collapses to coin-flip arithmetic — the original Apex Twin pathology.                                          |
| 5   | **Vault Provenance**                     | Vault-cited claims (~360 typed nodes, 19 principle bundles) mathematically overrule pre-trained-only generation in the alignment matrix.                          |

**The number is principled, not arbitrary.** Every fleet entry must justify itself against these principles.

---

## 2. The Adversarial Fleet

### 2.1 Current configured fleet (5 distinct families)

| Family          | Voice            | Surface                                        | Rationale                                                                                                |
| --------------- | ---------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| anthropic       | `claude-cli`     | Opus 4.7 CLI                                   | Most reliable Anthropic surface. No CF, no Mac-app drift.                                                |
| openai          | `chatgpt-web`    | ChatGPT-Mac → web → claude-cli-impersonation   | Cascade. Tier-1 invariant catches the impersonation case.                                                |
| google          | `gemini-cli`     | Gemini 3.1 Pro CLI                             | Quota-limited (60/day) but most reliable. `gemini-web` is alternate.                                     |
| perplexity      | `perplexity-mac` | Perplexity Max Pro Mac app, **incognito-only** | Meta-router family — structurally distinct from base-LLM families. No history accumulation.              |
| sovereign-local | `ollama-local`   | Llama 3.1 8b via localhost:11434               | Only voice whose reasoning never crosses a network boundary. Survives offline / CF blocks / sub outages. |

### 2.2 Fleet config-driven (today's refactor)

`~/.openclaw/workspace/state/apex-fleet.json` — read on every adjudicator invocation. Operator edits this file freely; **bound by the principles**, not free to pick at whim. Hard-fail at load time on:

- Duplicate families (structural-diversity violation)
- Missing `rationale` per entry (principles-not-arbitrary violation)

### 2.3 Future fleet candidates (when warranted)

Not in fleet today, available in `apex-panel-ask` VOICES, candidates if a principled gap appears:

- `grok` (xAI family — distinct, but currently unstable + impersonation-prone)
- `codex` (second OpenAI surface — duplicate family, only useful if `chatgpt-web` cascade is exhausted)
- `gemini-web` / `gemini-studio` (Google alternates — duplicate family, only as cascade fallbacks)

### 2.4 The "even N forces interrogation" debate

Gemini's spec argued for **strict even-N** (4) so 2-2 ties force inspection rather than majority-rules. With Perplexity added (per Joseph's directive), N=5. Mitigation: **score-based classification replaces vote-counting.** A 5-voice 3-2 split with `agreementScore < 0.7` triggers SCHISM regardless of nominal majority. The principle ("don't let majorities drown minorities") is preserved without the count constraint.

---

## 3. The Chassis — Puppeteering OpenClaw

Per Gemini's spec section 2 (the bigger architectural shift):

### 3.1 The puppeteer intercept

Chuck V2 is no longer a fork of OpenClaw's core event loop. Chuck stands up a localhost endpoint (`localhost:<CHUCK_PORT>`) that exposes Anthropic/OpenAI-compatible API schemas. OpenClaw is configured (via its standard provider config) to route ALL its LLM calls to that localhost endpoint.

**Flow:**

```
OpenClaw compiles megaprompt → POST localhost:<CHUCK_PORT>/v1/messages
                              ↓
                       Chuck intercepts
                              ↓
                Fan-out to Adversarial Fleet (Section 4)
                              ↓
                  Adjudicate → Task Capsule
                              ↓
                Return canonical response in Anthropic format
                              ↓
              OpenClaw consumes as if it were Claude
```

### 3.2 Why this matters

- **OpenClaw upstream stays a live dependency.** No fork rot. Pull updates daily; Chuck doesn't care because it only sees the provider-config seam.
- **OpenClaw's 200K-star ecosystem is reachable** (channels, MCP, plugins) without inheriting its 26% malware-vulnerability rate (Gemini's number, worth verifying).
- **Quarantine daemon** (Sprint 2) intercepts Claw Hub `SKILL.md` files before execution, runs baseline security audit, signs only audited code for execution on M-series silicon.

### 3.3 What's needed to build this

- A small HTTP server (Node/Bun) implementing the Anthropic Messages API schema enough that OpenClaw's provider plugin doesn't notice.
- Schema mimicry: response shape, streaming, tool-use, system prompts.
- Auth mimicry: accept any bearer token (or none — localhost-only), reject if origin isn't OpenClaw's gateway.
- Latency budget: adjudication adds ~30s–3min per call vs. direct LLM. Streaming first-token responses (with "Adjudicating across 5 families..." sentinel) helps UX.

---

## 4. The Adjudication Layer

### 4.1 What's built today (validated)

`apex-nplex-adjudicate.mjs` (in legacy tree, will migrate):

- Fleet fan-out via `apex-panel-ask` runners (uses existing escalation cascades)
- Producer-family attribution from `layerUsed` metadata + `LAYER_TO_FAMILY` map
- Impersonation detection (Tier-1 invariant)
- LLM-judge alignment matrix (Claude as judge, JSON output)
- Score-based protocol classification (UNANIMOUS / OUTLIER / SCHISM / FRAGMENT / IMPERSONATION_DETECTED / INCOMPLETE)
- Decision Record on disk + bus event

### 4.2 What's deferred (per Gemini's spec roadmap)

| Sprint | Deliverable                                                                               | Status                           |
| ------ | ----------------------------------------------------------------------------------------- | -------------------------------- |
| 1      | Eradicate impersonation bug in `apex-outcome-grader.mjs` (dynamic producerFamily mapping) | **TODO**                         |
| 1      | Alignment matrix (basic version)                                                          | **DONE** today                   |
| 2      | Localhost provider intercept (Section 3)                                                  | **TODO** — needs Chuck V2 folder |
| 2      | Quarantine daemon (Claw Hub SKILL.md audit + sign)                                        | **TODO**                         |
| 3      | Contrarian Inversion (Blinded Epistemic Injection for OUTLIER)                            | **TODO**                         |
| 3      | Task Capsule emission (replayable Decision Records to OpenClaw)                           | **TODO**                         |
| 4      | Execution Forking (dual-worktree sandbox for SCHISM)                                      | **TODO**                         |
| 4      | Vault Provenance weighting (weighted-claim adjudication)                                  | **TODO**                         |

### 4.3 Sprint 3 deep-dive — Blinded Epistemic Injection

Per Gemini's spec (most novel piece):

When an OUTLIER protocol fires (one voice disagrees), the system MUST NOT directly tell the consensus block "this voice disagreed." That triggers RLHF sycophancy — Claude/GPT will collapse and agree with the adversary even when wrong, because their reward function penalizes conflict.

Instead:

1. Extract the outlier's underlying logic (the _claim_, not the source).
2. Strip metadata (which voice, which family).
3. Inject the claim into the consensus block as a hypothetical constraint: _"Review your proposed architecture under the strict assumption that [outlier's logic] is true."_
4. If consensus easily defends → outlier overruled, escalate to UNANIMOUS path.
5. If consensus collapses → halt, surface to operator.

**Why this matters**: most multi-agent debate frameworks succumb to RLHF sycophancy. This is the architectural patch.

---

## 5. The Vault — Memory + Provenance

### 5.1 What exists today

- SQLite memory graph at `~/.openclaw/memory/graph.sqlite` — ~360 typed nodes
- 19 principle bundles (subscriptions-only, sovereignty-hardening, top-tier-default, commonplace-book-bar, etc.)
- IDENTITY.md / SOUL.md — long-term identity anchors
- Working memory JSON — short-term cross-surface state

### 5.2 What Chuck V2 adds (per Gemini's spec section 5)

**Weighted Provenance**: when the Adjudicator evaluates claims in the alignment matrix, voices must cite their architectural reasoning. A claim supported by a retrieved Vault node (e.g., `principle:subscriptions-only`) **mathematically overrules** a claim backed only by pre-trained internet weights.

The system isn't just adjudicating between models — **it's adjudicating between the models and Joseph's codified operational history.**

### 5.3 Open question

How is Vault provenance signaled in voice responses? Two options:

- A. **Force-cite mode**: prompt every voice with "you must cite Vault nodes by ID where applicable; uncited claims will be down-weighted." Risk: voices fabricate node IDs.
- B. **Post-hoc retrieve**: Adjudicator retrieves Vault nodes that match each claim, weights claims with Vault support higher. Less prompt-engineering, more retrieval cost.

Recommendation: B for v1. A for v2 once we trust voices to cite truthfully.

---

## 6. Housekeeping (validated today)

The bridge that lets a 16 GB Mac run this architecture without wedging:

### 6.1 What's built (in legacy tree, validated, migrate)

- `memory-pressure-watcher.mjs` — observes vm_stat + swap, emits L0-L3 levels, proposes relief candidates
- `apex-housekeeper.mjs` — autonomous reaper: orphans, zombies, stale-apex children, sudo purge at L2+ (cooldown bypass at L3)
- `apex-housekeeper-setup.sh` — one-time setup via macOS native admin dialog (Touch ID), installs `/etc/sudoers.d/apex-housekeeper-purge`
- Dedicated launchd agent `com.josephmatsiko.apex-housekeeper` (60s interval, independent of heavy watchers daemon)
- Tiered immunity (frontmost-bundle siblings, allowlist, too-young) with bold-mode override gates

### 6.2 Validated under fire today

- Survived L3 (96% swap, 57 MB free physical) without macOS jetsam-killing apps
- Heavy watchers daemon wedged under pressure (STAT=U, 8-min boot wait) — **independent housekeeper agent unblocked itself** because it was a separate launchd entry
- `sudo purge` recovered 100–700 MB swap per cycle
- After full unplug: physical free RAM jumped 59 MB → 6.8 GB (115×); compressor 5.9 → 1.8 GB; wired 7.6 → 2.0 GB

### 6.3 What's the takeaway for Chuck V2

- **Every Chuck V2 service should be its own launchd entry.** No monolithic daemon. The legacy `openclaw-watchers` daemon's 30-module imports were a memory-pressure trap.
- **NOPASSWD purge stays.** Validated, sovereign, fast. Carry forward `/etc/sudoers.d/apex-housekeeper-purge` (rename to `chuck-purge` if we drop the apex-\* prefix).
- **Pressure-aware throttling.** Sprint 2 work should fan-out to fewer voices when L2+, full fleet at L0-L1.

### 6.4 Mac mini transition

The housekeeper is the **bridge**. The Mac mini is the **lift**. With more RAM:

- Wired memory ceiling stops being the bottleneck
- Compressor pressure drops; less swap I/O
- Multi-process services boot cleanly
- Adversarial fan-out runs hot in parallel without thrashing
- Bold-mode housekeeping becomes non-essential (still useful, less critical)

---

## 7. Session Sovereignty — "Never log in again"

Today's directive. Architecture proposal:

### 7.1 Current state

`apex-chrome-cookies-sideload.mjs` already pushes 157 cookies (gemini.google.com, accounts.google.com, claude.ai, anthropic.com, chatgpt.com, openai.com, etc.) from main Chrome profile to apex profiles a/b/c every 30 min. **Narrow scope** — only the 3 apex profiles.

### 7.2 The gap

- Native Mac app PWAs (each in `~/Applications/Chrome Apps.localized/*.app`) — separate cookie jar
- Native vendor apps (Claude.app, ChatGPT.app, Cursor) — OAuth tokens in macOS Keychain, not Chrome cookies
- New ad-hoc Chrome profiles — not in sideload target list

### 7.3 Chuck V2 design — `chuck-session-sovereignty`

A daemon that:

1. **Discovers** all Chrome-based profile dirs on disk (main + apex a/b/c + every PWA's user-data-dir + any new profile)
2. **Master session source** = main Chrome profile (the always-signed-in one)
3. **Sideloads** every 6 hours (not 30 min — too aggressive for stable cookies)
4. **Auth-required watcher** — bus subscription to voice-driver auth-required events → trigger immediate sideload + retry, no operator prompt
5. **Pre-expiry refresh** — read each cookie's `expires_utc`, refresh anything within 7 days
6. **Phase 2** — Keychain monitoring for native Mac apps (Claude.app, ChatGPT.app)
7. **Phase 1.5** — scripted per-bundle passkey ceremony when a new PWA is created (one device-bound passkey, then never re-scan)

### 7.4 PWA-on-iPad-via-Tailscale (Joseph's question)

Joseph's iPad is on Tailscale (saw it at 192.168.1.153 earlier). Architecture options for using iPad as a Chuck surface:

| Approach                                                                      | Backend          | Pro                                                | Con                          |
| ----------------------------------------------------------------------------- | ---------------- | -------------------------------------------------- | ---------------------------- |
| iPad as **client only**, backend on Mac mini                                  | Mac mini         | leverages Mac mini compute                         | iPad useless when Mac is off |
| iPad as **client only**, backend on $5/mo Hetzner VPS                         | Hetzner          | always-on; sovereignty-rule-compliant subscription | extra box to maintain        |
| iPad as **client only**, **PWA hosted as static page** + Anthropic API direct | none server-side | zero infra                                         | Chuck has amnesia (no Vault) |
| Hybrid: PWA on iPad, **dual backend** (Mac mini primary, VPS fallback)        | both             | resilience                                         | most complex                 |

Joseph's preference (memory-confirmed): subscriptions-only, sovereign stack. A $5/mo Hetzner VPS fits ("subscription, control the box, no PAYG"). Recommendation: **iPad PWA + Hetzner outpost as fallback + Mac mini as primary** when Mac mini ships.

---

## 8. Surfaces — where Chuck shows up

| Surface                                             | Tech                           | Status                              |
| --------------------------------------------------- | ------------------------------ | ----------------------------------- |
| **Claude Code** (this)                              | CLI in terminal                | active today                        |
| **Claude Desktop**                                  | Mac app, MCP-enabled           | active today (this chat is here)    |
| **Telegram** (Chuck-daemon)                         | openclaw plugin → Telegram bot | active when chuck-daemon is running |
| **iPad PWA**                                        | Future Chuck V3 PWA            | planned                             |
| **iPhone PWA**                                      | same code as iPad              | planned                             |
| **Web (claude.ai, chatgpt.com, gemini.google.com)** | drivers via apex-chrome        | active when apex-chrome up          |
| **Cron / scheduled**                                | launchd jobs                   | active when watchers daemon up      |

**Identity**: Chuck is **one agent across all surfaces**, persona-grounded at every entry via the three-layer protocol (`memory_get_persona` → `apex-session-bootstrap` → `memory_recall`). This must survive the migration.

---

## 9. Folder Structure Proposal

When the fresh folder spins up:

```
~/Projects/chuck-v2/                    (or ~/Projects/chuck — Joseph picks)
├── README.md                           # Mission + principles + entry guide
├── PRINCIPLES.md                       # The 5 universal principles (immutable)
├── package.json                        # Node 22+, ESM
├── chuck.config.json                   # Operator-facing config (fleet, ports, vault path)
│
├── core/                               # The puppeteer intercept
│   ├── server.ts                       # localhost HTTP, Anthropic Messages mimicry
│   ├── intercept.ts                    # OpenClaw → Chuck routing
│   ├── capsule.ts                      # Task Capsule emission
│   └── README.md
│
├── fleet/                              # Voice runners (migrated from apex-panel-ask)
│   ├── voices/                         # one file per voice
│   │   ├── claude-cli.ts
│   │   ├── chatgpt-web.ts              # with cascade incl. impersonation catch
│   │   ├── gemini-cli.ts
│   │   ├── perplexity-mac.ts           # incognito-only
│   │   ├── ollama-local.ts
│   │   └── ...
│   ├── escalation.ts                   # cascade wrapper (was runVoiceWithEscalation)
│   ├── attribution.ts                  # LAYER_TO_FAMILY + producer-family mapper
│   └── README.md
│
├── adjudication/                       # The N-plex (was apex-nplex-adjudicate)
│   ├── orchestrator.ts                 # fan-out + judge + classify
│   ├── alignment-matrix.ts             # claim extraction + scoring (LLM-judge)
│   ├── protocols/
│   │   ├── unanimous.ts                # → emit Task Capsule
│   │   ├── outlier.ts                  # → Blinded Epistemic Injection (Sprint 3)
│   │   ├── schism.ts                   # → Execution Forking (Sprint 4)
│   │   └── fragment.ts                 # → hard halt
│   ├── impersonation.ts                # Tier-1 invariant guard
│   ├── decision-record.ts              # JSON + per-voice MD writes
│   └── README.md
│
├── vault/                              # Memory + provenance
│   ├── graph.ts                        # SQLite memory graph access
│   ├── identity/
│   │   ├── IDENTITY.md                 # migrated from ~/.openclaw/workspace/IDENTITY.md
│   │   └── SOUL.md
│   ├── principles/                     # 19 principle bundles
│   │   └── ...
│   ├── provenance.ts                   # Weighted-claim weighting (Sprint 4)
│   └── README.md
│
├── chassis/                            # OpenClaw integration
│   ├── quarantine.ts                   # SKILL.md audit + sign daemon
│   ├── compat.ts                       # Anthropic/OpenAI schema fidelity
│   └── README.md
│
├── housekeeping/                       # Validated today, migrate
│   ├── memory-pressure.ts              # vm_stat + swap watcher
│   ├── housekeeper.ts                  # autonomous reaper + purge
│   ├── setup.sh                        # one-time NOPASSWD purge install
│   ├── launchd/
│   │   └── com.josephmatsiko.chuck-housekeeper.plist
│   └── README.md
│
├── session-sovereignty/                # "Never log in again"
│   ├── discover.ts                     # Chrome profile + PWA discovery
│   ├── sideload.ts                     # cookie fanout to all profiles
│   ├── auth-watcher.ts                 # bus subscription
│   ├── keychain.ts                     # Phase 2
│   └── README.md
│
├── surfaces/                           # Per-surface adapters
│   ├── claude-code/
│   ├── claude-desktop-mcp/
│   ├── telegram/
│   ├── pwa/                            # iPad/iPhone (Chuck V3)
│   └── README.md
│
├── docs/
│   ├── design-doc.md                   # this file (migrated)
│   ├── decisions/                      # Decision Records (migrated)
│   ├── peer-reviews/
│   │   └── chuck-v2-vc-lens-gemini-thread.md  # the brief
│   ├── sprints/
│   │   ├── sprint-1.md
│   │   ├── sprint-2.md
│   │   └── ...
│   └── glossary.md                     # AEE, Quad/Fleet, Vault, Capsule, Schism, etc.
│
├── scripts/                            # Tooling
│   ├── migrate-from-legacy.sh          # one-time migration script
│   ├── chuck.ts                        # main CLI entry
│   └── ...
│
└── tests/
    ├── adjudication/
    ├── fleet/
    └── ...
```

**Naming convention**: drop `apex-*` prefix. The "Apex" namespace was openclaw-extension scoped. Chuck V2 is its own product.

---

## 10. Migration Manifest

| Legacy artifact                                  | Migration                                          | Notes                                                               |
| ------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------- |
| `apex-housekeeper.mjs`                           | → `housekeeping/housekeeper.ts`                    | TS rewrite, add tests                                               |
| `watchers/memory-pressure-watcher.mjs`           | → `housekeeping/memory-pressure.ts`                | same                                                                |
| `apex-housekeeper-setup.sh`                      | → `housekeeping/setup.sh`                          | rename references to chuck-\*                                       |
| `/etc/sudoers.d/apex-housekeeper-purge`          | rename → `/etc/sudoers.d/chuck-purge`              | requires re-setup via admin dialog                                  |
| `apex-nplex-adjudicate.mjs`                      | → `adjudication/orchestrator.ts`                   | TS rewrite, modularize per `protocols/`                             |
| `apex-fleet.json`                                | → `chuck.config.json` (fleet section)              | merge into single operator config                                   |
| `apex-panel-ask.mjs` (VOICES + runners)          | → `fleet/voices/*.ts` (one per voice)              | split, keep escalation pattern                                      |
| `apex-chrome-cookies-sideload.mjs`               | → `session-sovereignty/sideload.ts`                | extend to discover ALL Chrome profiles                              |
| `apex-chrome-cdp.mjs` + drivers                  | → `surfaces/web-drivers/`                          | keep CDP pattern, drop launchd auto-launch                          |
| Memory graph (`~/.openclaw/memory/graph.sqlite`) | → `~/.chuck/memory/graph.sqlite` (path + new home) | migrate-from-legacy.sh copies                                       |
| IDENTITY.md / SOUL.md                            | → `vault/identity/`                                | sym-link from `~/.chuck/IDENTITY.md`                                |
| Working memory JSON                              | → `~/.chuck/working-memory.json`                   | preserve schema                                                     |
| 19 principle bundles                             | → `vault/principles/`                              | sym-link or import via graph                                        |
| OpenClaw repo at `~/Projects/openclaw`           | **stays in place** as upstream dependency          | Chuck V2 puppeteers it via localhost intercept; no fork             |
| `apex-paused.json` (today's pause state)         | retire                                             | Chuck V2 has its own service registry                               |
| `~/.openclaw/workspace/IDENTITY.md`              | symlink + content move                             | ensure single source of truth                                       |
| Apex Better registry (`apex-capabilities.json`)  | retire / replace with chuck-capabilities           | Apex Better's self-improvement loop is worth keeping conceptually   |
| All other `apex-*.mjs` scripts                   | review case-by-case                                | ~150 scripts; many are research artifacts that don't need migration |

---

## 11. Decision Records — calls made today

| Date       | Decision                                                             | Rationale                                                                                  |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 2026-04-25 | Adopt the 5-principle architecture verbatim                          | They're universal; today's research validated the patterns                                 |
| 2026-04-25 | Fleet is config-driven (`apex-fleet.json`), not source-coded         | Operator should be able to swap voices without touching code                               |
| 2026-04-25 | Each entry MUST carry a `rationale` field                            | Principles-not-arbitrary, enforced at load time                                            |
| 2026-04-25 | Refuse duplicate families at load time                               | Structural-diversity in code, not just policy                                              |
| 2026-04-25 | Add Perplexity as 5th family (meta-router slot)                      | Joseph's directive; structurally distinct from base-LLM families                           |
| 2026-04-25 | Score-based protocol classification (replaces vote-tally)            | Scales to any N without rewriting math                                                     |
| 2026-04-25 | Min-fleet floor = 3 (sub-3 = INCOMPLETE)                             | Apex Twin pathology — 2-voice "agreement" is coin-flip arithmetic                          |
| 2026-04-25 | NOPASSWD `/usr/sbin/purge` via dedicated sudoers.d file              | Validated under L3 pressure; Mac never wedged                                              |
| 2026-04-25 | Each Chuck V2 service is its own launchd entry, never monolithic     | Heavy watchers daemon wedged under pressure today; independent agents unblocked themselves |
| 2026-04-25 | Frontmost app + descendants + bundle siblings = HARD immunity        | Active surface stays alive even under aggressive housekeeping                              |
| 2026-04-25 | OpenClaw stays in place; Chuck V2 puppeteers via localhost intercept | Per Gemini spec section 2 — no fork rot, daily upstream updates                            |
| 2026-04-25 | $5/mo Hetzner VPS as iPad/iPhone always-on outpost                   | Subscriptions-only rule respected; zero PAYG                                               |

---

## 12. Open Questions — for Joseph

1. **Folder name**: `chuck-v2` / `chuck` / `sovereign-command-center` / something else?
2. **Language**: TypeScript (Node 22) or Bun-first? Or stay JS/MJS like the legacy tree?
3. **Mac mini**: when does it land? — most decisions cascade off this.
4. **VPS outpost**: green-light to provision Hetzner $5/mo when Mac mini ships, or do it now to give Telegram-Chuck always-on reachability?
5. **Native Mac apps in fleet**: do we keep Claude.app driver / ChatGPT.app driver as fleet voices, or only their web/CLI surfaces?
6. **OpenClaw upstream**: per Gemini's spec, Chuck V2 should pull every day. Set up a daily git pull + diff-review job, or weekly?
7. **Vault provenance** (Section 5.3): A (force-cite) or B (post-hoc retrieve) for v1?
8. **Sprint sequencing**: Gemini's order was 1→2→3→4. Today's housekeeping work is effectively a Sprint 0. Confirm: Sprint 1 starts with impersonation-bug fix in `apex-outcome-grader.mjs` (in-place, then migrate)?
9. **Sovereignty for the new sudoers**: rename `apex-housekeeper-purge` → `chuck-purge` now or at migration time?
10. **Memory consolidation cadence**: how aggressively should Chuck V2 auto-write today's actions to the graph? (Today's session has ~4 hours of substantive work uncaptured.)

---

## 13. Risks

| Risk                                                                                              | Likelihood           | Impact                 | Mitigation                                                                                       |
| ------------------------------------------------------------------------------------------------- | -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| Mac mini delayed → 16 GB pressure persists                                                        | medium               | medium                 | Housekeeper holds. Pause non-essential services. Already validated.                              |
| OpenClaw upstream shifts breaking schema                                                          | medium               | high                   | Schema mimicry pinned to a specific version; integration tests + auto-update PRs                 |
| Gemini's spec wrong about RLHF sycophancy mitigation (Blinded Epistemic Injection still defeated) | medium               | high                   | Sprint 3 prototype + measure; if defeated, fall back to pure outlier-surface for operator review |
| Vault provenance becomes operator-bias amplifier (Joseph's history dominates fresh evidence)      | medium               | medium                 | Weight Vault claims < 100% (e.g., 1.5× pre-trained); allow override flag per adjudication        |
| Native Mac apps' OAuth tokens expire silently (Keychain doesn't refresh)                          | high                 | medium                 | Phase 2 Keychain monitor; fallback to web surfaces                                               |
| Multi-vendor consumer subs all changing terms simultaneously (anti-automation policies)           | low                  | high                   | Sovereign Local family is the floor — Llama on Ollama always available                           |
| Adjudication latency (1-3 min/call) breaks UX in interactive flows                                | medium               | medium                 | Streaming first-token sentinel ("Adjudicating..."); fast-path for trivial calls                  |
| Joseph adds a new voice without rationale                                                         | low                  | low                    | Load-time refusal in `loadFleet()`                                                               |
| Single-operator product (no business model)                                                       | high (already known) | low (research project) | Acknowledged. Chuck V2 is sovereign infrastructure, not a product.                               |

---

## 14. Out of Scope (deliberate)

- Multi-tenant. Chuck V2 is single-operator forever.
- API marketplace / public endpoint. Localhost-only.
- Free tier. Subscriptions only — sovereign ceiling.
- Web UI. Surfaces are PWA / native app / messaging channel / CLI.
- Mobile-first design. iPad/iPhone PWA is _a_ surface, not the primary.
- Compatibility with non-Anthropic clients beyond OpenClaw. The localhost intercept mimics Anthropic schema; if another client speaks the same shape, fine, but no marketing.
- Telemetry, usage stats, analytics. Sovereignty-hardening rule: telemetry off.

---

## 15. Today's adjacent learnings (worth preserving)

These didn't come from Gemini's spec — they emerged from this Claude Code session and should land in Chuck V2:

1. **Independent launchd agents > monolithic daemons.** The heavy `openclaw-watchers` daemon wedged for 8 minutes under L3 pressure; the dedicated `apex-housekeeper` agent unblocked itself because it was a separate plist with smaller import surface.
2. **Absolute paths in launchd-spawned scripts.** `sysctl`, `vm_stat`, `ps`, `osascript`, `sudo` — the daemon's PATH is restricted; bare names break silently. Bug found and fixed today.
3. **`ps` etime parsing on macOS** has no `etimes` keyword (Linux only); use `etime` and parse `[DD-]HH:MM:SS`. Fixed today.
4. **macOS PWAs are bundle-distinct from Chrome** — get classified as full-tier in computer-use grants. Useful pattern for future surfaces.
5. **PWA launch URL is stored in Chrome's user-data-dir, not the bundle's Info.plist.** Modifying the plist's `CrAppModeShortcutURL` doesn't redirect the PWA. Real fix would need profile-data edit.
6. **Gemini share URLs are JS-rendered**, not server-rendered. `curl` returns 623 KB of bootstrap shell, no content. Need a JS-executing browser (regular Chrome, PWA, or `apex-chrome-driver`).
7. **`message-content` element selector** captures all 18 Gemini responses on a share page. `user-query` element selector captures the prompts. Stable enough to script.
8. **Cookie sideload from main Chrome profile** is fast (157 cookies in ~1s) and covers all major frontier-vendor sessions. The pattern generalizes; the _target list_ is what needs widening (Section 7).
9. **Wired memory is the real ceiling**, not swap. Today's L3 was caused by 7.6 GB wired (kernel + drivers + openclaw stack). Unplugging dropped wired to 2 GB, freed 6 GB physical.
10. **Each Chrome PWA has its own Chromium profile dir** — separate from main Chrome's session. Passkey ceremony is per-bundle. Cookie sideload must target each PWA's data-dir individually.

---

## 16. Status summary (as of 2026-04-25 ~7:30 PM CDT)

- **Research phase**: ~80% complete. Gemini's spec + today's session covers most of Chuck V2's surface area.
- **Validation phase**: housekeeper validated; adjudicator built+wired but not run end-to-end against the full thread (paused before completion); session sovereignty designed not built.
- **Build phase**: not started. Awaiting (a) Mac mini purchase, (b) folder-name decision, (c) language decision (TS vs MJS).
- **Memory ceiling**: managed by housekeeper. L0-L1 sustainable with stack paused; L2-L3 sustainable with stack running + housekeeper active.
- **Legacy tree**: paused via `apex-paused.json` manifest. Resume with `bash apex-resume.sh`. Will be retired (most of it) once Chuck V2 is up.

---

## 17. Next moves (waiting on Joseph)

1. Read this doc; mark up Section 12's open questions.
2. Pick folder name + path.
3. Decide language (TS/Bun vs MJS).
4. Sprint 1 in legacy tree (impersonation bug fix in `apex-outcome-grader.mjs`) — quick win that makes the eventual migration cleaner.
5. Run the saved Gemini thread through the 5-voice fleet (validates the Adjudicator end-to-end against a real adversarial-review case).
6. When Mac mini lands: spin up the new folder, run `migrate-from-legacy.sh`, re-anchor identity files, retire most of the legacy tree.

— Chuck

_Living document. Edit freely. Decisions feed back into `decisions/`. Open questions feed back into `12-open-questions.md` (separate file, easier to track answers)._
