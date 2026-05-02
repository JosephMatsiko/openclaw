// Public types for @openclaw/skill-notify.

export const NOTIFY_LEDGER_SCHEMA = "chuck-v3.notification-ledger/1";

export interface NotifyEntry {
  schema: typeof NOTIFY_LEDGER_SCHEMA;
  notif_id: string;
  ts: string;
  event_type: string;
  channel: string;
  payload: unknown;
  ack_received: boolean;
  ack_ts: string | null;
  ack_method: string | null;
  ack_note?: string;
  meta?: Record<string, string>;
}

export interface WriteOptions {
  event: string;
  channel: string;
  payload: unknown;
  ts?: string;
  meta?: Record<string, string>;
  /**
   * When true, after writing the ledger entry, also dispatch via the
   * configured channel. Returns per-channel result in the receipt.
   * Default false (preserves chuck-notify.mjs ledger-only semantics).
   */
  dispatch?: boolean;
  /** Optional severity hint forwarded to the apple-bridge channel. */
  severity?: "info" | "warn" | "critical";
  /** Optional title; falls back to event_type. */
  title?: string;
}

export interface AckOptions {
  notifId: string;
  method: string;
  ts?: string;
  note?: string;
  date?: string;
}

export interface ListOptions {
  pending?: boolean;
  date?: string;
  limit?: number;
  /** When true, scan all day-dirs; otherwise just today (or --date). */
  all?: boolean;
}

export interface GetOptions {
  notifId: string;
  date?: string;
}

export interface ChannelDispatchResult {
  channel: string;
  ok: boolean;
  /** Channel-specific success identifier (e.g. Telegram message_id). */
  receiptId?: string | number | null;
  status?: number;
  durationMs?: number;
  reason?: string;
}

export interface WriteResult {
  ok: boolean;
  ledger: { notif_id: string; path: string };
  dispatched: ChannelDispatchResult[];
}

export interface AckResult {
  ok: true;
  notif_id: string;
  ack_ts: string;
  ack_method: string;
  path: string;
}

export interface ListResult {
  ok: true;
  entries: Array<{
    notif_id: string;
    ts: string;
    event_type: string;
    channel: string;
    ack_received: boolean;
    ack_ts: string | null;
    ack_method: string | null;
  }>;
}

export interface GetResult {
  ok: true;
  entry: NotifyEntry;
  path: string;
}

/** Injectable HTTP poster — production uses node:https; tests stub. */
export type HttpPoster = (args: {
  url: string;
  body: Record<string, string | number | boolean>;
  timeoutMs: number;
}) => Promise<{ ok: boolean; status: number; text: string }>;

/** Injectable osascript runner — production uses spawn; tests stub. */
export type OsascriptRunner = (args: {
  script: string;
  timeoutMs: number;
}) => Promise<{ ok: boolean; stderr: string }>;

export interface RunDeps {
  httpPost?: HttpPoster;
  osascript?: OsascriptRunner;
}
