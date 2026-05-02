// Public types for @openclaw/plugin-web-push.

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject?: string;
  createdAt?: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
  savedAt?: string;
  userAgent?: string | null;
}

export interface SaveSubscriptionResult {
  ok: boolean;
  file: string;
  deduped: boolean;
}

export interface RemoveSubscriptionResult {
  ok: boolean;
  file: string;
  error?: string;
}

export interface SendWebPushPayload {
  title?: string;
  body?: string;
  tag?: string;
  severity?: "info" | "warn" | "critical" | string;
  data?: Record<string, unknown>;
}

export interface SendWebPushParams {
  subscription: PushSubscriptionRecord;
  payload: SendWebPushPayload;
  ttl?: number;
}

export interface SendWebPushResult {
  ok: boolean;
  status: number;
  error?: string;
  durationMs: number;
}
