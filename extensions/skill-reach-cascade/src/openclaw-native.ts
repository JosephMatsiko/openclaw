// Subprocess wrapper around the openclaw CLI's `message send --json`.
//
// Why this exists: the openclaw gateway is the canonical send path for
// telegram + discord — single auth source, observable in the openclaw
// event ledger, follows configured channel auth + delivery policy. The
// raw bot-API curl fallbacks in each channel module exist solely so the
// cascade keeps working when the gateway is mid-restart.
//
// The CLI prints config warnings + plugin chatter before the result JSON,
// so we slice from the last "\n{" to end-of-stream when parsing.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const DEFAULT_OPENCLAW_CLI = join(HOME, "Projects", "openclaw", "dist", "index.js");

export interface OpenclawNativeResult {
  ok: boolean;
  durationMs: number;
  messageId?: string | null;
  transport?: "openclaw-native";
  error?: string;
}

function resolveCliPath(configured: string): string | null {
  if (configured && existsSync(configured)) return configured;
  if (existsSync(DEFAULT_OPENCLAW_CLI)) return DEFAULT_OPENCLAW_CLI;
  return null;
}

export async function sendViaOpenclaw(input: {
  channel: string;
  target: string;
  text: string;
  silent?: boolean;
  cliPath: string;
  timeoutMs: number;
}): Promise<OpenclawNativeResult> {
  const start = Date.now();
  const cliPath = resolveCliPath(input.cliPath);
  if (!cliPath) {
    return {
      ok: false,
      durationMs: 0,
      error: "openclaw CLI entry not found; configure openclawCliPath",
    };
  }
  const args = [
    cliPath,
    "message",
    "send",
    "--channel",
    input.channel,
    "--target",
    input.target,
    "--message",
    input.text,
    "--json",
  ];
  if (input.silent !== false) args.push("--silent");

  return await new Promise<OpenclawNativeResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => {
      stdout += String(d);
    });
    proc.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({
        ok: false,
        durationMs: Date.now() - start,
        error: `openclaw native timed out after ${input.timeoutMs}ms`,
      });
    }, input.timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (code !== 0) {
        resolve({
          ok: false,
          durationMs,
          error: `openclaw native exit ${code}: ${stderr.slice(-300).trim()}`,
        });
        return;
      }
      try {
        const lastBrace = stdout.lastIndexOf("\n{");
        const payloadJson = lastBrace >= 0 ? stdout.slice(lastBrace).trim() : stdout.trim();
        const payload = JSON.parse(payloadJson) as {
          payload?: {
            ok?: boolean;
            messageId?: string | null;
            id?: string | null;
            payload?: { messageId?: string | null };
          };
          action?: string;
        };
        const ok = payload?.payload?.ok === true || payload?.action === "send";
        const messageId =
          payload?.payload?.messageId ??
          payload?.payload?.payload?.messageId ??
          payload?.payload?.id ??
          null;
        if (ok) {
          resolve({ ok: true, durationMs, messageId, transport: "openclaw-native" });
        } else {
          resolve({
            ok: false,
            durationMs,
            error: `openclaw native payload not-ok: ${payloadJson.slice(0, 200)}`,
          });
        }
      } catch (err) {
        resolve({
          ok: false,
          durationMs,
          error: `openclaw native parse failed: ${(err as Error).message ?? String(err)}`,
        });
      }
    });
  });
}
