// Config resolver for @openclaw/plugin-reach-ledger.

export interface ReachLedgerConfig {
  enabled: boolean;
  ledgerPath: string;
  freshnessWindowMinutes: number;
  circuitBreakerThreshold: number;
}

const DEFAULTS: ReachLedgerConfig = {
  enabled: true,
  ledgerPath: "~/.openclaw/workspace/state/chuck-v3/reach-ledger.json",
  freshnessWindowMinutes: 15,
  circuitBreakerThreshold: 5,
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
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export function resolveConfig(raw: Record<string, unknown> | null | undefined): ReachLedgerConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    ledgerPath: pickString(r, "ledgerPath", DEFAULTS.ledgerPath),
    freshnessWindowMinutes: pickInt(r, "freshnessWindowMinutes", DEFAULTS.freshnessWindowMinutes),
    circuitBreakerThreshold: pickInt(
      r,
      "circuitBreakerThreshold",
      DEFAULTS.circuitBreakerThreshold,
    ),
  };
}
