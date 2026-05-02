// Read openclaw.json's channels.telegram block — bot token + paired chat IDs.

import { readFileSync } from "node:fs";
import type { NotifyConfig } from "./config.js";

export interface TelegramBinding {
  enabled: boolean;
  botToken: string;
  chatIds: string[];
}

export function readTelegramBinding(config: NotifyConfig): TelegramBinding | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(config.openclawConfigPath, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const channels = (raw as Record<string, unknown>).channels;
  if (!channels || typeof channels !== "object") return null;
  const tg = (channels as Record<string, unknown>).telegram;
  if (!tg || typeof tg !== "object") return null;
  const obj = tg as Record<string, unknown>;
  const enabled = obj.enabled !== false;
  const botToken = typeof obj.botToken === "string" ? obj.botToken : "";
  const allowFrom = Array.isArray(obj.allowFrom)
    ? (obj.allowFrom as unknown[]).map((id) => String(id)).filter(Boolean)
    : [];
  if (!botToken || allowFrom.length === 0) return { enabled, botToken, chatIds: allowFrom };
  return { enabled, botToken, chatIds: allowFrom };
}
