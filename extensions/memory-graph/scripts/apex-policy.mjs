#!/usr/bin/env node
// Apex Policy — the never-compromise invariant, codified.
//
// RULE: a worker call tagged at a tier (apex-tier, pro-tier, etc.)
// must NEVER be silently served by a sub-tier model. If the tier's
// quota is exhausted, rotate:
//   1. Profile rotation — multi-profile fleet gives a parallel seat
//   2. Peer-tier rotation — another apex-tier model stands in (e.g.,
//      GPT-5 swap → Opus 4.7 or Gemini 3.1 Pro). Peers are defined in
//      the PEER_MAP below.
//   3. Queue + retry — wait for the quota window to roll
//   4. Explicit fail with ETA — return an error the caller can surface
//
// Never: downshift within a service (GPT-5 → o3 / GPT-4o / mini),
// never tier-degrade silently (Opus → Haiku, Pro → Flash).
//
// Track per-service quota burn via a JSONL event log. Fleet-coordinator
// surfaces trends; handlers read `apex-policy.mjs`'s decide() to pick
// the rotation target.
//
// This module exports pure decision helpers + a small state tracker;
// it does NOT invoke workers itself. Callers (apex-route, magazine,
// etc.) wrap their worker dispatch with `withPolicy(...)`.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();
const STATE_DIR = join(HOME, ".openclaw", "workspace", "state");
const QUOTA_LOG = join(STATE_DIR, "apex-quota.jsonl");
const QUOTA_STATE_PATH = join(STATE_DIR, "apex-quota-state.json");

// Apex-tier model inventory. Each entry has a quota window + rough cap.
// Peers share answer quality at the tier; a rotation among peers is
// never a degradation. Within-service downshifts are FORBIDDEN.
//
// Naming convention: logical model IDs that reflect the current live
// SKU on the service. When a service renames (e.g., OpenAI moving from
// gpt-5 Instant/Thinking to gpt-5.4 on 2026-02-13), update the key here
// and let the dispatch layer resolve the ID to an API-level model name.
export const APEX_TIER = {
  "claude-opus-4-7": { service: "claude", window: "max-subscription", capPerWindow: Infinity },
  "gemini-3.1-pro-preview": { service: "gemini-cli", window: "day", capPerWindow: 60 },
  "gemini-3.1-pro-webchat": {
    service: "gemini-webchat",
    window: "rolling-soft",
    capPerWindow: 9999,
  },
  // gpt-5.4 supersedes the original gpt-5 Instant/Thinking retired 2026-02-13.
  // Plus plan's auto-router silently upgrades hard queries to Thinking for
  // free (doesn't count toward the manual 3k/week Thinking cap).
  "gpt-5.4": { service: "chatgpt", window: "3h-rolling", capPerWindow: 60 },
  // Distinct SKU: explicit manual-select Thinking calls (3k/week cap on Plus).
  // Lives in the REASONING peer group below.
  "gpt-5.4-thinking": { service: "chatgpt", window: "week", capPerWindow: 3000 },
  "perplexity-pro": { service: "perplexity", window: "day", capPerWindow: 300 },
  "grok-4": { service: "grok", window: "day", capPerWindow: 9999 },
  "claude-opus-via-claude-ai": { service: "claude-ai", window: "day", capPerWindow: 9999 },
};

// Peer groups — rotating within a group preserves tier. Order within a
// group is not a priority — the policy picks the peer with the most
// remaining quota in its current window.
//
// Group 4 (REASONING): Opus 4.7 adaptive-thinking, Gemini 3.1 Pro Deep
// Think, and GPT-5.4 Thinking are peers for hard multi-step reasoning
// (theological exegesis, systematic edges, finance math, long
// derivations). Adaptive and Deep Think are *modes* on the base models,
// not separate SKUs — the dispatch layer applies the mode flag when the
// caller opts into this lane. Quota is shared with the base model's
// general-lane entry (same physical bucket on the provider side), so
// decide() treating this group as separate from the general group is an
// ergonomic labeling, not quota-isolated. GPT-5.4 Thinking is the one
// peer with its own explicit cap (3k/week manual-select on Plus).
export const PEER_GROUPS = [
  ["claude-opus-4-7", "claude-opus-via-claude-ai"],
  ["gemini-3.1-pro-preview", "gemini-3.1-pro-webchat"],
  ["gpt-5.4", "claude-opus-4-7", "gemini-3.1-pro-webchat"], // apex-general: any of the three
  ["claude-opus-4-7", "gemini-3.1-pro-webchat", "gpt-5.4-thinking"], // apex-reasoning (NEW)
];

