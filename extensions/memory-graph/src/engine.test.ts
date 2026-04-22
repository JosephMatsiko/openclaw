import { describe, expect, test } from "vitest";
import { MemoryGraphContextEngine } from "./engine.js";
import { SqliteGraphStorage } from "./sqlite-storage.js";

function makeTurn(user: string, assistant?: string) {
  const messages: unknown[] = [{ role: "user", content: user }];
  if (assistant !== undefined) {
    messages.push({ role: "assistant", content: assistant });
  }
  return messages;
}

describe("MemoryGraphContextEngine afterTurn", () => {
  test("writes a thread node per completed turn", async () => {
    const storage = new SqliteGraphStorage({ dbPath: ":memory:" });
    const engine = new MemoryGraphContextEngine({
      storage,
      scope: "workspace",
      scopeId: "ws-1",
    });
    const messages = makeTurn("hello there, friend", "hi");
    await engine.afterTurn({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.jsonl",
      messages: messages as never,
      prePromptMessageCount: 0,
    });
    const nodes = await storage.findNodes({
      scope: "workspace",
      scopeId: "ws-1",
      kinds: ["thread"],
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].summary).toBe("hello there, friend");
    expect(nodes[0].body).toBe("hi");
    expect(nodes[0].kind).toBe("thread");
    expect(nodes[0].source?.sessionId).toBe("sess-1");
    await engine.dispose();
  });

  test("extracts and writes claim nodes alongside thread node", async () => {
    const storage = new SqliteGraphStorage({ dbPath: ":memory:" });
    const engine = new MemoryGraphContextEngine({
      storage,
      scope: "workspace",
      scopeId: "ws-1",
    });
    const messages = makeTurn("my favorite color is cobalt blue", "noted");
    await engine.afterTurn({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.jsonl",
      messages: messages as never,
      prePromptMessageCount: 0,
    });
    const all = await storage.findNodes({ scope: "workspace", scopeId: "ws-1" });
    const threads = all.filter((n) => n.kind === "thread");
    const prefs = all.filter((n) => n.kind === "preference");
    expect(threads).toHaveLength(1);
    expect(prefs).toHaveLength(1);
    expect(prefs[0].summary.toLowerCase()).toContain("color");
    expect(prefs[0].summary.toLowerCase()).toContain("cobalt blue");
    expect(prefs[0].confidence).toBeGreaterThanOrEqual(0.85);
    await engine.dispose();
  });

  test("skips turns without a new user message", async () => {
    const storage = new SqliteGraphStorage({ dbPath: ":memory:" });
    const engine = new MemoryGraphContextEngine({
      storage,
      scope: "workspace",
      scopeId: "ws-1",
    });
    const messages = makeTurn("hi", "hello");
    await engine.afterTurn({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.jsonl",
      messages: messages as never,
      // All messages are already counted as pre-prompt — no new user message.
      prePromptMessageCount: messages.length,
    });
    const nodes = await storage.findNodes({ scope: "workspace", scopeId: "ws-1" });
    expect(nodes).toHaveLength(0);
    await engine.dispose();
  });

  test("skips heartbeat turns", async () => {
    const storage = new SqliteGraphStorage({ dbPath: ":memory:" });
    const engine = new MemoryGraphContextEngine({
      storage,
      scope: "workspace",
      scopeId: "ws-1",
    });
    await engine.afterTurn({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.jsonl",
      messages: makeTurn("scheduled ping", "ok") as never,
      prePromptMessageCount: 0,
      isHeartbeat: true,
    });
    const nodes = await storage.findNodes({ scope: "workspace", scopeId: "ws-1" });
    expect(nodes).toHaveLength(0);
    await engine.dispose();
  });

  test("is a safe no-op when storage is absent", async () => {
    const engine = new MemoryGraphContextEngine();
    await expect(
      engine.afterTurn({
        sessionId: "sess-1",
        sessionFile: "/tmp/sess-1.jsonl",
        messages: makeTurn("hi", "hello") as never,
        prePromptMessageCount: 0,
      }),
    ).resolves.toBeUndefined();
    await engine.dispose();
  });

  test("warns once via logger when storage is absent across many calls", async () => {
    const warnings: string[] = [];
    const engine = new MemoryGraphContextEngine({
      logger: { warn: (m) => warnings.push(m) },
    });
    await engine.afterTurn({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.jsonl",
      messages: makeTurn("hi", "hello") as never,
      prePromptMessageCount: 0,
    });
    await engine.afterTurn({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.jsonl",
      messages: makeTurn("again", "ok") as never,
      prePromptMessageCount: 0,
    });
    await engine.assemble({
      sessionId: "sess-1",
      messages: [],
      prompt: "p",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("memory-graph");
    expect(warnings[0]).toContain("no-op");
    await engine.dispose();
  });

  test("honors scope isolation", async () => {
    const storage = new SqliteGraphStorage({ dbPath: ":memory:" });
    const engineA = new MemoryGraphContextEngine({
      storage,
      scope: "workspace",
      scopeId: "ws-a",
    });
    const engineB = new MemoryGraphContextEngine({
      storage,
      scope: "workspace",
      scopeId: "ws-b",
    });
    await engineA.afterTurn({
      sessionId: "s",
      sessionFile: "/tmp/s.jsonl",
      messages: makeTurn("msg from A", "reply") as never,
      prePromptMessageCount: 0,
    });
    await engineB.afterTurn({
      sessionId: "s",
      sessionFile: "/tmp/s.jsonl",
      messages: makeTurn("msg from B", "reply") as never,
      prePromptMessageCount: 0,
    });
    const aNodes = await storage.findNodes({ scope: "workspace", scopeId: "ws-a" });
    const bNodes = await storage.findNodes({ scope: "workspace", scopeId: "ws-b" });
    expect(aNodes.map((n) => n.summary)).toEqual(["msg from A"]);
    expect(bNodes.map((n) => n.summary)).toEqual(["msg from B"]);
    // Both writes share the same storage but neither can see the other.
    await storage.close();
  });

  test("end-to-end: afterTurn writes claim, assemble injects it in systemPromptAddition", async () => {
    const storage = new SqliteGraphStorage({ dbPath: ":memory:" });
    const engine = new MemoryGraphContextEngine({
      storage,
      scope: "workspace",
      scopeId: "ws-1",
    });
    // Session A: user states an allergy.
    await engine.afterTurn({
      sessionId: "sess-A",
      sessionFile: "/tmp/a.jsonl",
      messages: makeTurn(
        "Please remember that I'm allergic to peanuts.",
        "Got it — noted.",
      ) as never,
      prePromptMessageCount: 0,
    });
    // Session B: new session, unrelated prompt. Assemble should inject the
    // persisted fact via systemPromptAddition so the model can see it.
    const result = await engine.assemble({
      sessionId: "sess-B",
      messages: [],
      prompt: "plan me a trip to thailand",
    });
    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition!.toLowerCase()).toContain("allergic to peanuts");
    expect(result.estimatedTokens).toBeGreaterThan(0);
    await engine.dispose();
  });

  test("only stores the new slice when prePromptMessageCount > 0", async () => {
    const storage = new SqliteGraphStorage({ dbPath: ":memory:" });
    const engine = new MemoryGraphContextEngine({
      storage,
      scope: "workspace",
      scopeId: "ws-1",
    });
    const messages = [
      { role: "user", content: "old msg" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "new msg" },
      { role: "assistant", content: "new reply" },
    ];
    await engine.afterTurn({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.jsonl",
      messages: messages as never,
      prePromptMessageCount: 2,
    });
    const nodes = await storage.findNodes({ scope: "workspace", scopeId: "ws-1" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].summary).toBe("new msg");
    expect(nodes[0].body).toBe("new reply");
    await engine.dispose();
  });
});
