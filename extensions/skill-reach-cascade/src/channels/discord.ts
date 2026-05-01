// discord channel — gateway-routed openclaw send with raw Bot API fallback.
//
// Target derived from ~/.openclaw/credentials/discord-target.json (set up
// during Discord plugin onboarding). Caps content at 2000 chars (Discord
// limit) with a truncation marker.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sendViaOpenclaw } from "../openclaw-native.js";
import { buildSignedText } from "../sign.js";
import type { AttemptResult, NotifyPayload } from "../types.js";

const TIMEOUT_MS = 10_000;
const MAX_CONTENT_CHARS = 1900; // 100 char headroom under the 2000 limit

interface DiscordOpts {
  cliPath: string;
  nativeTimeoutMs: number;
}

interface DiscordTarget {
  primaryGuild?: { id?: string };
  primaryChannel?: { id?: string };
}

function readDiscordTarget(): DiscordTarget | null {
  const path = join(homedir(), ".openclaw", "credentials", "discord-target.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DiscordTarget;
  } catch {
    return null;
  }
}

function readDiscordToken(): string | null {
  const path = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      channels?: { discord?: { token?: string } };
    };
    return cfg?.channels?.discord?.token ?? null;
  } catch {
    return null;
  }
}

function clipContent(text: string): string {
  return text.length > MAX_CONTENT_CHARS
    ? `${text.slice(0, MAX_CONTENT_CHARS - 20)}\n…(truncated)`
    : text;
}

function sendDiscordRawFallback(text: string, channelId: string): AttemptResult {
  const start = Date.now();
  const token = readDiscordToken();
  if (!token) {
    return { ok: false, durationMs: 0, error: "no discord token (raw fallback skipped)" };
  }
  const res = spawnSync(
    "/usr/bin/curl",
    [
      "-sS",
      "--max-time",
      "10",
      "-X",
      "POST",
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      "-H",
      `Authorization: Bot ${token}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({ content: text }),
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
  let parsed: { id?: string; message?: string };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, durationMs, error: `non-JSON response: ${res.stdout.slice(0, 120)}` };
  }
  if (parsed?.id) {
    return {
      ok: true,
      durationMs,
      messageId: parsed.id,
      transport: "raw-bot-api",
    };
  }
  return {
    ok: false,
    durationMs,
    error: `api no message id: ${parsed?.message ?? "unknown"}`,
  };
}

export async function attemptDiscord(
  payload: NotifyPayload,
  opts: DiscordOpts,
): Promise<AttemptResult> {
  const target = readDiscordTarget();
  const channelId = target?.primaryChannel?.id;
  if (!channelId) {
    return { ok: false, durationMs: 0, error: "no primaryChannel.id in discord-target.json" };
  }
  const text = buildSignedText(payload);
  const safe = clipContent(text);

  const native = await sendViaOpenclaw({
    channel: "discord",
    target: `channel:${channelId}`,
    text: safe,
    cliPath: opts.cliPath,
    timeoutMs: opts.nativeTimeoutMs,
  });
  if (native.ok) {
    return {
      ...native,
      detail: { guildId: target?.primaryGuild?.id, channelId },
    };
  }

  const fallback = sendDiscordRawFallback(safe, channelId);
  if (fallback.ok) {
    return {
      ok: true,
      durationMs: native.durationMs + fallback.durationMs,
      messageId: fallback.messageId,
      transport: fallback.transport,
      detail: { guildId: target?.primaryGuild?.id, channelId },
    };
  }
  return {
    ok: false,
    durationMs: native.durationMs + fallback.durationMs,
    error: `${native.error}; raw fallback: ${fallback.error}`,
  };
}
