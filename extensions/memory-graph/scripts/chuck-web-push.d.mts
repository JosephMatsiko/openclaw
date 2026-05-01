// Type companion for chuck-web-push.mjs.
//
// Allows TS callers (currently the chuck-pwa plugin's legacy-routes.ts) to
// import the .mjs module without falling back to implicit any. The .mjs
// runtime stays unchanged; this declaration just describes its public
// shape for typecheck. Remove this file when chuck-web-push.mjs itself
// migrates into a typed plugin (queued in Unit 2 follow-on as part of the
// reach-ledger / sms-bridge / cascade re-housing work).

export interface VapidKeys {
  publicKey?: string;
  privateKey?: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
  userAgent?: string | null;
  savedAt?: string;
  hash?: string;
}

export interface SaveSubscriptionResult {
  ok?: boolean;
  deduped?: boolean;
  file?: string;
  hash?: string;
}

export interface RemoveSubscriptionResult {
  ok?: boolean;
  removed?: string | null;
}

export interface SendWebPushPayload {
  title?: string;
  body?: string;
  tag?: string;
  severity?: string;
  data?: Record<string, unknown>;
}

export interface SendWebPushParams {
  subscription: PushSubscriptionRecord;
  payload: SendWebPushPayload;
  ttl?: number;
}

export interface SendWebPushResult {
  ok: boolean;
  error?: string;
  status?: number;
}

export function loadVapidKeys(): VapidKeys | null;
export function listSubscriptions(): Promise<PushSubscriptionRecord[]>;
export function saveSubscription(
  subscription: PushSubscriptionRecord,
): SaveSubscriptionResult | null;
export function removeSubscription(endpoint: string): RemoveSubscriptionResult | null;
export function sendWebPush(params: SendWebPushParams): Promise<SendWebPushResult>;
