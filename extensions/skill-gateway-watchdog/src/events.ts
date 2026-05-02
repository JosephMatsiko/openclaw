// apex-events.jsonl emit — best-effort, never throws on the caller.

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

export interface EventEmitter {
  emit: (type: string, payload: unknown) => void;
}

export function createEventEmitter(eventsPath: string): EventEmitter {
  return {
    emit(type: string, payload: unknown): void {
      const ev = {
        id: `e-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
        ts: new Date().toISOString(),
        actor: "chuck",
        source: "skill-gateway-watchdog",
        type,
        payload,
      };
      try {
        appendFileSync(eventsPath, `${JSON.stringify(ev)}\n`, "utf8");
      } catch {
        // Best-effort.
      }
    },
  };
}
