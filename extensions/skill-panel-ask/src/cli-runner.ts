// Shared spawn helper for CLI-based voice drivers.
//
// Every CLI voice (claude-cli, codex, gemini-cli, ollama-local, ...) talks to
// the same shape of process: spawn a binary with args, write the prompt to
// stdin, collect stdout. The runner captures that pattern so per-voice
// drivers stay 5-line wrappers around `runCli`.

import { spawn } from "node:child_process";

export interface RunCliOptions {
  bin: string;
  args: string[];
  /** Text written to the child's stdin. Pass undefined to leave stdin closed. */
  stdin?: string;
  /** Hard SIGKILL timeout. */
  timeoutMs: number;
  /** Optional environment variables merged into process.env. */
  env?: Record<string, string>;
}

export interface RunCliResult {
  ok: boolean;
  text: string;
  error?: string;
  /** Subprocess exit code, or null if killed by timeout. */
  exitCode: number | null;
  ms: number;
}

export async function runCli(opts: RunCliOptions): Promise<RunCliResult> {
  const start = Date.now();
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(opts.bin, opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, opts.timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        text: stdout,
        error: `${opts.bin} spawn error: ${err.message}`,
        exitCode: null,
        ms: Date.now() - start,
      });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - start;
      if (code === null) {
        resolve({
          ok: false,
          text: stdout,
          error: `${opts.bin} timed out after ${opts.timeoutMs}ms`,
          exitCode: null,
          ms,
        });
        return;
      }
      if (code !== 0) {
        resolve({
          ok: false,
          text: stdout,
          error: `${opts.bin} exit ${code}: ${stderr.slice(-300).trim()}`,
          exitCode: code,
          ms,
        });
        return;
      }
      resolve({
        ok: true,
        text: stdout.trim(),
        exitCode: code,
        ms,
      });
    });
    if (opts.stdin !== undefined && proc.stdin) {
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    }
  });
}
