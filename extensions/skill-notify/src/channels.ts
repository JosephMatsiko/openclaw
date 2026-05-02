// Per-channel attempters with verifiable receipts.
//
// Telegram: HTTP POST to api.telegram.org/bot<token>/sendMessage as the
//   openclaw-bound bot, to every chatId in openclaw.json#channels.telegram.allowFrom.
// Apple Bridge: osascript display notification — a real macOS banner.

import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import type { NotifyConfig } from "./config.js";
import { readTelegramBinding } from "./openclaw-config.js";
import type { ChannelDispatchResult, HttpPoster, OsascriptRunner, RunDeps } from "./types.js";

export function defaultHttpPoster(): HttpPoster {
  return async ({ url, body, timeoutMs }) => {
    return new Promise((resolvePromise, rejectPromise) => {
      const formData = Object.entries(body)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
      const u = new URL(url);
      const req = httpsRequest(
        {
          method: "POST",
          host: u.hostname,
          path: u.pathname + u.search,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(formData).toString(),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () => {
            resolvePromise({
              ok:
                typeof res.statusCode === "number" && res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode ?? 0,
              text,
            });
          });
        },
      );
      const timer = setTimeout(() => {
        try {
          req.destroy(new Error(`telegram HTTP timed out after ${timeoutMs}ms`));
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      req.on("error", (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      });
      req.on("close", () => clearTimeout(timer));
      req.write(formData);
      req.end();
    });
  };
}

export function defaultOsascriptRunner(): OsascriptRunner {
  return async ({ script, timeoutMs }) => {
    return new Promise((resolvePromise) => {
      const child = spawn("/usr/bin/osascript", ["-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
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
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolvePromise({ ok: false, stderr: `timed out after ${timeoutMs}ms` });
          return;
        }
        resolvePromise({ ok: code === 0, stderr });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise({ ok: false, stderr: err instanceof Error ? err.message : String(err) });
      });
    });
  };
}

function osascriptEscape(value: string): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

interface AttemptInput {
  config: NotifyConfig;
  title: string;
  text: string;
  severity: "info" | "warn" | "critical";
}

export async function attemptTelegram(
  input: AttemptInput,
  deps: RunDeps = {},
): Promise<ChannelDispatchResult[]> {
  const start = Date.now();
  const binding = readTelegramBinding(input.config);
  if (!binding) {
    return [
      {
        channel: "telegram",
        ok: false,
        durationMs: Date.now() - start,
        reason: "no telegram binding in openclaw config",
      },
    ];
  }
  if (!binding.enabled) {
    return [
      {
        channel: "telegram",
        ok: false,
        durationMs: Date.now() - start,
        reason: "telegram channel is disabled in openclaw config",
      },
    ];
  }
  if (!binding.botToken) {
    return [
      {
        channel: "telegram",
        ok: false,
        durationMs: Date.now() - start,
        reason: "openclaw config has no telegram botToken",
      },
    ];
  }
  if (binding.chatIds.length === 0) {
    return [
      {
        channel: "telegram",
        ok: false,
        durationMs: Date.now() - start,
        reason: "openclaw config has no paired chat (allowFrom is empty)",
      },
    ];
  }
  const poster = deps.httpPost ?? defaultHttpPoster();
  const url = `${input.config.telegramApiBase}/bot${binding.botToken}/sendMessage`;
  const out: ChannelDispatchResult[] = [];
  for (const chatId of binding.chatIds) {
    const t0 = Date.now();
    try {
      const res = await poster({
        url,
        body: { chat_id: chatId, text: `${input.title}\n${input.text}`.trim() },
        timeoutMs: input.config.telegramTimeoutMs,
      });
      let messageId: number | null = null;
      try {
        const parsed = JSON.parse(res.text);
        if (parsed && typeof parsed === "object" && parsed.ok && parsed.result?.message_id) {
          messageId = Number(parsed.result.message_id);
        }
      } catch {
        /* ignore parse errors */
      }
      out.push({
        channel: `telegram:${chatId}`,
        ok: res.ok && messageId != null,
        receiptId: messageId,
        status: res.status,
        durationMs: Date.now() - t0,
        reason: res.ok ? undefined : `status ${res.status}`,
      });
    } catch (err) {
      out.push({
        channel: `telegram:${chatId}`,
        ok: false,
        durationMs: Date.now() - t0,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export async function attemptAppleBridge(
  input: AttemptInput,
  deps: RunDeps = {},
): Promise<ChannelDispatchResult> {
  const start = Date.now();
  if (!input.config.appleBridgeEnabled) {
    return {
      channel: "apple-bridge",
      ok: false,
      durationMs: Date.now() - start,
      reason: "apple-bridge channel disabled in plugin config",
    };
  }
  const subject = osascriptEscape(input.title || "Chuck notification");
  const text = osascriptEscape(input.text || input.title);
  const sound = input.severity === "critical" ? "Sosumi" : null;
  const script = sound
    ? `display notification "${text}" with title "${subject}" sound name "${sound}"`
    : `display notification "${text}" with title "${subject}"`;
  const runner = deps.osascript ?? defaultOsascriptRunner();
  const res = await runner({ script, timeoutMs: input.config.appleBridgeTimeoutMs });
  return {
    channel: "apple-bridge",
    ok: res.ok,
    durationMs: Date.now() - start,
    reason: res.ok ? undefined : res.stderr || "osascript failed",
  };
}
