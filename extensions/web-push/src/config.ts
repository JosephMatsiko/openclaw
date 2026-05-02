// Config resolver for @openclaw/plugin-web-push.

import { homedir } from "node:os";
import { join } from "node:path";

export interface WebPushConfig {
  enabled: boolean;
  vapidPath: string;
  subscriptionDir: string;
  defaultTtlSeconds: number;
}

const HOME = homedir();

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

const DEFAULTS: WebPushConfig = {
  enabled: true,
  vapidPath: expandHome("~/.openclaw/credentials/web-push-vapid.json"),
  subscriptionDir: expandHome("~/.openclaw/workspace/state/chuck-v3/push-subscriptions"),
  defaultTtlSeconds: 60,
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

function pickPath(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) return fallback;
  return expandHome(v);
}

export function resolveConfig(raw: Record<string, unknown> | null | undefined): WebPushConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    vapidPath: pickPath(r, "vapidPath", DEFAULTS.vapidPath),
    subscriptionDir: pickPath(r, "subscriptionDir", DEFAULTS.subscriptionDir),
    defaultTtlSeconds: pickInt(r, "defaultTtlSeconds", DEFAULTS.defaultTtlSeconds, {
      min: 0,
      max: 86_400,
    }),
  };
}
