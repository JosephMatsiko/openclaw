// Test suite for @openclaw/skill-notify.
//
// HTTP poster + osascript runner injected. Real ledger writes use a tmp dir.
// Real Telegram credentials read from a synthetic openclaw-config file.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ackEntry,
  attemptAppleBridge,
  attemptTelegram,
  dispatchNotification,
  getEntry,
  listEntries,
  readTelegramBinding,
  resolveConfig,
  writeEntry,
  type HttpPoster,
  type NotifyConfig,
  type OsascriptRunner,
} from "./api.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "skill-notify-"));
}

function makeConfig(root: string, overrides: Partial<NotifyConfig> = {}): NotifyConfig {
  const ledgerRoot = join(root, "ledger");
  const openclawConfigPath = join(root, "openclaw.json");
  return {
    ...resolveConfig({ ledgerRoot, openclawConfigPath }),
    ...overrides,
  };
}

function writeOpenclawConfig(root: string, telegram: object | null): void {
  const channels: Record<string, unknown> = {};
  if (telegram) channels.telegram = telegram;
  writeFileSync(join(root, "openclaw.json"), JSON.stringify({ channels }), "utf8");
}

describe("config", () => {
  it("clamps + expands paths", () => {
    const cfg = resolveConfig({
      ledgerRoot: "~/x/ledger",
      openclawConfigPath: "~/x/oc.json",
      telegramTimeoutMs: 1,
      appleBridgeTimeoutMs: 9999999,
    });
    expect(cfg.ledgerRoot).toMatch(/\/x\/ledger$/);
    expect(cfg.openclawConfigPath).toMatch(/\/x\/oc\.json$/);
    expect(cfg.telegramTimeoutMs).toBe(5000);
    expect(cfg.appleBridgeTimeoutMs).toBe(5000);
  });
});

describe("ledger I/O", () => {
  let root: string;
  let cfg: NotifyConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("writeEntry creates a chuck-v3.notification-ledger/1 entry under YYYYMMDD dir", () => {
    const r = writeEntry(cfg, {
      event: "test-event",
      channel: "telegram",
      payload: "hello",
      ts: new Date("2026-05-02T12:34:56.000Z"),
    });
    expect(r.notif_id).toMatch(/^notif_20260502T123456Z_[a-f0-9]{6}$/);
    expect(r.path).toMatch(/\/ledger\/20260502\/notif_/);
    const persisted = JSON.parse(readFileSync(r.path, "utf8"));
    expect(persisted.schema).toBe("chuck-v3.notification-ledger/1");
    expect(persisted.event_type).toBe("test-event");
    expect(persisted.channel).toBe("telegram");
    expect(persisted.ack_received).toBe(false);
  });

  it("ackEntry flips ack_received and stamps ack_method/note", () => {
    const r = writeEntry(cfg, { event: "e", channel: "telegram", payload: "x" });
    const ack = ackEntry(cfg, { notifId: r.notif_id, method: "telegram-read", note: "seen" });
    const persisted = JSON.parse(readFileSync(ack.path, "utf8"));
    expect(persisted.ack_received).toBe(true);
    expect(persisted.ack_method).toBe("telegram-read");
    expect(persisted.ack_note).toBe("seen");
  });

  it("listEntries returns today's entries by default; --pending filters acked", () => {
    const ts = new Date();
    writeEntry(cfg, { event: "a", channel: "telegram", payload: "x", ts });
    const r2 = writeEntry(cfg, { event: "b", channel: "telegram", payload: "y", ts });
    ackEntry(cfg, { notifId: r2.notif_id, method: "manual" });
    const all = listEntries(cfg);
    expect(all.entries.length).toBe(2);
    const pending = listEntries(cfg, { pending: true });
    expect(pending.entries.length).toBe(1);
    expect(pending.entries[0]?.event_type).toBe("a");
  });

  it("getEntry returns the full entry by notif_id", () => {
    const r = writeEntry(cfg, { event: "e", channel: "telegram", payload: { k: 1 } });
    const got = getEntry(cfg, r.notif_id);
    expect(got.entry.notif_id).toBe(r.notif_id);
    expect(got.entry.payload).toEqual({ k: 1 });
  });

  it("ackEntry throws on missing notif_id", () => {
    expect(() => ackEntry(cfg, { notifId: "notif_missing", method: "x" })).toThrow(/not found/);
  });
});

