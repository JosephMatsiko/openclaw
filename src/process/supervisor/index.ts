import { createBrokeredSupervisor, type BrokerRef } from "../broker/brokered-supervisor.js";
import { createExecPolicyBroker } from "../broker/exec-policy-broker.js";
import type { ExecBroker } from "../broker/types.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { ProcessSupervisor } from "./types.js";

let singleton: ProcessSupervisor | null = null;

// Auto-install the policy broker when OPENCLAW_EXEC_BROKER=1.
// The broker fast-paths for security="full" (the config default), so enabling
// this has no observable effect on existing deployments that haven't changed
// exec-approvals.json.
const _autoInstall =
  process.env.OPENCLAW_EXEC_BROKER === "1" || process.env.OPENCLAW_EXEC_BROKER === "true";
const brokerRef: BrokerRef = { current: _autoInstall ? createExecPolicyBroker() : null };

/**
 * Install or replace the exec broker used by the process supervisor.
 *
 * Passing `null` disables brokering (direct spawn). Brokering changes take
 * effect for subsequent spawns immediately and do not affect runs already
 * in flight.
 */
export function configureExecBroker(broker: ExecBroker | null): void {
  brokerRef.current = broker;
}

export function getConfiguredExecBroker(): ExecBroker | null {
  return brokerRef.current;
}

export function getProcessSupervisor(): ProcessSupervisor {
  if (singleton) {
    return singleton;
  }
  const base = createProcessSupervisor();
  singleton = createBrokeredSupervisor(base, brokerRef);
  return singleton;
}

/** Test-only: drop the cached supervisor so the next getter rebuilds. */
export function __resetProcessSupervisorForTests(): void {
  singleton = null;
  brokerRef.current = null;
}

export { createProcessSupervisor } from "./supervisor.js";
export type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  RunRecord,
  RunState,
  SpawnInput,
  SpawnMode,
  TerminationReason,
} from "./types.js";
