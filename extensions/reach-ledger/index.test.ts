// Smoke tests for @openclaw/plugin-reach-ledger.
//
// All tests use a fresh tmp ledger file (mkdtempSync) to avoid clobbering
// the operator's actual ledger at ~/.openclaw/workspace/state/chuck-v3/.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import { rankChannels } from "./src/ranking.js";
import { getStatus, recordFailure, recordSuccess, resetLedger } from "./src/store.js";

function tmpLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "reach-ledger-"));
  return join(dir, "ledger.json");
}

describe("recordSuccess + recordFailure", () => {
  test("first success creates channel record + sets global", () => {
    const path = tmpLedger();
    recordSuccess(
      "telegram",
      { messageId: "m1", transport: "openclaw-native" },
      { ledgerPath: path },
    );
    const ledger = getStatus({ ledgerPath: path });
    expect(ledger.channels["telegram"]?.consecutive_successes).toBe(1);
    expect(ledger.channels["telegram"]?.last_proven_message_id).toBe("m1");
    expect(ledger.global.last_reached_via).toBe("telegram");
    rmSync(path, { force: true });
  });

  test("failure bumps consecutive_failures but not global", () => {
    const path = tmpLedger();
    recordSuccess("telegram", {}, { ledgerPath: path });
    recordFailure("discord", "rate limited", { ledgerPath: path });
    const ledger = getStatus({ ledgerPath: path });
    expect(ledger.channels["discord"]?.consecutive_failures).toBe(1);
    expect(ledger.channels["discord"]?.last_failed_reason).toBe("rate limited");
    expect(ledger.global.last_reached_via).toBe("telegram"); // unchanged
    rmSync(path, { force: true });
  });

  test("success resets consecutive_failures", () => {
    const path = tmpLedger();
    recordFailure("sms", "boom", { ledgerPath: path });
    recordFailure("sms", "boom", { ledgerPath: path });
    expect(getStatus({ ledgerPath: path }).channels["sms"]?.consecutive_failures).toBe(2);
    recordSuccess("sms", {}, { ledgerPath: path });
    const ledger = getStatus({ ledgerPath: path });
    expect(ledger.channels["sms"]?.consecutive_failures).toBe(0);
    expect(ledger.channels["sms"]?.consecutive_successes).toBe(1);
    rmSync(path, { force: true });
  });

  test("resetLedger wipes everything", () => {
    const path = tmpLedger();
    recordSuccess("a", {}, { ledgerPath: path });
    recordFailure("b", "x", { ledgerPath: path });
    resetLedger({ ledgerPath: path });
    const ledger = getStatus({ ledgerPath: path });
    expect(ledger.channels).toEqual({});
    expect(ledger.global.last_reached_via).toBeNull();
    rmSync(path, { force: true });
  });
});

describe("rankChannels", () => {
  test("freshly-proven channel jumps to front of ranking", () => {
    const path = tmpLedger();
    recordSuccess("discord", {}, { ledgerPath: path });
    const ranked = rankChannels(["telegram", "discord", "sms"], {
      ledgerPath: path,
      freshnessMs: 60_000,
    });
    expect(ranked[0]).toBe("discord");
    rmSync(path, { force: true });
  });

  test("circuit-broken channels go to end", () => {
    const path = tmpLedger();
    for (let i = 0; i < 6; i += 1) recordFailure("flaky", "boom", { ledgerPath: path });
    const ranked = rankChannels(["telegram", "flaky", "discord"], {
      ledgerPath: path,
      circuitBreakerThreshold: 5,
    });
    expect(ranked[ranked.length - 1]).toBe("flaky");
    rmSync(path, { force: true });
  });

  test("multiple fresh channels sort by recency (most recent first)", async () => {
    const path = tmpLedger();
    recordSuccess("a", {}, { ledgerPath: path });
    await new Promise((r) => setTimeout(r, 5));
    recordSuccess("b", {}, { ledgerPath: path });
    await new Promise((r) => setTimeout(r, 5));
    recordSuccess("c", {}, { ledgerPath: path });
    const ranked = rankChannels(["a", "b", "c"], { ledgerPath: path, freshnessMs: 60_000 });
    expect(ranked[0]).toBe("c");
    expect(ranked[1]).toBe("b");
    expect(ranked[2]).toBe("a");
    rmSync(path, { force: true });
  });

  test("missing ledger file returns defaultOrder", () => {
    const path = join(tmpdir(), "no-ledger-" + Date.now() + ".json");
    const ranked = rankChannels(["telegram", "discord"], { ledgerPath: path });
    expect(ranked).toEqual(["telegram", "discord"]);
  });
});

describe("config resolver", () => {
  test("defaults", () => {
    const c = resolveConfig({});
    expect(c.enabled).toBe(true);
    expect(c.ledgerPath).toBe("~/.openclaw/workspace/state/chuck-v3/reach-ledger.json");
    expect(c.freshnessWindowMinutes).toBe(15);
    expect(c.circuitBreakerThreshold).toBe(5);
  });

  test("preserves valid overrides", () => {
    const c = resolveConfig({ freshnessWindowMinutes: 60, circuitBreakerThreshold: 3 });
    expect(c.freshnessWindowMinutes).toBe(60);
    expect(c.circuitBreakerThreshold).toBe(3);
  });
});
