// sendWebPush — primary entry point. Wraps the `web-push` npm lib (loaded
// lazily via createRequire so import-only consumers don't crash if the lib
// is missing). Returns a uniform shape the cascade enforcer can treat as
// just one more attempter result.

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WebPushConfig } from "./config.js";
import type { SendWebPushParams, SendWebPushResult } from "./types.js";
import { loadVapidKeys } from "./vapid.js";

const HOME = homedir();
// Anchor createRequire on the openclaw package.json so the resolution is
// independent of where this plugin is symlinked from.
const requireFromOpenclaw = createRequire(join(HOME, "Projects", "openclaw", "package.json"));

interface WebPushLib {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    sub: unknown,
    body: string,
    options?: { TTL?: number; urgency?: string },
  ): Promise<{ statusCode?: number }>;
}

let webpush: WebPushLib | null = null;
try {
  webpush = requireFromOpenclaw("web-push") as WebPushLib;
} catch {
  // Re-thrown lazily when sendWebPush is invoked, so import-only consumers
  // (cascade reading listSubscriptions) don't crash if the lib is missing.
  webpush = null;
}

interface WebPushError extends Error {
  statusCode?: number;
  body?: string | Buffer;
}

export async function sendWebPush(
  params: SendWebPushParams,
  config: WebPushConfig,
): Promise<SendWebPushResult> {
  const start = Date.now();
  if (!webpush) {
    return {
      ok: false,
      status: 0,
      error: "web-push lib not loadable (openclaw/node_modules/web-push missing)",
      durationMs: Date.now() - start,
    };
  }
  let vapid;
  try {
    vapid = loadVapidKeys(config);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: (err as Error).message ?? String(err),
      durationMs: Date.now() - start,
    };
  }
  webpush.setVapidDetails(
    vapid.subject ?? "mailto:operator@example.com",
    vapid.publicKey,
    vapid.privateKey,
  );
  const body = JSON.stringify(params.payload ?? {});
  const ttl = params.ttl ?? config.defaultTtlSeconds;
  try {
    const result = await webpush.sendNotification(params.subscription, body, {
      TTL: ttl,
      urgency: params.payload?.severity === "critical" ? "high" : "normal",
    });
    const status = result?.statusCode ?? 0;
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      error: ok ? undefined : `unexpected status ${status}`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const e = err as WebPushError;
    const status = e?.statusCode ?? 0;
    const detail = e?.body ? `${e.message}: ${String(e.body).slice(0, 200)}` : e?.message;
    return {
      ok: false,
      status,
      error: detail ?? String(err),
      durationMs: Date.now() - start,
    };
  }
}
