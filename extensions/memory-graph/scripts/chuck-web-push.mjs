#!/usr/bin/env node
// =============================================================================
// TRANSITIONAL DUPLICATE — Unit 7 of the openclaw-first migration (2026-05-01).
// =============================================================================
// The CANONICAL implementation lives at:
//   extensions/web-push/src/* (re-exported via @openclaw/plugin-web-push api.ts)
//
// This .mjs preserves identical VAPID + subscription-store + sendWebPush
// semantics so the remaining .mjs callers keep working unchanged:
//   - chuck-dashboard.mjs (LaunchAgent on :7777, line 34 import)
//   - chuck-comms-cascade.mjs (transitional duplicate of skill-reach-cascade)
//
// Vanilla Node can't import the TS plugin's api.ts at runtime, so duplicating
// the logic is the working seam. Both copies write to the same subscription
// store at ~/.openclaw/workspace/state/chuck-v3/push-subscriptions/ —
// wire-compatible.
//
// EDITS: bug fixes go in BOTH places (here AND extensions/web-push/src/*.ts).
// The .mjs retires when chuck-dashboard.mjs and chuck-comms-cascade.mjs
// migrate (queued in the watchers/cron migration unit).
//
// TS callers (chuck-pwa plugin's legacy-routes.ts, skill-reach-cascade's
// channels/web-push.ts) are switched to import from @openclaw/plugin-web-push
// in this commit — no longer depend on this .mjs. The chuck-web-push.d.mts
// type companion is also retired in this commit.
// =============================================================================
//
// chuck-web-push — Web Push (RFC 8030 / 8291 / 8292) sender for Chuck v3 PWA.
//
// Uses the `web-push` npm lib (installed at openclaw/node_modules/web-push@3.6.7).
// That lib handles VAPID JWT signing, ECDH-ES + HKDF + AES-128-GCM payload
// encryption, and POST to the push endpoint. We wrap it with three concerns:
//
//   1) Load VAPID keys from ~/.openclaw/credentials/web-push-vapid.json
//      (canonical store; perms 600; created via Part 1 generator).
//   2) Persist subscriptions to
//      ~/.openclaw/workspace/state/chuck-v3/push-subscriptions/
//      Each file = one PushSubscription JSON, named sub-<hash>.json where
//      hash = sha1(endpoint).slice(0,12). Dedupe is endpoint-based.
//   3) Single sender entry (`sendWebPush`) returning a uniform shape so the
//      cascade enforcer can treat web-push as one more attempter.
//
// Exports:
//   sendWebPush({ subscription, payload, ttl }) → { ok, status, error?, durationMs }
//   loadVapidKeys() → { publicKey, privateKey, subject, createdAt }
//   listSubscriptions() → array of PushSubscription objects (not file paths)
//   saveSubscription(sub) → { ok, file, deduped }
//   removeSubscription(endpoint) → { ok, file }
//
// CLI:
//   node chuck-web-push.mjs send-test
//   node chuck-web-push.mjs list

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const HOME = homedir();
const VAPID_PATH = join(HOME, ".openclaw", "credentials", "web-push-vapid.json");
const SUB_DIR = join(HOME, ".openclaw", "workspace", "state", "chuck-v3", "push-subscriptions");

// Load web-push from the openclaw workspace's node_modules. Use createRequire
// so this ESM module can pull the CommonJS lib without bundling. Locate it
// relative to a known anchor inside the workspace, not relative to import.meta
// (which is fragile if this file is symlinked / called from elsewhere).
const requireFromOpenclaw = createRequire(join(HOME, "Projects", "openclaw", "package.json"));
let webpush;
try {
  webpush = requireFromOpenclaw("web-push");
} catch (err) {
  // Re-thrown lazily when sendWebPush is actually invoked, so import-only
  // consumers (e.g. cascade reading listSubscriptions) don't crash if the
  // lib is missing.
  webpush = null;
}

// ─── helpers ───────────────────────────────────────────────────────────────
function ensureSubDir() {
  if (!existsSync(SUB_DIR)) mkdirSync(SUB_DIR, { recursive: true });
}

function endpointHash(endpoint) {
  return createHash("sha1").update(String(endpoint)).digest("hex").slice(0, 12);
}