describe("readTelegramBinding", () => {
  let root: string;
  let cfg: NotifyConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns null when openclaw.json is missing", () => {
    expect(readTelegramBinding(cfg)).toBeNull();
  });

  it("returns null when channels.telegram is missing", () => {
    writeOpenclawConfig(root, null);
    expect(readTelegramBinding(cfg)).toBeNull();
  });

  it("extracts botToken + allowFrom", () => {
    writeOpenclawConfig(root, {
      enabled: true,
      botToken: "TOKEN",
      allowFrom: ["123", "456"],
    });
    const b = readTelegramBinding(cfg);
    expect(b).toMatchObject({ enabled: true, botToken: "TOKEN", chatIds: ["123", "456"] });
  });
});

describe("attemptTelegram", () => {
  let root: string;
  let cfg: NotifyConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports no-binding when openclaw.json is missing", async () => {
    const results = await attemptTelegram({
      config: cfg,
      title: "t",
      text: "x",
      severity: "info",
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toMatch(/no telegram binding/);
  });

  it("reports no-paired-chat when allowFrom is empty", async () => {
    writeOpenclawConfig(root, { enabled: true, botToken: "T", allowFrom: [] });
    const results = await attemptTelegram({
      config: cfg,
      title: "t",
      text: "x",
      severity: "info",
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toMatch(/no paired chat/);
  });

  it("posts to api.telegram.org for each chatId and parses message_id", async () => {
    writeOpenclawConfig(root, { enabled: true, botToken: "TOK", allowFrom: ["111", "222"] });
    const captures: Array<{ url: string; body: Record<string, unknown> }> = [];
    let id = 100;
    const httpPost: HttpPoster = vi.fn(async ({ url, body }) => {
      captures.push({ url, body });
      const messageId = id++;
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({ ok: true, result: { message_id: messageId } }),
      };
    });
    const results = await attemptTelegram(
      { config: cfg, title: "Hi", text: "world", severity: "info" },
      { httpPost },
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      channel: "telegram:111",
      ok: true,
      receiptId: 100,
      status: 200,
    });
    expect(results[1]).toMatchObject({
      channel: "telegram:222",
      ok: true,
      receiptId: 101,
      status: 200,
    });
    expect(captures[0]?.url).toBe("https://api.telegram.org/botTOK/sendMessage");
    expect(captures[0]?.body).toMatchObject({
      chat_id: "111",
      text: expect.stringMatching(/Hi\nworld/),
    });
  });

  it("returns ok=false when Telegram returns non-OK status", async () => {
    writeOpenclawConfig(root, { enabled: true, botToken: "T", allowFrom: ["111"] });
    const httpPost: HttpPoster = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: JSON.stringify({ ok: false, description: "Bad Request: chat not found" }),
    }));
    const results = await attemptTelegram(
      { config: cfg, title: "t", text: "x", severity: "info" },
      { httpPost },
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toMatch(/status 400/);
  });

  it("returns ok=false when Telegram body lacks message_id even on 200", async () => {
    writeOpenclawConfig(root, { enabled: true, botToken: "T", allowFrom: ["111"] });
    const httpPost: HttpPoster = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: JSON.stringify({ ok: false }),
    }));
    const results = await attemptTelegram(
      { config: cfg, title: "t", text: "x", severity: "info" },
      { httpPost },
    );
    expect(results[0]?.ok).toBe(false);
  });

  it("captures HTTP poster errors", async () => {
    writeOpenclawConfig(root, { enabled: true, botToken: "T", allowFrom: ["111"] });
    const httpPost: HttpPoster = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const results = await attemptTelegram(
      { config: cfg, title: "t", text: "x", severity: "info" },
      { httpPost },
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toMatch(/ECONNREFUSED/);
  });
});

