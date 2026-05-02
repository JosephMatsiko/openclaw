// Smoke tests for @openclaw/plugin-web-push.
//
// Subscription store + VAPID loader verified with synthesized files. The
// live web-push send path requires the `web-push` npm lib + a real push
// endpoint; covered separately via `node web_push send-test` against a
// device that's actually subscribed.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import {
  listSubscriptions,
  removeSubscription,
  sanitizeEndpoint,
  saveSubscription,
} from "./src/store.js";
import { loadVapidKeys, loadVapidPublic } from "./src/vapid.js";

describe("config resolver", () => {
  test("applies defaults", () => {
    const r = resolveConfig({});
    expect(r.enabled).toBe(true);
    expect(r.defaultTtlSeconds).toBe(60);
  });

  test("clamps ttl out of bounds", () => {
    const r = resolveConfig({ defaultTtlSeconds: 999_999 } as unknown as Record<string, unknown>);
    expect(r.defaultTtlSeconds).toBe(60);
  });

  test("expands ~ paths", () => {
    const r = resolveConfig({ vapidPath: "~/x/y/z.json" });
    expect(r.vapidPath.startsWith("/")).toBe(true);
    expect(r.vapidPath.endsWith("/x/y/z.json")).toBe(true);
  });
});

describe("subscription store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "web-push-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function freshConfig() {
    return resolveConfig({ subscriptionDir: dir, vapidPath: join(dir, "vapid.json") });
  }

  test("list returns empty on fresh dir", () => {
    expect(listSubscriptions(freshConfig())).toEqual([]);
  });

  test("save persists then list returns it", () => {
    const config = freshConfig();
    const sub = {
      endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc123",
      keys: { p256dh: "p256dh-key", auth: "auth-key" },
    };
    const result = saveSubscription(sub, config);
    expect(result.ok).toBe(true);
    expect(result.deduped).toBe(false);
    expect(existsSync(result.file)).toBe(true);
    const subs = listSubscriptions(config);
    expect(subs.length).toBe(1);
    expect(subs[0].endpoint).toBe(sub.endpoint);
  });

  test("save same endpoint twice = deduped=true on second", () => {
    const config = freshConfig();
    const sub = {
      endpoint: "https://test.example/abc",
      keys: { p256dh: "p", auth: "a" },
    };
    saveSubscription(sub, config);
    const result = saveSubscription(sub, config);
    expect(result.deduped).toBe(true);
    expect(listSubscriptions(config).length).toBe(1);
  });

  test("save rejects missing endpoint", () => {
    const config = freshConfig();
    expect(() =>
      saveSubscription(
        { keys: { p256dh: "p", auth: "a" } } as unknown as Parameters<typeof saveSubscription>[0],
        config,
      ),
    ).toThrow(/endpoint is required/);
  });

  test("save rejects missing keys", () => {
    const config = freshConfig();
    expect(() =>
      saveSubscription(
        { endpoint: "https://x", keys: {} } as unknown as Parameters<typeof saveSubscription>[0],
        config,
      ),
    ).toThrow(/p256dh and \.auth are required/);
  });

  test("remove deletes the subscription file", () => {
    const config = freshConfig();
    const sub = {
      endpoint: "https://test.example/remove-me",
      keys: { p256dh: "p", auth: "a" },
    };
    const saved = saveSubscription(sub, config);
    expect(existsSync(saved.file)).toBe(true);
    const removed = removeSubscription(sub.endpoint, config);
    expect(removed.ok).toBe(true);
    expect(existsSync(saved.file)).toBe(false);
  });

  test("remove returns ok=false for unknown endpoint", () => {
    const config = freshConfig();
    const result = removeSubscription("https://nonexistent.example/x", config);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not found");
  });

  test("list silently skips malformed sub files", () => {
    const config = freshConfig();
    saveSubscription(
      { endpoint: "https://ok.example/x", keys: { p256dh: "p", auth: "a" } },
      config,
    );
    writeFileSync(join(dir, "sub-malformed.json"), "this isn't JSON {{");
    writeFileSync(join(dir, "sub-empty.json"), "{}");
    const subs = listSubscriptions(config);
    expect(subs.length).toBe(1);
    expect(subs[0].endpoint).toBe("https://ok.example/x");
  });
});

describe("sanitizeEndpoint", () => {
  test("keeps host + tail of path", () => {
    const out = sanitizeEndpoint(
      "https://updates.push.services.mozilla.com/wpush/v2/abcdefghij1234567890",
    );
    expect(out).toContain("updates.push.services.mozilla.com");
    expect(out).toContain("…");
  });

  test("returns truncated string for malformed URL", () => {
    const out = sanitizeEndpoint("not-a-url");
    expect(out.length).toBeLessThanOrEqual(40);
  });
});

describe("VAPID loader", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "web-push-vapid-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file throws", () => {
    const config = resolveConfig({ vapidPath: join(dir, "missing.json") });
    expect(() => loadVapidKeys(config)).toThrow(/VAPID keys missing/);
  });

  test("malformed file throws", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "not json {{");
    const config = resolveConfig({ vapidPath: path });
    expect(() => loadVapidKeys(config)).toThrow(/VAPID file present but unreadable/);
  });

  test("missing keys field throws", () => {
    const path = join(dir, "incomplete.json");
    writeFileSync(path, JSON.stringify({ subject: "mailto:test@example.com" }));
    const config = resolveConfig({ vapidPath: path });
    expect(() => loadVapidKeys(config)).toThrow(/malformed/);
  });

  test("valid file returns full keys", () => {
    const path = join(dir, "vapid.json");
    const expected = {
      publicKey: "BPubKeyValue",
      privateKey: "PrivKeyValue",
      subject: "mailto:joseph@example.com",
      createdAt: "2026-05-01T00:00:00Z",
    };
    writeFileSync(path, JSON.stringify(expected));
    const config = resolveConfig({ vapidPath: path });
    const out = loadVapidKeys(config);
    expect(out.publicKey).toBe(expected.publicKey);
    expect(out.privateKey).toBe(expected.privateKey);
    expect(out.subject).toBe(expected.subject);
  });

  test("loadVapidPublic strips privateKey", () => {
    const path = join(dir, "vapid.json");
    writeFileSync(
      path,
      JSON.stringify({
        publicKey: "BPubKey",
        privateKey: "Priv",
        subject: "mailto:x@example.com",
      }),
    );
    const config = resolveConfig({ vapidPath: path });
    const out = loadVapidPublic(config);
    expect(out.publicKey).toBe("BPubKey");
    expect((out as Record<string, unknown>).privateKey).toBeUndefined();
  });
});

describe("subscription file format wire-compat with chuck-web-push.mjs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "web-push-wire-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("written file has the same shape the .mjs writes", () => {
    const config = resolveConfig({ subscriptionDir: dir });
    const sub = {
      endpoint: "https://test.example/x",
      keys: { p256dh: "p", auth: "a" },
      expirationTime: null,
      userAgent: "Mozilla/5.0",
    };
    const result = saveSubscription(sub, config);
    const written = JSON.parse(readFileSync(result.file, "utf8"));
    expect(written.endpoint).toBe(sub.endpoint);
    expect(written.keys.p256dh).toBe(sub.keys.p256dh);
    expect(written.keys.auth).toBe(sub.keys.auth);
    expect(written.expirationTime).toBeNull();
    expect(typeof written.savedAt).toBe("string");
    expect(written.userAgent).toBe(sub.userAgent);
  });
});
