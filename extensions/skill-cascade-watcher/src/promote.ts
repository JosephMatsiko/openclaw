// Auto-promote-to-docket: medium/high-risk introspect observations become
// pending docket tasks so they're actionable, not just notified.
//
// Idempotent on introspectId (never duplicate-promote the same observation).
// Risk-class mapping caps docketed risk at "medium" so the dockethealth
// scanner doesn't escalate auto-promoted tasks into the recursive failure-
// investigation cycle if they later fail.

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CascadeWatcherConfig } from "./config.js";
import { SOURCE } from "./triggers.js";
import type { BusEvent, WatcherState } from "./types.js";

export function shouldPromoteToDocket(ev: BusEvent): boolean {
  if (ev?.type !== "chuck.introspect.observed") return false;
  const riskClass = ev.payload?.riskClass;
  return riskClass === "medium" || riskClass === "high";
}

export function alreadyPromoted(state: WatcherState, introspectId: string | undefined): boolean {
  if (!introspectId) return false;
  return (state.promotions ?? []).some((p) => p.introspectId === introspectId);
}

export interface PromoteResult {
  promoted: boolean;
  reason?: string;
  introspectId?: string;
  taskId?: string;
}

export function promoteObservationToDocket(
  ev: BusEvent,
  state: WatcherState,
  config: CascadeWatcherConfig,
): PromoteResult {
  const introspectId = ev?.payload?.introspectId as string | undefined;
  if (!introspectId) return { promoted: false, reason: "no introspectId" };
  if (alreadyPromoted(state, introspectId)) {
    return { promoted: false, reason: "already-promoted", introspectId };
  }
  const taskId = `task-introspect-promoted-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const now = new Date().toISOString();
  const riskClass = String(ev.payload?.riskClass ?? "low");
  const docketRisk = riskClass === "high" ? "medium" : "low";
  const category = (ev.payload?.category as string) ?? "introspect-observation";
  const recommendation =
    (ev.payload?.recommendation as string) ??
    "Address introspect observation (no recommendation in payload)";
  const titleBase =
    recommendation.length > 80 ? `${recommendation.slice(0, 77)}...` : recommendation;
  const title = `Introspect[${riskClass}/${category}]: ${titleBase}`;
  const task = {
    id: taskId,
    title,
    status: "pending",
    risk: docketRisk,
    commandKind: "claude-cli-build",
    surface: "chuck-cockpit",
    intent: recommendation,
    createdAt: now,
    updatedAt: now,
    createdBy: SOURCE,
    source: {
      kind: "chuck-introspect-promotion",
      category,
      fingerprint: introspectId,
    },
    heartbeats: [
      {
        at: now,
        phase: "pending",
        message: `Auto-promoted by ${SOURCE} from introspect observation ${introspectId} (riskClass=${riskClass})`,
      },
    ],
    promotedFrom: {
      eventId: ev.id ?? null,
      observedAt: ev.ts ?? null,
      introspectId,
      riskClass,
    },
  };
  const taskPath = join(config.docketDir, `${taskId}.json`);
  try {
    writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  } catch (err) {
    return { promoted: false, reason: `write failed: ${(err as Error).message ?? err}` };
  }
  state.promotions.push({
    ts: now,
    introspectId,
    eventId: ev.id,
    taskId,
    taskPath,
    riskClass,
    category,
  });
  return { promoted: true, taskId, introspectId };
}
