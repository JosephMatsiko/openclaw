// web-push channel — TRUE first leg of the cascade.
//
// Lands directly on PWA-installed devices (iPad/iPhone Safari + macOS Chrome
// PWA) without routing through Telegram. Falls through to apex-apple-bridge
// when no subscriptions are registered (empty PWA install state).
//
// Backed by @openclaw/plugin-web-push (Unit 7 salvage of chuck-web-push.mjs).
// Programmatic API: listSubscriptions + sendWebPush from sibling extension.

import {
  listSubscriptions,
  resolveConfig as resolveWebPushConfig,
  sendWebPush,
  type PushSubscriptionRecord,
} from "../../../web-push/api.js";
import type { AttemptResult, NotifyPayload } from "../types.js";

const webPushConfig = resolveWebPushConfig({});

export async function attemptWebPush(payload: NotifyPayload): Promise<AttemptResult> {
  const start = Date.now();
  let subs: PushSubscriptionRecord[];
  try {
    subs = listSubscriptions(webPushConfig);
  } catch (err) {
    return {
      ok: false,
      error: `listSubscriptions failed: ${(err as Error).message ?? String(err)}`,
      durationMs: Date.now() - start,
    };
  }
  if (!subs || subs.length === 0) {
    return { ok: false, error: "no subscriptions registered", durationMs: Date.now() - start };
  }
  const wpPayload = {
    title: payload.subject || "Chuck",
    body: payload.body ?? "",
    tag: payload.origin?.kind ?? "chuck-default",
    severity: payload.severity ?? "info",
    data: {
      origin: payload.origin ?? null,
      tier: payload.tier ?? null,
      severity: payload.severity ?? "info",
      ts: new Date().toISOString(),
    },
  };
  const results = await Promise.all(
    subs.map((s) => sendWebPush({ subscription: s, payload: wpPayload }, webPushConfig)),
  );
  const okCount = results.filter((r) => r.ok).length;
  const failures = results
    .filter((r) => !r.ok)
    .map((r) => r.error)
    .filter((e): e is string => typeof e === "string" && e.length > 0);
  return {
    ok: okCount > 0,
    error: okCount === 0 ? failures.join("; ") || "all subscriptions failed" : undefined,
    durationMs: Date.now() - start,
    detail: { subscriptionCount: subs.length, successCount: okCount },
  };
}
