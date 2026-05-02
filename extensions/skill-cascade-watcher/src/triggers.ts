// Cascade trigger table — patterns that fire skill-reach-cascade.notify().
//
// Each entry:
//   typeMatch: RegExp matched against event.type
//   when:      optional predicate (event) → bool; only fires if true
//   severity:  cascade severity (info | warn | critical)
//   tier:      cascade tier (immediate | immediate-low-friction | digest)
//   subjectFn: (event) → string subject line
//
// Anti-recursion: events from this watcher itself or any chuck.notify.* /
// chuck.cascade.watcher.* event are skipped before pattern matching.

import type { BusEvent, Trigger } from "./types.js";

export const SOURCE = "skill-cascade-watcher";

export const CASCADE_TRIGGERS: Trigger[] = [
  // Task / docket failures (executor already fires; harmless backstop).
  {
    typeMatch: /^chuck\.docket\.(failed|validation_failed)$/,
    severity: "warn",
    tier: "immediate-low-friction",
    subjectFn: (ev) => {
      const task = (ev.payload?.task as { title?: string; id?: string } | undefined) ?? {};
      return `Task failed: ${task.title ?? task.id ?? "(unknown)"}`;
    },
  },
  // Mac-self-heal failures.
  {
    typeMatch: /^chuck\.mac\.self_heal\.failed$/,
    severity: "warn",
    tier: "immediate-low-friction",
    subjectFn: (ev) => `Mac self-heal failed: ${(ev.payload?.reason as string) ?? "(no reason)"}`,
  },
  // Gateway / executor crashes.
  {
    typeMatch: /^chuck\.(gateway|executor)\.crashed$/,
    severity: "critical",
    tier: "immediate",
    subjectFn: (ev) => {
      const sub = (ev.payload?.subsystem as string) ?? ev.type?.split(".")[1] ?? "subsystem";
      return `${sub} crashed: ${(ev.payload?.reason as string) ?? "(no reason)"}`;
    },
  },
  // Zombie cluster sweeps (>=3 in one tick = real anomaly, not routine recovery).
  {
    typeMatch: /^chuck\.zombie_recovered$/,
    when: (ev) => {
      const batch = ev.payload?.batch as unknown[] | undefined;
      return Array.isArray(batch) ? batch.length >= 3 : false;
    },
    severity: "warn",
    tier: "immediate-low-friction",
    subjectFn: (ev) => {
      const batch = ev.payload?.batch as unknown[] | undefined;
      return `Zombie cluster recovered: ${batch?.length ?? 1} tasks in one sweep`;
    },
  },
  // Codex lockout state changes.
  {
    typeMatch: /^chuck\.codex\.(locked|unlocked)$/,
    severity: "info",
    tier: "immediate-low-friction",
    subjectFn: (ev) => {
      const state = ev.type?.split(".").pop() ?? "(state)";
      return `Codex ${state}: ${(ev.payload?.reason as string) ?? "(no reason)"}`;
    },
  },
  // High-risk decision proposals.
  {
    typeMatch: /^chuck\.decision\.proposed$/,
    when: (ev) => ev.payload?.riskClass === "high",
    severity: "warn",
    tier: "immediate-low-friction",
    subjectFn: (ev) =>
      `High-risk decision needs review: ${(ev.payload?.recommendation as string) ?? "(no rec)"}`,
  },
  // High-risk introspection observations.
  {
    typeMatch: /^chuck\.introspect\.observed$/,
    when: (ev) => ev.payload?.riskClass === "high",
    severity: "warn",
    tier: "immediate-low-friction",
    subjectFn: (ev) =>
      `Introspection flagged high-risk: ${(ev.payload?.recommendation as string) ?? "(no rec)"}`,
  },
  // NOTE: chuck.notify.failed is intentionally NOT a trigger — a failed
  // cascade firing another cascade would loop. The cascade itself records
  // into the digest.
];

export function isOwnEcho(ev: BusEvent | null): boolean {
  if (!ev || typeof ev.type !== "string") return true;
  if (ev.source === SOURCE || ev.source === "chuck-cascade-watcher") return true;
  if (ev.type.startsWith("chuck.notify.")) return true;
  if (ev.type.startsWith("chuck.cascade.watcher.")) return true;
  return false;
}

export function findTrigger(ev: BusEvent): Trigger | null {
  for (const trig of CASCADE_TRIGGERS) {
    if (typeof ev.type !== "string" || !trig.typeMatch.test(ev.type)) continue;
    if (typeof trig.when === "function") {
      let ok = false;
      try {
        ok = trig.when(ev);
      } catch {
        ok = false;
      }
      if (!ok) continue;
    }
    return trig;
  }
  return null;
}
