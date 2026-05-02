// restartGateway — fires `launchctl kickstart -k <target>` to bounce the
// gateway service. Returns timing + success/error for the watchdog ledger.

import { spawnSync } from "node:child_process";
import type { GatewayWatchdogConfig } from "./config.js";
import type { RestartResult } from "./types.js";

const LAUNCHCTL_PATH = "/bin/launchctl";

export function restartGateway(config: GatewayWatchdogConfig): RestartResult {
  const start = Date.now();
  const res = spawnSync(LAUNCHCTL_PATH, ["kickstart", "-k", config.gatewayLaunchdTarget], {
    encoding: "utf8",
  });
  return {
    ok: res.status === 0,
    durationMs: Date.now() - start,
    error: res.status !== 0 ? (res.stderr || `exit ${res.status}`).trim() : null,
  };
}
