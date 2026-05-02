// dispatchClaudeCli — spawns `claude -p --model <m> --permission-mode
// bypassPermissions <prompt>` with timeout. Returns the structured result
// the scan/focus orchestrators consume.

import { spawn } from "node:child_process";
import type { IntrospectConfig } from "./config.js";
import type { ClaudeDispatchResult } from "./types.js";
import { buildExecutorEnv } from "./util.js";

export function dispatchClaudeCli(
  prompt: string,
  config: IntrospectConfig,
): Promise<ClaudeDispatchResult> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const args = [
      "-p",
      "--model",
      config.claudeModel,
      "--permission-mode",
      "bypassPermissions",
      prompt,
    ];
    const child = spawn(config.claudeCliPath, args, {
      env: buildExecutorEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const t = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, config.claudeTimeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolvePromise({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}
