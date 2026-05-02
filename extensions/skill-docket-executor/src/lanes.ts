// Lane policies — per-lane timeout ceilings + per-lane running caps.
//
// Lanes group commandKinds by operational character: diagnostic = read-only
// cockpit/doctor checks; scout = model-family scout dispatch; build = repo/
// state writing; memory = prior/posterior maintenance; maintenance = Mac
// self-heal + local stewardship.

import type { Lane, LaneRunPolicy, LaneTimeoutPolicy } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export const LANE_TIMEOUT_POLICY: ReadonlyMap<Lane, LaneTimeoutPolicy> = new Map<
  Lane,
  LaneTimeoutPolicy
>([
  ["diagnostic", { defaultMs: 5 * 60 * 1000, longMs: 5 * 60 * 1000, maxMs: 15 * 60 * 1000 }],
  ["memory", { defaultMs: 10 * 60 * 1000, longMs: 20 * 60 * 1000, maxMs: 30 * 60 * 1000 }],
  ["maintenance", { defaultMs: 20 * 60 * 1000, longMs: 45 * 60 * 1000, maxMs: 60 * 60 * 1000 }],
  ["scout", { defaultMs: 45 * 60 * 1000, longMs: 90 * 60 * 1000, maxMs: 2 * 60 * 60 * 1000 }],
  ["build", { defaultMs: 45 * 60 * 1000, longMs: 2 * 60 * 60 * 1000, maxMs: 2 * 60 * 60 * 1000 }],
]);

// 2026-04-29: opened up per Joseph's "open it up fully" — codex was locked
// till May 5 (and per Joseph "until further notice" claude-cli stays primary),
// so build lane gets paralleled. Claude Max sub has materially higher headroom
// than codex's per-account weekly cap; multi-task concurrency is now safe.
export const EXECUTOR_LANE_POLICY: ReadonlyMap<Lane, LaneRunPolicy> = new Map<Lane, LaneRunPolicy>([
  ["diagnostic", { maxRunning: 2, description: "read-only cockpit/doctor checks" }],
  ["scout", { maxRunning: 2, description: "model-family scout dispatch" }],
  [
    "build",
    {
      maxRunning: 2,
      description: "repo/state writing build lane (claude-cli primary, paralleled)",
    },
  ],
  ["memory", { maxRunning: 2, description: "prior/posterior maintenance" }],
  ["maintenance", { maxRunning: 2, description: "Mac self-heal and local stewardship" }],
]);

export function laneTimeoutPolicy(lane: Lane | string | null | undefined): LaneTimeoutPolicy {
  if (!lane || !LANE_TIMEOUT_POLICY.has(lane as Lane)) {
    return { defaultMs: DEFAULT_TIMEOUT_MS, longMs: DEFAULT_TIMEOUT_MS, maxMs: DEFAULT_TIMEOUT_MS };
  }
  return LANE_TIMEOUT_POLICY.get(lane as Lane) as LaneTimeoutPolicy;
}

export function laneRunPolicy(lane: Lane | string | null | undefined): LaneRunPolicy | null {
  if (!lane || !EXECUTOR_LANE_POLICY.has(lane as Lane)) return null;
  return EXECUTOR_LANE_POLICY.get(lane as Lane) ?? null;
}
