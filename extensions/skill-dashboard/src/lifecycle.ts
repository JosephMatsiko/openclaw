// LaunchAgent status probe via `launchctl print`. Read-only.

import { spawn } from "node:child_process";
import type { DashboardConfig } from "./config.js";
import type { LaunchAgentStatus, LaunchctlRunner, RunDeps } from "./types.js";

export function defaultLaunchctlRunner(): LaunchctlRunner {
  return async ({ label }) => {
    return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolvePromise) => {
      // `launchctl print gui/<uid>/<label>` is the modern equivalent of `list`.
      // We use the simpler `launchctl list <label>` which works on macOS 10.10+
      // and returns "PID Status Label" or "Could not find service".
      const child = spawn("/bin/launchctl", ["list", label], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", () => {
        resolvePromise({ ok: false, stdout, stderr });
      });
      child.on("close", (code) => {
        resolvePromise({ ok: code === 0, stdout, stderr });
      });
    });
  };
}

function parseLaunchctlList(stdout: string, label: string): LaunchAgentStatus {
  const text = stdout.trim();
  if (!text || /Could not find service/i.test(text)) {
    return { label, loaded: false, pid: null, lastExitCode: null, raw: text };
  }
  // Format: <PID|"-"> <last-exit-status> <label>
  // Example: "12345  0  com.openclaw.chuck-dashboard"
  // Or:      "-      0  com.openclaw.chuck-dashboard"  (loaded but not running)
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 3) continue;
    if (cols[cols.length - 1] !== label) continue;
    const rawPid = cols[0];
    const rawExit = cols[1];
    const pid = rawPid === "-" || !/^\d+$/.test(rawPid ?? "") ? null : Number(rawPid);
    const lastExitCode = /^-?\d+$/.test(rawExit ?? "") ? Number(rawExit) : null;
    return { label, loaded: true, pid, lastExitCode, raw: text };
  }
  return { label, loaded: false, pid: null, lastExitCode: null, raw: text };
}

export async function readLaunchAgentStatus(
  config: DashboardConfig,
  deps: RunDeps = {},
): Promise<LaunchAgentStatus> {
  const runner = deps.launchctl ?? defaultLaunchctlRunner();
  const result = await runner({ label: config.launchAgentLabel });
  return parseLaunchctlList(result.stdout, config.launchAgentLabel);
}
