import { describe, expect, it, vi } from "vitest";
import type { ManagedRun, ProcessSupervisor, RunRecord, SpawnInput } from "../supervisor/types.js";
import { createBrokeredSupervisor, type BrokerRef } from "./brokered-supervisor.js";
import { BrokerDenyError, type ExecBroker } from "./types.js";

function makeStubRun(runId = "run-1"): ManagedRun {
  return {
    runId,
    pid: 4321,
    startedAtMs: Date.now(),
    wait: vi.fn(async () => ({
      reason: "exit" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    })),
    cancel: vi.fn(),
  };
}

function makeStubSupervisor(overrides?: Partial<ProcessSupervisor>): {
  supervisor: ProcessSupervisor;
  spawn: ReturnType<typeof vi.fn>;
} {
  const spawn = vi.fn(async (_input: SpawnInput) => makeStubRun());
  const cancel = vi.fn();
  const cancelScope = vi.fn();
  const reconcileOrphans = vi.fn(async () => {});
  const getRecord = vi.fn((_runId: string): RunRecord | undefined => undefined);
  return {
    supervisor: {
      spawn,
      cancel,
      cancelScope,
      reconcileOrphans,
      getRecord,
      ...overrides,
    },
    spawn,
  };
}

describe("createBrokeredSupervisor", () => {
  it("forwards spawn unmodified when broker ref is null", async () => {
    const { supervisor, spawn } = makeStubSupervisor();
    const ref: BrokerRef = { current: null };
    const brokered = createBrokeredSupervisor(supervisor, ref);

    const input: SpawnInput = {
      mode: "child",
      sessionId: "s1",
      backendId: "exec-host",
      argv: ["/bin/echo", "hi"],
    };
    const run = await brokered.spawn(input);

    expect(run.runId).toBe("run-1");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(input);
  });

  it("forwards spawn when broker allows without rewriting", async () => {
    const { supervisor, spawn } = makeStubSupervisor();
    const broker: ExecBroker = {
      validate: () => ({ kind: "allow", reason: "ok" }),
    };
    const ref: BrokerRef = { current: broker };
    const brokered = createBrokeredSupervisor(supervisor, ref);

    const input: SpawnInput = {
      mode: "child",
      sessionId: "s1",
      backendId: "exec-host",
      argv: ["/bin/echo", "hi"],
    };
    await brokered.spawn(input);

    expect(spawn).toHaveBeenCalledTimes(1);
    // argv preserved byte-for-byte when decision carries no rewrite
    expect(spawn.mock.calls[0][0].argv).toEqual(["/bin/echo", "hi"]);
  });

  it("rewrites argv when broker allow decision supplies argv", async () => {
    const { supervisor, spawn } = makeStubSupervisor();
    const broker: ExecBroker = {
      validate: () => ({
        kind: "allow",
        reason: "normalized",
        argv: ["/bin/echo", "REDACTED"],
      }),
    };
    const ref: BrokerRef = { current: broker };
    const brokered = createBrokeredSupervisor(supervisor, ref);

    await brokered.spawn({
      mode: "child",
      sessionId: "s1",
      backendId: "exec-host",
      argv: ["/bin/echo", "secret"],
    });

    expect(spawn.mock.calls[0][0].argv).toEqual(["/bin/echo", "REDACTED"]);
  });

  it("rewrites ptyCommand on pty input when broker supplies it", async () => {
    const { supervisor, spawn } = makeStubSupervisor();
    const broker: ExecBroker = {
      validate: () => ({
        kind: "allow",
        reason: "normalized",
        ptyCommand: "echo safe",
      }),
    };
    const ref: BrokerRef = { current: broker };
    const brokered = createBrokeredSupervisor(supervisor, ref);

    await brokered.spawn({
      mode: "pty",
      sessionId: "s1",
      backendId: "exec-host",
      ptyCommand: "echo $SECRET",
    });

    expect(spawn.mock.calls[0][0]).toMatchObject({
      mode: "pty",
      ptyCommand: "echo safe",
    });
  });

  it("rewrites env when broker decision supplies env", async () => {
    const { supervisor, spawn } = makeStubSupervisor();
    const broker: ExecBroker = {
      validate: () => ({
        kind: "allow",
        reason: "redacted",
        env: { SAFE: "1" },
      }),
    };
    const ref: BrokerRef = { current: broker };
    const brokered = createBrokeredSupervisor(supervisor, ref);

    await brokered.spawn({
      mode: "child",
      sessionId: "s1",
      backendId: "exec-host",
      argv: ["/bin/true"],
      env: { ANTHROPIC_API_KEY: "sk-xxx", SAFE: "1" },
    });

    expect(spawn.mock.calls[0][0].env).toEqual({ SAFE: "1" });
  });

  it("throws BrokerDenyError when broker denies, and never invokes inner spawn", async () => {
    const { supervisor, spawn } = makeStubSupervisor();
    const broker: ExecBroker = {
      validate: () => ({
        kind: "deny",
        reason: "argv[0] not on allowlist",
        code: "allowlist-miss",
      }),
    };
    const ref: BrokerRef = { current: broker };
    const brokered = createBrokeredSupervisor(supervisor, ref);

    await expect(
      brokered.spawn({
        mode: "child",
        sessionId: "s1",
        backendId: "exec-host",
        argv: ["/usr/bin/rm", "-rf", "/"],
      }),
    ).rejects.toMatchObject({
      name: "BrokerDenyError",
      code: "allowlist-miss",
      brokerReason: "argv[0] not on allowlist",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("awaits async broker decisions", async () => {
    const { supervisor, spawn } = makeStubSupervisor();
    let resolveDecision!: (d: { kind: "allow"; reason: string }) => void;
    const broker: ExecBroker = {
      validate: () =>
        new Promise((resolve) => {
          resolveDecision = resolve as typeof resolveDecision;
        }),
    };
    const ref: BrokerRef = { current: broker };
    const brokered = createBrokeredSupervisor(supervisor, ref);

    const pending = brokered.spawn({
      mode: "child",
      sessionId: "s1",
      backendId: "exec-host",
      argv: ["/bin/echo", "hi"],
    });
    // Broker not yet settled — inner spawn must not have been called.
    expect(spawn).not.toHaveBeenCalled();

    resolveDecision({ kind: "allow", reason: "ok" });
    await pending;
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("picks up broker swaps on the ref without rebuilding", async () => {
    const { supervisor, spawn } = makeStubSupervisor();
    const ref: BrokerRef = { current: null };
    const brokered = createBrokeredSupervisor(supervisor, ref);

    // 1st call: no broker → forwarded
    await brokered.spawn({
      mode: "child",
      sessionId: "s1",
      backendId: "exec-host",
      argv: ["/bin/echo"],
    });
    expect(spawn).toHaveBeenCalledTimes(1);

    // Swap in a denying broker
    ref.current = { validate: () => ({ kind: "deny", reason: "nope" }) };
    await expect(
      brokered.spawn({
        mode: "child",
        sessionId: "s1",
        backendId: "exec-host",
        argv: ["/bin/echo"],
      }),
    ).rejects.toBeInstanceOf(BrokerDenyError);
    expect(spawn).toHaveBeenCalledTimes(1);

    // Swap to null again → forwards
    ref.current = null;
    await brokered.spawn({
      mode: "child",
      sessionId: "s1",
      backendId: "exec-host",
      argv: ["/bin/echo"],
    });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("delegates cancel / cancelScope / reconcileOrphans / getRecord to inner supervisor", async () => {
    const { supervisor } = makeStubSupervisor();
    const ref: BrokerRef = { current: null };
    const brokered = createBrokeredSupervisor(supervisor, ref);

    brokered.cancel("run-1", "manual-cancel");
    expect(supervisor.cancel).toHaveBeenCalledWith("run-1", "manual-cancel");

    brokered.cancelScope("scope-1");
    expect(supervisor.cancelScope).toHaveBeenCalledWith("scope-1", undefined);

    await brokered.reconcileOrphans();
    expect(supervisor.reconcileOrphans).toHaveBeenCalledTimes(1);

    brokered.getRecord("run-1");
    expect(supervisor.getRecord).toHaveBeenCalledWith("run-1");
  });
});
