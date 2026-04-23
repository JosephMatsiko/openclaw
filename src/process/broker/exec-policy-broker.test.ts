import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecPolicyBroker } from "./exec-policy-broker.js";
import { BrokerDenyError } from "./types.js";
import type { BrokerInputChild, BrokerInputPty } from "./types.js";

// ---------------------------------------------------------------------------
// Mock infra so tests never hit the filesystem
// ---------------------------------------------------------------------------

vi.mock("../../infra/exec-approvals.js", () => ({
  loadExecApprovals: vi.fn(() => ({ version: 1 })),
  normalizeExecSecurity: vi.fn((v: unknown) => v ?? null),
}));

vi.mock("../../infra/exec-approvals-allowlist.js", () => ({
  evaluateShellAllowlist: vi.fn(() => ({
    analysisOk: true,
    allowlistSatisfied: true,
    allowlistMatches: [],
    segments: [],
    segmentAllowlistEntries: [],
    segmentSatisfiedBy: [],
  })),
}));

// Stub sandbox probe — default to "available" so policy tests are not
// blocked by Docker availability on the CI host.
vi.mock("./sandbox-probe.js", () => ({
  probeSandboxRuntime: vi.fn(() => ({
    available: true,
    runtime: "docker-desktop",
    socketPath: "/var/run/docker.sock",
  })),
  formatSandboxUnavailableMessage: vi.fn(() => "exec broker: sandbox runtime unavailable"),
}));

// Stub audit log writes so no files are created during tests.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => ({
      write: vi.fn(),
      on: vi.fn(),
    })),
  };
});

import { evaluateShellAllowlist } from "../../infra/exec-approvals-allowlist.js";
import { loadExecApprovals } from "../../infra/exec-approvals.js";
import { probeSandboxRuntime } from "./sandbox-probe.js";

const mockLoadExecApprovals = vi.mocked(loadExecApprovals);
const mockEvaluateShellAllowlist = vi.mocked(evaluateShellAllowlist);
const mockProbeSandboxRuntime = vi.mocked(probeSandboxRuntime);

function makeChildInput(overrides?: Partial<BrokerInputChild>): BrokerInputChild {
  return {
    mode: "child",
    sessionId: "s1",
    backendId: "exec-host",
    argv: ["/usr/bin/git", "status"],
    ...overrides,
  };
}

function makePtyInput(overrides?: Partial<BrokerInputPty>): BrokerInputPty {
  return {
    mode: "pty",
    sessionId: "s1",
    backendId: "exec-host",
    ptyCommand: "git status",
    ...overrides,
  };
}

