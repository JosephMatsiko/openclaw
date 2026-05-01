// Config resolver for @openclaw/plugin-chuck-pwa.

export interface ChuckPwaConfig {
  enabled: boolean;
  routePrefix: string;
  defaultVoice: string;
  askTimeoutMs: number;
  personaInjectsIdentity: boolean;
  personaInjectsRecentMemory: boolean;
  personaRecentNodes: number;
}

const DEFAULTS: ChuckPwaConfig = {
  enabled: true,
  routePrefix: "/chuck-v3",
  defaultVoice: "gemini-web",
  askTimeoutMs: 180_000,
  personaInjectsIdentity: true,
  personaInjectsRecentMemory: true,
  personaRecentNodes: 8,
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

export function resolveConfig(raw: Record<string, unknown> | null | undefined): ChuckPwaConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    routePrefix: pickString(r, "routePrefix", DEFAULTS.routePrefix).replace(/\/+$/, ""),
    defaultVoice: pickString(r, "defaultVoice", DEFAULTS.defaultVoice),
    askTimeoutMs: pickInt(r, "askTimeoutMs", DEFAULTS.askTimeoutMs),
    personaInjectsIdentity: pickBoolean(
      r,
      "personaInjectsIdentity",
      DEFAULTS.personaInjectsIdentity,
    ),
    personaInjectsRecentMemory: pickBoolean(
      r,
      "personaInjectsRecentMemory",
      DEFAULTS.personaInjectsRecentMemory,
    ),
    personaRecentNodes: pickInt(r, "personaRecentNodes", DEFAULTS.personaRecentNodes),
  };
}
