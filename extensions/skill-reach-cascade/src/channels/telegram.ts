// telegram channel — gateway-routed openclaw send with raw Bot API fallback.
//
// Long-form HTML (formatLongUpdate output) goes through raw Bot API directly
// because the openclaw native message send doesn't expose parse_mode through
// the public CLI flag set today. The underlying telegram channel SUPPORTS
// parse_mode (see extensions/telegram/src/draft-stream.test.ts:281), but the
// seam is via presentation.renderText, not a CLI flag. Once that surface
// lands publicly, the HTML path collapses back into sendViaOpenclaw.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatLongUpdate } from "../../../skill-panel-ask/api.js";
import { sendViaOpenclaw } from "../openclaw-native.js";
import { buildSignedText } from "../sign.js";
import type { AttemptResult, NotifyPayload } from "../types.js";

const TIMEOUT_MS = 10_000;

interface TelegramOpts {
  chatId: string;
  cliPath: string;
  nativeTimeoutMs: number;
}

function readTelegramToken(): string | null {
  const path = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      channels?: { telegram?: { botToken?: string } };
    };
    return cfg?.channels?.telegram?.botToken ?? null;
  } catch {
    return null;
  }
}

function sendTelegramHtmlRaw(htmlText: string, chatId: string): AttemptResult {
  const start = Date.now();
  const token = readTelegramToken();
  if (!token) {
    return { ok: false, durationMs: 0, error: "no telegram botToken in openclaw.json" };
  }
  const res = spawnSync(
    "/usr/bin/curl",
    [
      "-sS",
      "--max-time",
      "10",
      "-X",
      "POST",
      `https://api.telegram.org/bot${token}/sendMessage`,
      "--data-urlencode",
      `chat_id=${chatId}`,
      "--data-urlencode",
      "parse_mode=HTML",
      "--data-urlencode",
      `text=${htmlText}`,
    ],
    { timeout: TIMEOUT_MS, encoding: "utf8" },
  );
  const durationMs = Date.now() - start;
  if (res.error) return { ok: false, durationMs, error: res.error.message };
  if (res.status !== 0) {
    return {
      ok: false,
      durationMs,
      error: (res.stderr ?? "").trim() || `curl exit ${res.status}`,
    };
  }
  let parsed: { ok?: boolean; description?: string; result?: { message_id?: number } };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, durationMs, error: `non-JSON response: ${res.stdout.slice(0, 120)}` };
  }
  if (parsed?.ok) {
    return {
      ok: true,
      durationMs,
      messageId: String(parsed?.result?.message_id ?? ""),
      transport: "raw-bot-api-html",
    };
  }
  return {
    ok: false,
    durationMs,
    error: parsed?.description ?? "telegram api returned not-ok (HTML mode)",
  };
}

function sendTelegramRawFallback(text: string, chatId: string): AttemptResult {
  const start = Date.now();
  const token = readTelegramToken();
  if (!token) {
    return { ok: false, durationMs: 0, error: "no telegram botToken (raw fallback skipped)" };
  }
  const res = spawnSync(
    "/usr/bin/curl",
    [
      "-sS",
      "--max-time",
      "10",
      "-X",
      "POST",
      `https://api.telegram.org/bot${token}/sendMessage`,
      "--data-urlencode",
      `chat_id=${chatId}`,
      "--data-urlencode",
      `text=${text}`,
    ],
    { timeout: TIMEOUT_MS, encoding: "utf8" },
  );
  const durationMs = Date.now() - start;
  if (res.error) return { ok: false, durationMs, error: res.error.message };
  if (res.status !== 0) {
    return {
      ok: false,
      durationMs,
      error: (res.stderr ?? "").trim() || `curl exit ${res.status}`,
    };
  }
  let parsed: { ok?: boolean; description?: string; result?: { message_id?: number } };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, durationMs, error: `non-JSON response: ${res.stdout.slice(0, 120)}` };
  }
  if (parsed?.ok) {
    return {
      ok: true,
      durationMs,
      messageId: parsed?.result?.message_id ?? null,
      transport: "raw-bot-api",
    };
  }
  return {
    ok: false,
    durationMs,
    error: `api not-ok: ${parsed?.description ?? "unknown"}`,
  };
}

export async function attemptTelegram(
  payload: NotifyPayload,
  opts: TelegramOpts,
): Promise<AttemptResult> {
  const text = buildSignedText(payload);
  const formatted = formatLongUpdate(text);

  if (formatted.parseMode === "HTML") {
    return sendTelegramHtmlRaw(formatted.text, opts.chatId);
  }

  const native = await sendViaOpenclaw({
    channel: "telegram",
    target: opts.chatId,
    text,
    cliPath: opts.cliPath,
    timeoutMs: opts.nativeTimeoutMs,
  });
  if (native.ok) return native;

  const fallback = sendTelegramRawFallback(text, opts.chatId);
  if (fallback.ok) {
    return {
      ok: true,
      durationMs: native.durationMs + fallback.durationMs,
      messageId: fallback.messageId,
      transport: fallback.transport,
    };
  }
  return {
    ok: false,
    durationMs: native.durationMs + fallback.durationMs,
    error: `${native.error}; raw fallback: ${fallback.error}`,
  };
}
