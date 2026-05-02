// Default launchctl + ps runners. Both injectable so tests can stub.

import { spawn } from "node:child_process";
import type { LaunchctlRunner, PsRunner } from "./types.js";

export function defaultLaunchctlRunner(): LaunchctlRunner {
  return async ({ label, timeoutMs }) => {
    return new Promise((resolvePromise) => {
      const child = spawn("/bin/launchctl", ["list", label], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolvePromise({ ok: false, stdout, stderr: `timed out after ${timeoutMs}ms` });
          return;
        }
        resolvePromise({ ok: code === 0, stdout, stderr });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise({
          ok: false,
          stdout,
          stderr: err instanceof Error ? err.message : String(err),
        });
      });
    });
  };
}

export function defaultPsRunner(): PsRunner {
  return async ({ pid }) => {
    return new Promise((resolvePromise) => {
      // ps -p <pid> -o pcpu=,etime= → "%CPU ET" or empty if pid not found
      const child = spawn("/bin/ps", ["-p", String(pid), "-o", "pcpu=,etime="], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.on("close", (code) => {
        if (code !== 0) {
          resolvePromise({ ok: false, cpu: null, uptimeSec: null });
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolvePromise({ ok: false, cpu: null, uptimeSec: null });
          return;
        }
        const parts = trimmed.split(/\s+/);
        const cpu = parts[0] ? Number(parts[0]) : null;
        const etime = parts[1];
        let uptimeSec: number | null = null;
        if (etime) {
          // etime format: dd-hh:mm:ss | hh:mm:ss | mm:ss
          const dh = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
          if (dh) {
            const days = Number(dh[1] ?? 0);
            const hours = Number(dh[2] ?? 0);
            const mins = Number(dh[3] ?? 0);
            const secs = Number(dh[4] ?? 0);
            uptimeSec = days * 86400 + hours * 3600 + mins * 60 + secs;
          }
        }
        resolvePromise({ ok: true, cpu: Number.isFinite(cpu ?? NaN) ? cpu : null, uptimeSec });
      });
      child.on("error", () => resolvePromise({ ok: false, cpu: null, uptimeSec: null }));
    });
  };
}
