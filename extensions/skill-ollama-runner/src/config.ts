// Runtime config resolver — base URL + defaults + timeout.

export interface OllamaConfig {
  enabled: boolean;
  baseUrl: string;
  defaultModel: string;
  defaultMaxTokens: number;
  defaultTemp: number;
  defaultKeepAlive: string;
  generateTimeoutMs: number;
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

function pickFloat(input: unknown, fallback: number, min: number, max: number): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

export function resolveConfig(input: Record<string, unknown> | undefined): OllamaConfig {
  const raw = input ?? {};
  return {
    enabled: pickBoolean(raw.enabled, true),
    baseUrl: pickString(raw.baseUrl, process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"),
    defaultModel: pickString(raw.defaultModel, "llama3.1:8b"),
    defaultMaxTokens: pickInt(raw.defaultMaxTokens, 512, 16, 8192),
    defaultTemp: pickFloat(raw.defaultTemp, 0.2, 0, 2),
    defaultKeepAlive: pickString(raw.defaultKeepAlive, "10m"),
    generateTimeoutMs: pickInt(raw.generateTimeoutMs, 60_000, 5000, 600_000),
  };
}