describe("createExecPolicyBroker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadExecApprovals.mockReturnValue({ version: 1 });
    mockEvaluateShellAllowlist.mockReturnValue({
      analysisOk: true,
      allowlistSatisfied: true,
      allowlistMatches: [],
      segments: [],
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: [],
    });
    // Default: sandbox runtime is available
    mockProbeSandboxRuntime.mockReturnValue({
      available: true,
      runtime: "docker-desktop",
      socketPath: "/var/run/docker.sock",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // full mode
  // ---------------------------------------------------------------------------

  it("allows everything in full mode", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "full" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makeChildInput({ argv: ["/usr/bin/rm", "-rf", "/"] }));
    expect(decision.kind).toBe("allow");
  });

  it("defaults to full mode when security is absent from config", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1 });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makeChildInput());
    expect(decision.kind).toBe("allow");
  });

  // ---------------------------------------------------------------------------
  // deny mode
  // ---------------------------------------------------------------------------

  it("denies everything in deny mode", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "deny" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makeChildInput({ argv: ["/usr/bin/git", "status"] }));
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.code).toBe("deny-mode");
    }
  });

  it("denies pty commands in deny mode", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "deny" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makePtyInput({ ptyCommand: "echo hi" }));
    expect(decision.kind).toBe("deny");
  });

  // ---------------------------------------------------------------------------
  // allowlist mode — child
  // ---------------------------------------------------------------------------

  it("allows git in allowlist mode", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "allowlist" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makeChildInput({ argv: ["/usr/bin/git", "log"] }));
    expect(decision.kind).toBe("allow");
  });

  it("allows pnpm in allowlist mode", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "allowlist" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makeChildInput({ argv: ["/usr/local/bin/pnpm", "install"] }));
    expect(decision.kind).toBe("allow");
  });

  it("denies an unknown binary in allowlist mode", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "allowlist" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(
      makeChildInput({ argv: ["/usr/bin/nmap", "-sS", "10.0.0.0/8"] }),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.code).toBe("allowlist-miss");
    }
  });

  it("denies sudo in allowlist mode with dangerous-bin code", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "allowlist" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makeChildInput({ argv: ["/usr/bin/sudo", "rm", "-rf", "/"] }));
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.code).toBe("dangerous-bin");
    }
  });

  it("denies sandbox-exec in allowlist mode", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "allowlist" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(
      makeChildInput({ argv: ["/usr/bin/sandbox-exec", "-f", "policy"] }),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.code).toBe("dangerous-bin");
    }
  });

  // ---------------------------------------------------------------------------
  // allowlist mode — pty
  // ---------------------------------------------------------------------------

  it("allows pty command when evaluateShellAllowlist is satisfied", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "allowlist" } });
    mockEvaluateShellAllowlist.mockReturnValue({
      analysisOk: true,
      allowlistSatisfied: true,
      allowlistMatches: [],
      segments: [],
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: [],
    });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makePtyInput({ ptyCommand: "git status" }));
    expect(decision.kind).toBe("allow");
  });

  it("denies pty command when evaluateShellAllowlist is not satisfied", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "allowlist" } });
    mockEvaluateShellAllowlist.mockReturnValue({
      analysisOk: false,
      allowlistSatisfied: false,
      allowlistMatches: [],
      segments: [],
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: [],
    });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makePtyInput({ ptyCommand: "nmap -sS target" }));
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.code).toBe("allowlist-miss");
    }
  });

  // ---------------------------------------------------------------------------
  // env redaction
  // ---------------------------------------------------------------------------

  it("redacts ANTHROPIC_API_KEY in env", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "full" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(
      makeChildInput({ env: { ANTHROPIC_API_KEY: "sk-real-key", PATH: "/usr/bin" } }),
    );
    expect(decision.kind).toBe("allow");
    if (decision.kind === "allow") {
      expect(decision.env?.["ANTHROPIC_API_KEY"]).toBe("[REDACTED]");
      expect(decision.env?.["PATH"]).toBe("/usr/bin");
    }
  });

  it("redacts keys matching *_SECRET suffix", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "full" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(
      makeChildInput({ env: { MY_APP_SECRET: "abc123", NODE_ENV: "production" } }),
    );
    if (decision.kind === "allow") {
      expect(decision.env?.["MY_APP_SECRET"]).toBe("[REDACTED]");
      expect(decision.env?.["NODE_ENV"]).toBe("production");
    }
  });

  it("passes through env unchanged when no secret keys present", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "full" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(
      makeChildInput({ env: { PATH: "/usr/bin", HOME: "/home/user" } }),
    );
    if (decision.kind === "allow") {
      // No env override when nothing to redact
      expect(decision.env).toBeUndefined();
    }
  });

  it("redacts env in allowlist mode on allowed commands", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "allowlist" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(
      makeChildInput({
        argv: ["/usr/bin/git", "push"],
        env: { ANTHROPIC_API_KEY: "sk-oops", GIT_DIR: ".git" },
      }),
    );
    expect(decision.kind).toBe("allow");
    if (decision.kind === "allow") {
      expect(decision.env?.["ANTHROPIC_API_KEY"]).toBe("[REDACTED]");
      expect(decision.env?.["GIT_DIR"]).toBe(".git");
    }
  });

  // ---------------------------------------------------------------------------
  // Sandbox probe (M3)
  // ---------------------------------------------------------------------------

  it("denies with sandbox-unavailable when Docker socket not found in allowlist mode", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "allowlist" } });
    mockProbeSandboxRuntime.mockReturnValue({ available: false });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makeChildInput({ argv: ["/usr/bin/git", "status"] }));
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.code).toBe("sandbox-unavailable");
    }
  });

  it("denies with sandbox-unavailable in deny mode when Docker not found", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "deny" } });
    mockProbeSandboxRuntime.mockReturnValue({ available: false });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makeChildInput());
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.code).toBe("sandbox-unavailable");
    }
  });

  it("skips sandbox probe for exec-sandbox backendId (command already in container)", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "allowlist" } });
    mockProbeSandboxRuntime.mockReturnValue({ available: false });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(
      makeChildInput({ backendId: "exec-sandbox", argv: ["/usr/bin/git", "status"] }),
    );
    // Should NOT get sandbox-unavailable — it's already in the container
    if (decision.kind === "deny") {
      expect(decision.code).not.toBe("sandbox-unavailable");
    }
    expect(decision.kind).toBe("allow");
  });

  it("allows in full mode even when Docker is unavailable", () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "full" } });
    mockProbeSandboxRuntime.mockReturnValue({ available: false });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makeChildInput({ argv: ["/usr/bin/rm", "-rf", "/"] }));
    // full mode never checks probe
    expect(decision.kind).toBe("allow");
    expect(mockProbeSandboxRuntime).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // BrokerDenyError integration
  // ---------------------------------------------------------------------------

  it("validate() returns deny decision (BrokerDenyError thrown by brokered-supervisor)", async () => {
    mockLoadExecApprovals.mockReturnValue({ version: 1, defaults: { security: "deny" } });
    const broker = createExecPolicyBroker();
    const decision = broker.validate(makeChildInput());
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      const error = new BrokerDenyError(decision.reason, decision.code);
      expect(error.name).toBe("BrokerDenyError");
      // Either sandbox-unavailable (if probe fails) or deny-mode (if probe passes)
      expect(["sandbox-unavailable", "deny-mode"]).toContain(error.code);
    }
  });
});
