// apex-events.jsonl emitter — best-effort, never throws on the caller.
//
// The events file is the primary observability seam for the cascade. Every
// `notify()` call produces at least one started event, one event per
// attempt, and a delivered/failed terminal event. Downstream watchers
// (chuck-cascade-watcher.mjs, chuck-introspect.mjs) tail this file.

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

export interface EventRecord {
  id: string;
  ts: string;
  actor: "chuck";
  source: "skill-reach-cascade";
  type: string;
  payload: unknown;
}

export interface EventEmitter {
  emit: (type: string, payload: unknown) => void;
}

export function createEventEmitter(eventsPath: string): EventEmitter {
  return {
    emit(type: string, payload: unknown): void {
      const ev: EventRecord = {
        id: `e-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
        ts: new Date().toISOString(),
        actor: "chuck",
        source: "skill-reach-cascade",
        type,
        payload,
      };
      try {
        appendFileSync(eventsPath, `${JSON.stringify(ev)}\n`, "utf8");
      } catch {
        // Best-effort; never break the cascade on event-bus failures.
      }
    },
  };
}
