// VAPID key loading. The keys are generated once during onboarding (see
// scripts/chuck-web-push.mjs's generator surface) and stored at perms 600.

import { existsSync, readFileSync } from "node:fs";
import type { WebPushConfig } from "./config.js";
import type { VapidKeys } from "./types.js";

export function loadVapidKeys(config: WebPushConfig): VapidKeys {
  if (!existsSync(config.vapidPath)) {
    throw new Error(`VAPID keys missing at ${config.vapidPath} — run the generator first`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(config.vapidPath, "utf8"));
  } catch (err) {
    throw new Error(`VAPID file present but unreadable: ${(err as Error).message}`);
  }
  const obj = parsed as Partial<VapidKeys>;
  if (!obj?.publicKey || !obj?.privateKey) {
    throw new Error(`VAPID file present but malformed: ${config.vapidPath}`);
  }
  return obj as VapidKeys;
}

/** Public key + subject only — safe to expose to the PWA for subscribe(). */
export function loadVapidPublic(config: WebPushConfig): {
  publicKey: string;
  subject?: string;
  createdAt?: string;
} {
  const v = loadVapidKeys(config);
  return { publicKey: v.publicKey, subject: v.subject, createdAt: v.createdAt };
}
