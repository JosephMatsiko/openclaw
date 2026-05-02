// Runtime config resolver.

import { homedir } from "node:os";
import { join } from "node:path";

export interface WatchersConfig {
  enabled: boolean;
  logsDir: string;
  eventsPath: string;
  busWindowHours: number;
  launchctlTimeoutMs: number;
}

const HOME = homedir();
const DEFAULT_LOGS = join(HOME, ".openclaw", "logs");
const DEFAULT_EVENTS = join(HOME, ".openclaw", "workspace", "state", "apex-events.jsonl");

function pickBoolean(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input;
  return fallback;
}

function pickPath(input: unknown, fallback: string): string {
  if (typeof input !== "string" || input.length === 0) return fallback;
  if (input.startsWith("~/")) return join(HOME, input.slice(2));
  return input;
}

function pickInt(input: unknown, fallback: number, min: number, max: number): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return fallback;
  const intVal = Math.trunc(n);
  if (intVal < min || intVal > max) return fallback;
  return intVal;
}

export function resolveConfig(input: Record<string, unknown> | undefined): WatchersConfig {
  const raw = input ?? {};
  return {
    enabled: pickBoolean(raw.enabled, true),
    logsDir: pickPath(raw.logsDir, DEFAULT_LOGS),
    eventsPath: pickPath(raw.eventsPath, DEFAULT_EVENTS),
    busWindowHours: pickInt(raw.busWindowHours, 6, 1, 168),
    launchctlTimeoutMs: pickInt(raw.launchctlTimeoutMs, 5000, 500, 30_000),
  };
}
