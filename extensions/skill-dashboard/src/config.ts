// Runtime config resolver — host + port + timeout + LaunchAgent label.

export interface DashboardConfig {
  enabled: boolean;
  host: string;
  port: number;
  baseUrl: string;
  queryTimeoutMs: number;
  launchAgentLabel: string;
}

function pickBoolean(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input;
  return fallback;
}

function pickString(input: unknown, fallback: string): string {
  if (typeof input !== "string" || input.length === 0) return fallback;
  return input;
}

function pickInt(input: unknown, fallback: number, min: number, max: number): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return fallback;
  const intVal = Math.trunc(n);
  if (intVal < min || intVal > max) return fallback;
  return intVal;
}

export function resolveConfig(input: Record<string, unknown> | undefined): DashboardConfig {
  const raw = input ?? {};
  const host = pickString(raw.host, "127.0.0.1");
  const port = pickInt(raw.port, 7777, 1, 65535);
  return {
    enabled: pickBoolean(raw.enabled, true),
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    queryTimeoutMs: pickInt(raw.queryTimeoutMs, 5000, 500, 60_000),
    launchAgentLabel: pickString(raw.launchAgentLabel, "com.openclaw.chuck-dashboard"),
  };
}
