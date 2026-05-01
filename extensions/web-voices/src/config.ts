// Config resolver for @openclaw/plugin-web-voices.

export interface WebVoicesConfig {
  enabled: boolean;
  workstationLeaseFile: string;
  selectorRegistryPath: string;
  perVoiceTimeoutMs: number;
  defaultProfilePort: number;
}

const DEFAULTS: WebVoicesConfig = {
  enabled: true,
  workstationLeaseFile:
    "~/.openclaw/workspace/state/chuck-v2/surface-control/active-workstation-lease.json",
  selectorRegistryPath: "~/.openclaw/workspace/state/web-voices/selectors.json",
  perVoiceTimeoutMs: 300_000,
  defaultProfilePort: 9222,
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
  return typeof v === "string" && v.trim().length > 0 ? v : fallback;
}

export function resolveConfig(raw: Record<string, unknown> | null | undefined): WebVoicesConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    workstationLeaseFile: pickString(r, "workstationLeaseFile", DEFAULTS.workstationLeaseFile),
    selectorRegistryPath: pickString(r, "selectorRegistryPath", DEFAULTS.selectorRegistryPath),
    perVoiceTimeoutMs: pickInt(r, "perVoiceTimeoutMs", DEFAULTS.perVoiceTimeoutMs),
    defaultProfilePort: pickInt(r, "defaultProfilePort", DEFAULTS.defaultProfilePort),
  };
}