// Convenience accessor: the reasoning peer group, for callers that want
// to opt in explicitly (e.g., `withPolicy({ target: "claude-opus-4-7",
// peerGroup: REASONING_PEER_GROUP, lane: "reasoning" }, ...)`). The
// dispatch layer is responsible for applying the reasoning-mode flag
// (thinking=adaptive on Opus, Deep Think on Gemini) — policy.mjs only
// names peers + enforces no-degrade.
export const REASONING_PEER_GROUP = PEER_GROUPS[3];

// Forbidden swaps guard general-lane callers from silent degrade. A
// reasoning-lane caller opts in via peerGroup explicitly and is outside
// the scope of this rule — the two concerns are decoupled (Opus 2026-04-23).
//
// 2026-02-13 sweep: retired models (o3, gpt-4o, gpt-4o-mini, gpt-4,
// o1-mini) removed. gpt-5.4-mini and gpt-5.3-instant are the current
// live degrades the rule actually needs to protect against.
export const SUB_TIER_FORBIDDEN_SWAPS = {
  "gpt-5.4": ["gpt-5.4-mini", "gpt-5.3-instant"],
  "claude-opus-4-7": ["claude-sonnet-4-6", "claude-haiku-4-5"],
  "gemini-3.1-pro-preview": ["gemini-3.1-flash-preview", "gemini-2.5-flash"],
  "perplexity-pro": ["perplexity-standard"],
};

// ---- State helpers ----------------------------------------------------

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function readState() {
  if (!existsSync(QUOTA_STATE_PATH)) {
    return { counters: {}, lastReset: {} };
  }
  try {
    return JSON.parse(readFileSync(QUOTA_STATE_PATH, "utf8"));
  } catch {
    return { counters: {}, lastReset: {} };
  }
}

