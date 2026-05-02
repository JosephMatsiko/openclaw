// handleEvent — composes anti-recursion → flood gate → match → promote-to-
// docket → cascade fire. Pure-ish (mutates state in-place; caller saves).

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { checkAndRecordFlood } from "./antiflood.js";
import type { CascadeWatcherConfig } from "./config.js";
import { fireCascade } from "./notify.js";
import { promoteObservationToDocket, shouldPromoteToDocket } from "./promote.js";
import { findTrigger, isOwnEcho, SOURCE } from "./triggers.js";
import type { BusEvent, WatcherState } from "./types.js";

function emitEvent(eventsPath: string, type: string, payload: unknown): void {
  const ev = {
    id: `e-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
    ts: new Date().toISOString(),
    actor: "chuck",
    source: SOURCE,
    type,
    payload,
  };
  try {
    appendFileSync(eventsPath, `${JSON.stringify(ev)}\n`, "utf8");
  } catch {
    // Best-effort; never break the watcher on event-bus failures.
  }
}

export interface HandleResult {
  ignored?: { reason: string };
  promoted?: ReturnType<typeof promoteObservationToDocket>;
  matched?: { triggerType: string; severity: string; tier: string; subject: string };
  suppressed?: { triggerType: string; source: string; count: number; windowMs: number };
  fired?: {
    delivered: boolean;
    deliveredVia: string | null;
    ledgerEntryId: string | null;
    finalReason: string | null;
  };
}

export async function handleEvent(
  ev: BusEvent,
  state: WatcherState,
  config: CascadeWatcherConfig,
): Promise<HandleResult> {
  if (isOwnEcho(ev)) return { ignored: { reason: "own-echo" } };

  const result: HandleResult = {};

  // Auto-promote introspect observations in PARALLEL to (not instead of)
  // the cascade-notify path so a high-risk observation both notifies AND
  // lands as an actionable docket task.
  if (shouldPromoteToDocket(ev)) {
    try {
      const promoted = promoteObservationToDocket(ev, state, config);
      result.promoted = promoted;
      if (promoted.promoted) {
        emitEvent(config.eventsPath, "chuck.cascade.watcher.promoted", {
          triggerEventId: ev.id,
          introspectId: promoted.introspectId,
          taskId: promoted.taskId,
          riskClass: ev.payload?.riskClass,
        });
      }
    } catch (err) {
      process.stderr.write(`[skill-cascade-watcher] promote-to-docket: ${String(err)}\n`);
    }
  }

  const trig = findTrigger(ev);
  if (!trig) return result;

  const nowMs = Date.now();
  const triggerType = trig.typeMatch.source;
  const source = ev.source ?? "unknown";

  const flood = checkAndRecordFlood(state, triggerType, source, nowMs, config);
  if (flood.suppressed) {
    state.suppressions.push({
      ts: new Date(nowMs).toISOString(),
      triggerType,
      source,
      count: flood.count,
      windowMs: flood.windowMs,
      triggerEventId: ev.id,
      triggerEventType: ev.type,
    });
    emitEvent(config.eventsPath, "chuck.cascade.watcher.suppressed", {
      triggerType,
      source,
      count: flood.count,
      windowMs: flood.windowMs,
      triggerEventId: ev.id,
      triggerEventType: ev.type,
    });
    result.suppressed = { triggerType, source, count: flood.count, windowMs: flood.windowMs };
    return result;
  }

  let subject: string;
  try {
    subject = trig.subjectFn(ev);
  } catch (err) {
    subject = `Trigger ${triggerType} fired (subjectFn threw: ${(err as Error).message ?? err})`;
  }
  state.matches.push({
    ts: new Date(nowMs).toISOString(),
    triggerEventId: ev.id,
    triggerType,
    eventType: ev.type ?? "(unknown)",
    source,
    severity: trig.severity,
    tier: trig.tier,
    subject,
  });
  emitEvent(config.eventsPath, "chuck.cascade.watcher.matched", {
    triggerEventId: ev.id,
    triggerType,
    eventType: ev.type,
    riskClass: ev.payload?.riskClass ?? null,
    severity: trig.severity,
    tier: trig.tier,
  });
  result.matched = { triggerType, severity: trig.severity, tier: trig.tier, subject };

  const bodyRaw = JSON.stringify(ev.payload ?? {});
  const body = bodyRaw.length > 600 ? bodyRaw.slice(0, 600) : bodyRaw;
  let cascade: Awaited<ReturnType<typeof fireCascade>>;
  try {
    cascade = await fireCascade({
      subject,
      body,
      severity: trig.severity,
      tier: trig.tier,
      origin: { kind: SOURCE, ref: ev.id },
    });
  } catch (err) {
    cascade = {
      delivered: false,
      channel: null,
      attempts: [],
      ledgerEntryId: null,
      finalReason: `fireCascade threw: ${(err as Error).message ?? err}`,
    };
  }
  state.fires.push({
    ts: new Date().toISOString(),
    triggerEventId: ev.id,
    triggerType,
    eventType: ev.type ?? "(unknown)",
    subject,
    delivered: cascade.delivered,
    deliveredVia: cascade.channel,
    ledgerEntryId: cascade.ledgerEntryId,
    finalReason: cascade.finalReason ?? null,
  });
  emitEvent(config.eventsPath, "chuck.cascade.watcher.fired", {
    triggerEventId: ev.id,
    triggerType,
    ledgerEntryId: cascade.ledgerEntryId,
    deliveredVia: cascade.channel,
    delivered: cascade.delivered,
  });
  result.fired = {
    delivered: cascade.delivered,
    deliveredVia: cascade.channel,
    ledgerEntryId: cascade.ledgerEntryId,
    finalReason: cascade.finalReason ?? null,
  };
  return result;
}
