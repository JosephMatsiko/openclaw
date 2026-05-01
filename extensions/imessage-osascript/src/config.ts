// Config resolver for @openclaw/plugin-imessage-osascript.

export interface ImessageOsascriptConfig {
  enabled: boolean;
  defaultBuddy: string;
  timeoutMs: number;
  recordToLedger: boolean;
}

const DEFAULTS: ImessageOsascriptConfig = {
  enabled: true,
  defaultBuddy: "",
  timeoutMs: 12_000,
  recordToLedger: true,
};

function pickBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  return typeof v === "boolean" ? v : fallback;
}

function pickInt(raw: Record<string, unknown>, key: string, fallback: number): number {
  const v = raw[key];
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? v : fallback;
}

function pickString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  return typeof v === "string" ? v : fallback;
}

export function resolveConfig(
  raw: Record<string, unknown> | null | undefined,
): ImessageOsascriptConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    defaultBuddy: pickString(r, "defaultBuddy", DEFAULTS.defaultBuddy),
    timeoutMs: pickInt(r, "timeoutMs", DEFAULTS.timeoutMs),
    recordToLedger: pickBoolean(r, "recordToLedger", DEFAULTS.recordToLedger),
  };
}
