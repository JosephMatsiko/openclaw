// Smoke tests for @openclaw/plugin-imessage-osascript.
//
// Pure-logic checks: input validation, config resolution. The actual
// osascript send is verified live (it requires Messages.app, which only
// runs on macOS in a real session) — covered by the plugin commit
// verification rather than vitest.

import { describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import { sendImessage } from "./src/send.js";

describe("sendImessage input validation", () => {
  test("rejects empty buddy without spawning osascript", () => {
    const result = sendImessage({ buddy: "", text: "hi", recordToLedger: false });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("buddy required");
    expect(result.durationMs).toBe(0);
  });

  test("rejects empty text without spawning osascript", () => {
    const result = sendImessage({ buddy: "+15555550123", text: "", recordToLedger: false });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("text required");
    expect(result.durationMs).toBe(0);
  });

  test("transport is always messages-osascript", () => {
    const result = sendImessage({ buddy: "", text: "x", recordToLedger: false });
    expect(result.transport).toBe("messages-osascript");
  });
});

describe("config resolver", () => {
  test("defaults", () => {
    const c = resolveConfig({});
    expect(c.enabled).toBe(true);
    expect(c.defaultBuddy).toBe("");
    expect(c.timeoutMs).toBe(12_000);
    expect(c.recordToLedger).toBe(true);
  });

  test("preserves valid overrides", () => {
    const c = resolveConfig({
      defaultBuddy: "+14044517063",
      timeoutMs: 30_000,
      recordToLedger: false,
    });
    expect(c.defaultBuddy).toBe("+14044517063");
    expect(c.timeoutMs).toBe(30_000);
    expect(c.recordToLedger).toBe(false);
  });

  test("rejects invalid types", () => {
    const c = resolveConfig({
      timeoutMs: "no",
      recordToLedger: "yes",
    } as unknown as Record<string, unknown>);
    expect(c.timeoutMs).toBe(12_000);
    expect(c.recordToLedger).toBe(true);
  });
});
