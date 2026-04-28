import { describe, expect, test, vi } from "vitest";
import { CRITICAL_TOOL_NAMES, isCriticalTool, runExecutionGate } from "./execution-gate.js";

function logger() {
  const info: string[] = [];
  const warn: string[] = [];
  const debug: string[] = [];
  return {
    log: {
      info: (m: string) => info.push(m),
      warn: (m: string) => warn.push(m),
      debug: (m: string) => debug.push(m),
    },
    info,
    warn,
    debug,
  };
}

describe("execution-gate isCriticalTool", () => {
  test("recognizes the registered critical tool set", () => {
    // memory-graph writers
    expect(isCriticalTool("memory_set_persona")).toBe(true);
    expect(isCriticalTool("memory_self_edit")).toBe(true);
    expect(isCriticalTool("memory_forget")).toBe(true);
    expect(isCriticalTool("memory_consolidate")).toBe(true);
    expect(isCriticalTool("memory_ingest_claude_code")).toBe(true);
    // apple-toolkit surfaces (Mac-native side effects)
    expect(isCriticalTool("messages_send")).toBe(true);
    expect(isCriticalTool("notes_create")).toBe(true);
    expect(isCriticalTool("reminders_add")).toBe(true);
    expect(isCriticalTool("open_url")).toBe(true);
    expect(isCriticalTool("mac_app_open")).toBe(true);
  });

  test("non-critical tools return false", () => {
    expect(isCriticalTool("memory_recall")).toBe(false);
    expect(isCriticalTool("memory_search")).toBe(false);
    expect(isCriticalTool("memory_classify_message")).toBe(false);
    expect(isCriticalTool("")).toBe(false);
    expect(isCriticalTool("random_tool")).toBe(false);
  });

  test("registry is non-empty and covers memory-graph's destructive surface", () => {
    expect(CRITICAL_TOOL_NAMES.length).toBeGreaterThan(0);
    // These are the minimum invariants. If we add more, great; if we
    // ever accidentally remove one of these, fail loudly.
    expect(CRITICAL_TOOL_NAMES).toContain("memory_set_persona");
    expect(CRITICAL_TOOL_NAMES).toContain("memory_self_edit");
    expect(CRITICAL_TOOL_NAMES).toContain("memory_forget");
  });
});

describe("execution-gate runExecutionGate — autonomous mode", () => {
  test("allows non-critical tools silently", () => {
    const l = logger();
    const r = runExecutionGate(
      { toolName: "memory_recall", params: {}, runId: "r1" },
      { mode: "autonomous", logger: l.log },
    );
    expect(r).toBeUndefined();
    expect([...l.info, ...l.warn, ...l.debug]).toEqual([]);
  });

  test("allows critical tools but logs them for audit", () => {
    const l = logger();
    const r = runExecutionGate(
      { toolName: "memory_set_persona", params: { file: "soul" }, runId: "r1" },
      { mode: "autonomous", logger: l.log },
    );
    expect(r).toBeUndefined();
    expect(l.info.some((m) => m.includes("allowed critical tool memory_set_persona"))).toBe(true);
  });
});

describe("execution-gate runExecutionGate — suggest mode", () => {
  test("non-critical tools pass through", () => {
    const l = logger();
    const r = runExecutionGate(
      { toolName: "memory_recall", params: {} },
      { mode: "suggest", logger: l.log },
    );
    expect(r).toBeUndefined();
  });

  test("critical tools are blocked with a reason", () => {
    const l = logger();
    const r = runExecutionGate(
      { toolName: "memory_set_persona", params: { file: "soul" } },
      { mode: "suggest", logger: l.log },
    );
    expect(r).toMatchObject({ block: true });
    expect(typeof r?.blockReason).toBe("string");
    expect(r?.blockReason).toContain("suggest");
    expect(r?.blockReason).toContain("memory_set_persona");
    expect(l.warn.some((m) => m.includes("blocked memory_set_persona"))).toBe(true);
  });
});

