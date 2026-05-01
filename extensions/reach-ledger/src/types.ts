// Public types for @openclaw/plugin-reach-ledger.

export interface ChannelRecord {
  last_proven_at: string | null;
  last_proven_message_id: string | null;
  last_proven_transport: string | null;
  last_failed_at: string | null;
  last_failed_reason: string | null;
  consecutive_failures: number;
  consecutive_successes: number;
}

export interface GlobalRecord {
  last_reached_via: string | null;
  last_reached_at: string | null;
}

export interface Ledger {
  version: 1;
  channels: Record<string, ChannelRecord>;
  global: GlobalRecord;
}

export interface RecordSuccessDetail {
  messageId?: string | null;
  transport?: string | null;
  ledgerEntryId?: string;
}

export interface RankOptions {
  /** Freshness window in ms. Default 15 minutes. */
  freshnessMs?: number;
  /** Consecutive-failure count that trips the circuit breaker. Default 5. */
  circuitBreakerThreshold?: number;
}