function readJsonSafe(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function sanitizeEndpoint(endpoint) {
  // Show host + last 8 chars of path so logs are useful but don't leak the
  // full subscription URL (which would let anyone push to the device).
  try {
    const u = new URL(endpoint);
    const tail = u.pathname.length > 8 ? `…${u.pathname.slice(-8)}` : u.pathname;
    return `${u.host}${tail}`;
  } catch {
    return String(endpoint).slice(0, 40);
  }
}

// ─── exports ───────────────────────────────────────────────────────────────
export function loadVapidKeys() {
  if (!existsSync(VAPID_PATH)) {
    throw new Error(`VAPID keys missing at ${VAPID_PATH} — run the generator first`);
  }
  const obj = readJsonSafe(VAPID_PATH, null);
  if (!obj || !obj.publicKey || !obj.privateKey) {
    throw new Error(`VAPID file present but malformed: ${VAPID_PATH}`);
  }
  return obj;
}

export async function listSubscriptions() {
  ensureSubDir();
  const files = readdirSync(SUB_DIR).filter((n) => n.startsWith("sub-") && n.endsWith(".json"));
  const subs = [];
  for (const f of files) {
    const sub = readJsonSafe(join(SUB_DIR, f), null);
    if (sub && sub.endpoint && sub.keys?.p256dh && sub.keys?.auth) {
      subs.push(sub);
    }
  }
  return subs;
}

export async function saveSubscription(subscription) {
  ensureSubDir();
  if (!subscription || !subscription.endpoint) {
    throw new Error("saveSubscription: subscription.endpoint is required");
  }
  if (!subscription.keys?.p256dh || !subscription.keys?.auth) {
    throw new Error("saveSubscription: subscription.keys.p256dh and .auth are required");
  }
  const hash = endpointHash(subscription.endpoint);
  const file = join(SUB_DIR, `sub-${hash}.json`);
  const deduped = existsSync(file);
  const record = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
    expirationTime: subscription.expirationTime ?? null,
    savedAt: new Date().toISOString(),
    userAgent: subscription.userAgent ?? null,
  };
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  return { ok: true, file, deduped };
}

export async function removeSubscription(endpoint) {
  ensureSubDir();
  if (!endpoint) throw new Error("removeSubscription: endpoint is required");
  const hash = endpointHash(endpoint);
  const file = join(SUB_DIR, `sub-${hash}.json`);
  if (!existsSync(file)) return { ok: false, file, error: "not found" };
  rmSync(file);
  return { ok: true, file };
}

export async function sendWebPush({ subscription, payload, ttl = 60 }) {
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
    vapid = loadVapidKeys();
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err?.message || String(err),
      durationMs: Date.now() - start,
    };
  }
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  const body = JSON.stringify(payload || {});
  try {
    const result = await webpush.sendNotification(subscription, body, {
      TTL: ttl,
      urgency: payload?.severity === "critical" ? "high" : "normal",
    });
    // result.statusCode is 201 on most success cases, 200 on some.
    const status = result?.statusCode ?? 0;
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      error: ok ? undefined : `unexpected status ${status}`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    // WebPushError exposes statusCode + body for upstream debug.
    const status = err?.statusCode ?? 0;
    const detail = err?.body ? `${err.message}: ${String(err.body).slice(0, 200)}` : err?.message;
    return {
      ok: false,
      status,
      error: detail || String(err),
      durationMs: Date.now() - start,
    };
  }
}

// ─── CLI ───────────────────────────────────────────────────────────────────
async function cliSendTest() {
  const subs = await listSubscriptions();
  if (subs.length === 0) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason:
            "no subscriptions registered yet — open the PWA on a device, click 'Enable notifications', then re-run send-test",
          subscriptionDir: SUB_DIR,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  const payload = {
    title: "Chuck push test",
    body: "If you see this on your home screen, web push is wired.",
    tag: "chuck-push-test",
    severity: "info",
    data: { kind: "test", ts: new Date().toISOString() },
  };
  const results = [];
  for (const sub of subs) {
    const res = await sendWebPush({ subscription: sub, payload });
    results.push({ endpoint: sanitizeEndpoint(sub.endpoint), ...res });
  }
  console.log(
    JSON.stringify(
      {
        ok: results.some((r) => r.ok),
        sent: results.length,
        successCount: results.filter((r) => r.ok).length,
        results,
      },
      null,
      2,
    ),
  );
}

async function cliList() {
  const subs = await listSubscriptions();
  console.log(
    JSON.stringify(
      {
        count: subs.length,
        subscriptionDir: SUB_DIR,
        subscriptions: subs.map((s) => ({
          endpoint: sanitizeEndpoint(s.endpoint),
          savedAt: s.savedAt ?? null,
          userAgent: s.userAgent ?? null,
          expirationTime: s.expirationTime ?? null,
        })),
      },
      null,
      2,
    ),
  );
}

async function cliVapidPublic() {
  const v = loadVapidKeys();
  console.log(
    JSON.stringify({ publicKey: v.publicKey, subject: v.subject, createdAt: v.createdAt }, null, 2),
  );
}

async function main() {
  const cmd = process.argv[2] || "list";
  if (cmd === "send-test") return cliSendTest();
  if (cmd === "list") return cliList();
  if (cmd === "vapid-public") return cliVapidPublic();
  console.error(`unknown command: ${cmd}`);
  console.error("usage: chuck-web-push.mjs {send-test | list | vapid-public}");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
