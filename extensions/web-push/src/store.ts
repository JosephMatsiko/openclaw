// Subscription store. Per-device sub-<sha1(endpoint).slice(0,12)>.json files.
// Endpoint-based dedupe (re-saving the same subscription overwrites cleanly).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebPushConfig } from "./config.js";
import type {
  PushSubscriptionRecord,
  RemoveSubscriptionResult,
  SaveSubscriptionResult,
} from "./types.js";

function endpointHash(endpoint: string): string {
  return createHash("sha1").update(String(endpoint)).digest("hex").slice(0, 12);
}

function readJsonSafe<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function ensureSubDir(config: WebPushConfig): void {
  if (!existsSync(config.subscriptionDir)) {
    mkdirSync(config.subscriptionDir, { recursive: true });
  }
}

export function listSubscriptions(config: WebPushConfig): PushSubscriptionRecord[] {
  ensureSubDir(config);
  const files = readdirSync(config.subscriptionDir).filter(
    (n) => n.startsWith("sub-") && n.endsWith(".json"),
  );
  const subs: PushSubscriptionRecord[] = [];
  for (const f of files) {
    const sub = readJsonSafe<PushSubscriptionRecord | null>(join(config.subscriptionDir, f), null);
    if (sub?.endpoint && sub.keys?.p256dh && sub.keys?.auth) subs.push(sub);
  }
  return subs;
}

export function saveSubscription(
  subscription: PushSubscriptionRecord,
  config: WebPushConfig,
): SaveSubscriptionResult {
  ensureSubDir(config);
  if (!subscription || !subscription.endpoint) {
    throw new Error("saveSubscription: subscription.endpoint is required");
  }
  if (!subscription.keys?.p256dh || !subscription.keys?.auth) {
    throw new Error("saveSubscription: subscription.keys.p256dh and .auth are required");
  }
  const hash = endpointHash(subscription.endpoint);
  const file = join(config.subscriptionDir, `sub-${hash}.json`);
  const deduped = existsSync(file);
  const record: PushSubscriptionRecord = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    expirationTime: subscription.expirationTime ?? null,
    savedAt: new Date().toISOString(),
    userAgent: subscription.userAgent ?? null,
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { ok: true, file, deduped };
}

export function removeSubscription(
  endpoint: string,
  config: WebPushConfig,
): RemoveSubscriptionResult {
  ensureSubDir(config);
  if (!endpoint) throw new Error("removeSubscription: endpoint is required");
  const hash = endpointHash(endpoint);
  const file = join(config.subscriptionDir, `sub-${hash}.json`);
  if (!existsSync(file)) return { ok: false, file, error: "not found" };
  rmSync(file);
  return { ok: true, file };
}

/** Sanitize an endpoint for logging (keeps host + last 8 chars of path). */
export function sanitizeEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    const tail = u.pathname.length > 8 ? `…${u.pathname.slice(-8)}` : u.pathname;
    return `${u.host}${tail}`;
  } catch {
    return String(endpoint).slice(0, 40);
  }
}
