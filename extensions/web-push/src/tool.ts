// `web_push` agent tool — list subscriptions, save/remove, vapid-public,
// send-test.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { WebPushConfig } from "./config.js";
import { sendWebPush } from "./send.js";
import {
  listSubscriptions,
  removeSubscription,
  sanitizeEndpoint,
  saveSubscription,
} from "./store.js";
import type { PushSubscriptionRecord } from "./types.js";
import { loadVapidPublic } from "./vapid.js";

interface RawParams {
  action: "list" | "save" | "remove" | "vapid-public" | "send-test";
  subscription?: PushSubscriptionRecord;
  endpoint?: string;
  payload?: { title?: string; body?: string; tag?: string; severity?: string };
}

export function createWebPushTool(_params: { api: OpenClawPluginApi; config: WebPushConfig }) {
  const config = _params.config;
  return {
    name: "web_push",
    label: "Web Push",
    description:
      "Web Push subscription store + sender. 'list' returns registered subscriptions (sanitized endpoints). 'save' persists a PushSubscription. 'remove' deletes by endpoint. 'vapid-public' returns publicKey + subject for the PWA's subscribe() flow. 'send-test' fires a test notification to every registered subscription.",
    parameters: Type.Object({
      action: Type.String({
        enum: ["list", "save", "remove", "vapid-public", "send-test"],
      }),
      subscription: Type.Optional(
        Type.Object(
          {
            endpoint: Type.String(),
            keys: Type.Object({ p256dh: Type.String(), auth: Type.String() }),
            expirationTime: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
            userAgent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          },
          { additionalProperties: true },
        ),
      ),
      endpoint: Type.Optional(Type.String()),
      payload: Type.Optional(
        Type.Object(
          {
            title: Type.Optional(Type.String()),
            body: Type.Optional(Type.String()),
            tag: Type.Optional(Type.String()),
            severity: Type.Optional(Type.String()),
          },
          { additionalProperties: true },
        ),
      ),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "list") {
        const subs = listSubscriptions(config);
        return jsonResult({
          count: subs.length,
          subscriptionDir: config.subscriptionDir,
          subscriptions: subs.map((s) => ({
            endpoint: sanitizeEndpoint(s.endpoint),
            savedAt: s.savedAt ?? null,
            userAgent: s.userAgent ?? null,
            expirationTime: s.expirationTime ?? null,
          })),
        });
      }
      if (raw.action === "save") {
        if (!raw.subscription) throw new Error("save: subscription is required");
        return jsonResult(saveSubscription(raw.subscription, config));
      }
      if (raw.action === "remove") {
        if (!raw.endpoint) throw new Error("remove: endpoint is required");
        return jsonResult(removeSubscription(raw.endpoint, config));
      }
      if (raw.action === "vapid-public") {
        return jsonResult(loadVapidPublic(config));
      }
      if (raw.action === "send-test") {
        const subs = listSubscriptions(config);
        if (subs.length === 0) {
          return jsonResult({
            ok: false,
            reason:
              "no subscriptions registered yet — open the PWA on a device, click 'Enable notifications', then re-run send-test",
            subscriptionDir: config.subscriptionDir,
          });
        }
        const payload = {
          title: raw.payload?.title ?? "Chuck push test",
          body: raw.payload?.body ?? "If you see this on your home screen, web push is wired.",
          tag: raw.payload?.tag ?? "chuck-push-test",
          severity: raw.payload?.severity ?? "info",
          data: { kind: "test", ts: new Date().toISOString() },
        };
        const results = [];
        for (const sub of subs) {
          const res = await sendWebPush({ subscription: sub, payload }, config);
          results.push({ endpoint: sanitizeEndpoint(sub.endpoint), ...res });
        }
        return jsonResult({
          ok: results.some((r) => r.ok),
          sent: results.length,
          successCount: results.filter((r) => r.ok).length,
          results,
        });
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
