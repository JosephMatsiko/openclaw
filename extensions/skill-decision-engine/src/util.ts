// Filesystem + crypto + bus emit helpers shared by detectors / store / scan.

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function fingerprint(category: string, payload: string): string {
  return createHash("sha1").update(`${category}::${payload}`).digest("hex").slice(0, 12);
}

export function decisionId(): string {
  return `decision-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

export function tailLines(path: string, maxLines: number): string[] {
  if (!existsSync(path)) return [];
  try {
    const buf = readFileSync(path, "utf8");
    const lines = buf.split("\n");
    return lines.slice(-maxLines - 1).filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

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
        source: "skill-decision-engine",
        type,
        payload,
      };
      try {
        appendFileSync(eventsPath, `${JSON.stringify(ev)}\n`, "utf8");
      } catch {
        // Best-effort; never break the scan on event-bus failures.
      }
    },
  };
}