describe("execution-gate runExecutionGate — assisted mode", () => {
  test("non-critical tools pass through", () => {
    const l = logger();
    const r = runExecutionGate(
      { toolName: "memory_recall", params: {} },
      { mode: "assisted", logger: l.log },
    );
    expect(r).toBeUndefined();
  });

  test("critical tools trigger requireApproval with severity=critical", () => {
    const l = logger();
    const r = runExecutionGate(
      { toolName: "memory_forget", params: { id: "fact-abc123" } },
      { mode: "assisted", logger: l.log },
    );
    expect(r).toMatchObject({
      requireApproval: {
        severity: "critical",
        timeoutBehavior: "deny",
        pluginId: "memory-graph",
      },
    });
    expect(r?.requireApproval?.title).toContain("memory_forget");
    expect(r?.requireApproval?.description).toContain("fact-abc123");
    expect(l.info.some((m) => m.includes("requesting approval"))).toBe(true);
  });

  test("approval description renders string params clearly", () => {
    const r = runExecutionGate(
      {
        toolName: "memory_set_persona",
        params: { file: "soul", content: "new content here" },
      },
      { mode: "assisted" },
    );
    expect(r?.requireApproval?.description).toContain("soul");
    expect(r?.requireApproval?.description).toContain("new content here");
  });

  test("approval description truncates long values with total-chars hint", () => {
    const big = "x".repeat(500);
    const r = runExecutionGate(
      { toolName: "memory_set_persona", params: { content: big } },
      { mode: "assisted" },
    );
    const desc = r?.requireApproval?.description ?? "";
    expect(desc).toContain("chars total");
    // Should not contain the full 500-char body.
    expect(desc.length).toBeLessThan(600);
  });

  test("approval timeout is overridable per-install", () => {
    const r = runExecutionGate(
      { toolName: "memory_set_persona", params: {} },
      { mode: "assisted", approvalTimeoutMs: 30_000 },
    );
    expect(r?.requireApproval?.timeoutMs).toBe(30_000);
  });

  test("default approval timeout is 5 minutes", () => {
    const r = runExecutionGate(
      { toolName: "memory_set_persona", params: {} },
      { mode: "assisted" },
    );
    expect(r?.requireApproval?.timeoutMs).toBe(5 * 60 * 1000);
  });
});

describe("execution-gate runExecutionGate — customization", () => {
  test("empty criticalTools override disables gating (force-autonomous)", () => {
    const r = runExecutionGate(
      { toolName: "memory_set_persona", params: {} },
      { mode: "suggest", criticalTools: [] },
    );
    expect(r).toBeUndefined();
  });

  test("custom criticalTools list gates a caller-chosen name", () => {
    const l = logger();
    const r = runExecutionGate(
      { toolName: "exotic_write_tool", params: { target: "prod-db" } },
      { mode: "assisted", logger: l.log, criticalTools: ["exotic_write_tool"] },
    );
    expect(r?.requireApproval).toBeDefined();
    expect(r?.requireApproval?.title).toContain("exotic_write_tool");
  });

  test("missing logger is tolerated", () => {
    expect(() =>
      runExecutionGate({ toolName: "memory_set_persona", params: {} }, { mode: "suggest" }),
    ).not.toThrow();
    expect(() =>
      runExecutionGate({ toolName: "memory_set_persona", params: {} }, { mode: "assisted" }),
    ).not.toThrow();
  });

  test("autonomous mode does NOT log non-critical calls (zero telemetry noise)", () => {
    const l = logger();
    for (const tool of ["memory_recall", "memory_search", "memory_stats"]) {
      runExecutionGate({ toolName: tool, params: {} }, { mode: "autonomous", logger: l.log });
    }
    expect([...l.info, ...l.warn, ...l.debug]).toEqual([]);
  });
});

describe("execution-gate runExecutionGate — unrecognized modes", () => {
  // TypeScript prevents this at compile time, but the hook takes values
  // from a config file at runtime, so an unknown string could slip in.
  // `resolveMemoryGraphConfig` coerces unknowns to "autonomous", so this
  // path shouldn't fire in practice. If it does, we fail CLOSED — treat
  // the unknown mode like "assisted" (requireApproval) rather than
  // silently allowing. Security-adjacent code should be conservative on
  // unknown inputs.
  test("unknown mode on non-critical tool passes (nothing to gate)", () => {
    const r = runExecutionGate(
      { toolName: "memory_recall", params: {} },
      { mode: "unknown" as never },
    );
    expect(r).toBeUndefined();
  });

  test("unknown mode on critical tool falls closed → requireApproval", () => {
    const spy = vi.fn();
    const r = runExecutionGate(
      { toolName: "memory_set_persona", params: {} },
      { mode: "nonsense" as never, logger: { warn: spy, info: spy, debug: spy } },
    );
    expect(r?.requireApproval).toBeDefined();
    expect(r?.requireApproval?.severity).toBe("critical");
  });
});
