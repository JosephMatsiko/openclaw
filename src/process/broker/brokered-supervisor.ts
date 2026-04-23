import type {
  ManagedRun,
  ProcessSupervisor,
  RunRecord,
  SpawnInput,
  TerminationReason,
} from "../supervisor/types.js";
import type { BrokerInput, ExecBroker } from "./types.js";
import { BrokerDenyError } from "./types.js";

export type BrokerRef = { current: ExecBroker | null };

function toBrokerInput(input: SpawnInput): BrokerInput {
  const base = {
    sessionId: input.sessionId,
    backendId: input.backendId,
    scopeKey: input.scopeKey,
    cwd: input.cwd,
    env: input.env,
  };
  if (input.mode === "pty") {
    return { ...base, mode: "pty", ptyCommand: input.ptyCommand };
  }
  return { ...base, mode: "child", argv: input.argv };
}

/**
 * Wrap a ProcessSupervisor so every spawn passes through the configured
 * broker first. When `brokerRef.current` is null, spawn is forwarded
 * unmodified — the wrapper is behavior-neutral. Swapping the ref mutates
 * broker policy without rebuilding the supervisor (preserves active runs).
 */
export function createBrokeredSupervisor(
  inner: ProcessSupervisor,
  brokerRef: BrokerRef,
): ProcessSupervisor {
  const spawn = async (input: SpawnInput): Promise<ManagedRun> => {
    const broker = brokerRef.current;
    if (!broker) {
      return await inner.spawn(input);
    }
    const decision = await broker.validate(toBrokerInput(input));
    if (decision.kind === "deny") {
      throw new BrokerDenyError(decision.reason, decision.code);
    }
    const rewritten: SpawnInput =
      input.mode === "pty"
        ? {
            ...input,
            mode: "pty",
            ptyCommand: decision.ptyCommand ?? input.ptyCommand,
            env: decision.env ?? input.env,
          }
        : {
            ...input,
            mode: "child",
            argv: decision.argv ?? input.argv,
            env: decision.env ?? input.env,
          };
    return await inner.spawn(rewritten);
  };

  return {
    spawn,
    cancel: (runId: string, reason?: TerminationReason) => inner.cancel(runId, reason),
    cancelScope: (scopeKey: string, reason?: TerminationReason) =>
      inner.cancelScope(scopeKey, reason),
    reconcileOrphans: () => inner.reconcileOrphans(),
    getRecord: (runId: string): RunRecord | undefined => inner.getRecord(runId),
  };
}