describe("attemptAppleBridge", () => {
  let root: string;
  let cfg: NotifyConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("invokes osascript with display-notification script", async () => {
    let captured = "";
    const osascript: OsascriptRunner = vi.fn(async ({ script }) => {
      captured = script;
      return { ok: true, stderr: "" };
    });
    const result = await attemptAppleBridge(
      { config: cfg, title: "Hello", text: "world", severity: "info" },
      { osascript },
    );
    expect(result.ok).toBe(true);
    expect(captured).toContain("display notification");
    expect(captured).toContain('with title "Hello"');
  });

  it("escapes quotes in title + text", async () => {
    let captured = "";
    const osascript: OsascriptRunner = vi.fn(async ({ script }) => {
      captured = script;
      return { ok: true, stderr: "" };
    });
    await attemptAppleBridge(
      { config: cfg, title: 'a"b', text: 'c"d', severity: "info" },
      { osascript },
    );
    expect(captured).toContain('"a\\"b"');
    expect(captured).toContain('"c\\"d"');
  });

  it("uses Sosumi sound for critical severity", async () => {
    let captured = "";
    const osascript: OsascriptRunner = vi.fn(async ({ script }) => {
      captured = script;
      return { ok: true, stderr: "" };
    });
    await attemptAppleBridge(
      { config: cfg, title: "t", text: "x", severity: "critical" },
      { osascript },
    );
    expect(captured).toContain('sound name "Sosumi"');
  });

  it("returns ok=false when osascript fails", async () => {
    const osascript: OsascriptRunner = vi.fn(async () => ({
      ok: false,
      stderr: "syntax error",
    }));
    const result = await attemptAppleBridge(
      { config: cfg, title: "t", text: "x", severity: "info" },
      { osascript },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/syntax error/);
  });

  it("respects appleBridgeEnabled=false in config", async () => {
    const cfg2 = { ...cfg, appleBridgeEnabled: false };
    const osascript: OsascriptRunner = vi.fn(async () => ({ ok: true, stderr: "" }));
    const result = await attemptAppleBridge(
      { config: cfg2, title: "t", text: "x", severity: "info" },
      { osascript },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/disabled/);
    expect(osascript).not.toHaveBeenCalled();
  });
});

describe("dispatchNotification orchestrator", () => {
  let root: string;
  let cfg: NotifyConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
    writeOpenclawConfig(root, { enabled: true, botToken: "T", allowFrom: ["111"] });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("routes channel='telegram' to Telegram only", async () => {
    const httpPost: HttpPoster = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: JSON.stringify({ ok: true, result: { message_id: 42 } }),
    }));
    const osascript: OsascriptRunner = vi.fn(async () => ({ ok: true, stderr: "" }));
    const results = await dispatchNotification(
      cfg,
      { channel: "telegram", title: "t", text: "x" },
      { httpPost, osascript },
    );
    expect(results.every((r) => r.channel.startsWith("telegram"))).toBe(true);
    expect(httpPost).toHaveBeenCalled();
    expect(osascript).not.toHaveBeenCalled();
  });

  it("routes channel='apple-bridge' to apple-bridge only", async () => {
    const httpPost: HttpPoster = vi.fn();
    const osascript: OsascriptRunner = vi.fn(async () => ({ ok: true, stderr: "" }));
    const results = await dispatchNotification(
      cfg,
      { channel: "apple-bridge", title: "t", text: "x" },
      { httpPost, osascript },
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.channel).toBe("apple-bridge");
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("routes channel='all' to both telegram + apple-bridge", async () => {
    const httpPost: HttpPoster = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: JSON.stringify({ ok: true, result: { message_id: 1 } }),
    }));
    const osascript: OsascriptRunner = vi.fn(async () => ({ ok: true, stderr: "" }));
    const results = await dispatchNotification(
      cfg,
      { channel: "all", title: "t", text: "x" },
      { httpPost, osascript },
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.find((r) => r.channel.startsWith("telegram"))).toBeDefined();
    expect(results.find((r) => r.channel === "apple-bridge")).toBeDefined();
  });

  it("returns explicit error for unknown channel", async () => {
    const results = await dispatchNotification(cfg, { channel: "smoke", title: "t", text: "x" });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toMatch(/unknown channel/);
  });
});
