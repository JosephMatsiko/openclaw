// Public types for @openclaw/skill-ollama-runner.

export interface AskOptions {
  prompt: string;
  /** Override default model (e.g. "llama3.1:8b"). */
  model?: string;
  /** Optional system prompt prefixed before the user prompt. */
  system?: string;
  maxTokens?: number;
  temp?: number;
  keepAlive?: string;
}

export interface AskResult {
  ok: boolean;
  reply: string;
  model: string;
  promptEvalCount?: number;
  evalCount?: number;
  evalDurationMs?: number;
  totalDurationMs?: number;
  reason?: string;
}

export type HttpJsonPoster = (args: {
  url: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}) => Promise<{ ok: boolean; status: number; text: string }>;

export interface RunDeps {
  httpPost?: HttpJsonPoster;
}
