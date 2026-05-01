// Public types for @openclaw/skill-reach-cascade.

export type Severity = "info" | "warn" | "critical";
export type Tier = "immediate" | "immediate-low-friction" | "digest";

export type ChannelName =
  | "web-push"
  | "apex-apple-bridge"
  | "telegram"
  | "discord"
  | "imessage"
  | "sms-bridge"
  | "voice"
  | "digest";

export interface NotifyOrigin {
  /** Free-form origin tag (e.g. "task-runner", "chuck-decision"). */
  kind?: string;
  /** Caller-supplied id so consumers can correlate ledger entries to source events. */
  id?: string;
  [key: string]: unknown;
}

export interface NotifyPayload {
  /** Required headline. Used as the notification title across every channel. */
  subject: string;
  /** Optional long-form body. Telegram applies long-update HTML formatting when present. */
  body?: string | null;
  /** info | warn | critical. critical bypasses quiet-hours. */
  severity?: Severity;
  /** Cascade tier. critical severity is auto-promoted to "immediate". */
  tier?: Tier;
  /** Origin metadata for downstream observers (web-push tag, ledger payload, etc). */
  origin?: NotifyOrigin | null;
  /** When true, walk the cascade but never actually fire any channel. */
  dryRun?: boolean;
  /** When true, skip the apex-apple-bridge step in this run. */
  skipAppleBridge?: boolean;
  /** Marker propagated by replay() so duplicate-cascades stay traceable. */
  replayOf?: string;
}

export interface AttemptResult {
  /** Per-attempter latency including subprocess launch. */
  durationMs: number;
  ok: boolean;
  error?: string;
  /** "openclaw-native" | "raw-bot-api" | "raw-bot-api-html" | "messages-osascript" | etc. */
  transport?: string;
  /** Optional message id surfaced by Telegram/Discord/etc. */
  messageId?: string | number | null;
  /** Channel-specific extras (subscription counts, guild ids, etc). */
  detail?: Record<string, unknown>;
  dryRun?: boolean;
}

export interface CascadeAttempt {
  channel: ChannelName;
  ok: boolean;
  ts: string;
  durationMs: number;
  /** True when the cascade explicitly skipped this channel (dry-run flag, --no-apple-bridge, etc). */
  skipped?: boolean;
  error?: string;
  transport?: string;
  messageId?: string | number | null;
  dryRun?: boolean;
}

export interface NotifyResult {
  /** True when at least one live channel succeeded (digest excluded). */
  delivered: boolean;
  /** Channel that produced the first ok=true. null when nothing succeeded. */
  channel: ChannelName | null;
  attempts: CascadeAttempt[];
  ledgerEntryId: string | null;
  finalReason: string;
  /** True when anti-spam squelched this notification. */
  squelched?: boolean;
}

export interface NotifyOptions {
  /** Override the runtime config snapshot (testing). */
  configOverrides?: Partial<import("./config.js").ReachCascadeConfig>;
  /** Skip the in-process anti-spam cache (testing or replay). */
  bypassAntispam?: boolean;
}

export interface CommsPolicyDoc {
  tiers?: Record<string, { cascadeOrder?: ChannelName[] }>;
}

export interface LedgerEntry {
  id: string;
  ts: string;
  payload: NotifyPayload;
  tier: Tier;
  cascadeOrder: ChannelName[];
  attempts: CascadeAttempt[];
  delivered: boolean;
  deliveredVia: ChannelName | null;
  finalReason: string;
  quietHoursActive: boolean;
  antispamHash: string;
  dryRun: boolean;
}
