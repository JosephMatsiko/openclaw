// Public types for @openclaw/plugin-imessage-osascript.

export interface SendInput {
  /** Recipient — E.164 phone number or Apple ID. */
  buddy: string;
  /** Message body. */
  text: string;
  /** When false, skip the reach-ledger write. Default true. */
  recordToLedger?: boolean;
  /** Override the per-send timeout. */
  timeoutMs?: number;
}

export interface SendResult {
  ok: boolean;
  /** End-to-end latency including osascript launch. */
  durationMs: number;
  /** Always "messages-osascript" — Apple decides iMessage vs SMS-over-LTE. */
  transport: "messages-osascript";
  error?: string;
}
