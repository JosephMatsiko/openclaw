/**
 * Exec broker interfaces (Phase 1 M1: seam only).
 *
 * The broker sits between the agent's tool-call surface and the process
 * supervisor. It validates and optionally rewrites the argv/env of every
 * spawn request before the OS sees it. M1 ships the seam only; the
 * default configuration is `null` (bypass). M2 wires in a real policy.
 */
export type BrokerInputBase = {
  sessionId: string;
  backendId: string;
  scopeKey?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type BrokerInputChild = BrokerInputBase & {
  mode: "child";
  argv: string[];
};

export type BrokerInputPty = BrokerInputBase & {
  mode: "pty";
  ptyCommand: string;
};

export type BrokerInput = BrokerInputChild | BrokerInputPty;

/**
 * Decision returned by the broker. `allow` may optionally supply a rewritten
 * argv / ptyCommand / env that the supervisor will use instead of the
 * original input.
 */
export type BrokerDecisionAllow = {
  kind: "allow";
  reason: string;
  argv?: string[];
  ptyCommand?: string;
  env?: NodeJS.ProcessEnv;
};

export type BrokerDecisionDeny = {
  kind: "deny";
  reason: string;
  /** Stable machine-readable code (e.g. "allowlist-miss", "credential-path"). */
  code?: string;
};

export type BrokerDecision = BrokerDecisionAllow | BrokerDecisionDeny;

export interface ExecBroker {
  validate(input: BrokerInput): Promise<BrokerDecision> | BrokerDecision;
}

export class BrokerDenyError extends Error {
  readonly code: string | undefined;
  readonly brokerReason: string;
  constructor(reason: string, code?: string) {
    super(`exec broker denied: ${reason}`);
    this.name = "BrokerDenyError";
    this.code = code;
    this.brokerReason = reason;
  }
}
