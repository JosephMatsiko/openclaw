// Config resolver for @openclaw/skill-reach-cascade.
//
// All knobs that chuck-comms-cascade.mjs hard-coded as constants now flow
// through this resolver so per-deployment overrides via openclaw.json work
// without touching code.

import { homedir } from "node:os";
import { join } from "node:path";

export interface ReachCascadeConfig {
  enabled: boolean;
  telegramChatId: string;
  imessageBuddy: string;
  policyPath: string;
  ledgerDir: string;
  digestPendingDir: string;
  eventsPath: string;
  /** Empty string = auto-derive from $OPENCLAW_CLI_PATH or default dist location. */
  openclawCliPath: string;
  openclawNativeTimeoutMs: number;
  antispamWindowMs: number;
  /** Hour-of-day (0-23) at which quiet hours start. */
  quietHoursStart: number;
  /** Hour-of-day (0-23) at which quiet hours end. */
  quietHoursEnd: number;
  quietHoursTimezone: string;
}

const HOME = homedir();

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

const DEFAULTS: ReachCascadeConfig = {
  enabled: true,
  telegramChatId: "8630163522",
  imessageBuddy: "+14044517063",
  policyPath: expandHome("~/.openclaw/workspace/state/chuck-v3/policies/comms-policy.json"),
  ledgerDir: expandHome("~/.openclaw/workspace/state/chuck-v3/notification-ledger"),
  digestPendingDir: expandHome("~/.openclaw/workspace/state/chuck-v3/morning-digest/pending"),
  eventsPath: expandHome("~/.openclaw/workspace/state/apex-events.jsonl"),
  openclawCliPath: "",
  openclawNativeTimeoutMs: 30_000,
  antispamWindowMs: 30_000,
  quietHoursStart: 23,
  quietHoursEnd: 8,
  quietHoursTimezone: "America/Chicago",
};

function pickBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  return typeof v === "boolean" ? v : fallback;
}

function pickInt(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  bounds?: { min?: number; max?: number },
): number {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return fallback;
  if (bounds?.min != null && v < bounds.min) return fallback;
  if (bounds?.max != null && v > bounds.max) return fallback;
  return v;
}

function pickString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  return typeof v === "string" ? v : fallback;
}

function pickPath(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) return fallback;
  return expandHome(v);
}

export function resolveConfig(raw: Record<string, unknown> | null | undefined): ReachCascadeConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    telegramChatId: pickString(r, "telegramChatId", DEFAULTS.telegramChatId),
    imessageBuddy: pickString(r, "imessageBuddy", DEFAULTS.imessageBuddy),
    policyPath: pickPath(r, "policyPath", DEFAULTS.policyPath),
    ledgerDir: pickPath(r, "ledgerDir", DEFAULTS.ledgerDir),
    digestPendingDir: pickPath(r, "digestPendingDir", DEFAULTS.digestPendingDir),
    eventsPath: pickPath(r, "eventsPath", DEFAULTS.eventsPath),
    openclawCliPath: pickPath(r, "openclawCliPath", DEFAULTS.openclawCliPath),
    openclawNativeTimeoutMs: pickInt(
      r,
      "openclawNativeTimeoutMs",
      DEFAULTS.openclawNativeTimeoutMs,
      {
        min: 1000,
        max: 120_000,
      },
    ),
    antispamWindowMs: pickInt(r, "antispamWindowMs", DEFAULTS.antispamWindowMs, {
      min: 0,
      max: 600_000,
    }),
    quietHoursStart: pickInt(r, "quietHoursStart", DEFAULTS.quietHoursStart, { min: 0, max: 23 }),
    quietHoursEnd: pickInt(r, "quietHoursEnd", DEFAULTS.quietHoursEnd, { min: 0, max: 23 }),
    quietHoursTimezone: pickString(r, "quietHoursTimezone", DEFAULTS.quietHoursTimezone),
  };
}
