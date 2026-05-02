// Runtime config resolver — ledger paths + openclaw config location + channel
// timeouts.

import { homedir } from "node:os";
import { join } from "node:path";

export interface NotifyConfig {
  enabled: boolean;
  ledgerRoot: string;
  openclawConfigPath: string;
  telegramApiBase: string;
  telegramTimeoutMs: number;
  appleBridgeEnabled: boolean;
  appleBridgeTimeoutMs: number;
}

const HOME = homedir();
const DEFAULT_LEDGER = join(
  HOME,
  ".openclaw",
  "workspace",
  "state",
  "chuck-v3",
  "notification-ledger",
);
const DEFAULT_OPENCLAW = join(HOME, ".openclaw", "openclaw.json");

function pickBoolean(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input;
  return fallback;
}

function pickString(input: unknown, fallback: string): string {
  if (typeof input !== "string" || input.length === 0) return fallback;
  return input;
}

function pickPath(input: unknown, fallback: string): string {
  const s = pickString(input, fallback);
  if (s.startsWith("~/")) return join(HOME, s.slice(2));
  return s;
}

function pickInt(input: unknown, fallback: number, min: number, max: number): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return fallback;
  const intVal = Math.trunc(n);
  if (intVal < min || intVal > max) return fallback;
  return intVal;
}

export function resolveConfig(input: Record<string, unknown> | undefined): NotifyConfig {
  const raw = input ?? {};
  return {
    enabled: pickBoolean(raw.enabled, true),
    ledgerRoot: pickPath(raw.ledgerRoot, DEFAULT_LEDGER),
    openclawConfigPath: pickPath(raw.openclawConfigPath, DEFAULT_OPENCLAW),
    telegramApiBase: pickString(raw.telegramApiBase, "https://api.telegram.org"),
    telegramTimeoutMs: pickInt(raw.telegramTimeoutMs, 5000, 500, 60_000),
    appleBridgeEnabled: pickBoolean(raw.appleBridgeEnabled, true),
    appleBridgeTimeoutMs: pickInt(raw.appleBridgeTimeoutMs, 5000, 500, 30_000),
  };
}