function writeState(state) {
  ensureStateDir();
  const dir = dirname(QUOTA_STATE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(`${QUOTA_STATE_PATH}.tmp`, JSON.stringify(state, null, 2), "utf8");
  // Atomic swap
  const { renameSync } = require("node:fs");
  renameSync(`${QUOTA_STATE_PATH}.tmp`, QUOTA_STATE_PATH);
}

function windowStartMs(window) {
  const now = Date.now();
  if (window === "day") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (window === "3h-rolling") {
    return now - 3 * 3600 * 1000;
  }
  if (window === "max-subscription") {
    return 0;
  }
  return now - 3600 * 1000; // default 1h rolling
}

function activeCount(state, model, window) {
  const cutoff = windowStartMs(window);
  const log = state.counters[model] ?? [];
  const active = log.filter((t) => t >= cutoff);
  return active.length;
}

// ---- Public API -------------------------------------------------------

export function recordCall(model, { profileId = "default", tsMs = Date.now() } = {}) {
  ensureStateDir();
  const state = readState();
  state.counters[model] = state.counters[model] ?? [];
  state.counters[model].push(tsMs);
  // Cap log size per model
  if (state.counters[model].length > 2000) {
    state.counters[model] = state.counters[model].slice(-2000);
  }
  writeState(state);
  try {
    appendFileSync(
      QUOTA_LOG,
      `${JSON.stringify({ ts: new Date(tsMs).toISOString(), model, profileId })}\n`,
    );
  } catch {
    /* best-effort */
  }
}

export function remainingQuota(model) {
  const spec = APEX_TIER[model];
  if (!spec) {
    return Infinity;
  }
  if (spec.capPerWindow === Infinity) {
    return Infinity;
  }
  const state = readState();
  const used = activeCount(state, model, spec.window);
  return Math.max(0, spec.capPerWindow - used);
}

// decide({ target, peerGroup? }): returns the best-available model
// within the peer group. Never returns a sub-tier forbidden swap.
//
// Returns null if NO peer has remaining quota (caller should queue /
// fail explicit). Includes a `rotatedFrom` field when the returned
// model differs from the requested target, so callers log the
// rotation + surface it to Joseph.
export function decide({ target, peerGroup, profileId = "default" } = {}) {
  if (!target) {
    throw new Error("decide: target required");
  }
  const spec = APEX_TIER[target];
  if (!spec) {
    return {
      model: target,
      rotatedFrom: null,
      peerGroup: null,
      reason: "non-apex-tier-passthrough",
      profileId,
    };
  }
  const group = peerGroup ?? PEER_GROUPS.find((g) => g.includes(target)) ?? [target];
  const scored = group
    .filter((m) => APEX_TIER[m])
    .map((m) => ({
      model: m,
      remaining: remainingQuota(m),
      isTarget: m === target,
    }))
    .toSorted((a, b) => {
      // Prefer the original target if it has quota
      if (a.isTarget && a.remaining > 0) {
        return -1;
      }
      if (b.isTarget && b.remaining > 0) {
        return 1;
      }
      return b.remaining - a.remaining;
    });
  const pick = scored.find((s) => s.remaining > 0);
  if (!pick) {
    return {
      model: null,
      rotatedFrom: target,
      peerGroup: group,
      reason: "all-peers-exhausted",
      retryAfterMs: estimateRetryMs(target),
      profileId,
    };
  }
  return {
    model: pick.model,
    rotatedFrom: pick.model === target ? null : target,
    peerGroup: group,
    reason: pick.model === target ? "target-available" : "peer-rotation",
    profileId,
  };
}

function estimateRetryMs(model) {
  const spec = APEX_TIER[model];
  if (!spec) {
    return 60_000;
  }
  const state = readState();
  const log = state.counters[model] ?? [];
  if (log.length === 0) {
    return 60_000;
  }
  const cutoff = windowStartMs(spec.window);
  const active = log.filter((t) => t >= cutoff);
  if (active.length === 0) {
    return 60_000;
  }
  const oldestInWindow = active[0];
  // When the oldest call leaves the window, a quota unit frees
  if (spec.window === "3h-rolling") {
    return Math.max(0, oldestInWindow + 3 * 3600 * 1000 - Date.now() + 5000);
  }
  if (spec.window === "day") {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime() - Date.now();
  }
  return 3600 * 1000;
}

export function forbidsDowngrade(fromModel, toModel) {
  const forbidden = SUB_TIER_FORBIDDEN_SWAPS[fromModel];
  return Array.isArray(forbidden) && forbidden.includes(toModel);
}

// Wrap a worker call with policy enforcement. `workerFn` takes
// `{ model, prompt, profileId }` and returns the answer. If the
// caller passed a forbidden downshift, this throws.
export async function withPolicy({ target, peerGroup, prompt, profileId = "default" }, workerFn) {
  const decision = decide({ target, peerGroup, profileId });
  if (!decision.model) {
    const err = new Error(
      `apex-policy: no peer available for ${target}; retry in ${Math.round((decision.retryAfterMs ?? 0) / 1000)}s`,
    );
    err.policy = decision;
    throw err;
  }
  if (forbidsDowngrade(target, decision.model)) {
    throw new Error(`apex-policy: forbidden tier-downgrade ${target} → ${decision.model}`);
  }
  const t0 = Date.now();
  try {
    const result = await workerFn({ model: decision.model, prompt, profileId });
    recordCall(decision.model, { profileId, tsMs: t0 });
    return { ...result, _policy: decision };
  } catch (err) {
    recordCall(decision.model, { profileId, tsMs: t0 });
    throw err;
  }
}

// ---- CLI --------------------------------------------------------------

async function mainCli() {
  const cmd = process.argv[2] ?? "status";
  if (cmd === "status") {
    console.log(`[apex-policy] state=${QUOTA_STATE_PATH}`);
    const state = readState();
    for (const [model, spec] of Object.entries(APEX_TIER)) {
      const used = activeCount(state, model, spec.window);
      const remaining =
        spec.capPerWindow === Infinity ? "∞" : Math.max(0, spec.capPerWindow - used);
      console.log(
        `  ${model.padEnd(32)} window=${spec.window.padEnd(20)} used=${String(used).padStart(4)} remaining=${String(remaining).padStart(6)}`,
      );
    }
    return;
  }
  if (cmd === "decide") {
    const target = process.argv[3];
    if (!target) {
      console.error("usage: apex-policy.mjs decide <target-model>");
      process.exit(2);
    }
    const d = decide({ target });
    console.log(JSON.stringify(d, null, 2));
    return;
  }
  if (cmd === "peers") {
    console.log(JSON.stringify(PEER_GROUPS, null, 2));
    return;
  }
  console.error("usage: apex-policy.mjs [status|decide <model>|peers]");
  process.exit(2);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  mainCli().catch((err) => {
    console.error(`[apex-policy] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
