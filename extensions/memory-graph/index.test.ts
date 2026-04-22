import { describe, expect, test } from "vitest";
import { resolveMemoryGraphConfig } from "./src/config.js";
import { MemoryGraphContextEngine } from "./src/engine.js";

describe("memory-graph skeleton", () => {
  test("config resolves defaults", () => {
    const cfg = resolveMemoryGraphConfig({});
    expect(cfg.scope).toBe("workspace");
    expect(cfg.autoIngest).toBe(true);
    expect(cfg.tokenBudgetRatio).toBe(0.2);
    expect(cfg.dbPath.endsWith("graph.sqlite")).toBe(true);
  });

  test("config honors overrides and clamps ratio", () => {
    const cfg = resolveMemoryGraphConfig({
      dbPath: "/tmp/custom.sqlite",
      scope: "agent",
      autoIngest: false,
      tokenBudgetRatio: 2,
    });
    expect(cfg.dbPath).toBe("/tmp/custom.sqlite");
    expect(cfg.scope).toBe("agent");
    expect(cfg.autoIngest).toBe(false);
    expect(cfg.tokenBudgetRatio).toBe(1);
  });

  test("config coerces unexpected shapes to defaults", () => {
    const cfg = resolveMemoryGraphConfig(null);
    expect(cfg.scope).toBe("workspace");
    expect(cfg.autoIngest).toBe(true);
    expect(cfg.tokenBudgetRatio).toBe(0.2);
  });

  test("context engine exposes stable info", () => {
    const engine = new MemoryGraphContextEngine();
    expect(engine.info.id).toBe("memory-graph");
    expect(engine.info.name).toBe("Memory Graph");
    expect(engine.info.version).toBe("1.0.0");
  });

  test("context engine assemble is pass-through", async () => {
    const engine = new MemoryGraphContextEngine();
    const out = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(out.messages).toEqual([]);
    expect(out.estimatedTokens).toBe(0);
  });

  test("context engine dispose is safe", async () => {
    const engine = new MemoryGraphContextEngine();
    await expect(engine.dispose()).resolves.toBeUndefined();
  });
});
