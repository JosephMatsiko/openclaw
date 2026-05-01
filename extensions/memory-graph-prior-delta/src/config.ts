// Config resolver for memory-graph-prior-delta plugin.

export interface PriorDeltaConfig {
  enabled: boolean;
  freshnessWindowMinutes: number;
  circuitBreakerThreshold: number;
  synthesizerCandidatePool: string[];
}

const DEFAULTS: PriorDeltaConfig = {
  enabled: true,
  freshnessWindowMinutes: 240,
  circuitBreakerThreshold: 5,
  synthesizerCandidatePool: ["claude-cli", "chatgpt-web", "gemini-cli", "grok-web"],
};

function pickBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  return typeof v === "boolean" ? v : fallback;
}

function pickInt(raw: Record<string, unknown>, key: string, fallback: number): number {
  const v = raw[key];
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? v : fallback;
}

function pickStringArray(raw: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const v = raw[key];
  if (Array.isArray(v) && v.every((s) => typeof s === "string")) {
    return v as string[];
  }
  return fallback;
}

export function resolveConfig(raw: Record<string, unknown> | null | undefined): PriorDeltaConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    freshnessWindowMinutes: pickInt(r, "freshnessWindowMinutes", DEFAULTS.freshnessWindowMinutes),
    circuitBreakerThreshold: pickInt(
      r,
      "circuitBreakerThreshold",
      DEFAULTS.circuitBreakerThreshold,
    ),
    synthesizerCandidatePool: pickStringArray(
      r,
      "synthesizerCandidatePool",
      DEFAULTS.synthesizerCandidatePool,
    ),
  };
}
