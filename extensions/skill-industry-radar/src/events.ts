// apex-events.jsonl emit — best-effort, never throws on the caller.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface EventEmitter {
  emit: (type: string, payload: unknown) => void;
}

export function createEventEmitter(eventsPath: string): EventEmitter {
  return {
    emit(type: string, payload: unknown): void {
      const entry = {
        id: `e-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
        ts: new Date().toISOString(),
        actor: "chuck",
        source: "skill-industry-radar",
        type,
        payload,
      };
      try {
        if (!existsSync(dirname(eventsPath))) mkdirSync(dirname(eventsPath), { recursive: true });
        appendFileSync(eventsPath, `${JSON.stringify(entry)}\n`, "utf8");
      } catch {
        // Best-effort.
      }
    },
  };
}
